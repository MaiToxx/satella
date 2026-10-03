// Traduction touche -> caractère selon la disposition clavier ACTIVE de
// l'application au premier plan (AZERTY, QWERTY, QWERTZ...), avec Maj,
// AltGr et touches mortes (^ ¨ ` ´ ~). Sert à l'expansion de texte.
//
// ToUnicodeEx est appelé avec le drapeau 0x4 (Windows 10 1607+) : l'état
// clavier du système n'est pas modifié, la frappe de l'utilisateur (et ses
// accents) n'est donc jamais perturbée.

let koffi = null;
const k = {};

try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  k.GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  k.GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hwnd, void* pid)');
  k.GetKeyboardLayout = user32.func('void* __stdcall GetKeyboardLayout(uint32 thread)');
  k.MapVirtualKeyExW = user32.func('uint32 __stdcall MapVirtualKeyExW(uint32 code, uint32 type, void* hkl)');
  k.ToUnicodeEx = user32.func('int __stdcall ToUnicodeEx(uint32 vk, uint32 scan, uint8 *state, _Out_ uint16 *buf, int cch, uint32 flags, void* hkl)');
  k.GetKeyState = user32.func('int16 __stdcall GetKeyState(int vk)');
} catch {
  koffi = null;
}

const available = () => !!koffi;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_CAPITAL = 0x14;
const MAPVK_VK_TO_VSC = 0;
const TOUNICODE_NO_STATE_CHANGE = 0x4;

// Diacritiques combinants des touches mortes usuelles
const DEAD_COMBINING = {
  '^': '̂', '¨': '̈', '`': '̀', '´': '́', '~': '̃',
  '¸': '̧', '˘': '̆', 'ˇ': '̌', '˚': '̊',
};

// Combine une touche morte avec le caractère suivant (« ^ » + « e » = « ê »).
// Renvoie la chaîne réellement tapée par Windows dans ce cas. Les
// dispositions usuelles ne composent que vers les lettres latines
// accentuées courantes (jusqu'à U+017F) : « ^ » + « z » donne « ^z ».
function combineDead(dead, ch) {
  if (ch === ' ') return dead;
  const mark = DEAD_COMBINING[dead];
  if (mark) {
    const composed = (ch + mark).normalize('NFC');
    if ([...composed].length === 1 && composed.codePointAt(0) <= 0x17f) return composed;
  }
  return dead + ch; // pas de composition : Windows tape les deux
}

function foregroundLayout() {
  const hwnd = k.GetForegroundWindow();
  const thread = hwnd ? k.GetWindowThreadProcessId(hwnd, null) : 0;
  return k.GetKeyboardLayout(thread);
}

// Caractère produit par une touche (code virtuel) avec les modificateurs
// donnés. Renvoie { text } (chaîne, éventuellement vide), { dead } pour une
// touche morte, ou null si la traduction est impossible.
function translate(vk, mods = {}) {
  if (!koffi || vk === undefined) return null;
  try {
    const hkl = foregroundLayout();
    const scan = k.MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, hkl);
    const state = new Uint8Array(256);
    if (mods.shift) state[VK_SHIFT] = 0x80;
    if (mods.ctrl) state[VK_CONTROL] = 0x80;
    if (mods.alt) state[VK_MENU] = 0x80;
    if (k.GetKeyState(VK_CAPITAL) & 1) state[VK_CAPITAL] = 0x01;
    const buf = new Uint16Array(8);
    const n = k.ToUnicodeEx(vk, scan, state, buf, buf.length, TOUNICODE_NO_STATE_CHANGE, hkl);
    if (n < 0) return { dead: String.fromCharCode(buf[0]) };
    if (n === 0) return { text: '' };
    return { text: String.fromCharCode(...buf.subarray(0, n)) };
  } catch {
    return null;
  }
}

module.exports = { available, translate, combineDead };
