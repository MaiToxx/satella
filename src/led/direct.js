// Pilote USB direct, sans logiciel tiers.
//
// Clavier SURMEN GS98 : puce EVision GENERATION 2 (VID 0x320F, PID 0x505B).
//   Vérifié sur le matériel le 2026-08-31 : la lecture des capacités (cmd 0x03)
//   renvoie la signature AA 55 ; les commandes V1 sont ignorées (écho + erreur).
//   Trame : 64 octets [0x04, chkLo, chkHi, cmd, taille, offLo, offHi, 0, données...],
//   somme de contrôle NON signée sur les octets 3..63. La réponse reprend la
//   même trame avec un code d'erreur à l'octet 7 (0 = succès).
//   Les couleurs par touche s'écrivent en « jeux de couleurs » (colorsets) de
//   3 x map_size octets, rangés en colonnes de 6 emplacements.
//
// Souris Risophy PC365A : puce Areson (VID 0x25A7, PID 0xFA7B).
//   Rapport « feature » de 17 octets (report ID 0x08), couleur unique,
//   7 modes matériels, checksum = 0x55 - somme des octets 6..11.
//
// Protocoles documentés par la communauté OpenRGB (GPL) ; implémentation
// indépendante pour Satella.

const { EventEmitter } = require('events');
const path = require('path');
const { Worker } = require('worker_threads');

let HID = null;
let hidError = null;
try {
  HID = require('node-hid');
} catch (err) {
  hidError = err;
}

// ---------------------------------------------------------------- Clavier --
const KB_VID = 0x320f;
const KB_PID = 0x505b;
const KB_USAGE_PAGE = 0xff1c;

// Commandes V2
const KB_CMD_BEGIN = 0x01;
const KB_CMD_END = 0x02;
const KB_CMD_READ_CAPS = 0x03;
const KB_CMD_READ_CONFIG = 0x05;
const KB_CMD_WRITE_CONFIG = 0x06;
const KB_CMD_WRITE_CUSTOM = 0x0b;
const KB_CMD_DYNAMIC = 0x12;
const KB_CMD_DYNAMIC_END = 0x13;

const KB_OFFSET_CURRENT_PROFILE = 0x00;
const KB_OFFSET_FIRST_PROFILE = 0x01;
const KB_PARAM_CUSTOM_COLORSET = 0x19;

const KB_MODES = {
  colorWaveShort: 0x01, colorWave: 0x02, colorWheel: 0x03, spectrumCycle: 0x04,
  breathing: 0x05, static: 0x06, reactive: 0x07, reactiveRipple: 0x08,
  reactiveLine: 0x09, starlightFast: 0x0a, blooming: 0x0b, rainbowVertical: 0x0c,
  hurricane: 0x0d, accumulate: 0x0e, starlightSlow: 0x0f, visor: 0x10,
  rainbowCircle: 0x12, custom: 0x14,
};

// Effets logiciels : calculés par le moteur de Satella et diffusés en continu
// vers le clavier via le mode dynamique (aucune écriture en flash).
const SOFT_EFFECTS = new Set(['ripple', 'fire', 'rain', 'scanner', 'spiral', 'disco', 'gradient']);

// Carte V2 : id de touche Satella -> emplacement dans le tampon de couleurs.
// Cette carte a été CALIBRÉE sur le vrai SURMEN GS98 le 2026-08-31
// (assistant de calibration de Satella : une touche allumée à la fois,
// appui de l'utilisateur, 91 touches associées). Elle sert de carte par
// défaut ; une recalibration dans l'app la remplace pour l'utilisateur.
const KB_LED_MAP = {
  esc: 0, quote: 1, tab: 2, capslock: 3, lshift: 4, numlock: 6,
  f1: 8, 1: 9, a: 10, q: 11, lwin: 13, npdivide: 14,
  f2: 16, 2: 17, z: 18, s: 19, w: 20, lalt: 21, npmultiply: 22,
  f3: 24, 3: 25, e: 26, d: 27, x: 28, npsubtract: 30,
  f4: 32, 4: 33, r: 34, f: 35, c: 36, np7: 38,
  f5: 40, 5: 41, t: 42, g: 43, v: 44, space: 45, np8: 46,
  f6: 48, 6: 49, y: 50, h: 51, b: 52, np9: 54,
  f7: 56, 7: 57, u: 58, j: 59, n: 60, np4: 62,
  f8: 64, 8: 65, i: 66, k: 67, comma: 68, np5: 70,
  f9: 72, 9: 73, o: 74, l: 75, period: 76, np6: 78,
  f10: 80, 0: 81, p: 82, m: 83, lctrl: 85, npadd: 86,
  f11: 88, lbracket: 89, rbracket: 90, grave: 91, slash: 92, np2: 94,
  f12: 96, equal: 97, semicolon: 98, rctrl: 101, np3: 102,
  backspace: 105, backslash: 106, enter: 107, rshift: 108, left: 109, np0: 110,
  delete: 114, pageup: 115, up: 116, down: 117, npdecimal: 118,
  pagedown: 123, np1: 124, right: 125, npenter: 126,
};

// ----------------------------------------------------------------- Souris --
const MOUSE_VID = 0x25a7;
const MOUSE_PIDS = [0xfa7b, 0xfa7c]; // filaire / sans fil
const MOUSE_USAGE_PAGE = 0xff02;
const MOUSE_USAGE = 0x02;

const MOUSE_MODES = {
  rainbowWave: 0x00, breathing: 0x01, static: 0x02, spectrumCycle: 0x03,
  off: 0x04, singleColorWave: 0x05, breathingColorful: 0x07,
};
// Vitesse 1-10 -> valeur matérielle (modes lents / mode vague arc-en-ciel)
const MOUSE_SPEED_HIGH = [0xff, 0xe6, 0xd2, 0xbe, 0xaa, 0x96, 0x82, 0x6e, 0x46, 0x28];
const MOUSE_SPEED_LOW = [0x2d, 0x28, 0x23, 0x1e, 0x19, 0x13, 0x0f, 0x0a, 0x05, 0x03];
const MOUSE_BRIGHTNESS = [0x19, 0x32, 0x4b, 0x64, 0x7d, 0x96, 0xaf, 0xc8, 0xe1, 0xff];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class DirectBackend extends EventEmitter {
  constructor() {
    super();
    this.kb = null;          // handle HID clavier
    this.mouse = null;       // handle HID souris
    this.keyMap = { ...KB_LED_MAP }; // remplaçable par une carte calibrée
    this.kbInfo = null;
    this.mouseInfo = null;
    this._kbTimer = null;
    this._mouseTimer = null;
    this._lastKbSig = '';
    this._lastMouseSig = '';
  }

  get available() { return !!HID; }

  status() {
    return {
      available: this.available,
      error: hidError ? hidError.message : null,
      keyboard: this.kb ? { name: 'SURMEN GS98 (EVision)', path: this.kbInfo.path } : null,
      mouse: this.mouse ? { name: 'Risophy PC365A (Areson)', path: this.mouseInfo.path } : null,
    };
  }

  detect() {
    if (!HID) return this.status();
    let devices = [];
    try { devices = HID.devices(); } catch { return this.status(); }

    if (!this.kb) {
      // La bonne interface est STRICTEMENT celle de la page d'usage 0xFF1C :
      // le clavier expose aussi des collections clavier/souris standard sur
      // l'interface 1, qui n'acceptent pas les commandes RGB.
      const candidates = devices.filter((d) => d.vendorId === KB_VID && d.productId === KB_PID);
      const info = candidates.find((d) => d.usagePage === KB_USAGE_PAGE)
        || candidates.find((d) => d.usagePage === undefined && d.interface === 1);
      if (info) {
        try {
          this.kb = new HID.HID(info.path);
          this.kbInfo = info;
          this.kb.on('error', () => this.dropKeyboard());
          this.kbProbe(); // signature V2 + taille du tampon
        } catch (err) {
          this.dropKeyboard();
          this.emit('log', 'Clavier détecté mais initialisation impossible : ' + err.message);
        }
      }
    }

    if (!this.mouse) {
      // Idem : ne retenir que la collection 0xFF02 (usage 2 si disponible).
      const candidates = devices.filter((d) => d.vendorId === MOUSE_VID && MOUSE_PIDS.includes(d.productId));
      const info = candidates.find((d) => d.usagePage === MOUSE_USAGE_PAGE && d.usage === MOUSE_USAGE)
        || candidates.find((d) => d.usagePage === MOUSE_USAGE_PAGE)
        || candidates.find((d) => d.usagePage === undefined && d.interface === 1);
      if (info) {
        try {
          this.mouse = new HID.HID(info.path);
          this.mouseInfo = info;
          this.mouse.on('error', () => this.dropMouse());
        } catch (err) {
          this.mouse = null;
          this.emit('log', 'Souris détectée mais ouverture impossible : ' + err.message);
        }
      }
    }

    this.emit('status', this.status());
    return this.status();
  }

  dropKeyboard() {
    this.stopWorker();
    try { if (this.kb) this.kb.close(); } catch { /* ignore */ }
    this.kb = null;
    this.kbStreaming = false;
    this.emit('status', this.status());
  }

  dropMouse() {
    try { if (this.mouse) this.mouse.close(); } catch { /* ignore */ }
    this.mouse = null;
    this.emit('status', this.status());
  }

  // ---- Bas niveau clavier (protocole EVision V2) --------------------------
  // Une requête = un paquet de 64 octets, une réponse avec code d'erreur.
  kbQuery(cmd, offset = 0, size = 0, idata = null, waitReply = true) {
    const buf = new Array(64).fill(0);
    buf[0] = 0x04;
    buf[3] = cmd;
    buf[4] = size;
    buf[5] = offset & 0xff;
    buf[6] = (offset >> 8) & 0xff;
    if (idata) idata.forEach((v, i) => { buf[8 + i] = v & 0xff; });
    let sum = 0;
    for (let i = 3; i < 64; i++) sum = (sum + buf[i]) & 0xffff;
    buf[1] = sum & 0xff;
    buf[2] = sum >> 8;
    if (waitReply) this.kbDrain(); // évite de lire une réponse d'un envoi sans attente
    this.kb.write(Buffer.from(buf));
    if (!waitReply) return null;
    let resp = [];
    try { resp = this.kb.readTimeout(400); } catch { /* pas de réponse */ }
    if (!resp.length) throw new Error(`clavier muet (commande 0x${cmd.toString(16)})`);
    if (resp[7] !== 0) throw new Error(`clavier : erreur ${resp[7]} (commande 0x${cmd.toString(16)})`);
    return resp.slice(8, 8 + (resp[4] || 0));
  }

  // Vide les réponses en attente (accumulées par les envois sans attente)
  kbDrain() {
    try {
      for (let i = 0; i < 32; i++) {
        const r = this.kb.readTimeout(0);
        if (!r || !r.length) break;
      }
    } catch { /* rien à vider */ }
  }

  // Lecture/écriture par blocs de 56 octets
  kbRead(cmd, offset, size) {
    const out = [];
    while (size > 0) {
      const chunk = Math.min(size, 56);
      const data = this.kbQuery(cmd, offset, chunk);
      out.push(...data);
      offset += data.length || chunk;
      size -= data.length || chunk;
    }
    return out;
  }

  kbWrite(cmd, offset, data) {
    for (let i = 0; i < data.length; i += 56) {
      const chunk = data.slice(i, i + 56);
      this.kbQuery(cmd, offset + i, chunk.length, chunk);
    }
  }

  // Vérifie la signature V2 et récupère la taille du tampon de couleurs
  kbProbe() {
    const caps = this.kbRead(KB_CMD_READ_CAPS, 0, 7);
    if (caps[0] !== 0xaa || caps[1] !== 0x55) {
      throw new Error('signature V2 absente (clavier inconnu)');
    }
    this.kbMapSize = caps[5] || 128;
  }

  // Retourne le profil actif (0..2), en le réinitialisant à 0 s'il est invalide
  kbCurrentProfile() {
    let profile = this.kbRead(KB_CMD_READ_CONFIG, KB_OFFSET_CURRENT_PROFILE, 1)[0];
    if (profile > 2) {
      profile = 0;
      this.kbWrite(KB_CMD_WRITE_CONFIG, KB_OFFSET_CURRENT_PROFILE, [0]);
    }
    return profile;
  }

  // Écrit le bloc de configuration (mode, luminosité, vitesse, couleur...)
  kbSetMode(mode, brightness, speed, direction, randomFlag, r, g, b, colorset = 0) {
    this.kbQuery(KB_CMD_BEGIN);
    try {
      const profile = this.kbCurrentProfile();
      const cfg = new Array(18).fill(0);
      cfg[0x00] = mode;
      cfg[0x01] = brightness;      // 0 (éteint) .. 4 (max)
      cfg[0x02] = speed;           // 5 (lent) .. 0 (rapide)
      cfg[0x03] = direction;
      cfg[0x04] = randomFlag ? 255 : 0;
      cfg[0x05] = r; cfg[0x06] = g; cfg[0x07] = b;
      const base = profile * 0x40 + KB_OFFSET_FIRST_PROFILE;
      this.kbWrite(KB_CMD_WRITE_CONFIG, base, cfg);
      if (mode === KB_MODES.custom) {
        this.kbWrite(KB_CMD_WRITE_CONFIG, base + KB_PARAM_CUSTOM_COLORSET, [colorset]);
      }
    } finally {
      this.kbQuery(KB_CMD_END);
    }
  }

  // Écrit un jeu de couleurs personnalisé (par touche) dans le colorset 0
  kbWriteCustomColors(rgbPerSlot /* tableau mapSize x [r,g,b] */) {
    const mapSize = this.kbMapSize || 128;
    const data = new Array(3 * mapSize).fill(0);
    for (let slot = 0; slot < mapSize; slot++) {
      const rgb = rgbPerSlot[slot];
      if (rgb) {
        data[slot * 3] = rgb[0];
        data[slot * 3 + 1] = rgb[1];
        data[slot * 3 + 2] = rgb[2];
      }
    }
    this.kbQuery(KB_CMD_BEGIN);
    try {
      this.kbWrite(KB_CMD_WRITE_CUSTOM, 0, data); // colorset 0 (offset 512 * 0)
    } finally {
      this.kbQuery(KB_CMD_END);
    }
  }

  // ---- Bas niveau souris --------------------------------------------------
  mouseSetMode(mode, r, g, b, speed10 /* 1-10 */, brightness10 /* 1-10 */) {
    const buf = new Array(17).fill(0);
    buf[0x00] = 0x08; // report ID
    buf[0x01] = 0x07;
    buf[0x04] = 0xa0;
    buf[0x05] = 0x07;
    buf[0x06] = mode;
    buf[0x07] = r; buf[0x08] = g; buf[0x09] = b;
    const slow = [MOUSE_MODES.breathing, MOUSE_MODES.spectrumCycle,
      MOUSE_MODES.singleColorWave, MOUSE_MODES.breathingColorful].includes(mode);
    if (slow) buf[0x0a] = MOUSE_SPEED_HIGH[(speed10 || 5) - 1];
    else if (mode === MOUSE_MODES.rainbowWave) buf[0x0a] = MOUSE_SPEED_LOW[(speed10 || 5) - 1];
    if (mode !== MOUSE_MODES.off) buf[0x0b] = MOUSE_BRIGHTNESS[(brightness10 || 10) - 1];
    buf[0x0c] = (0x55 - buf[6] - buf[7] - buf[8] - buf[9] - buf[10] - buf[11]) & 0xff;
    buf[0x10] = 0x4a;
    this.mouse.sendFeatureReport(Buffer.from(buf));
  }

  // ---- Traduction de l'état Satella -> matériel ------------------------------
  // Débouncé : les changements rapides (glissement de curseur) ne provoquent
  // qu'une écriture, et un état identique n'est jamais réécrit (la flash du
  // clavier est sollicitée à chaque écriture).
  applyKeyboard(state) {
    if (!this.kb) return;
    clearTimeout(this._kbTimer);
    this._kbTimer = setTimeout(() => {
      const sig = JSON.stringify([state.effect, state.baseColor, state.speed,
        state.brightness, state.direction, state.colors]);
      if (sig === this._lastKbSig) return;
      this._lastKbSig = sig;
      this.pushKeyboard(state).catch((err) => {
        this.emit('log', 'Erreur écriture clavier : ' + err.message);
        this.dropKeyboard();
      });
    }, 250);
  }

  async pushKeyboard(state) {
    const bright = Math.round((state.brightness / 100) * 4);         // 0..4
    const speed = 5 - Math.round((state.speed / 100) * 5);           // 5 lent .. 0 rapide
    const [r, g, b] = hexToRgb(state.baseColor);
    const dirLR = state.direction === 'rl' ? 1 : 0;

    // Effets logiciels : le flux d'images prend le relais (streamKeyboard)
    if (SOFT_EFFECTS.has(state.effect)) {
      this._lastFallback = null; // repartir d'une image complète
      this.kbStreaming = true;
      return;
    }
    if (this.kbStreaming) {
      // Retour à un effet natif : suspendre le thread de flux puis sortir
      // du mode dynamique avant d'écrire la configuration
      this.kbStreaming = false;
      this._lastFallback = null;
      await this.pauseWorker();
      try { this.kbQuery(KB_CMD_DYNAMIC_END); } catch { /* déjà sorti */ }
    }

    switch (state.effect) {
      case 'off':
        this.kbSetMode(KB_MODES.static, 0, 3, 0, 0, 0, 0, 0);
        break;
      case 'static': {
        const hasPerKey = state.colors && Object.keys(state.colors).length > 0;
        if (!hasPerKey) {
          this.kbSetMode(KB_MODES.static, bright, 3, 0, 0, r, g, b);
        } else {
          // Mode « Custom » : chaque touche a sa couleur (colorset 0)
          const perSlot = new Array(this.kbMapSize || 128).fill(null);
          for (const key of Object.keys(this.keyMap)) {
            const hex = state.colors[key] || state.baseColor;
            perSlot[this.keyMap[key]] = hexToRgb(hex);
          }
          this.kbWriteCustomColors(perSlot);
          this.kbSetMode(KB_MODES.custom, bright, 3, 0, 0, 0, 0, 0, 0);
        }
        break;
      }
      case 'breathing':
        this.kbSetMode(KB_MODES.breathing, bright, speed, 0, 0, r, g, b);
        break;
      case 'wave':
        if (state.direction === 'tb' || state.direction === 'bt') {
          this.kbSetMode(KB_MODES.rainbowVertical, bright, speed,
            state.direction === 'tb' ? 3 : 2, 1, r, g, b);
        } else {
          this.kbSetMode(KB_MODES.colorWave, bright, speed, dirLR, 1, r, g, b);
        }
        break;
      case 'rainbow':
        this.kbSetMode(KB_MODES.spectrumCycle, bright, speed, 0, 0, 0, 0, 0);
        break;
      case 'reactive':
        this.kbSetMode(KB_MODES.reactive, bright, speed, 0, 0, r, g, b);
        break;
      case 'sparkle':
        this.kbSetMode(KB_MODES.starlightFast, bright, speed, 0, 0, r, g, b);
        break;
      default:
        this.kbSetMode(KB_MODES.static, bright, 3, 0, 0, r, g, b);
    }
  }

  applyMouse(state) {
    if (!this.mouse) return;
    clearTimeout(this._mouseTimer);
    this._mouseTimer = setTimeout(() => {
      const sig = JSON.stringify([state.effect, state.baseColor, state.speed,
        state.brightness, state.colors]);
      if (sig === this._lastMouseSig) return;
      this._lastMouseSig = sig;
      try { this.pushMouse(state); }
      catch (err) { this.emit('log', 'Erreur écriture souris : ' + err.message); this.dropMouse(); }
    }, 250);
  }

  pushMouse(state) {
    const bright10 = Math.max(1, Math.round((state.brightness / 100) * 10));
    const speed10 = Math.max(1, Math.round((state.speed / 100) * 10));
    // La souris n'a qu'une couleur : première zone personnalisée, sinon couleur de base
    const zoneColors = Object.values(state.colors || {});
    const [r, g, b] = hexToRgb(zoneColors[0] || state.baseColor);

    switch (state.effect) {
      case 'off': this.mouseSetMode(MOUSE_MODES.off, 0, 0, 0, 1, 1); break;
      case 'static': this.mouseSetMode(MOUSE_MODES.static, r, g, b, speed10, bright10); break;
      case 'breathing': this.mouseSetMode(MOUSE_MODES.breathing, r, g, b, speed10, bright10); break;
      case 'wave': this.mouseSetMode(MOUSE_MODES.rainbowWave, r, g, b, speed10, bright10); break;
      case 'rainbow': this.mouseSetMode(MOUSE_MODES.spectrumCycle, r, g, b, speed10, bright10); break;
      case 'sparkle': this.mouseSetMode(MOUSE_MODES.breathingColorful, r, g, b, speed10, bright10); break;
      default: this.mouseSetMode(MOUSE_MODES.static, r, g, b, speed10, bright10);
    }
  }

  // ---- Flux temps réel (effets logiciels) ---------------------------------
  // Les écritures USB vivent dans un thread dédié (stream-worker.js) : le
  // processus principal ne fait que calculer les images et les poster. Le
  // thread n'écrit que les blocs modifiés et fusionne les images en retard.
  ensureWorker() {
    if (this._worker || !this.kbInfo) return;
    // Après un échec, ne pas relancer en boucle : le repli par le canal
    // principal prend le relais pendant 30 secondes.
    if (this._workerFailedAt && Date.now() - this._workerFailedAt < 30000) return;
    this._worker = new Worker(path.join(__dirname, 'stream-worker.js'), {
      workerData: { path: this.kbInfo.path },
    });
    this._workerPaused = false;
    this._worker.on('message', (msg) => {
      if (msg.type === 'error') {
        this.emit('log', 'Flux clavier (thread) : ' + msg.message + ' ; repli sur le canal principal');
        this._workerFailedAt = Date.now();
        this.stopWorker();
      } else if (msg.type === 'paused' && this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
    });
    this._worker.on('exit', () => { this._worker = null; });
  }

  pauseWorker() {
    if (!this._worker || this._workerPaused) return Promise.resolve();
    this._workerPaused = true;
    return new Promise((resolve) => {
      this._pauseResolve = resolve;
      this._worker.postMessage({ type: 'pause' });
      setTimeout(resolve, 300); // filet de sécurité
    });
  }

  stopWorker() {
    if (!this._worker) return;
    try { this._worker.postMessage({ type: 'stop' }); } catch { /* déjà mort */ }
    this._worker = null;
    this._workerPaused = false;
  }

  streamKeyboard(colors) {
    if (!this.kb || this._calibTimer) return;
    const mapSize = this.kbMapSize || 128;
    const data = new Uint8Array(3 * mapSize);
    for (const key of Object.keys(this.keyMap)) {
      const rgb = colors[key];
      if (!rgb) continue;
      const slot = this.keyMap[key] * 3;
      data[slot] = rgb[0];
      data[slot + 1] = rgb[1];
      data[slot + 2] = rgb[2];
    }

    this.ensureWorker();
    if (this._worker) {
      if (this._workerPaused) {
        this._worker.postMessage({ type: 'resume' });
        this._workerPaused = false;
      }
      this._worker.postMessage({ type: 'frame', data });
      this.kbStreaming = true;
      return;
    }

    // Repli : écriture par le canal principal (blocs modifiés uniquement,
    // avec accusé de réception, limitée à 15 images/s)
    const now = Date.now();
    if (now - (this._lastStream || 0) < 66) return;
    this._lastStream = now;
    try {
      let wrote = 0;
      for (let i = 0; i < data.length; i += 54) {
        const len = Math.min(54, data.length - i);
        if (this._lastFallback && this.sameChunk(this._lastFallback, data, i, len)) continue;
        this.kbQuery(KB_CMD_DYNAMIC, i, len, Array.from(data.slice(i, i + len)), true);
        wrote++;
      }
      // Entretien du mode dynamique quand l'image ne change pas (au-delà
      // de ~400 ms sans écriture, le clavier raffiche son effet enregistré)
      if (!wrote && now - (this._lastFallbackWrite || 0) > 300) {
        for (let i = 0; i < data.length; i += 54) {
          const len = Math.min(54, data.length - i);
          this.kbQuery(KB_CMD_DYNAMIC, i, len, Array.from(data.slice(i, i + len)), true);
        }
        wrote = 1;
      }
      if (wrote) this._lastFallbackWrite = now;
      this._lastFallback = data;
      this.kbStreaming = true;
    } catch (err) {
      this.emit('log', 'Flux clavier interrompu : ' + err.message);
      this.dropKeyboard();
    }
  }

  sameChunk(a, b, start, len) {
    for (let i = start; i < start + len && i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ---- Calibration de la carte des touches --------------------------------
  setKeyMap(map) {
    this.keyMap = map && Object.keys(map).length ? map : { ...KB_LED_MAP };
    this._lastKbSig = '';
  }

  // Allume un seul emplacement via le mode dynamique (aucune écriture en flash).
  // Le clavier quitte le mode dynamique s'il n'est pas rafraîchi : un minuteur
  // réémet l'allumage tant que la calibration est en cours.
  kbCalibLight(slot) {
    if (!this.kb) throw new Error('clavier non connecté');
    // Le flux d'effets ne doit pas écrire en même temps que la calibration
    if (this._worker && !this._workerPaused) this.pauseWorker();
    this._calibSlot = slot;
    this.kbCalibPush();
    if (!this._calibTimer) {
      this._calibTimer = setInterval(() => {
        try { this.kbCalibPush(); }
        catch { this.kbCalibEnd(); }
      }, 400);
    }
  }

  kbCalibPush() {
    const mapSize = this.kbMapSize || 128;
    const slot = this._calibSlot;
    const data = new Array(3 * mapSize).fill(0);
    if (slot >= 0 && slot < mapSize) {
      data[slot * 3] = 0;
      data[slot * 3 + 1] = 255;
      data[slot * 3 + 2] = 60;
    }
    this.kbWrite(KB_CMD_DYNAMIC, 0, data);
  }

  // Quitte le mode dynamique et réapplique l'état normal
  kbCalibEnd() {
    clearInterval(this._calibTimer);
    this._calibTimer = null;
    this._calibSlot = null;
    if (!this.kb) return;
    try { this.kbQuery(KB_CMD_DYNAMIC_END); } catch { /* déjà sorti */ }
    this._lastKbSig = '';
  }

  // ---- Diagnostic (page Périphériques) ------------------------------------
  // Envois bruts pour identifier les valeurs comprises par chaque firmware.
  testKeyboard(r, g, b) {
    if (!this.kb) throw new Error('clavier non connecté');
    this._lastKbSig = '';
    this.kbSetMode(KB_MODES.static, 4, 3, 0, 0, r, g, b);
  }

  testMouse(modeValue) {
    if (!this.mouse) throw new Error('souris non connectée');
    this._lastMouseSig = '';
    this.mouseSetMode(modeValue, 255, 0, 51, 5, 10);
  }

  dispose() {
    this.stopWorker();
    clearTimeout(this._kbTimer);
    clearTimeout(this._mouseTimer);
    clearInterval(this._calibTimer);
    this.dropKeyboard();
    this.dropMouse();
  }
}

module.exports = { DirectBackend, KB_LED_MAP, SOFT_EFFECTS };
