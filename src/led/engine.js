// Moteur d'effets lumineux : calcule ~30 images/s les couleurs de chaque
// touche/zone selon l'effet actif, diffuse aux backends (OpenRGB) et à
// l'interface (aperçu temps réel).

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

const DEFAULT_DEVICE_STATE = () => ({
  effect: 'static',        // static | breathing | wave | rainbow | reactive | sparkle | off
  baseColor: '#00a8ff',
  color2: '#ff00d4',
  speed: 50,               // 0..100
  brightness: 100,         // 0..100
  direction: 'lr',         // lr | rl | tb | bt
  colors: {},              // couleurs personnalisées par touche/zone (mode static)
});

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

  loadState(saved) {
    if (saved && saved.keyboard) Object.assign(this.state.keyboard, saved.keyboard);
    if (saved && saved.mouse) Object.assign(this.state.mouse, saved.mouse);
    this.emit('state', this.state);
    this.renderOnce();
  }

  // Appelé par l'écoute clavier globale (effets réactif et onde de choc)
  keyActivity(keyId) {
    this.reactiveKeys.set(keyId, 1);
    if (this.state.keyboard.effect === 'ripple') {
      const k = layout.keyboard.find((x) => x.id === keyId);
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
      'ripple', 'fire', 'rain', 'scanner', 'spiral', 'disco', 'gradient'].includes(effect);
  }

  tick() {
    this.t += 1 / FPS;
    const kbAnim = this.isAnimated(this.state.keyboard.effect);
    const msAnim = this.isAnimated(this.state.mouse.effect);
    if (!kbAnim && !msAnim) return; // statique : rien à recalculer
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
        default:
          rgb = base;
      }
      out[key.id] = scale(rgb, bright);
    }

    // Nettoyage des ondes et gouttes expirées
    this.ripples = this.ripples.filter((rp) => this.t - rp.t0 < 2.5);
    this.drops = this.drops.filter((dr) => (this.t - dr.t0) * dr.v < layout.bounds.h + 4);

    // Décroissance des effets réactif/étincelles
    for (const [k, v] of this.reactiveKeys) {
      const nv = v - 0.04 * (0.5 + speed);
      if (nv <= 0) this.reactiveKeys.delete(k); else this.reactiveKeys.set(k, nv);
    }
    for (const [k, v] of this.sparkles) {
      const nv = v - 0.03 * (0.5 + speed);
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

module.exports = { LedEngine, hexToRgb };
