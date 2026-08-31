// Optimiseur mémoire (principe de MemReduct) : lecture de l'état de la RAM
// et libération via les API Windows natives, sans logiciel tiers.
//
// Deux leviers, comme MemReduct :
//  1. vider les « working sets » des processus (EmptyWorkingSet) : renvoie
//     vers le fichier d'échange les pages non utilisées ; fonctionne pour
//     tous les processus qu'on peut ouvrir, même sans droits admin ;
//  2. purger la liste « standby » et les working sets système
//     (NtSetSystemInformation / SystemMemoryListInformation) : le vrai gain,
//     mais nécessite les droits administrateur et le privilège de profilage.

let koffi = null;
let loadError = null;
let k = {};

const MEMORYSTATUSEX_SIZE = 64;

try {
  koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const psapi = koffi.load('psapi.dll');
  const ntdll = koffi.load('ntdll.dll');
  const advapi32 = koffi.load('advapi32.dll');

  koffi.struct('LYNN_MEMORYSTATUSEX', {
    dwLength: 'uint32',
    dwMemoryLoad: 'uint32',
    ullTotalPhys: 'uint64',
    ullAvailPhys: 'uint64',
    ullTotalPageFile: 'uint64',
    ullAvailPageFile: 'uint64',
    ullTotalVirtual: 'uint64',
    ullAvailVirtual: 'uint64',
    ullAvailExtendedVirtual: 'uint64',
  });
  koffi.struct('LYNN_LUID', { LowPart: 'uint32', HighPart: 'int32' });
  koffi.struct('LYNN_LUID_AND_ATTRIBUTES', { Luid: 'LYNN_LUID', Attributes: 'uint32' });
  koffi.struct('LYNN_TOKEN_PRIVILEGES', {
    PrivilegeCount: 'uint32',
    Luid: 'LYNN_LUID',
    Attributes: 'uint32',
  });

  k.GlobalMemoryStatusEx = kernel32.func('int __stdcall GlobalMemoryStatusEx(_Inout_ LYNN_MEMORYSTATUSEX *buf)');
  k.GetCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()');
  k.OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
  k.CloseHandle = kernel32.func('int __stdcall CloseHandle(void* h)');

  // Selon les versions de Windows, ces fonctions vivent dans psapi.dll
  // (noms EnumProcesses/EmptyWorkingSet) ou dans kernel32.dll (préfixe K32).
  const pick = (decls) => {
    for (const [lib, decl] of decls) {
      try { return lib.func(decl); } catch { /* essai suivant */ }
    }
    throw new Error('fonction introuvable : ' + decls[0][1]);
  };
  k.EnumProcesses = pick([
    [psapi, 'int __stdcall EnumProcesses(_Out_ uint32 *pids, uint32 cb, _Out_ uint32 *needed)'],
    [kernel32, 'int __stdcall K32EnumProcesses(_Out_ uint32 *pids, uint32 cb, _Out_ uint32 *needed)'],
  ]);
  k.EmptyWorkingSet = pick([
    [psapi, 'int __stdcall EmptyWorkingSet(void* proc)'],
    [kernel32, 'int __stdcall K32EmptyWorkingSet(void* proc)'],
  ]);

  // NtSetSystemInformation(SystemMemoryListInformation = 80, &command, 4)
  k.NtSetSystemInformation = ntdll.func('int32 __stdcall NtSetSystemInformation(int cls, _In_ int *info, uint32 len)');

  k.OpenProcessToken = advapi32.func('int __stdcall OpenProcessToken(void* proc, uint32 access, _Out_ void** token)');
  k.LookupPrivilegeValue = advapi32.func('int __stdcall LookupPrivilegeValueW(str16 sys, str16 name, _Out_ LYNN_LUID *luid)');
  k.AdjustTokenPrivileges = advapi32.func('int __stdcall AdjustTokenPrivileges(void* token, int disableAll, _In_ LYNN_TOKEN_PRIVILEGES *newState, uint32 len, void* prev, void* prevLen)');
} catch (err) {
  loadError = err;
  koffi = null;
}

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_SET_QUOTA = 0x0100;
const TOKEN_ADJUST_PRIVILEGES = 0x0020;
const TOKEN_QUERY = 0x0008;
const SE_PRIVILEGE_ENABLED = 0x0002;
const SYSTEM_MEMORY_LIST_INFORMATION = 80;
const MEMORY_EMPTY_WORKING_SETS = 2;
const MEMORY_FLUSH_MODIFIED_LIST = 3;
const MEMORY_PURGE_STANDBY_LIST = 4;

const available = () => !!koffi;

function readStatus() {
  if (!koffi) return null;
  const buf = { dwLength: MEMORYSTATUSEX_SIZE };
  if (!k.GlobalMemoryStatusEx(buf)) return null;
  return {
    load: buf.dwMemoryLoad,                 // % utilisé
    totalPhys: Number(buf.ullTotalPhys),
    availPhys: Number(buf.ullAvailPhys),
    usedPhys: Number(buf.ullTotalPhys) - Number(buf.ullAvailPhys),
  };
}

// Active un privilège sur le processus courant (pour la purge système)
function enablePrivilege(name) {
  const tokenPtr = [null];
  if (!k.OpenProcessToken(k.GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, tokenPtr)) {
    return false;
  }
  const token = tokenPtr[0];
  try {
    const luid = {};
    if (!k.LookupPrivilegeValue(null, name, luid)) return false;
    const tp = { PrivilegeCount: 1, Luid: luid, Attributes: SE_PRIVILEGE_ENABLED };
    return !!k.AdjustTokenPrivileges(token, 0, tp, 0, null, null);
  } finally {
    k.CloseHandle(token);
  }
}

// Vide le working set de chaque processus accessible. Renvoie le nombre traité.
function emptyAllWorkingSets() {
  const CAP = 2048;
  const pids = new Uint32Array(CAP);
  const needed = [0];
  if (!k.EnumProcesses(pids, CAP * 4, needed)) return 0;
  const count = Math.floor(needed[0] / 4);
  let done = 0;
  for (let i = 0; i < count; i++) {
    const pid = pids[i];
    if (!pid) continue;
    const h = k.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, 0, pid);
    if (!h) continue;
    try { if (k.EmptyWorkingSet(h)) done++; } catch { /* refusé */ }
    k.CloseHandle(h);
  }
  return done;
}

// Purge système (liste standby + working sets + liste modifiée). Admin requis.
function purgeSystem() {
  let ok = false;
  enablePrivilege('SeProfileSingleProcessPrivilege');
  enablePrivilege('SeIncreaseQuotaPrivilege');
  for (const cmd of [MEMORY_EMPTY_WORKING_SETS, MEMORY_FLUSH_MODIFIED_LIST, MEMORY_PURGE_STANDBY_LIST]) {
    try {
      const status = k.NtSetSystemInformation(SYSTEM_MEMORY_LIST_INFORMATION, [cmd], 4);
      if (status === 0) ok = true;
    } catch { /* commande refusée sans admin */ }
  }
  return ok;
}

// Optimisation complète : working sets (toujours) + purge système (si admin).
function optimize() {
  if (!koffi) return { ok: false, error: loadError ? loadError.message : 'indisponible' };
  const before = readStatus();
  const processes = emptyAllWorkingSets();
  const systemPurged = purgeSystem();
  const after = readStatus();
  const freed = before && after ? after.availPhys - before.availPhys : 0;
  return {
    ok: true,
    before,
    after,
    processes,
    systemPurged,
    freed: Math.max(0, freed),
  };
}

module.exports = { available, readStatus, optimize };
