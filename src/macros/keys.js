// Table des touches : nom interne Satella <-> code virtuel Windows (VK)
// Clavier QWERTY US (SURMEN GS98).

const VK = {
  // Lettres
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5a,
  // Rangée des chiffres
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  // Fonctions
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  // Contrôle
  esc: 0x1b, tab: 0x09, capslock: 0x14, enter: 0x0d, backspace: 0x08, space: 0x20,
  lshift: 0xa0, rshift: 0xa1, lctrl: 0xa2, rctrl: 0xa3, lalt: 0xa4, ralt: 0xa5,
  lwin: 0x5b, rwin: 0x5c, apps: 0x5d,
  // Navigation (touches étendues)
  insert: 0x2d, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  printscreen: 0x2c, scrolllock: 0x91, pause: 0x13,
  // Pavé numérique
  numlock: 0x90, npdivide: 0x6f, npmultiply: 0x6a, npsubtract: 0x6d, npadd: 0x6b,
  npenter: 0x0d, npdecimal: 0x6e,
  np0: 0x60, np1: 0x61, np2: 0x62, np3: 0x63, np4: 0x64,
  np5: 0x65, np6: 0x66, np7: 0x67, np8: 0x68, np9: 0x69,
  // Touches OEM (QWERTY US)
  grave: 0xc0,      // ` (VK_OEM_3)
  minus: 0xbd,      // - (VK_OEM_MINUS)
  equal: 0xbb,      // = (VK_OEM_PLUS)
  lbracket: 0xdb,   // [ (VK_OEM_4)
  rbracket: 0xdd,   // ] (VK_OEM_6)
  backslash: 0xdc,  // \ (VK_OEM_5)
  semicolon: 0xba,  // ; (VK_OEM_1)
  quote: 0xde,      // ' (VK_OEM_7)
  comma: 0xbc,      // , (VK_OEM_COMMA)
  period: 0xbe,     // . (VK_OEM_PERIOD)
  slash: 0xbf,      // / (VK_OEM_2)
  // Multimédia
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad,
  medianext: 0xb0, mediaprev: 0xb1, mediastop: 0xb2, mediaplay: 0xb3,
};

// Touches "étendues" (nécessitent le drapeau KEYEVENTF_EXTENDEDKEY)
const EXTENDED = new Set([
  'insert', 'delete', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'npdivide', 'npenter',
  'rctrl', 'ralt', 'lwin', 'rwin', 'printscreen', 'numlock',
]);

// VK -> nom Satella (pour l'enregistreur : uiohook fournit rawcode = VK sous Windows)
const VK_TO_NAME = {};
for (const [name, code] of Object.entries(VK)) {
  if (!(code in VK_TO_NAME)) VK_TO_NAME[code] = name;
}
VK_TO_NAME[0x10] = 'lshift'; // VK génériques -> variante gauche
VK_TO_NAME[0x11] = 'lctrl';
VK_TO_NAME[0x12] = 'lalt';
VK_TO_NAME[0x0d] = 'enter';

// Codes uiohook (dérivés des scancodes) -> nom Satella.
// La couche JS d'uiohook-napi n'expose PAS le code Windows (rawcode),
// uniquement son propre keycode : cette table fait la conversion.
const UIOHOOK_TO_NAME = {
  0x0001: 'esc', 0x000e: 'backspace', 0x000f: 'tab', 0x001c: 'enter',
  0x003a: 'capslock', 0x0039: 'space',
  0x0e49: 'pageup', 0x0e51: 'pagedown', 0x0e4f: 'end', 0x0e47: 'home',
  0x0e52: 'insert', 0x0e53: 'delete',
  0xe04b: 'left', 0xe048: 'up', 0xe04d: 'right', 0xe050: 'down',
  0x000b: '0', 0x0002: '1', 0x0003: '2', 0x0004: '3', 0x0005: '4',
  0x0006: '5', 0x0007: '6', 0x0008: '7', 0x0009: '8', 0x000a: '9',
  0x001e: 'a', 0x0030: 'b', 0x002e: 'c', 0x0020: 'd', 0x0012: 'e',
  0x0021: 'f', 0x0022: 'g', 0x0023: 'h', 0x0017: 'i', 0x0024: 'j',
  0x0025: 'k', 0x0026: 'l', 0x0032: 'm', 0x0031: 'n', 0x0018: 'o',
  0x0019: 'p', 0x0010: 'q', 0x0013: 'r', 0x001f: 's', 0x0014: 't',
  0x0016: 'u', 0x002f: 'v', 0x0011: 'w', 0x002d: 'x', 0x0015: 'y',
  0x002c: 'z',
  0x0052: 'np0', 0x004f: 'np1', 0x0050: 'np2', 0x0051: 'np3',
  0x004b: 'np4', 0x004c: 'np5', 0x004d: 'np6', 0x0047: 'np7',
  0x0048: 'np8', 0x0049: 'np9',
  0x0037: 'npmultiply', 0x004e: 'npadd', 0x004a: 'npsubtract',
  0x0053: 'npdecimal', 0x0e35: 'npdivide', 0x0e1c: 'npenter',
  // Variantes du pavé quand Verr Num est éteint (5 = touche « Clear »)
  0xee4f: 'np1', 0xee50: 'np2', 0xee51: 'np3', 0xee4b: 'np4',
  0xee4c: 'np5', 0xee4d: 'np6', 0xee47: 'np7', 0xee48: 'np8',
  0xee49: 'np9', 0xee52: 'np0', 0xee53: 'npdecimal',
  0x003b: 'f1', 0x003c: 'f2', 0x003d: 'f3', 0x003e: 'f4', 0x003f: 'f5',
  0x0040: 'f6', 0x0041: 'f7', 0x0042: 'f8', 0x0043: 'f9', 0x0044: 'f10',
  0x0057: 'f11', 0x0058: 'f12',
  0x0027: 'semicolon', 0x000d: 'equal', 0x0033: 'comma', 0x000c: 'minus',
  0x0034: 'period', 0x0035: 'slash', 0x0029: 'grave', 0x001a: 'lbracket',
  0x002b: 'backslash', 0x001b: 'rbracket', 0x0028: 'quote',
  0x001d: 'lctrl', 0x0e1d: 'rctrl', 0x0038: 'lalt', 0x0e38: 'ralt',
  0x002a: 'lshift', 0x0036: 'rshift', 0x0e5b: 'lwin', 0x0e5c: 'rwin',
  0x0045: 'numlock', 0x0046: 'scrolllock', 0x0e37: 'printscreen',
};

// Libellés d'affichage français
const LABELS = {
  esc: 'Échap', tab: 'Tab', capslock: 'Verr Maj', enter: 'Entrée',
  backspace: 'Retour arrière', space: 'Espace',
  lshift: 'Maj gauche', rshift: 'Maj droite', lctrl: 'Ctrl gauche', rctrl: 'Ctrl droit',
  lalt: 'Alt gauche', ralt: 'Alt droit', lwin: 'Win',
  insert: 'Inser', delete: 'Suppr', home: 'Début', end: 'Fin',
  pageup: 'Page préc.', pagedown: 'Page suiv.',
  up: 'Flèche haut', down: 'Flèche bas', left: 'Flèche gauche', right: 'Flèche droite',
  printscreen: 'Impr écran', grave: '`', minus: '-', equal: '=',
  lbracket: '[', rbracket: ']', backslash: '\\', semicolon: ';', quote: "'",
  comma: ',', period: '.', slash: '/',
  numlock: 'Verr Num', npdivide: 'Pavé /', npmultiply: 'Pavé *',
  npsubtract: 'Pavé -', npadd: 'Pavé +', npenter: 'Pavé Entrée', npdecimal: 'Pavé .',
  np0: 'Pavé 0', np1: 'Pavé 1', np2: 'Pavé 2', np3: 'Pavé 3', np4: 'Pavé 4',
  np5: 'Pavé 5', np6: 'Pavé 6', np7: 'Pavé 7', np8: 'Pavé 8', np9: 'Pavé 9',
  volumeup: 'Volume +', volumedown: 'Volume -', volumemute: 'Muet',
  medianext: 'Piste suiv.', mediaprev: 'Piste préc.', mediastop: 'Stop média', mediaplay: 'Lecture/Pause',
};

function labelFor(name) {
  if (LABELS[name]) return LABELS[name];
  return name.toUpperCase();
}

// Nom Satella -> accélérateur Electron (pour les déclencheurs de macros)
const ACCEL = {
  lctrl: 'Ctrl', rctrl: 'Ctrl', lalt: 'Alt', ralt: 'Alt',
  lshift: 'Shift', rshift: 'Shift', lwin: 'Super', rwin: 'Super',
  esc: 'Esc', enter: 'Return', space: 'Space', backspace: 'Backspace',
  tab: 'Tab', capslock: 'Capslock',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  insert: 'Insert', delete: 'Delete', printscreen: 'PrintScreen',
  grave: '`', minus: '-', equal: '=', lbracket: '[', rbracket: ']',
  backslash: '\\', semicolon: ';', quote: "'", comma: ',', period: '.', slash: '/',
  np0: 'num0', np1: 'num1', np2: 'num2', np3: 'num3', np4: 'num4',
  np5: 'num5', np6: 'num6', np7: 'num7', np8: 'num8', np9: 'num9',
  npadd: 'numadd', npsubtract: 'numsub', npmultiply: 'nummult',
  npdivide: 'numdiv', npdecimal: 'numdec', npenter: 'Return',
  volumeup: 'VolumeUp', volumedown: 'VolumeDown', volumemute: 'VolumeMute',
  medianext: 'MediaNextTrack', mediaprev: 'MediaPreviousTrack',
  mediastop: 'MediaStop', mediaplay: 'MediaPlayPause',
};

function toAccelerator(name) {
  if (ACCEL[name]) return ACCEL[name];
  if (/^f\d{1,2}$/.test(name)) return name.toUpperCase();
  return name.length === 1 ? name.toUpperCase() : null;
}

module.exports = { VK, EXTENDED, VK_TO_NAME, UIOHOOK_TO_NAME, LABELS, labelFor, toAccelerator };
