// État des touches de verrouillage (Verr. Maj, Verr. Num) pour les témoins
// lumineux : le GS98 n'a pas de voyants, Satella allume la touche elle-même.
// GetKeyState : le bit de poids faible indique l'état basculé.

let koffi = null;
let GetKeyState = null;

try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  GetKeyState = user32.func('int16 __stdcall GetKeyState(int nVirtKey)');
} catch {
  koffi = null;
}

const VK_CAPITAL = 0x14;
const VK_NUMLOCK = 0x90;

const available = () => !!koffi;

// { capslock, numlock } (booléens), ou null hors Windows
function read() {
  if (!koffi) return null;
  try {
    return {
      capslock: (GetKeyState(VK_CAPITAL) & 1) === 1,
      numlock: (GetKeyState(VK_NUMLOCK) & 1) === 1,
    };
  } catch {
    return null;
  }
}

// Touches à allumer pour un état donné
function indicatorMap(state, rgb) {
  const out = {};
  if (!state) return out;
  for (const id of ['capslock', 'numlock']) if (state[id]) out[id] = rgb;
  return out;
}

module.exports = { available, read, indicatorMap };
