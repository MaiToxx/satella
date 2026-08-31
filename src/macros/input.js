// Injection d'entrées Windows via SendInput (user32.dll, FFI koffi).
// Fournit : appui/relâchement de touches, frappe de texte Unicode,
// clics/mouvements/molette souris.

let koffi, SendInput, GetSystemMetrics;
let available = false;
let loadError = null;

const INPUT_KEYBOARD = 1;
const INPUT_MOUSE = 0;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

let INPUT_SIZE = 0;

try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  koffi.struct('SATELLA_KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr',
  });
  koffi.struct('SATELLA_MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'int32', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr',
  });
  koffi.union('SATELLA_INPUT_U', { mi: 'SATELLA_MOUSEINPUT', ki: 'SATELLA_KEYBDINPUT' });
  const INPUT = koffi.struct('SATELLA_INPUT', { type: 'uint32', u: 'SATELLA_INPUT_U' });

  INPUT_SIZE = koffi.sizeof(INPUT);
  SendInput = user32.func('uint32 SendInput(uint32 cInputs, SATELLA_INPUT *pInputs, int cbSize)');
  GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
  available = true;
} catch (err) {
  loadError = err;
}

const { VK, EXTENDED } = require('./keys');

function sendKeyboard(events) {
  // events: [{vk, scan, flags}]
  const inputs = events.map((e) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: e.vk || 0, wScan: e.scan || 0, dwFlags: e.flags || 0, time: 0, dwExtraInfo: 0 } },
  }));
  return SendInput(inputs.length, inputs, INPUT_SIZE);
}

function sendMouse(events) {
  // events: [{dx, dy, data, flags}]
  const inputs = events.map((e) => ({
    type: INPUT_MOUSE,
    u: { mi: { dx: e.dx || 0, dy: e.dy || 0, mouseData: e.data || 0, dwFlags: e.flags || 0, time: 0, dwExtraInfo: 0 } },
  }));
  return SendInput(inputs.length, inputs, INPUT_SIZE);
}

function keyFlags(name, up) {
  let flags = EXTENDED.has(name) ? KEYEVENTF_EXTENDEDKEY : 0;
  if (up) flags |= KEYEVENTF_KEYUP;
  return flags;
}

function keyDown(name) {
  const vk = VK[name];
  if (vk === undefined) throw new Error(`Touche inconnue : ${name}`);
  sendKeyboard([{ vk, flags: keyFlags(name, false) }]);
}

function keyUp(name) {
  const vk = VK[name];
  if (vk === undefined) throw new Error(`Touche inconnue : ${name}`);
  sendKeyboard([{ vk, flags: keyFlags(name, true) }]);
}

function keyTap(name, modifiers = []) {
  for (const m of modifiers) keyDown(m);
  keyDown(name);
  keyUp(name);
  for (const m of [...modifiers].reverse()) keyUp(m);
}

function typeText(text) {
  // Frappe Unicode : indépendante de la disposition du clavier.
  const events = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const units = code > 0xffff
      ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
      : [code];
    for (const unit of units) {
      events.push({ vk: 0, scan: unit, flags: KEYEVENTF_UNICODE });
      events.push({ vk: 0, scan: unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
    }
  }
  // Envoi par petits lots pour rester fluide
  for (let i = 0; i < events.length; i += 64) sendKeyboard(events.slice(i, i + 64));
}

const BUTTON_FLAGS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  x1: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
  x2: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
};

function mouseButton(button, up) {
  const pair = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  const data = button === 'x1' ? 1 : button === 'x2' ? 2 : 0;
  sendMouse([{ flags: pair[up ? 1 : 0], data }]);
}

function mouseClick(button = 'left', count = 1) {
  for (let i = 0; i < count; i++) {
    mouseButton(button, false);
    mouseButton(button, true);
  }
}

function mouseMove(x, y, relative = false) {
  if (relative) {
    sendMouse([{ dx: Math.round(x), dy: Math.round(y), flags: MOUSEEVENTF_MOVE }]);
  } else {
    const sw = GetSystemMetrics(SM_CXSCREEN);
    const sh = GetSystemMetrics(SM_CYSCREEN);
    const nx = Math.round((x / (sw - 1)) * 65535);
    const ny = Math.round((y / (sh - 1)) * 65535);
    sendMouse([{ dx: nx, dy: ny, flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE }]);
  }
}

function mouseWheel(delta, horizontal = false) {
  sendMouse([{ data: Math.round(delta), flags: horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL }]);
}

module.exports = {
  available,
  loadError,
  keyDown, keyUp, keyTap, typeText,
  mouseButton, mouseClick, mouseMove, mouseWheel,
};
