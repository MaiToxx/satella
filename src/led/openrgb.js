// Client OpenRGB : pilote le matériel via le serveur SDK d'OpenRGB
// (OpenRGB doit être lancé avec son serveur SDK actif, port 6742 par défaut).

const { EventEmitter } = require('events');

let OpenRGBClient = null;
let sdkError = null;
try {
  ({ Client: OpenRGBClient } = require('openrgb-sdk'));
} catch (err) {
  sdkError = err;
}

const KEYBOARD_TYPE = 5; // DEVICE_TYPE_KEYBOARD
const MOUSE_TYPE = 6;    // DEVICE_TYPE_MOUSE

class OpenRGB extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.devices = [];       // [{index, name, type, ledCount, ledNames}]
    this.keyboardIndex = -1;
    this.mouseIndex = -1;
    this.keyMap = null;      // keyId -> index LED
    this._connecting = false;
  }

  get available() { return !!OpenRGBClient; }

  status() {
    return {
      available: this.available,
      connected: this.connected,
      error: sdkError ? sdkError.message : null,
      devices: this.devices.map((d) => ({ name: d.name, type: d.type, ledCount: d.ledCount })),
      keyboard: this.keyboardIndex >= 0 ? this.devices[this.keyboardIndex].name : null,
      mouse: this.mouseIndex >= 0 ? this.devices[this.mouseIndex].name : null,
    };
  }

  async connect(host = '127.0.0.1', port = 6742) {
    if (!OpenRGBClient || this._connecting) return this.status();
    this._connecting = true;
    try {
      await this.disconnect();
      this.client = new OpenRGBClient('Satella', port, host);
      await this.client.connect();
      const count = await this.client.getControllerCount();
      this.devices = [];
      for (let i = 0; i < count; i++) {
        const d = await this.client.getControllerData(i);
        this.devices.push({
          index: i,
          name: d.name || `Périphérique ${i}`,
          type: d.type,
          ledCount: (d.leds || []).length,
          ledNames: (d.leds || []).map((l) => (l.name || '').toLowerCase()),
          raw: d,
        });
        // Mode direct si disponible (contrôle par logiciel)
        try {
          const direct = (d.modes || []).findIndex((m) => /direct/i.test(m.name));
          if (direct >= 0) await this.client.updateMode(i, direct);
        } catch { /* certains périphériques refusent, on continue */ }
      }
      this.pickDevices();
      this.connected = true;
      this.emit('status', this.status());
    } catch (err) {
      this.connected = false;
      this.client = null;
      this.emit('status', { ...this.status(), error: err.message });
    } finally {
      this._connecting = false;
    }
    return this.status();
  }

  pickDevices() {
    const kb = this.devices.filter((d) => d.type === KEYBOARD_TYPE);
    const ms = this.devices.filter((d) => d.type === MOUSE_TYPE);
    // Priorité aux noms proches de nos périphériques, sinon premier de chaque type
    const prefKb = kb.find((d) => /surmen|gs98/i.test(d.name)) || kb[0];
    const prefMs = ms.find((d) => /risophy|pc365/i.test(d.name)) || ms[0];
    this.keyboardIndex = prefKb ? prefKb.index : -1;
    this.mouseIndex = prefMs ? prefMs.index : -1;
    this.keyMap = null;
  }

  // Correspondance nom de LED OpenRGB -> id de touche Satella
  buildKeyMap(layoutKeys) {
    if (this.keyboardIndex < 0) return null;
    const dev = this.devices[this.keyboardIndex];
    const map = {};
    const aliases = {
      esc: ['escape'], backspace: ['backspace'], capslock: ['caps lock'],
      lshift: ['left shift'], rshift: ['right shift'],
      lctrl: ['left control', 'left ctrl'], rctrl: ['right control', 'right ctrl'],
      lalt: ['left alt'], ralt: ['right alt', 'right fn'], lwin: ['left windows', 'left win'],
      enter: ['enter', 'return'], space: ['space'],
      pageup: ['page up'], pagedown: ['page down'], printscreen: ['print screen'],
      up: ['up arrow'], down: ['down arrow'], left: ['left arrow'], right: ['right arrow'],
      grave: ['`', 'back tick', 'tilde'], minus: ['-'], equal: ['='],
      lbracket: ['['], rbracket: [']'], backslash: ['\\'], semicolon: [';'],
      quote: ["'"], comma: [','], period: ['.'], slash: ['/'],
      numlock: ['num lock'], npdivide: ['number pad /'], npmultiply: ['number pad *'],
      npsubtract: ['number pad -'], npadd: ['number pad +'], npenter: ['number pad enter'],
      npdecimal: ['number pad .'],
    };
    for (let i = 0; i <= 9; i++) aliases['np' + i] = ['number pad ' + i, 'numpad ' + i];

    for (const key of layoutKeys) {
      const candidates = [
        'key: ' + key.id, key.id,
        ...(aliases[key.id] || []).flatMap((a) => ['key: ' + a, a]),
      ];
      if (key.id.length === 1) candidates.push('key: ' + key.id.toUpperCase());
      const idx = dev.ledNames.findIndex((n) => candidates.includes(n));
      if (idx >= 0) map[key.id] = idx;
    }
    this.keyMap = map;
    return map;
  }

  // colors : { keyId: [r,g,b] } — applique sur le clavier
  async pushKeyboard(colors, layoutKeys) {
    if (!this.connected || this.keyboardIndex < 0) return;
    const dev = this.devices[this.keyboardIndex];
    if (!this.keyMap) this.buildKeyMap(layoutKeys);
    const arr = new Array(dev.ledCount).fill({ red: 0, green: 0, blue: 0 });

    const mapped = Object.keys(this.keyMap || {}).length;
    if (mapped >= layoutKeys.length * 0.5) {
      // Correspondance par nom réussie
      for (const [keyId, rgb] of Object.entries(colors)) {
        const idx = this.keyMap[keyId];
        if (idx !== undefined) arr[idx] = { red: rgb[0], green: rgb[1], blue: rgb[2] };
      }
    } else {
      // Repli : répartir dans l'ordre du layout
      layoutKeys.forEach((key, i) => {
        const rgb = colors[key.id];
        if (rgb && i < dev.ledCount) arr[i] = { red: rgb[0], green: rgb[1], blue: rgb[2] };
      });
    }
    try { await this.client.updateLeds(this.keyboardIndex, arr); }
    catch { this.connected = false; this.emit('status', this.status()); }
  }

  // colors : { zoneId: [r,g,b] } — applique sur la souris (répartition par zones)
  async pushMouse(colors, zones) {
    if (!this.connected || this.mouseIndex < 0) return;
    const dev = this.devices[this.mouseIndex];
    if (dev.ledCount === 0) return;
    const zoneColors = zones.map((z) => colors[z.id] || [0, 0, 0]);
    const arr = [];
    for (let i = 0; i < dev.ledCount; i++) {
      const rgb = zoneColors[Math.floor((i / dev.ledCount) * zoneColors.length)] || [0, 0, 0];
      arr.push({ red: rgb[0], green: rgb[1], blue: rgb[2] });
    }
    try { await this.client.updateLeds(this.mouseIndex, arr); }
    catch { this.connected = false; this.emit('status', this.status()); }
  }

  async disconnect() {
    if (this.client) {
      try { await this.client.disconnect(); } catch { /* ignore */ }
    }
    this.client = null;
    this.connected = false;
  }
}

module.exports = { OpenRGB };
