// Moteur d'effets lumineux : calcule ~30 images/s les couleurs de chaque
// touche/zone selon l'effet actif, pour le flux temps réel vers le clavier
// (effets logiciels) et l'aperçu de l'interface.

const { EventEmitter } = require('events');
const layout = require('../shared/layout');

const FPS = 30;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function scale(rgb, f) {
  return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
}

function lerpRgb(a, b, f) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Pseudo-bruit continu (pour le feu)
function fnoise(x, t) {
  return clamp01(
    (Math.sin(x * 1.7 + t * 3.1) + Math.sin(x * 2.9 - t * 2.3) + Math.sin(x * 0.9 + t * 4.7)) / 6 + 0.5
  );
}

// Palette de feu : noir -> rouge -> orange -> jaune
function firePalette(v) {
  v = clamp01(v);
  return [
    Math.round(clamp01(v * 2.5) * 255),
    Math.round(clamp01(v * 2 - 0.7) * 255),
    Math.round(clamp01(v * 4 - 3.2) * 255),
  ];
}

// Hachage stable pour l'effet disco
function hashKey(id, seed) {
  let h = seed * 374761393;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Couleur d'un segment de jauge : vert -> jaune -> rouge
function gaugeColor(f) {
  return hsvToRgb(120 - 120 * clamp01(f), 1, 1);
}

const AUDIO_BANDS = 16;

// Ambiance écran : l'écran est découpé en une grille de couleurs moyennes,
// projetée sur le clavier (colonnes et rangées)
const SCREEN_COLS = 20;
const SCREEN_ROWS = 6;

const DEFAULT_DEVICE_STATE = () => ({
  effect: 'static',        // static | breathing | wave | rainbow | reactive | sparkle | off | effets logiciels
  baseColor: '#00a8ff',
  color2: '#ff00d4',
  speed: 50,               // 0..100
  brightness: 100,         // 0..100
  direction: 'lr',         // lr | rl | tb | bt
  colors: {},              // couleurs personnalisées par touche/zone (mode static)
  overlay: {},             // calque : touches fixes par-dessus n'importe quel effet
});

// Rangées utilisées par la jauge système
const SYSMON_CPU_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
const SYSMON_RAM_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'minus', 'equal'];

class LedEngine extends EventEmitter {
  constructor() {
    super();
    this.state = { keyboard: DEFAULT_DEVICE_STATE(), mouse: DEFAULT_DEVICE_STATE() };
    this.t = 0;
    this.timer = null;
    this.reactiveKeys = new Map(); // keyId -> intensité 0..1
    this.sparkles = new Map();
    this.ripples = [];             // ondes de choc {x, y, t0}
    this.drops = [];               // gouttes de pluie {x, t0, v}
    this.stats = { cpu: 0, ram: 0 };                // jauge système (0..1)
    this.audio = new Array(AUDIO_BANDS).fill(0);    // spectre lissé (0..1)
    this.audioTarget = new Array(AUDIO_BANDS).fill(0);
    this.screen = new Float32Array(SCREEN_COLS * SCREEN_ROWS * 3);       // couleurs lissées
    this.screenTarget = new Uint8Array(SCREEN_COLS * SCREEN_ROWS * 3);   // dernière capture
    this.flashState = null;        // { rgb, t0, ms }
    this.keyIndex = new Map(layout.keyboard.map((k) => [k.id, k]));
    // Consommateurs d'images : sans aperçu visible ni flux vers le
    // clavier, inutile de calculer 30 images/s (remplacé par main.js)
    this.wantFrames = () => true;
    this._frameCount = 0;
    this.start();
  }

  setDeviceState(device, patch) {
    const st = this.state[device];
    if (!st) return;
    Object.assign(st, patch);
    this.emit('state', this.state);
    this.renderOnce();
  }

  // Calque de touches fixes (clavier) : s'affiche par-dessus l'effet
  setOverlay(device, colorMap) {
    const st = this.state[device];
    if (!st) return;
    st.overlay = { ...(st.overlay || {}), ...colorMap };
    this.emit('state', this.state);
    this.renderOnce();
  }

  removeOverlay(device, ids) {
    const st = this.state[device];
    if (!st) return;
    const next = { ...(st.overlay || {}) };
    for (const id of ids || Object.keys(next)) delete next[id];
    st.overlay = next;
    this.emit('state', this.state);
    this.renderOnce();
  }

  setSystemStats(stats) {
    this.stats = { cpu: clamp01(stats.cpu || 0), ram: clamp01(stats.ram || 0) };
  }

  setAudioBands(bands) {
    if (!Array.isArray(bands)) return;
    for (let i = 0; i < AUDIO_BANDS; i++) this.audioTarget[i] = clamp01(Number(bands[i]) || 0);
  }

  // Grille de couleurs de l'écran : SCREEN_ROWS x SCREEN_COLS x [r, g, b]
  setScreenGrid(grid) {
    if (!grid || typeof grid.length !== 'number') return;
    const n = Math.min(grid.length, this.screenTarget.length);
    for (let i = 0; i < n; i++) this.screenTarget[i] = Math.max(0, Math.min(255, Number(grid[i]) || 0));
  }

  // Flash bref de tout le clavier (retour visuel des macros)
  flash(rgb, ms = 350) {
    this.flashState = { rgb, t0: Date.now(), ms };
    this.renderOnce();
  }

  flashLevel() {
    if (!this.flashState) return 0;
    const age = Date.now() - this.flashState.t0;
    if (age >= this.flashState.ms) return 0;
    return 1 - age / this.flashState.ms;
  }

  setKeys(device, colorMap) {
    const st = this.state[device];
    if (!st) return;
    Object.assign(st.colors, colorMap);
    st.effect = 'static';
    this.emit('state', this.state);
    this.renderOnce();
  }

  clearKeys(device) {
    const st = this.state[device];
    if (!st) return;
    st.colors = {};
    this.emit('state', this.state);
    this.renderOnce();
  }

  // Les champs absents d'un état sauvegardé (anciennes versions) repartent
  // des valeurs par défaut au lieu de garder ceux de l'état précédent.
  loadState(saved) {
    if (saved && saved.keyboard) Object.assign(this.state.keyboard, DEFAULT_DEVICE_STATE(), saved.keyboard);
    if (saved && saved.mouse) Object.assign(this.state.mouse, DEFAULT_DEVICE_STATE(), saved.mouse);
    this.emit('state', this.state);
    this.renderOnce();
  }

  // Appelé par l'écoute clavier globale (effets réactif et onde de choc)
  keyActivity(keyId) {
    this.reactiveKeys.set(keyId, 1);
    if (this.state.keyboard.effect === 'ripple') {
      const k = this.keyIndex.get(keyId);
      if (k) {
        this.ripples.push({ x: k.x + k.w / 2, y: k.y + k.h / 2, t0: this.t });
        if (this.ripples.length > 12) this.ripples.shift();
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / FPS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  isAnimated(effect) {
    return ['breathing', 'wave', 'rainbow', 'reactive', 'sparkle',
      'ripple', 'fire', 'rain', 'scanner', 'spiral', 'disco', 'gradient',
      'sysmon', 'audio', 'screen'].includes(effect);
  }

  tick() {
    // Temps réel mesuré : si une image saute, l'animation garde sa vitesse
    // au lieu de ralentir (fluidité indépendante de la cadence effective).
    const now = Date.now();
    const dt = this._lastTick ? Math.min(0.1, (now - this._lastTick) / 1000) : 1 / FPS;
    this._lastTick = now;
    this.dt = dt;
    const kbAnim = this.isAnimated(this.state.keyboard.effect);
    const msAnim = this.isAnimated(this.state.mouse.effect);
    // Un flash en cours (ou qui vient de finir) doit être dessiné puis effacé
    const flashing = this.flashState && now - this.flashState.t0 < this.flashState.ms + 100;
    if (!flashing) this.flashState = null;
    if (!kbAnim && !msAnim && !flashing) return; // statique : rien à recalculer
    this.t += dt;
    if (!this.wantFrames() && !flashing) return; // personne ne regarde
    this.renderOnce();
  }

  renderOnce() {
    const frame = {
      keyboard: this.computeKeyboard(),
      mouse: this.computeMouse(),
    };
    this.emit('frame', frame);
  }

  computeKeyboard() {
    const st = this.state.keyboard;
    const bright = st.brightness / 100;
    const speed = 0.2 + (st.speed / 100) * 2.3;
    const base = hexToRgb(st.baseColor);
    const color2 = hexToRgb(st.color2 || '#ff00d4');
    const out = {};

    // Temps réel écoulé depuis le dernier calcul : les décroissances ne
    // dépendent pas de la cadence d'images
    const nowMs = Date.now();
    const elapsed = this._lastCompute ? Math.min(0.1, (nowMs - this._lastCompute) / 1000) : 1 / FPS;
    this._lastCompute = nowMs;

    // Spectre audio : montée immédiate, retombée progressive
    if (st.effect === 'audio') {
      for (let i = 0; i < AUDIO_BANDS; i++) {
        const target = this.audioTarget[i];
        this.audio[i] = target >= this.audio[i] ? target : Math.max(target, this.audio[i] - 1.6 * elapsed);
      }
    }

    // Ambiance écran : transition douce vers la dernière capture (la vitesse
    // règle la réactivité)
    if (st.effect === 'screen') {
      const k = Math.min(1, elapsed * (2 + speed * 8));
      for (let i = 0; i < this.screen.length; i++) {
        this.screen[i] += (this.screenTarget[i] - this.screen[i]) * k;
      }
    }

    // Apparition des gouttes (effet pluie)
    if (st.effect === 'rain' && Math.random() < 0.05 * (0.5 + speed * 1.5)) {
      this.drops.push({ x: Math.random() * layout.bounds.w, t0: this.t, v: 2.5 + speed * 3 });
      if (this.drops.length > 24) this.drops.shift();
    }

    for (const key of layout.keyboard) {
      let rgb = [0, 0, 0];
      switch (st.effect) {
        case 'off': break;
        case 'static':
          rgb = st.colors[key.id] ? hexToRgb(st.colors[key.id]) : base;
          break;
        case 'breathing': {
          const f = (Math.sin(this.t * speed * 2 * Math.PI * 0.35) + 1) / 2;
          rgb = scale(st.colors[key.id] ? hexToRgb(st.colors[key.id]) : base, 0.08 + 0.92 * f);
          break;
        }
        case 'wave': {
          let pos;
          switch (st.direction) {
            case 'rl': pos = 1 - key.x / layout.bounds.w; break;
            case 'tb': pos = key.y / layout.bounds.h; break;
            case 'bt': pos = 1 - key.y / layout.bounds.h; break;
            default: pos = key.x / layout.bounds.w;
          }
          rgb = hsvToRgb((pos * 360 + this.t * speed * 120) % 360, 1, 1);
          break;
        }
        case 'rainbow':
          rgb = hsvToRgb((this.t * speed * 60) % 360, 1, 1);
          break;
        case 'reactive': {
          const glow = this.reactiveKeys.get(key.id) || 0;
          rgb = scale(base, glow);
          break;
        }
        case 'sparkle': {
          if (Math.random() < 0.002 * speed * 3) this.sparkles.set(key.id, 1);
          const s = this.sparkles.get(key.id) || 0;
          rgb = scale(base, s);
          break;
        }
        case 'ripple': {
          // Onde de choc : anneaux qui se propagent depuis chaque frappe
          const cx = key.x + key.w / 2, cy = key.y + key.h / 2;
          let inten = 0;
          for (const rp of this.ripples) {
            const age = this.t - rp.t0;
            const ringR = age * (4 + speed * 7);
            const d = Math.hypot(cx - rp.x, cy - rp.y);
            const band = Math.exp(-((d - ringR) ** 2) / 0.6);
            const fade = Math.max(0, 1 - age * 0.5);
            inten = Math.max(inten, band * fade);
          }
          rgb = scale(base, Math.min(1, inten));
          break;
        }
        case 'fire': {
          const depth = key.y / layout.bounds.h;             // 0 haut, 1 bas
          const n = fnoise(key.x * 0.45, this.t * (1 + speed));
          rgb = firePalette(depth * 0.85 + n * 0.6 - 0.3);
          break;
        }
        case 'rain': {
          const cx = key.x + key.w / 2, cy = key.y + key.h / 2;
          let inten = 0;
          for (const dr of this.drops) {
            if (Math.abs(cx - dr.x) > 0.7) continue;
            const headY = (this.t - dr.t0) * dr.v;
            const dy = headY - cy;
            if (dy >= -0.3 && dy < 3) inten = Math.max(inten, dy < 0.6 ? 1 : 1 - dy / 3);
          }
          rgb = scale(base, inten);
          break;
        }
        case 'scanner': {
          const w = layout.bounds.w;
          const p = (this.t * (2 + speed * 5)) % (2 * w);
          const barX = p < w ? p : 2 * w - p;
          const cx = key.x + key.w / 2;
          rgb = scale(base, Math.exp(-((cx - barX) ** 2) / 1.1));
          break;
        }
        case 'spiral': {
          const cx = layout.bounds.w / 2, cy = layout.bounds.h / 2;
          const ang = Math.atan2(key.y + key.h / 2 - cy, (key.x + key.w / 2 - cx) * 0.45);
          rgb = hsvToRgb((ang / (2 * Math.PI)) * 360 + this.t * speed * 160, 1, 1);
          break;
        }
        case 'disco': {
          const seed = Math.floor(this.t * (0.8 + speed * 2.5));
          const h = hashKey(key.id, seed);
          rgb = (h % 100 < 42) ? hsvToRgb(h % 360, 1, 1) : [0, 0, 0];
          break;
        }
        case 'gradient': {
          const p = (key.x + key.w / 2) / layout.bounds.w;
          const f = (Math.sin((p - this.t * speed * 0.35) * Math.PI * 2) + 1) / 2;
          rgb = lerpRgb(base, color2, f);
          break;
        }
        case 'sysmon': {
          // Jauge système : F1-F12 = processeur, 1 à = = mémoire vive
          const cpuIdx = SYSMON_CPU_KEYS.indexOf(key.id);
          const ramIdx = SYSMON_RAM_KEYS.indexOf(key.id);
          const idx = cpuIdx >= 0 ? cpuIdx : ramIdx;
          if (idx >= 0) {
            const value = cpuIdx >= 0 ? this.stats.cpu : this.stats.ram;
            const n = SYSMON_CPU_KEYS.length;
            const lit = clamp01(value * n - idx); // remplissage partiel du dernier segment
            rgb = scale(gaugeColor(idx / (n - 1)), 0.06 + 0.94 * lit);
          } else {
            rgb = scale(base, 0.25);
          }
          break;
        }
        case 'audio': {
          // Visualiseur : une colonne de touches par bande de fréquence,
          // remplie depuis le bas selon le niveau
          const cx = key.x + key.w / 2, cy = key.y + key.h / 2;
          const band = Math.min(AUDIO_BANDS - 1, Math.floor((cx / layout.bounds.w) * AUDIO_BANDS));
          const height = (layout.bounds.h - cy) / layout.bounds.h; // 0 bas .. 1 haut
          const level = this.audio[band];
          rgb = level >= height ? lerpRgb(base, color2, height) : scale(base, 0.04);
          break;
        }
        case 'screen': {
          const cx = key.x + key.w / 2, cy = key.y + key.h / 2;
          const col = Math.min(SCREEN_COLS - 1, Math.floor((cx / layout.bounds.w) * SCREEN_COLS));
          const row = Math.min(SCREEN_ROWS - 1, Math.floor((cy / layout.bounds.h) * SCREEN_ROWS));
          const i = (row * SCREEN_COLS + col) * 3;
          rgb = [Math.round(this.screen[i]), Math.round(this.screen[i + 1]), Math.round(this.screen[i + 2])];
          break;
        }
        default:
          rgb = base;
      }
      // Calque : touches fixes par-dessus l'effet (sauf « éteint »)
      if (st.overlay && st.overlay[key.id] && st.effect !== 'off') rgb = hexToRgb(st.overlay[key.id]);
      out[key.id] = scale(rgb, bright);
    }

    // Flash bref (retour visuel des macros) par-dessus tout le reste
    const fl = this.flashLevel();
    if (fl > 0) {
      for (const id of Object.keys(out)) out[id] = lerpRgb(out[id], this.flashState.rgb, fl);
    }

    // Nettoyage des ondes et gouttes expirées
    this.ripples = this.ripples.filter((rp) => this.t - rp.t0 < 2.5);
    this.drops = this.drops.filter((dr) => (this.t - dr.t0) * dr.v < layout.bounds.h + 4);

    // Décroissance des effets réactif/étincelles (mêmes vitesses qu'avant
    // à 30 img/s, mais indexées sur le temps réel)
    for (const [k, v] of this.reactiveKeys) {
      const nv = v - 1.2 * (0.5 + speed) * elapsed;
      if (nv <= 0) this.reactiveKeys.delete(k); else this.reactiveKeys.set(k, nv);
    }
    for (const [k, v] of this.sparkles) {
      const nv = v - 0.9 * (0.5 + speed) * elapsed;
      if (nv <= 0) this.sparkles.delete(k); else this.sparkles.set(k, nv);
    }
    return out;
  }

  computeMouse() {
    const st = this.state.mouse;
    const bright = st.brightness / 100;
    const speed = 0.2 + (st.speed / 100) * 2.3;
    const base = hexToRgb(st.baseColor);
    const out = {};

    layout.mouse.forEach((zone, i) => {
      let rgb = [0, 0, 0];
      switch (st.effect) {
        case 'off': break;
        case 'static':
          rgb = st.colors[zone.id] ? hexToRgb(st.colors[zone.id]) : base;
          break;
        case 'breathing': {
          const f = (Math.sin(this.t * speed * 2 * Math.PI * 0.35) + 1) / 2;
          rgb = scale(st.colors[zone.id] ? hexToRgb(st.colors[zone.id]) : base, 0.08 + 0.92 * f);
          break;
        }
        case 'wave':
          rgb = hsvToRgb((i / layout.mouse.length) * 360 + this.t * speed * 120, 1, 1);
          break;
        case 'rainbow':
          rgb = hsvToRgb((this.t * speed * 60) % 360, 1, 1);
          break;
        case 'sparkle': {
          if (Math.random() < 0.01 * speed) this.sparkles.set('m_' + zone.id, 1);
          rgb = scale(base, this.sparkles.get('m_' + zone.id) || 0);
          break;
        }
        default:
          rgb = base;
      }
      out[zone.id] = scale(rgb, bright);
    });
    return out;
  }
}

module.exports = { LedEngine, hexToRgb, DEFAULT_DEVICE_STATE, AUDIO_BANDS, SCREEN_COLS, SCREEN_ROWS };
