// Mode d'alimentation de Windows (Paramètres > Système > Alimentation :
// « Meilleure efficacité énergétique », « Équilibré », « Meilleures
// performances »). Windows le range comme un « overlay » du mode de gestion
// Utilisation normale ; on le lit et on le change avec les fonctions de
// powrprof.dll qu'utilise l'application Paramètres.

const OVERLAYS = {
  efficiency: '961cc777-2547-4f9d-8174-7d86181b8a7a',
  balanced: '00000000-0000-0000-0000-000000000000',
  performance: 'ded574b5-45a0-4f42-8737-46345c09c238',
};

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// '01234567-89ab-cdef-0123-456789abcdef' <-> structure GUID de Windows
function guidToStruct(s) {
  if (!GUID_RE.test(s)) throw new Error('GUID invalide');
  const h = s.replace(/-/g, '');
  const Data4 = [];
  for (let i = 16; i < 32; i += 2) Data4.push(parseInt(h.slice(i, i + 2), 16));
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4,
  };
}

function structToGuid(g) {
  const hex = (n, len) => (n >>> 0).toString(16).padStart(len, '0');
  const b = Array.from(g.Data4 || []).map((x) => hex(x, 2)).join('');
  return `${hex(g.Data1, 8)}-${hex(g.Data2, 4)}-${hex(g.Data3, 4)}-${b.slice(0, 4)}-${b.slice(4)}`;
}

function overlayId(guid) {
  const g = String(guid || '').toLowerCase();
  return Object.keys(OVERLAYS).find((k) => OVERLAYS[k] === g) || 'other';
}

let koffi = null;
const p = {};
try {
  if (process.platform !== 'win32') throw new Error('Windows uniquement');
  koffi = require('koffi');
  const powrprof = koffi.load('powrprof.dll');
  koffi.struct('SATELLA_GUID', {
    Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8, 'Array'),
  });
  p.set = powrprof.func('uint32 __stdcall PowerSetActiveOverlayScheme(SATELLA_GUID guid)');
  // « Effective » (Windows 11) tient compte de la source d'alimentation
  try {
    p.get = powrprof.func('uint32 __stdcall PowerGetEffectiveOverlayScheme(_Out_ SATELLA_GUID *guid)');
  } catch {
    p.get = powrprof.func('uint32 __stdcall PowerGetActualOverlayScheme(_Out_ SATELLA_GUID *guid)');
  }
} catch {
  koffi = null;
}

const available = () => !!koffi;

// Mode actuel : 'efficiency' | 'balanced' | 'performance' | 'other' | null
function getOverlay() {
  if (!koffi) return null;
  try {
    const out = {};
    if (p.get(out) !== 0) return null;
    return overlayId(structToGuid(out));
  } catch {
    return null;
  }
}

function setOverlay(id) {
  if (!koffi) return { ok: false, error: 'indisponible' };
  if (!OVERLAYS[id]) return { ok: false, error: 'mode inconnu' };
  try {
    const rc = p.set(guidToStruct(OVERLAYS[id]));
    return rc === 0 ? { ok: true } : { ok: false, error: `Windows a refusé (code ${rc})` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { OVERLAYS, guidToStruct, structToGuid, overlayId, available, getOverlay, setOverlay };
