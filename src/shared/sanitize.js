// Validation des données importées (fichiers .satella) : un fichier
// partagé ne doit jamais pouvoir injecter autre chose que des réglages
// valides (types, bornes, longueurs, listes fermées).

const FORMAT = 'satella';
const FORMAT_VERSION = 1;

const KB_EFFECTS = ['static', 'breathing', 'wave', 'rainbow', 'reactive', 'ripple', 'sparkle',
  'fire', 'rain', 'scanner', 'spiral', 'disco', 'gradient', 'sysmon', 'audio', 'screen', 'heatmap', 'palette', 'off'];
const DEFAULT_PALETTE = ['#ff2a6d', '#ff9f1c', '#ffe066'];
const MOUSE_EFFECTS = ['static', 'breathing', 'wave', 'rainbow', 'sparkle', 'off'];
const DIRECTIONS = ['lr', 'rl', 'tb', 'bt'];
const BUTTONS = ['left', 'right', 'middle', 'x1', 'x2'];
const STEP_TYPES = ['keyTap', 'keyDown', 'keyUp', 'text', 'delay', 'mouseClick', 'mouseDown',
  'mouseUp', 'mouseMove', 'mouseWheel', 'loop', 'runMacro', 'open', 'waitKey', 'profile', 'effect'];
const MAX_LOOP_DEPTH = 8;

// Cible d'une étape « Ouvrir » : lien web ou courriel, ou chemin Windows
// absolu (C:\... ou \\serveur\...). Tout autre schéma est refusé.
function openTarget(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 1000) : '';
  if (/^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(s)) return s;
  if (/^([a-zA-Z]:\\|\\\\[^\\])[^\r\n\t<>"|?*]*$/.test(s)) return s;
  return '';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const bool = (v) => v === true;
function num(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
const int = (v, min, max, def) => Math.round(num(v, min, max, def));

function hex(v, def = null) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : def;
}

function id(v) {
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null;
}

function colorMap(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, c] of Object.entries(v).slice(0, 256)) {
    if (/^[a-z0-9_]{1,24}$/.test(k) && hex(c)) out[k] = hex(c);
  }
  return out;
}

function deviceState(v, effects) {
  const s = isObj(v) ? v : {};
  const out = {
    effect: effects.includes(s.effect) ? s.effect : 'static',
    baseColor: hex(s.baseColor, '#00a8ff'),
    color2: hex(s.color2, '#ff00d4'),
    speed: int(s.speed, 0, 100, 50),
    brightness: int(s.brightness, 0, 100, 100),
    direction: DIRECTIONS.includes(s.direction) ? s.direction : 'lr',
    colors: colorMap(s.colors),
  };
  if (effects === KB_EFFECTS) {
    out.overlay = colorMap(s.overlay);
    // Vague de couleurs : 2 à 6 couleurs valides
    const pal = (Array.isArray(s.palette) ? s.palette : []).map((c) => hex(c)).filter(Boolean).slice(0, 6);
    out.palette = pal.length >= 2 ? pal : [...DEFAULT_PALETTE];
  }
  return out;
}

function ledState(v) {
  const s = isObj(v) ? v : {};
  return { keyboard: deviceState(s.keyboard, KB_EFFECTS), mouse: deviceState(s.mouse, MOUSE_EFFECTS) };
}

// Accélérateur Electron : lettres, chiffres, signes usuels et « + »
function accelerator(v) {
  return typeof v === 'string' && v.length <= 64 && /^[\w+\-=`[\]\\;',./]+$/.test(v) ? v : '';
}

function step(v, keyNames, depth) {
  if (!isObj(v) || !STEP_TYPES.includes(v.type)) return null;
  const key = (k) => (keyNames.includes(k) ? k : null);
  const out = { type: v.type, gapMs: int(v.gapMs, 0, 60000, 15) };
  switch (v.type) {
    case 'keyTap':
      out.key = key(v.key);
      out.modifiers = (Array.isArray(v.modifiers) ? v.modifiers : []).map(key).filter(Boolean).slice(0, 4);
      if (!out.key) return null;
      break;
    case 'keyDown': case 'keyUp':
      out.key = key(v.key);
      if (!out.key) return null;
      break;
    case 'text': out.value = str(v.value, 10000); break;
    case 'delay': out.ms = int(v.ms, 0, 600000, 100); break;
    case 'mouseClick':
      out.button = BUTTONS.includes(v.button) ? v.button : 'left';
      out.count = int(v.count, 1, 100, 1);
      break;
    case 'mouseDown': case 'mouseUp':
      out.button = BUTTONS.includes(v.button) ? v.button : 'left';
      if (v.x !== undefined) out.x = int(v.x, -100000, 100000, 0);
      if (v.y !== undefined) out.y = int(v.y, -100000, 100000, 0);
      break;
    case 'mouseMove':
      out.x = int(v.x, -100000, 100000, 0);
      out.y = int(v.y, -100000, 100000, 0);
      out.relative = bool(v.relative);
      break;
    case 'mouseWheel':
      out.delta = int(v.delta, -6000, 6000, 120);
      out.horizontal = bool(v.horizontal);
      break;
    case 'loop':
      out.count = int(v.count, 1, 10000, 2);
      out.steps = depth >= MAX_LOOP_DEPTH ? [] : steps(v.steps, keyNames, depth + 1);
      break;
    case 'runMacro':
      out.macroId = id(v.macroId);
      if (!out.macroId) return null;
      break;
    case 'open':
      out.target = openTarget(v.target);
      if (!out.target) return null;
      break;
    case 'waitKey':
      out.key = key(v.key);
      out.timeoutMs = int(v.timeoutMs, 0, 600000, 0);
      if (!out.key) return null;
      break;
    case 'profile':
      out.name = str(v.name, 60).trim();
      if (!out.name) return null;
      break;
    case 'effect':
      if (!KB_EFFECTS.includes(v.effect)) return null;
      out.effect = v.effect;
      if (hex(v.color)) out.color = hex(v.color);
      break;
    default: return null;
  }
  return out;
}

function steps(v, keyNames, depth = 0) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 5000).map((s) => step(s, keyNames, depth)).filter(Boolean);
}

function macro(v, keyNames) {
  if (!isObj(v)) return null;
  const o = isObj(v.options) ? v.options : {};
  const accel = isObj(v.trigger) ? accelerator(v.trigger.accelerator) : '';
  return {
    id: id(v.id) || 'm_' + Math.random().toString(36).slice(2, 12),
    name: str(v.name, 100) || 'Macro importée',
    enabled: v.enabled !== false,
    trigger: accel ? { type: 'hotkey', accelerator: accel } : null,
    options: {
      repeat: int(o.repeat, 1, 9999, 1),
      loopInfinite: bool(o.loopInfinite),
      repeatDelayMs: int(o.repeatDelayMs, 0, 600000, 0),
      speed: num(o.speed, 0.25, 4, 1),
      holdMs: int(o.holdMs, 0, 1000, 0),
      jitter: int(o.jitter, 0, 50, 0),
    },
    steps: steps(v.steps, keyNames),
  };
}

function macros(v, keyNames) {
  return (Array.isArray(v) ? v : []).slice(0, 500).map((m) => macro(m, keyNames)).filter(Boolean);
}

function appName(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[\w .()+-]{1,96}\.exe$/.test(s) ? s : null;
}

// Plage horaire d'un profil programmé ({ from, to } en HH:MM), ou null
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function schedule(v) {
  if (!isObj(v) || !TIME_RE.test(v.from) || !TIME_RE.test(v.to) || v.from === v.to) return null;
  return { from: v.from, to: v.to };
}

function profile(v, keyNames) {
  if (!isObj(v)) return null;
  const name = str(v.name, 60).trim();
  if (!name) return null;
  return {
    name,
    savedAt: typeof v.savedAt === 'string' && !Number.isNaN(Date.parse(v.savedAt))
      ? v.savedAt : new Date().toISOString(),
    ledState: ledState(v.ledState),
    macros: macros(v.macros, keyNames),
    apps: (Array.isArray(v.apps) ? v.apps : []).map(appName).filter(Boolean).slice(0, 50),
    isDefault: bool(v.isDefault),
    schedule: schedule(v.schedule),
  };
}

function snippet(v) {
  if (!isObj(v)) return null;
  return {
    id: id(v.id) || 'm_' + Math.random().toString(36).slice(2, 12),
    abbr: str(v.abbr, 32),
    text: str(v.text, 20000),
    enabled: v.enabled !== false,
  };
}

function turbo(v, keyNames) {
  if (!isObj(v)) return null;
  const t = isObj(v.target) ? v.target : {};
  const target = t.type === 'key' && keyNames.includes(t.key)
    ? { type: 'key', key: t.key }
    : { type: 'mouse', button: BUTTONS.includes(t.button) ? t.button : 'left' };
  return {
    id: id(v.id) || 'm_' + Math.random().toString(36).slice(2, 12),
    target,
    cps: int(v.cps, 1, 50, 10),
    accelerator: accelerator(v.accelerator),
    enabled: v.enabled !== false,
  };
}

function keymap(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, slot] of Object.entries(v).slice(0, 256)) {
    if (/^[a-z0-9_]{1,24}$/.test(k) && Number.isInteger(slot) && slot >= 0 && slot < 256) out[k] = slot;
  }
  return out;
}

// Réglages restaurables depuis une sauvegarde (le lancement au démarrage
// dépend de la machine : jamais importé)
const SETTING_TYPES = {
  ledsEnabled: 'boolean', macrosEnabled: 'boolean', autoOptimize: 'boolean',
  autoOptimizeThreshold: 'number', appProfiles: 'boolean', idleOff: 'boolean',
  idleMinutes: 'number', autoCheckUpdates: 'boolean', autoInstallUpdates: 'boolean', offOnLock: 'boolean',
  flashOnMacro: 'boolean', keyStats: 'boolean', nightMode: 'boolean', nightFrom: 'string',
  nightTo: 'string', nightAction: 'string', nightLevel: 'number',
  lockIndicators: 'boolean', lockColor: 'string', timerMinutes: 'number', autoBackup: 'boolean',
  appShortcuts: 'object', theme: 'string',
};

// Raccourcis globaux de l'application (action -> accélérateur)
const APP_SHORTCUT_ACTIONS = ['leds', 'nextProfile', 'brightUp', 'brightDown', 'stopAll', 'timer', 'palette'];
function appShortcuts(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const a of APP_SHORTCUT_ACTIONS) out[a] = accelerator(v[a]);
  return out;
}

function settingsPatch(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, type] of Object.entries(SETTING_TYPES)) {
    if (typeof v[k] !== type) continue;
    if (k === 'autoOptimizeThreshold') out[k] = int(v[k], 50, 95, 80);
    else if (k === 'idleMinutes') out[k] = int(v[k], 1, 60, 10);
    else if (k === 'nightLevel') out[k] = int(v[k], 5, 100, 30);
    else if (k === 'timerMinutes') out[k] = int(v[k], 1, 180, 25);
    else if (k === 'lockColor') {
      const c = hex(v[k]);
      if (c) out[k] = c;
    } else if (k === 'theme') {
      if (['dark', 'light', 'system'].includes(v[k])) out[k] = v[k];
    } else if (k === 'appShortcuts') {
      if (isObj(v[k])) out[k] = appShortcuts(v[k]);
    }
    else if (k === 'nightFrom' || k === 'nightTo') {
      if (TIME_RE.test(v[k])) out[k] = v[k];
    } else if (k === 'nightAction') {
      if (v[k] === 'off' || v[k] === 'dim') out[k] = v[k];
    } else out[k] = v[k];
  }
  return out;
}

// Analyse un fichier importé. Renvoie { kind: 'profile', profile } ou
// { kind: 'backup', data }, ou lève une erreur lisible.
function parseImport(text, keyNames) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("ce fichier n'est pas un fichier Satella (JSON invalide)");
  }
  if (!isObj(doc) || doc.format !== FORMAT) throw new Error("ce fichier n'est pas un fichier Satella");
  if (typeof doc.version !== 'number' || doc.version > FORMAT_VERSION) {
    throw new Error('fichier créé par une version plus récente de Satella');
  }
  if (doc.kind === 'profile') {
    const p = profile(doc.profile, keyNames);
    if (!p) throw new Error('profil invalide');
    p.isDefault = false; // un import ne vole jamais le rôle de profil par défaut
    return { kind: 'profile', profile: p };
  }
  if (doc.kind === 'macro') {
    const m = macro(doc.macro, keyNames);
    if (!m) throw new Error('macro invalide');
    return { kind: 'macro', macro: m };
  }
  if (doc.kind === 'backup') {
    const d = isObj(doc.data) ? doc.data : {};
    const profiles = (Array.isArray(d.profiles) ? d.profiles : []).slice(0, 200)
      .map((p) => profile(p, keyNames)).filter(Boolean);
    // Un seul profil par défaut, noms uniques
    const seen = new Set();
    let hasDefault = false;
    const unique = profiles.filter((p) => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      if (p.isDefault) { if (hasDefault) p.isDefault = false; hasDefault = true; }
      return true;
    });
    return {
      kind: 'backup',
      data: {
        macros: macros(d.macros, keyNames),
        profiles: unique,
        snippets: (Array.isArray(d.snippets) ? d.snippets : []).slice(0, 500).map(snippet).filter(Boolean),
        turbos: (Array.isArray(d.turbos) ? d.turbos : []).slice(0, 100).map((t) => turbo(t, keyNames)).filter(Boolean),
        settings: settingsPatch(d.settings),
        keymap: keymap(d.keymap),
        ledState: ledState(d.ledState),
      },
    };
  }
  throw new Error('type de fichier Satella inconnu');
}

function makeExport(kind, payload, appVersion) {
  const doc = { format: FORMAT, version: FORMAT_VERSION, kind, exportedAt: new Date().toISOString(), appVersion };
  if (kind === 'profile') doc.profile = payload;
  else if (kind === 'macro') doc.macro = payload;
  else doc.data = payload;
  return JSON.stringify(doc, null, 2);
}

// Cibles des étapes « Ouvrir » contenues dans des macros (boucles comprises)
function openTargets(list) {
  const out = [];
  const walk = (steps) => (steps || []).forEach((s) => {
    if (s.type === 'open') out.push(s.target);
    if (s.type === 'loop') walk(s.steps);
  });
  (list || []).forEach((m) => walk(m.steps));
  return out;
}

// Mêmes macros sans aucune étape « Ouvrir »
function stripOpenSteps(list) {
  const clean = (steps) => (steps || []).filter((s) => s.type !== 'open')
    .map((s) => (s.type === 'loop' ? { ...s, steps: clean(s.steps) } : s));
  return (list || []).map((m) => ({ ...m, steps: clean(m.steps) }));
}

module.exports = {
  parseImport, makeExport, ledState, macro, macros, profile, snippet, turbo, keymap, settingsPatch,
  openTarget, openTargets, stripOpenSteps, schedule, KB_EFFECTS, MOUSE_EFFECTS, APP_SHORTCUT_ACTIONS,
};
