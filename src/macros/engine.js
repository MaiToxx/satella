// Moteur de macros : déclencheurs globaux, lecture asynchrone annulable,
// enregistreur d'événements clavier/souris (uiohook).

const { EventEmitter } = require('events');
const input = require('./input');
const { UIOHOOK_TO_NAME, toAccelerator } = require('./keys');

let uiohook = null;
let uiohookError = null;
try {
  uiohook = require('uiohook-napi').uIOhook;
} catch (err) {
  uiohookError = err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MacroEngine extends EventEmitter {
  constructor({ globalShortcut }) {
    super();
    this.globalShortcut = globalShortcut;
    this.macros = [];
    this.playing = new Map(); // id -> {cancelled}
    this.recording = false;
    this.recordBuffer = [];
    this.recordOpts = { mouse: true, moves: false };
    this.lastEventTime = 0;
    this.hookStarted = false;
    this.suppressRecord = false;
  }

  // ---- Déclencheurs -------------------------------------------------------
  setMacros(macros) {
    this.macros = macros || [];
    this.registerTriggers();
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
          else this.play(macro.id);
        });
        if (!ok) errors.push({ id: macro.id, accelerator: macro.trigger.accelerator });
      } catch (err) {
        errors.push({ id: macro.id, accelerator: macro.trigger.accelerator, error: err.message });
      }
    }
    return errors;
  }

  // ---- Lecture ------------------------------------------------------------
  async play(id) {
    const macro = this.macros.find((m) => m.id === id);
    if (!macro) throw new Error('Macro introuvable');
    if (!input.available) throw new Error("Injection d'entrées indisponible : " + (input.loadError && input.loadError.message));
    if (this.playing.has(id)) return;

    const ctx = { cancelled: false };
    this.playing.set(id, ctx);
    this.emit('play-state', { id, playing: true });

    const opts = macro.options || {};
    const speed = Math.max(0.1, Math.min(10, opts.speed || 1));
    const repeat = opts.loopInfinite ? Infinity : Math.max(1, opts.repeat || 1);

    try {
      for (let i = 0; i < repeat && !ctx.cancelled; i++) {
        await this.runSteps(macro.steps || [], ctx, speed);
        if (opts.repeatDelayMs && i < repeat - 1 && !ctx.cancelled) {
          await this.cancellableSleep(opts.repeatDelayMs / speed, ctx);
        }
      }
    } catch (err) {
      this.emit('play-error', { id, message: err.message });
    } finally {
      this.playing.delete(id);
      this.emit('play-state', { id, playing: false });
    }
  }

  async cancellableSleep(ms, ctx) {
    const step = 50;
    let left = ms;
    while (left > 0 && !ctx.cancelled) {
      await sleep(Math.min(step, left));
      left -= step;
    }
  }

  async runSteps(steps, ctx, speed) {
    for (const step of steps) {
      if (ctx.cancelled) return;
      switch (step.type) {
        case 'keyDown': input.keyDown(step.key); break;
        case 'keyUp': input.keyUp(step.key); break;
        case 'keyTap':
          input.keyTap(step.key, step.modifiers || []);
          break;
        case 'text': input.typeText(step.value || ''); break;
        case 'delay': await this.cancellableSleep((step.ms || 0) / speed, ctx); break;
        case 'mouseDown': input.mouseButton(step.button || 'left', false); break;
        case 'mouseUp': input.mouseButton(step.button || 'left', true); break;
        case 'mouseClick': input.mouseClick(step.button || 'left', step.count || 1); break;
        case 'mouseMove': input.mouseMove(step.x || 0, step.y || 0, !!step.relative); break;
        case 'mouseWheel': input.mouseWheel(step.delta || 120, !!step.horizontal); break;
        case 'loop': {
          const count = Math.max(1, step.count || 1);
          for (let i = 0; i < count && !ctx.cancelled; i++) {
            await this.runSteps(step.steps || [], ctx, speed);
          }
          break;
        }
        case 'runMacro': {
          const sub = this.macros.find((m) => m.id === step.macroId);
          if (sub && sub.id !== step.parentGuard) {
            await this.runSteps(sub.steps || [], ctx, speed);
          }
          break;
        }
        default: break;
      }
      // Petit délai par défaut entre les étapes pour la fiabilité
      if (step.type !== 'delay' && !ctx.cancelled) {
        await sleep(Math.max(2, (step.gapMs !== undefined ? step.gapMs : 15) / speed));
      }
    }
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
    if (!uiohook) throw new Error("Module d'écoute globale indisponible : " + (uiohookError && uiohookError.message));
    if (this.hookStarted) return;

    uiohook.on('keydown', (e) => this.onRecordKey(e, false));
    uiohook.on('keyup', (e) => this.onRecordKey(e, true));
    uiohook.on('mousedown', (e) => this.onRecordMouse(e, 'down'));
    uiohook.on('mouseup', (e) => this.onRecordMouse(e, 'up'));
    uiohook.on('wheel', (e) => this.onRecordWheel(e));
    uiohook.on('mousemove', (e) => this.onRecordMove(e));
    uiohook.on('keydown', (e) => this.emit('key-activity', { key: UIOHOOK_TO_NAME[e.keycode], down: true }));
    uiohook.on('keyup', (e) => this.emit('key-activity', { key: UIOHOOK_TO_NAME[e.keycode], down: false }));
    uiohook.start();
    this.hookStarted = true;
  }

  // Démarre l'écoute globale même sans enregistrement (pour l'effet réactif)
  startActivityFeed() {
    try { this.ensureHook(); return true; } catch { return false; }
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
    this.pushRecordStep({
      type: dir === 'down' ? 'mouseDown' : 'mouseUp',
      button, x: e.x, y: e.y, gapMs: 0,
    });
  }

  onRecordWheel(e) {
    if (!this.recording || !this.recordOpts.mouse) return;
    this.pushRecordStep({ type: 'mouseWheel', delta: (e.rotation || 1) * -120, gapMs: 0 });
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
    this.recordOpts = { mouse: opts.mouse !== false, moves: !!opts.moves };
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

module.exports = { MacroEngine, toAccelerator, uiohookAvailable: !!uiohook };
