// Application au premier plan (pour les profils par application).
// GetForegroundWindow -> PID -> chemin de l'exécutable, via les API Windows.

let koffi = null;
let k = {};

try {
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  k.GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  k.GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32 *pid)');
  k.OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
  k.CloseHandle = kernel32.func('int __stdcall CloseHandle(void* h)');
  k.QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)');
} catch {
  koffi = null;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const available = () => !!koffi;

// Nom de l'exécutable au premier plan, en minuscules (ex. « game.exe »),
// ou null si indisponible.
function currentExe() {
  if (!koffi) return null;
  const hwnd = k.GetForegroundWindow();
  if (!hwnd) return null;
  const pidOut = [0];
  k.GetWindowThreadProcessId(hwnd, pidOut);
  const pid = pidOut[0];
  if (!pid) return null;
  const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!h) return null;
  try {
    const buf = new Uint16Array(520);
    const size = [519];
    if (!k.QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    const full = String.fromCharCode(...buf.subarray(0, size[0]));
    const base = full.slice(full.lastIndexOf('\\') + 1);
    return base ? base.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    k.CloseHandle(h);
  }
}

module.exports = { available, currentExe };
