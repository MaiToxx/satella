// Temps d'inactivité de la session (pour l'extinction automatique des LED).
// GetLastInputInfo donne l'horodatage de la dernière frappe ou action souris.

let koffi = null;
let k = {};

try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  koffi.struct('LYNN_LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
  k.GetLastInputInfo = user32.func('int __stdcall GetLastInputInfo(_Inout_ LYNN_LASTINPUTINFO *info)');
  k.GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
} catch {
  koffi = null;
}

const available = () => !!koffi;

// Millisecondes depuis la dernière activité clavier ou souris, ou null.
function idleMs() {
  if (!koffi) return null;
  const info = { cbSize: 8, dwTime: 0 };
  if (!k.GetLastInputInfo(info)) return null;
  // GetTickCount boucle sur 32 bits : le masque gère le retournement
  return (k.GetTickCount() - info.dwTime) >>> 0;
}

module.exports = { available, idleMs };
