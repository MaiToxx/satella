// Réglages de performance de Windows (page Optimiseur) : mode
// d'alimentation, turbo du processeur, options de jeu, carte graphique par
// application, programmes lancés au démarrage, fichiers temporaires.
//
// Tout passe par les outils livrés avec Windows (powercfg, reg, PowerShell),
// appelés par leur chemin complet avec des arguments séparés : aucune donnée
// n'est interprétée par un interpréteur de commandes. Les lectures sont
// groupées dans une seule sonde PowerShell qui renvoie du JSON en UTF-8.
// Les fonctions d'analyse sont pures (testées sans Windows).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const power = require('./power');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------- Modes de gestion --

const BALANCED_PLAN = '381b4222-f694-41f0-9685-d5d57a8bd5c1';
const ULTIMATE_SOURCE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
// Noms des modes fournis par Windows (la sortie de powercfg peut perdre
// ses accents selon la page de code de la console)
const PLAN_NAMES = {
  [BALANCED_PLAN]: 'Utilisation normale',
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'Performances élevées',
  'a1841308-3541-4fab-bc81-f71556f20b4a': 'Économie d\'énergie',
  [ULTIMATE_SOURCE]: 'Performances optimales',
};

// Sortie de `powercfg /list` (toutes langues) : une ligne par mode,
// « GUID ... : <guid>  (Nom) * » où l'astérisque marque le mode actif
function parsePlans(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*(?:\((.*)\))?\s*(\*)?\s*$/i);
    if (!m) continue;
    const guid = m[1].toLowerCase();
    out.push({ guid, name: PLAN_NAMES[guid] || (m[2] || '').trim() || guid, active: !!m[3] });
  }
  return out;
}

const isUltimate = (plan) => plan.guid === ULTIMATE_SOURCE || /optimal|ultimate/i.test(plan.name);

// ------------------------------------------------- Turbo du processeur --

// PERFBOOSTMODE : 0 désactivé, 1 activé, 2 agressif, 3 activé (efficace),
// 4 agressif (efficace). `powercfg /q` affiche les valeurs courantes sur
// secteur puis sur batterie, en hexadécimal, en fin de sortie.
const BOOST_MODES = [0, 1, 2, 3, 4];

function parseBoost(text) {
  const vals = [...String(text || '').matchAll(/0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16));
  if (vals.length < 2) return null;
  return { ac: vals[vals.length - 2], dc: vals[vals.length - 1] };
}

// --------------------------------------- Préférences graphiques DirectX --

// « GpuPreference=2;SwapEffectUpgradeEnable=1; » <-> { GpuPreference: '2', ... }
function parseDx(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function formatDx(obj) {
  return Object.entries(obj)
    .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v};`)
    .join('');
}

// 0 : Windows décide, 1 : économie d'énergie (puce intégrée),
// 2 : hautes performances (carte dédiée)
const GPU_PREFS = [0, 1, 2];
const DX_GLOBAL = 'DirectXUserGlobalSettings';

// Chemin de programme acceptable pour une préférence graphique
function validExePath(p) {
  return typeof p === 'string' && p.length < 1024 && /^[a-z]:\\/i.test(p)
    && /\.exe$/i.test(p) && !/[\u0000-\u001f"*?<>|]/.test(p);
}

// -------------------------------------------------- Programmes au démarrage --

const SA = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const STARTUP_SCOPES = {
  hkcu: { approved: `HKCU\\${SA}\\Run`, machine: false },
  hklm: { approved: `HKLM\\${SA}\\Run`, machine: true },
  hklm32: { approved: `HKLM\\${SA}\\Run32`, machine: true },
  ufolder: { approved: `HKCU\\${SA}\\StartupFolder`, machine: false },
  cfolder: { approved: `HKLM\\${SA}\\StartupFolder`, machine: true },
};

// Premier octet de la valeur StartupApproved (comme le gestionnaire des
// tâches) : pair = activé, impair = désactivé ; absente = activé
const startupEnabled = (state) => !(Number.isInteger(state) && state >= 0 && (state & 1) === 1);
const startupData = (enabled) => (enabled ? '02' : '03') + '00'.repeat(11);

// ------------------------------------------------------ Matériel, conseils --

function classifyGpus(names) {
  const integrated = [];
  const dedicated = [];
  for (const n of names) {
    if (/basic display|basic render|virtual|parsec|remote|meta|spacedesk|citrix/i.test(n)) continue;
    if (/radeon(\(tm\))? graphics$|vega \d+ graphics|radeon(\(tm\))? \d+m graphics|intel.*(uhd|hd|iris)/i.test(n)) integrated.push(n);
    else dedicated.push(n);
  }
  return { integrated, dedicated };
}

const shortCpu = (s) => String(s || '')
  .replace(/\((R|TM)\)/gi, '')
  .replace(/\s+with\s+radeon.*$/i, '')
  .replace(/\s+(\d+-core\s+)?processor.*$/i, '')
  .replace(/\s+CPU\s+@.*$/i, '')
  .replace(/\s+/g, ' ')
  .trim();

// Conseils adaptés au PC détecté (textes courts, affichés tels quels)
function adviceFor(state) {
  const hw = state.hw || {};
  const tips = [];
  const { integrated, dedicated } = classifyGpus(hw.gpus || []);
  const dgpu = dedicated[0];
  const cpu = shortCpu(hw.cpu);
  if (integrated.length && dgpu) {
    tips.push({ id: 'hybrid', text: `Deux puces graphiques : ${integrated[0]} (économe) et ${dgpu} (puissante). `
      + `Pour chaque jeu, choisis « Hautes performances » dans Jeux > Carte graphique par application : il tournera sur la ${dgpu}.` });
  }
  if (hw.laptop) {
    tips.push({ id: 'plug', text: 'Pour jouer, branche le chargeur : sur batterie, Windows et la carte graphique brident les performances.' });
  }
  if (/\d{4,5}(H|HS|HX|HK)\b/.test(cpu)) {
    tips.push({ id: 'turbo', text: `Le processeur ${cpu} chauffe vite dans un portable. Le préréglage « Silencieux et frais » coupe son turbo : `
      + 'nettement moins chaud et plus silencieux, un peu moins rapide. « Jeu » le remet au maximum.' });
  }
  if (dgpu && /radeon|amd/i.test(dgpu)) {
    tips.push({ id: 'amd', text: 'Dans AMD Software (Adrenalin) : Radeon Chill limite les images par seconde quand l\'action est calme '
      + '(moins de chaleur et de bruit) et Radeon Anti-Lag réduit la latence. Garde le pilote graphique à jour.' });
  } else if (dgpu && /nvidia|geforce|rtx|gtx/i.test(dgpu)) {
    tips.push({ id: 'nvidia', text: 'Garde le pilote NVIDIA à jour ; dans le panneau NVIDIA, « Mode de faible latence » réduit le délai d\'affichage.' });
  }
  if (/dell/i.test(hw.maker || '') && hw.laptop) {
    tips.push({ id: 'dell', text: 'Dell : l\'application Dell Power Manager (ou My Dell) propose des profils thermiques. '
      + '« Ultra performance » pour jouer, « Refroidi » ou « Silencieux » le reste du temps.' });
  }
  if (hw.laptop) {
    tips.push({ id: 'air', text: 'Surélève l\'arrière du portable (ou utilise un support ventilé) et dépoussière les aérations de temps en temps : '
      + 'sur un portable de jeu, c\'est souvent le gain le plus net.' });
  }
  if (hw.ramGb && hw.ramGb < 12) {
    tips.push({ id: 'ram', text: `Avec ${hw.ramGb} Go de mémoire, active le nettoyage automatique dans l'onglet Mémoire.` });
  }
  const startupOn = (state.startup || []).filter((s) => s.enabled).length;
  if (startupOn > 6) {
    tips.push({ id: 'startup', text: `${startupOn} programmes se lancent avec Windows : désactive ceux dont tu ne te sers pas dans l'onglet Démarrage.` });
  }
  if (state.gameDvr) {
    tips.push({ id: 'dvr', text: 'L\'enregistrement Xbox (Game DVR) est actif : le couper (onglet Jeux) libère des ressources pendant les parties.' });
  }
  return tips;
}

// ----------------------------------------------------------- Préréglages --

const PRESETS = {
  game: { label: 'Jeu', overlay: 'performance', boost: 2 },
  balanced: { label: 'Équilibré', overlay: 'balanced', boost: 2 },
  quiet: { label: 'Silencieux et frais', overlay: 'efficiency', boost: 0 },
};

// Préréglage correspondant à l'état lu (ou null)
function currentPreset(state) {
  if (!state || !state.boost) return null;
  return Object.keys(PRESETS).find((id) => {
    const p = PRESETS[id];
    return state.overlay === p.overlay && state.boost.ac === p.boost && state.boost.dc === p.boost;
  }) || null;
}

// ------------------------------------------------------ Lecture groupée --

const winBuild = (release) => Number(String(release || '').split('.')[2]) || 0;
const toList = (v) => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]);
const baseName = (p) => String(p).split(/[\\/]/).pop();

// Résultat brut de la sonde -> état affiché par l'interface
function normalizeProbe(raw, env = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const plans = parsePlans(r.plans);
  const active = plans.find((p) => p.active) || null;
  const build = winBuild(env.release);
  const prefs = r.gpuPrefs && typeof r.gpuPrefs === 'object' ? r.gpuPrefs : {};
  const gpuApps = Object.entries(prefs)
    .filter(([k]) => k !== DX_GLOBAL && validExePath(k))
    .map(([p, v]) => {
      const pref = Number(parseDx(v).GpuPreference);
      return { path: p, name: baseName(p), pref: GPU_PREFS.includes(pref) ? pref : 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const startup = toList(r.startup)
    .filter((e) => e && STARTUP_SCOPES[e.scope] && typeof e.name === 'string' && e.name)
    .map((e) => ({
      id: `${e.scope}:${e.name}`,
      scope: e.scope,
      name: e.name,
      label: /folder$/.test(e.scope) ? e.name.replace(/\.(lnk|url|bat|cmd|exe)$/i, '') : e.name,
      command: String(e.cmd || ''),
      enabled: startupEnabled(Number(e.state)),
      machine: STARTUP_SCOPES[e.scope].machine,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  const num = (v, def) => (v === null || v === undefined || v === '' ? def : Number(v));
  const state = {
    available: true,
    admin: !!r.admin,
    plans,
    activePlan: active ? active.guid : null,
    canCreateUltimate: plans.length > 0 && !plans.some(isUltimate),
    // Le mode d'alimentation de Windows n'agit qu'avec « Utilisation normale »
    overlayUsable: !active || active.guid === BALANCED_PLAN,
    overlay: env.overlay ?? null,
    boost: parseBoost(r.boost),
    gameMode: num(r.gameMode, 1) !== 0,
    gameDvr: num(r.dvr, 1) !== 0 && num(r.capture, 1) !== 0,
    hags: Number(r.hags) === 2,
    windowed: build >= 22000 ? parseDx(prefs[DX_GLOBAL]).SwapEffectUpgradeEnable === '1' : null,
    gpuApps,
    startup,
    hw: {
      cpu: env.cpu || '',
      gpus: toList(r.gpus).map(String).filter(Boolean),
      maker: String(r.maker || '').trim(),
      model: String(r.model || '').trim(),
      laptop: !!r.battery,
      ramGb: env.totalmem ? Math.round(env.totalmem / 2 ** 30) : 0,
      build,
      onBattery: !!env.onBattery,
    },
  };
  state.preset = currentPreset(state);
  state.tips = adviceFor(state);
  return state;
}

// La sortie est du JSON en ASCII pur (caractères accentués échappés en
// \uXXXX) : elle se lit correctement quelle que soit la page de code de la
// console. SATELLA_LIGHT=1 saute la lecture du matériel (déjà connue).
const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function RegK($p) { try { Get-Item -LiteralPath $p -ErrorAction Stop } catch { $null } }
function RegV($p, $n) { $k = RegK $p; if ($k) { $k.GetValue($n) } else { $null } }
$o = @{}
$o.admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o.plans = (powercfg.exe /list | Out-String)
$o.boost = (powercfg.exe /q SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE | Out-String)
if ($o.boost -notmatch '0x') { $o.boost = (powercfg.exe /qh SCHEME_CURRENT SUB_PROCESSOR PERFBOOSTMODE | Out-String) }
$o.gameMode = RegV 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled'
$o.dvr = RegV 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled'
$o.capture = RegV 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled'
$o.hags = RegV 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'HwSchMode'
$gp = @{}
$k = RegK 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) { $gp[$n] = [string]$k.GetValue($n) } } }
$o.gpuPrefs = $gp
if ($env:SATELLA_LIGHT -ne '1') {
  $o.gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.Name })
  $cs = Get-CimInstance Win32_ComputerSystem
  $o.maker = [string]$cs.Manufacturer
  $o.model = [string]$cs.Model
  $o.battery = @(Get-CimInstance Win32_Battery).Count -gt 0
}
$sa = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
$st = @()
$runs = @(
  @('hkcu', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', "HKCU:\$sa\Run"),
  @('hklm', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', "HKLM:\$sa\Run"),
  @('hklm32', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run', "HKLM:\$sa\Run32"))
foreach ($s in $runs) {
  $rk = RegK $s[1]
  if (-not $rk) { continue }
  $ak = RegK $s[2]
  foreach ($n in $rk.GetValueNames()) {
    if (-not $n) { continue }
    $a = if ($ak) { $ak.GetValue($n) } else { $null }
    $st += @{ scope = $s[0]; name = $n; cmd = [string]$rk.GetValue($n); state = $(if ($a) { [int]$a[0] } else { -1 }) }
  }
}
$folders = @(
  @('ufolder', [Environment]::GetFolderPath('Startup'), "HKCU:\$sa\StartupFolder"),
  @('cfolder', [Environment]::GetFolderPath('CommonStartup'), "HKLM:\$sa\StartupFolder"))
foreach ($s in $folders) {
  if (-not $s[1]) { continue }
  $ak = RegK $s[2]
  foreach ($f in @(Get-ChildItem -LiteralPath $s[1] -File | Where-Object { $_.Name -ne 'desktop.ini' })) {
    $a = if ($ak) { $ak.GetValue($f.Name) } else { $null }
    $st += @{ scope = $s[0]; name = $f.Name; cmd = $f.FullName; state = $(if ($a) { [int]$a[0] } else { -1 }) }
  }
}
$o.startup = $st
$json = $o | ConvertTo-Json -Compress -Depth 4
[regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`;

// Lancement élevé de reg.exe (confirmation de Windows) pour les réglages
// communs à tous les utilisateurs quand Satella n'est pas administrateur.
// Arguments déjà mis entre guillemets, transmis par variable d'environnement.
const ELEVATE_SCRIPT = String.raw`
try {
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\reg.exe') -ArgumentList $env:SATELLA_ARGS -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
  exit $p.ExitCode
} catch { exit 1223 }
`;

// Mise entre guillemets d'un argument selon les règles de Windows
// (CommandLineToArgvW), pour une ligne de commande passée telle quelle
function quoteArg(a) {
  a = String(a);
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') out += '\\'.repeat(bs * 2 + 1) + '"';
    else out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

// ------------------------------------------------- Fichiers temporaires --

const TEMP_MIN_AGE = 24 * 3600 * 1000; // on ne touche pas aux fichiers récents

// Parcourt un dossier sans suivre les liens ni les jonctions
async function walkFiles(root, onFile, dirs = null, { maxEntries = 200000, maxDepth = 16 } = {}) {
  let count = 0;
  async function walk(dir, depth) {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    for (const name of names) {
      if (++count > maxEntries) return;
      const p = path.join(dir, name);
      let st;
      try { st = await fs.promises.lstat(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < maxDepth) {
          await walk(p, depth + 1);
          if (dirs) dirs.push(p);
        }
      } else if (st.isFile()) {
        await onFile(p, st);
      }
    }
  }
  await walk(root, 0);
}

async function tempInfo(dir, now = Date.now()) {
  let bytes = 0;
  let files = 0;
  await walkFiles(dir, (p, st) => {
    if (now - st.mtimeMs < TEMP_MIN_AGE) return;
    bytes += st.size;
    files++;
  });
  return { dir, bytes, files };
}

async function tempClean(dir, now = Date.now()) {
  let freed = 0;
  let removed = 0;
  let failed = 0;
  const dirs = [];
  await walkFiles(dir, async (p, st) => {
    if (now - st.mtimeMs < TEMP_MIN_AGE) return;
    try {
      await fs.promises.unlink(p);
      freed += st.size;
      removed++;
    } catch {
      failed++; // fichier ouvert par un programme
    }
  }, dirs);
  // Dossiers devenus vides (les plus profonds d'abord) ; jamais la racine
  for (const d of dirs) {
    try { await fs.promises.rmdir(d); } catch { /* pas vide */ }
  }
  return { ok: true, freed, removed, failed };
}

// ------------------------------------------------------ Moteur Windows --

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TOOLS = {
  powershell: path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  powercfg: path.join(SYS32, 'powercfg.exe'),
  reg: path.join(SYS32, 'reg.exe'),
};

function runFile(file, args, { env, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      // powercfg et reg écrivent parfois leurs erreurs sur la sortie standard
      const msg = (String(stderr || '').trim() || String(stdout || '').trim() || (err ? err.message : '')).slice(0, 300);
      resolve({ ok: !err, code, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? msg : null });
    });
  });
}

const fail = (res, fallback = 'échec') => ({ ok: false, error: (res && res.error) || fallback });

function createWindowsBackend({ run = runFile, pw = power, tmpdir = os.tmpdir } = {}) {
  let last = null;       // dernier état lu (valide les demandes de l'interface)
  let lastPrefs = {};    // préférences graphiques brutes
  let hwRaw = null;      // matériel lu une fois (les lectures suivantes le sautent)

  const ps = (script, env) => run(TOOLS.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)], { env, timeout: 45000 });
  const powercfg = (args) => run(TOOLS.powercfg, args);

  // reg.exe ; élevé (confirmation Windows) pour HKLM sans droits admin
  async function reg(args, machine = false) {
    if (!machine || (last && last.admin)) return run(TOOLS.reg, args);
    const res = await ps(ELEVATE_SCRIPT, { SATELLA_ARGS: args.map(quoteArg).join(' ') });
    if (res.code === 1223) return { ...res, ok: false, error: 'autorisation refusée' };
    return res.ok ? res : { ...res, error: res.error || `reg.exe a échoué (code ${res.code})` };
  }
  const dword = (key, name, value, machine) => reg(['add', key, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], machine);

  async function setBoost(ac, dc) {
    for (const [flag, v] of [['/setacvalueindex', ac], ['/setdcvalueindex', dc]]) {
      if (v === undefined || v === null) continue;
      if (!BOOST_MODES.includes(v)) return { ok: false, error: 'valeur invalide' };
      const r = await powercfg([flag, 'SCHEME_CURRENT', 'SUB_PROCESSOR', 'PERFBOOSTMODE', String(v)]);
      if (!r.ok) return fail(r);
    }
    const r = await powercfg(['/setactive', 'SCHEME_CURRENT']);
    return r.ok ? { ok: true } : fail(r);
  }

  return {
    async probe({ onBattery = false } = {}) {
      const res = await ps(PROBE_SCRIPT, hwRaw ? { SATELLA_LIGHT: '1' } : undefined);
      let raw = null;
      try { raw = JSON.parse(res.stdout.replace(/^\uFEFF/, '').trim() || 'null'); } catch { raw = null; }
      if (raw && typeof raw === 'object') {
        if (hwRaw) Object.assign(raw, hwRaw);
        else hwRaw = { gpus: raw.gpus, maker: raw.maker, model: raw.model, battery: raw.battery };
      }
      lastPrefs = raw && raw.gpuPrefs && typeof raw.gpuPrefs === 'object' ? raw.gpuPrefs : {};
      const state = normalizeProbe(raw, {
        overlay: pw.getOverlay(),
        release: os.release(),
        totalmem: os.totalmem(),
        cpu: (os.cpus()[0] || {}).model,
        onBattery,
      });
      if (!raw) state.error = 'lecture des réglages de Windows impossible' + (res.error ? ` (${res.error.slice(0, 200)})` : '');
      last = state;
      return state;
    },

    setOverlay: async (id) => pw.setOverlay(id),
    setBoost,

    async setPlan(guid) {
      if (!GUID_RE.test(guid) || !(last && last.plans.some((p) => p.guid === guid))) return { ok: false, error: 'mode inconnu' };
      const r = await powercfg(['/setactive', guid]);
      return r.ok ? { ok: true } : fail(r);
    },

    // Ajoute le mode « Performances optimales » (copie du modèle caché de
    // Windows) et l'active
    async createUltimate() {
      const r = await powercfg(['/duplicatescheme', ULTIMATE_SOURCE]);
      const m = r.ok && r.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (!m) return fail(r, 'mode non disponible sur ce PC');
      const a = await powercfg(['/setactive', m[0].toLowerCase()]);
      return a.ok ? { ok: true, guid: m[0].toLowerCase() } : fail(a);
    },

    async setGameMode(on) {
      const r = await dword('HKCU\\Software\\Microsoft\\GameBar', 'AutoGameModeEnabled', on ? 1 : 0);
      if (!r.ok) return fail(r);
      await dword('HKCU\\Software\\Microsoft\\GameBar', 'AllowAutoGameMode', on ? 1 : 0);
      return { ok: true };
    },

    async setGameDvr(on) {
      const a = await dword('HKCU\\System\\GameConfigStore', 'GameDVR_Enabled', on ? 1 : 0);
      if (!a.ok) return fail(a);
      const b = await dword('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled', on ? 1 : 0);
      return b.ok ? { ok: true } : fail(b);
    },

    // Planification GPU à accélération matérielle : réglage machine,
    // pris en compte au prochain redémarrage
    async setHags(on) {
      const r = await dword('HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', 'HwSchMode', on ? 2 : 1, true);
      return r.ok ? { ok: true, restart: true } : fail(r);
    },

    // Optimisations pour les jeux en fenêtre (Windows 11)
    async setWindowed(on) {
      const cur = parseDx(lastPrefs[DX_GLOBAL]);
      cur.SwapEffectUpgradeEnable = on ? '1' : '0';
      const r = await reg(['add', 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences', '/v', DX_GLOBAL, '/t', 'REG_SZ', '/d', formatDx(cur), '/f']);
      return r.ok ? { ok: true } : fail(r);
    },

    // Carte graphique d'un programme ; pref null = retirer de la liste
    async setGpuPref(exe, pref) {
      if (!validExePath(exe)) return { ok: false, error: 'programme invalide' };
      const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
      if (pref === null) {
        const r = await reg(['delete', key, '/v', exe, '/f']);
        return r.ok ? { ok: true } : fail(r);
      }
      if (!GPU_PREFS.includes(pref)) return { ok: false, error: 'valeur invalide' };
      const cur = parseDx(lastPrefs[exe]);
      cur.GpuPreference = String(pref);
      const r = await reg(['add', key, '/v', exe, '/t', 'REG_SZ', '/d', formatDx(cur), '/f']);
      if (r.ok) lastPrefs[exe] = formatDx(cur);
      return r.ok ? { ok: true } : fail(r);
    },

    async setStartup(id, enabled) {
      const e = last && last.startup.find((s) => s.id === id);
      if (!e) return { ok: false, error: 'programme introuvable' };
      const scope = STARTUP_SCOPES[e.scope];
      const r = await reg(['add', scope.approved, '/v', e.name, '/t', 'REG_BINARY', '/d', startupData(!!enabled), '/f'], scope.machine);
      return r.ok ? { ok: true } : fail(r);
    },

    tempInfo: () => tempInfo(tmpdir()),
    tempClean: () => tempClean(tmpdir()),
  };
}

// Préréglage : mode d'alimentation + turbo (secteur et batterie)
async function applyPreset(backend, id) {
  const p = PRESETS[id];
  if (!backend || !p) return { ok: false, error: 'préréglage inconnu' };
  const errors = [];
  const o = await backend.setOverlay(p.overlay);
  if (!o.ok) errors.push(`mode d'alimentation : ${o.error}`);
  const b = await backend.setBoost(p.boost, p.boost);
  if (!b.ok) errors.push(`turbo : ${b.error}`);
  return errors.length ? { ok: false, error: errors.join(' ; ') } : { ok: true };
}

// Moteur choisi au démarrage : Windows, ou simulé pour les tests de bout
// en bout (SATELLA_FAKE_TUNING=1), sinon aucun
function createBackend() {
  if (process.env.SATELLA_FAKE_TUNING === '1') return require('./tuning-fake').create();
  if (process.platform === 'win32') return createWindowsBackend();
  return null;
}

module.exports = {
  BALANCED_PLAN, ULTIMATE_SOURCE, BOOST_MODES, GPU_PREFS, PRESETS, STARTUP_SCOPES, PROBE_SCRIPT,
  parsePlans, parseBoost, parseDx, formatDx, validExePath, startupEnabled, startupData,
  classifyGpus, shortCpu, adviceFor, currentPreset, normalizeProbe, quoteArg, encodePs,
  tempInfo, tempClean, createWindowsBackend, applyPreset, createBackend,
};
