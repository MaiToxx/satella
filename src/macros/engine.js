// Moteur de macros : déclencheurs globaux, lecture asynchrone annulable,
// enregistreur d'événements clavier/souris (uiohook).

const { EventEmitter } = require('events');
const input = require('./input');
const { UIOHOOK_TO_NAME, toAccelerator } = require('./keys');
const textvars = require('../shared/textvars');

// Le module natif d'écoute globale n'est chargé qu'au premier besoin
// (effet réactif, enregistrement, expansion de texte...)
let uiohook = null;
let uiohookError = null;
let uiohookTried = false;
function loadHook() {
  if (!uiohookTried) {
    uiohookTried = true;
    try {
      uiohook = require('uiohook-napi').uIOhook;
    } catch (err) {
      uiohookError = err;
    }
  }
  return uiohook;
}
const hookAvailable = () => !!loadHook();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Profondeur maximale d'appels « Exécuter macro » imbriqués (filet de
// sécurité en plus de la détection de cycle)
const MAX_DEPTH = 16;

class MacroEngine extends EventEmitter {
  // `injector` : module d'injection d'entrées (remplaçable pour les tests)
  // `opener` : ouvre un programme, un fichier ou un lien (étape « Ouvrir »)
  // `actions` : { loadProfile(nom) -> booléen, setEffect(effet, couleur) }
  // pour les étapes « Charger un profil » et « Effet clavier »
  constructor({ globalShortcut, injector = input, opener = null, clipboardRead = () => '', actions = {} }) {
    super();
    this.globalShortcut = globalShortcut;
    this.input = injector;
    this.opener = opener;
    this.actions = actions;
    this.clipboardRead = clipboardRead; // variable {presse-papiers} des étapes « Texte »
    this.macros = [];
    this.playing = new Map(); // id -> {cancelled}
    this.recording = false;
    this.recordBuffer = [];
    this.recordOpts = { mouse: true, moves: false, clickPositions: false };
    this.lastEventTime = 0;
    this.hookStarted = false;
    this.suppressRecord = false;
    this.waiters = 0; // étapes « Attendre une touche » en cours
  }

  get busy() { return this.playing.size > 0; }

  // Une étape attend une touche : l'écoute globale doit rester active
  get waitingForKey() { return this.waiters > 0; }

  // ---- Déclencheurs -------------------------------------------------------
  // Renvoie la liste des raccourcis refusés (déjà pris par une autre
  // application, ou invalides).
  setMacros(macros) {
    this.macros = macros || [];
    return this.registerTriggers();
  }

  registerTriggers() {
    this.globalShortcut.unregisterAll();
    const errors = [];
    for (const macro of this.macros) {
      if (!macro.enabled || !macro.trigger || !macro.trigger.accelerator) continue;
      try {
        const ok = this.globalShortcut.register(macro.trigger.accelerator, () => {
          if (this.recording) return; // pas de déclenchement pendant un enregistrement
          if (this.playing.has(macro.id)) this.stop(macro.id);
          else this.play(macro.id).catch((err) => this.emit('play-error', { id: macro.id, message: err.message }));
        });
        if (!ok) errors.push({ kind: 'macro', id: macro.id, accelerator: macro.trigger.accelerator });
      } catch (err) {
        errors.push({ kind: 'macro', id: macro.id, accelerator: macro.trigger.accelerator, error: err.message });
      }
    }
    return errors;
  }

  // ---- Lecture ------------------------------------------------------------
  // `draft` : version non sauvegardée de la macro (bouton « Tester »).
  async play(id, draft = null) {
    const macro = draft || this.macros.find((m) => m.id === id);
    if (!macro) throw new Error('Macro introuvable');
    // Une macro qui ne fait qu'ouvrir et attendre n'a pas besoin d'injection
    if (!this.input.available && this.needsInput(macro.steps)) {
      throw new Error("Injection d'entrées indisponible : " + (this.input.loadError && this.input.loadError.message));
    }
    if (this.playing.has(macro.id)) return;

    const ctx = { cancelled: false, keys: new Set(), buttons: new Set() };
    this.playing.set(macro.id, ctx);
    this.emit('play-state', { id: macro.id, playing: true });

    const o = macro.options || {};
    const opts = {
      speed: Math.max(0.1, Math.min(10, o.speed || 1)),
      holdMs: Math.max(0, Math.min(1000, o.holdMs || 0)),
      jitter: Math.max(0, Math.min(50, o.jitter || 0)) / 100,
    };
    const repeat = o.loopInfinite ? Infinity : Math.max(1, o.repeat || 1);

    try {
      for (let i = 0; i < repeat && !ctx.cancelled; i++) {
        await this.runSteps(macro.steps || [], ctx, opts, [macro.id]);
        if (o.repeatDelayMs && i < repeat - 1 && !ctx.cancelled) {
          await this.cancellableSleep(this.duration(o.repeatDelayMs, opts), ctx);
        }
      }
    } catch (err) {
      this.emit('play-error', { id: macro.id, message: err.message });
    } finally {
      // Une macro arrêtée entre un appui et son relâchement ne doit jamais
      // laisser une touche ou un bouton enfoncé dans Windows
      this.releaseAll(ctx);
      this.playing.delete(macro.id);
      this.emit('play-state', { id: macro.id, playing: false });
    }
  }

  // Les étapes (et les macros appelées) envoient-elles des touches ou des
  // actions souris ?
  needsInput(steps, seen = new Set()) {
    return (steps || []).some((s) => {
      if (['delay', 'open', 'waitKey', 'profile', 'effect'].includes(s.type)) return false;
      if (s.type === 'loop') return this.needsInput(s.steps, seen);
      if (s.type === 'runMacro') {
        if (seen.has(s.macroId)) return false;
        seen.add(s.macroId);
        const sub = this.macros.find((m) => m.id === s.macroId);
        return !!sub && this.needsInput(sub.steps, seen);
      }
      return true;
    });
  }

  // Durée ajustée à la vitesse de lecture, avec variation aléatoire
  // (« humanisation ») si demandée
  duration(ms, opts) {
    let d = ms / opts.speed;
    if (opts.jitter) d *= 1 + (Math.random() * 2 - 1) * opts.jitter;
    return Math.max(0, d);
  }

  async cancellableSleep(ms, ctx) {
    const step = 50;
    let left = ms;
    while (left > 0 && !ctx.cancelled) {
      await sleep(Math.min(step, left));
      left -= step;
    }
  }

  press(ctx, key) {
    this.input.keyDown(key);
    ctx.keys.add(key);
  }

  release(ctx, key) {
    this.input.keyUp(key);
    ctx.keys.delete(key);
  }

  pressButton(ctx, button) {
    this.input.mouseButton(button, false);
    ctx.buttons.add(button);
  }

  releaseButton(ctx, button) {
    this.input.mouseButton(button, true);
    ctx.buttons.delete(button);
  }

  releaseAll(ctx) {
    for (const key of [...ctx.keys].reverse()) {
      try { this.input.keyUp(key); } catch { /* touche inconnue */ }
    }
    for (const button of ctx.buttons) {
      try { this.input.mouseButton(button, true); } catch { /* ignore */ }
    }
    ctx.keys.clear();
    ctx.buttons.clear();
  }

  // Frappe avec maintien optionnel : certains jeux ne voient pas un appui
  // de 0 ms (ils lisent l'état du clavier une fois par image)
  async tap(ctx, key, modifiers, holdMs) {
    for (const m of modifiers) this.press(ctx, m);
    this.press(ctx, key);
    if (holdMs > 0) await sleep(holdMs);
    this.release(ctx, key);
    for (const m of [...modifiers].reverse()) this.release(ctx, m);
  }

  async click(ctx, button, count, holdMs) {
    for (let i = 0; i < count && !ctx.cancelled; i++) {
      this.pressButton(ctx, button);
      if (holdMs > 0) await sleep(holdMs);
      this.releaseButton(ctx, button);
      if (holdMs > 0 && i < count - 1) await sleep(holdMs);
    }
  }

  // `stack` : macros en cours d'exécution (de la racine à la courante),
  // pour refuser les cycles A -> B -> A.
  async runSteps(steps, ctx, opts, stack) {
    for (const step of steps) {
      if (ctx.cancelled) return;
      switch (step.type) {
        case 'keyDown': this.press(ctx, step.key); break;
        case 'keyUp': this.release(ctx, step.key); break;
        case 'keyTap':
          await this.tap(ctx, step.key, step.modifiers || [], opts.holdMs);
          break;
        case 'text': {
          // Variables ({date}, {presse-papiers}...) ; {curseur} : flèche
          // gauche jusqu'à l'endroit marqué
          const { text, back } = textvars.expand(step.value || '', { clipboard: this.clipboardRead });
          this.input.typeTextLines(text);
          for (let i = 0; i < back && !ctx.cancelled; i++) this.input.keyTap('left');
          break;
        }
        case 'delay': await this.cancellableSleep(this.duration(step.ms || 0, opts), ctx); break;
        case 'mouseDown': this.pressButton(ctx, step.button || 'left'); break;
        case 'mouseUp': this.releaseButton(ctx, step.button || 'left'); break;
        case 'mouseClick': await this.click(ctx, step.button || 'left', step.count || 1, opts.holdMs); break;
        case 'mouseMove': this.input.mouseMove(step.x || 0, step.y || 0, !!step.relative); break;
        case 'mouseWheel': this.input.mouseWheel(step.delta || 120, !!step.horizontal); break;
        case 'open':
          if (!this.opener) throw new Error('ouverture de programmes indisponible');
          await this.opener(step.target || '');
          break;
        case 'waitKey':
          await this.waitForKey(ctx, step.key, step.timeoutMs || 0);
          break;
        case 'profile':
          if (!this.actions.loadProfile) throw new Error('chargement de profil indisponible');
          if (!this.actions.loadProfile(step.name)) throw new Error(`profil « ${step.name} » introuvable`);
          break;
        case 'effect':
          if (!this.actions.setEffect) throw new Error('éclairage indisponible');
          this.actions.setEffect(step.effect, step.color || null);
          break;
        case 'loop': {
          const count = Math.max(1, step.count || 1);
          for (let i = 0; i < count && !ctx.cancelled; i++) {
            await this.runSteps(step.steps || [], ctx, opts, stack);
          }
          break;
        }
        case 'runMacro': {
          const sub = this.macros.find((m) => m.id === step.macroId);
          if (!sub) break;
          if (stack.includes(sub.id) || stack.length >= MAX_DEPTH) {
            throw new Error(`boucle infinie évitée : « ${sub.name || sub.id} » finit par s'appeler elle-même`);
          }
          await this.runSteps(sub.steps || [], ctx, opts, [...stack, sub.id]);
          break;
        }
        default: break;
      }
      // Petit délai par défaut entre les étapes pour la fiabilité
      if (step.type !== 'delay' && !ctx.cancelled) {
        await sleep(Math.max(2, this.duration(step.gapMs !== undefined ? step.gapMs : 15, opts)));
      }
    }
  }

  // Attend l'appui sur `key` (écoute globale), un délai maximal (0 = sans
  // limite) ou l'arrêt de la macro. Renvoie true si la touche a été pressée.
  waitForKey(ctx, key, timeoutMs) {
    if (!this.startActivityFeed()) {
      throw new Error("écoute du clavier indisponible : impossible d'attendre une touche");
    }
    this.waiters++;
    this.emit('wait-change');
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let poll = null;
      let onKey = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        this.off('key-activity', onKey);
        this.waiters--;
        this.emit('wait-change');
        resolve(result);
      };
      onKey = (e) => { if (e.down && e.key === key) finish(true); };
      this.on('key-activity', onKey);
      poll = setInterval(() => { if (ctx.cancelled) finish(false); }, 50);
      if (timeoutMs > 0) timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  stop(id) {
    if (id) {
      const ctx = this.playing.get(id);
      if (ctx) ctx.cancelled = true;
    } else {
      for (const ctx of this.playing.values()) ctx.cancelled = true;
    }
  }

  // ---- Enregistreur -------------------------------------------------------
  ensureHook() {
    if (!loadHook()) throw new Error("Module d'écoute globale indisponible : " + (uiohookError && uiohookError.message));
    if (!this._listenersAttached) {
      uiohook.on('keydown', (e) => this.onRecordKey(e, false));
      uiohook.on('keyup', (e) => this.onRecordKey(e, true));
      uiohook.on('mousedown', (e) => this.onRecordMouse(e, 'down'));
      uiohook.on('mouseup', (e) => this.onRecordMouse(e, 'up'));
      uiohook.on('wheel', (e) => this.onRecordWheel(e));
      uiohook.on('mousemove', (e) => this.onRecordMove(e));
      const activity = (e, down) => ({
        key: UIOHOOK_TO_NAME[e.keycode],
        down,
        shift: !!e.shiftKey,
        ctrl: !!e.ctrlKey,
        alt: !!e.altKey,
        meta: !!e.metaKey,
      });
      uiohook.on('keydown', (e) => this.emit('key-activity', activity(e, true)));
      uiohook.on('keyup', (e) => this.emit('key-activity', activity(e, false)));
      uiohook.on('mousedown', () => this.emit('mouse-activity'));
      // Boutons de souris (turbo « tant que maintenu »)
      const BUTTON_NAMES = { 1: 'left', 2: 'right', 3: 'middle', 4: 'x1', 5: 'x2' };
      uiohook.on('mousedown', (e) => this.emit('mouse-button', { button: BUTTON_NAMES[e.button], down: true }));
      uiohook.on('mouseup', (e) => this.emit('mouse-button', { button: BUTTON_NAMES[e.button], down: false }));
      this._listenersAttached = true;
    }
    if (!this.hookStarted) {
      uiohook.start();
      this.hookStarted = true;
    }
  }

  // Démarre l'écoute globale (effet réactif, onde de choc, calibration)
  startActivityFeed() {
    try { this.ensureHook(); return true; } catch { return false; }
  }

  // Coupe l'écoute globale quand plus rien n'en a besoin (économie de ressources)
  stopActivityFeed() {
    if (this.recording || this.waiters > 0 || !this.hookStarted || !uiohook) return;
    try { uiohook.stop(); } catch { /* déjà arrêté */ }
    this.hookStarted = false;
  }

  pushRecordStep(step) {
    const now = Date.now();
    if (this.lastEventTime) {
      const dt = now - this.lastEventTime;
      if (dt > 10) this.recordBuffer.push({ type: 'delay', ms: dt });
    }
    this.lastEventTime = now;
    this.recordBuffer.push(step);
    this.emit('record-event', step);
  }

  onRecordKey(e, up) {
    if (!this.recording) return;
    const name = UIOHOOK_TO_NAME[e.keycode];
    if (!name) return;
    this.pushRecordStep({ type: up ? 'keyUp' : 'keyDown', key: name, gapMs: 0 });
  }

  onRecordMouse(e, dir) {
    if (!this.recording || !this.recordOpts.mouse) return;
    const buttons = { 1: 'left', 2: 'right', 3: 'middle', 4: 'x1', 5: 'x2' };
    const button = buttons[e.button] || 'left';
    // Option « clics à leur position » : le curseur revient à l'endroit
    // du clic enregistré avant d'appuyer
    if (dir === 'down' && this.recordOpts.clickPositions && !this.recordOpts.moves) {
      this.pushRecordStep({ type: 'mouseMove', x: e.x, y: e.y, relative: false, gapMs: 0 });
    }
    this.pushRecordStep({
      type: dir === 'down' ? 'mouseDown' : 'mouseUp',
      button, x: e.x, y: e.y, gapMs: 0,
    });
  }

  onRecordWheel(e) {
    if (!this.recording || !this.recordOpts.mouse) return;
    this.pushRecordStep({
      type: 'mouseWheel',
      delta: (e.rotation || 1) * -120,
      horizontal: e.direction === 4,
      gapMs: 0,
    });
  }

  onRecordMove(e) {
    if (!this.recording || !this.recordOpts.moves) return;
    const now = Date.now();
    if (now - (this._lastMove || 0) < 50) return; // échantillonnage 20 Hz
    this._lastMove = now;
    this.pushRecordStep({ type: 'mouseMove', x: e.x, y: e.y, gapMs: 0 });
  }

  startRecording(opts = {}) {
    this.ensureHook();
    this.recordOpts = {
      mouse: opts.mouse !== false,
      moves: !!opts.moves,
      clickPositions: !!opts.clickPositions,
    };
    this.recordBuffer = [];
    this.lastEventTime = 0;
    this.recording = true;
  }

  stopRecording() {
    this.recording = false;
    let steps = this.recordBuffer;
    this.recordBuffer = [];
    steps = this.compressTaps(steps);
    return steps;
  }

  // Fusionne keyDown+keyUp consécutifs (sans délai notable) en keyTap
  compressTaps(steps) {
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const next = steps[i + 1];
      const nextNext = steps[i + 2];
      if (
        s.type === 'keyDown' && next && nextNext &&
        next.type === 'delay' && next.ms < 250 &&
        nextNext.type === 'keyUp' && nextNext.key === s.key
      ) {
        out.push({ type: 'keyTap', key: s.key, gapMs: 0 });
        i += 2;
      } else if (s.type === 'keyDown' && next && next.type === 'keyUp' && next.key === s.key) {
        out.push({ type: 'keyTap', key: s.key, gapMs: 0 });
        i += 1;
      } else {
        out.push(s);
      }
    }
    return out;
  }

  dispose() {
    this.stop();
    if (this.hookStarted && uiohook) {
      try { uiohook.stop(); } catch { /* ignore */ }
    }
  }
}

module.exports = { MacroEngine, toAccelerator, hookAvailable };
