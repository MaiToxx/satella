// Satella — processus principal Electron.
// Assemble : moteur d'effets LED, pilote USB direct, moteur de macros,
// persistance et IPC vers l'interface.

const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage,
  powerMonitor, dialog, shell, clipboard, screen, session, desktopCapturer, Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');

// Mise à jour automatique via les releases GitHub du dépôt MaiToxx/satella
// (configuré dans package.json, section build.publish). Publier une version :
// bump de version, puis `npx electron-builder --win --publish always`.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./src/store');
const logger = require('./src/system/logger');
const { LedEngine, DEFAULT_DEVICE_STATE, hexToRgb, TIMER_DONE_MS } = require('./src/led/engine');
const { DirectBackend } = require('./src/led/direct');
const hid = require('./src/led/hid');
const memory = require('./src/system/memory');
const foreground = require('./src/system/foreground');
const idle = require('./src/system/idle');
const locks = require('./src/system/locks');
const { MacroEngine, hookAvailable } = require('./src/macros/engine');
const { SnippetEngine } = require('./src/macros/snippets');
const input = require('./src/macros/input');
const keys = require('./src/macros/keys');
const layout = require('./src/shared/layout');
const sanitize = require('./src/shared/sanitize');
const { inTimeWindow, autoProfileFor } = require('./src/system/schedule');

// Dossier de données séparé (tests, version de développement lancée à
// côté de la version installée) : SATELLA_USER_DATA=<dossier>
if (process.env.SATELLA_USER_DATA) app.setPath('userData', path.resolve(process.env.SATELLA_USER_DATA));

// Une seule instance : un deuxième lancement (raccourci, démarrage de
// Windows) réaffiche simplement la fenêtre existante au lieu de piloter
// le même clavier en parallèle.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('Satella tourne déjà (zone de notification) : sa fenêtre est réaffichée. '
    + 'Pour lancer une version de développement à côté, utilise un autre dossier de données : SATELLA_USER_DATA=<dossier>.');
  app.quit();
}

let win = null;
let tray = null;
let quitting = false;
let store, ledEngine, direct, macroEngine, snippetEngine;
let macros = [];
let turbos = [];
const turboRunning = new Map(); // id -> { timer, release }
let calibrating = false;
let hookDebug = false;
let detectTimer = null;
let autoOptTimer = null;
let lastAutoOpt = 0;
let fgTimer = null;
let idleTimer = null;
let nightTimer = null;
let nightDim = null;            // facteur d'atténuation du mode nuit, ou null
let nightOverride = false;      // LED rallumées à la main pendant la plage du mode nuit
let lockTimer = null;           // témoins Verr. Maj / Verr. Num
let liveLayers = false;         // calques temporaires affichés (flux temps réel)
let timer = null;               // minuteur { t0, ms, minutes, done, endTimer, clearTimer }
let backupTimer = null;
let keyStats = { counts: {}, total: 0, since: null };
let sysmonTimer = null;
let lastCpu = null;
let lastFgExe = '';
let lastAutoTarget = null;      // dernier profil choisi par la bascule automatique
let uiPage = 'home';
let captureKind = null; // effet capturé en cours : 'audio' | 'screen' | null
let shortcutErrors = [];
let boundsTimer = null;
let updateReadyVersion = null;   // mise à jour téléchargée, prête à installer
let updateDownloading = false;
let whatsNew = null;             // nouveautés à montrer après une mise à jour

// Raisons d'extinction des LED (inactivité, session verrouillée, choix
// manuel depuis la zone de notification) : allumées quand il n'y en a aucune.
const dimReasons = new Set();
const isDimmed = () => dimReasons.size > 0;

// Profil actif : les modifications d'éclairage et de macros y sont
// enregistrées au fil de l'eau, une bascule automatique ne perd donc rien.
// `dirty` : réglages courants modifiés alors qu'aucun profil n'est actif.
let sessionState = { activeProfile: null, dirty: false };
let profileSyncTimer = null;
let applyingProfile = false;
const UNSAVED_PROFILE = 'Réglages non sauvegardés';

// Modules activables (page Paramètres) : couper un module libère ses
// ressources (timers, écoute clavier, poignées USB).
const DEFAULT_SETTINGS = {
  ledsEnabled: true,
  macrosEnabled: true,
  autoOptimize: false,
  autoOptimizeThreshold: 80,
  launchAtStartup: false,
  startMinimized: true,
  appProfiles: true,
  idleOff: false,
  idleMinutes: 10,
  autoCheckUpdates: true,
  autoInstallUpdates: false,
  offOnLock: false,
  flashOnMacro: false,
  keyStats: false,          // statistiques de frappe (comptage par touche, local)
  nightMode: false,         // mode nuit programmé
  nightFrom: '23:00',
  nightTo: '07:00',
  nightAction: 'off',       // 'off' (éteindre) | 'dim' (atténuer)
  nightLevel: 30,           // % de luminosité en mode « atténuer »
  lockIndicators: false,    // témoins Verr. Maj / Verr. Num sur le clavier
  lockColor: '#ffffff',
  timerMinutes: 25,         // durée du minuteur (dernière utilisée)
  autoBackup: true,         // sauvegarde automatique quotidienne des données
  appShortcuts: {},         // raccourcis globaux de l'application : action -> accélérateur
};

// Démarrage silencieux : Windows relance Satella avec ce drapeau
const startedHidden = process.argv.includes('--hidden');
let settings = { ...DEFAULT_SETTINGS };

const AUTO_OPT_COOLDOWN = 10 * 60 * 1000;

// ---------------------------------------------------------------- Fenêtre --

// Position et taille mémorisées, si elles tombent encore sur un écran
function savedBounds() {
  const b = store.read('window', null);
  if (!b || !b.width || !b.height) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100
    && b.y < area.y + area.height - 50 && b.y + 40 > area.y;
  return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  store.writeLater('window', { ...win.getNormalBounds(), maximized: win.isMaximized() }, 1000);
}

function createWindow() {
  const b = savedBounds() || {};
  win = new BrowserWindow({
    width: Math.max(1080, b.width || 1280),
    height: Math.max(680, b.height || 820),
    x: b.x,
    y: b.y,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'Satella',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // La capture audio (effet visualiseur) doit continuer fenêtre cachée
      backgroundThrottling: false,
    },
  });
  if (b.maximized) win.maximize();
  if (!startedHidden) win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Aucune navigation ni fenêtre externe depuis l'interface
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Fermer la fenêtre = minimiser en zone de notification : Satella
  // continue de tourner (macros, effets). Quitter via l'icône de la zone
  // de notification, ou lors d'une mise à jour.
  win.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  const queueBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', queueBounds);
  win.on('move', queueBounds);

  win.webContents.on('did-finish-load', () => {
    if (ledEngine) ledEngine.renderOnce();
    if (captureKind) startCaptureInRenderer();
  });

  // Signature (event, level, message, line, sourceId) jusqu'à Electron 34,
  // puis un objet événement unique : les deux sont pris en charge.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const lvl = typeof e.level === 'string' ? e.level : ['debug', 'info', 'warning', 'error'][level];
    const msg = e.message !== undefined ? e.message : message;
    const ln = e.lineNumber !== undefined ? e.lineNumber : line;
    const src = e.sourceId !== undefined ? e.sourceId : sourceId;
    if (lvl === 'warning' || lvl === 'error') {
      console.log(`[UI ${lvl === 'error' ? 'ERREUR' : 'avert.'}] ${msg} (${src}:${ln})`);
    }
  });

  // Capture d'écran de diagnostic : SATELLA_SHOT=<fichier.png> [SATELLA_PAGE=<page>]
  if (process.env.SATELLA_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      if (process.env.SATELLA_PAGE) {
        try {
          await win.webContents.executeJavaScript(
            `document.querySelector('.nav-btn[data-page="${process.env.SATELLA_PAGE}"]').click()`);
        } catch (err) {
          console.log('[capture] navigation impossible :', err.message);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.SATELLA_SHOT, img.toPNG());
      quitting = true;
      app.quit();
    });
  }
}

function revealWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (ledEngine) ledEngine.renderOnce(); // l'aperçu était en veille
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function previewVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    && ['home', 'keyboard', 'mouse'].includes(uiPage));
}

// ------------------------------------------------------------ Démarrage --

function migrateLegacyData() {
  // L'application s'appelait « Lynn » : récupère les données existantes
  // (%APPDATA%/lynn-rgb/lynn-data) si le nouveau dossier n'existe pas encore.
  const newDir = path.join(app.getPath('userData'), 'satella-data');
  const oldDir = path.join(app.getPath('appData'), 'lynn-rgb', 'lynn-data');
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try {
      fs.cpSync(oldDir, newDir, { recursive: true });
      console.log('Données migrées depuis', oldDir);
    } catch (err) {
      console.log('Migration des données impossible :', err.message);
    }
  }
}

// Forme comparable d'un état LED (champs manquants complétés)
function canonLed(ls) {
  return JSON.stringify(['keyboard', 'mouse'].map((d) => ({ ...DEFAULT_DEVICE_STATE(), ...((ls && ls[d]) || {}) })));
}

function setupEngines() {
  logger.init(path.join(app.getPath('userData'), 'logs'));
  console.log(`Satella ${app.getVersion()} (Electron ${process.versions.electron}, ${os.platform()} ${os.release()})`);
  migrateLegacyData();
  store = new Store(path.join(app.getPath('userData'), 'satella-data'), { log: (m) => console.log('[données]', m) });
  ledEngine = new LedEngine();
  direct = new DirectBackend();
  const clipboardRead = () => clipboard.readText();
  macroEngine = new MacroEngine({ globalShortcut, opener: openTargetSafely, clipboardRead });
  snippetEngine = new SnippetEngine({ clipboardRead });
  turbos = store.read('turbos', []);

  // État LED sauvegardé
  ledEngine.loadState(store.read('led-state', null));

  // Statistiques de frappe (comptage par touche uniquement, jamais la suite
  // des touches tapées)
  keyStats = { counts: {}, total: 0, since: null, ...store.read('key-stats', {}) };
  ledEngine.setHeatmap(keyStats.counts);

  // Macros sauvegardées (déclencheurs enregistrés par applySettings)
  macros = store.read('macros', []);

  settings = { ...DEFAULT_SETTINGS, ...store.read('settings', {}) };
  checkWhatsNew();

  // Profil actif. Première exécution de cette version : on reconnaît le
  // profil identique aux réglages courants ; sinon les réglages courants
  // sont protégés (sauvegardés avant toute bascule automatique).
  const saved = store.read('session', null);
  if (saved) {
    sessionState = { activeProfile: saved.activeProfile || null, dirty: !!saved.dirty };
  } else {
    const profiles = store.read('profiles', []);
    const cur = canonLed(ledEngine.state) + JSON.stringify(macros);
    const match = profiles.find((p) => canonLed(p.ledState) + JSON.stringify(p.macros || []) === cur);
    sessionState = { activeProfile: match ? match.name : null, dirty: !match && profiles.length > 0 };
    saveSession();
  }

  // Le moteur ne calcule des images que si quelqu'un les regarde
  ledEngine.wantFrames = () => previewVisible() || streamingKeyboard();

  // Diffusion des images : aperçu UI (seulement page visible) + flux temps
  // réel vers le clavier pour les effets logiciels. Les effets natifs sont
  // programmés dans le matériel lors des changements d'état.
  ledEngine.on('frame', (frame) => {
    if (previewVisible()) win.webContents.send('led:frame', frame);
    if (streamingKeyboard()) direct.streamKeyboard(frame.keyboard);
  });
  ledEngine.on('state', (state) => {
    store.writeLater('led-state', state, 400);
    if (settings.ledsEnabled && !isDimmed()) {
      direct.applyKeyboard(hwState('keyboard'));
      direct.applyMouse(hwState('mouse'));
    }
    updateHookNeed();
    updateSysmon();
    updateCapture();
    profileChanged();
  });

  direct.on('status', (s) => send('devices:direct', s));
  direct.on('log', (msg) => console.log('[direct]', msg));
  // Périphérique (re)branché : lui réécrire l'état courant
  direct.on('connected', (device) => {
    console.log('[direct] connecté :', device);
    applyLeds();
  });

  // Carte des touches calibrée par l'utilisateur, si présente
  const savedKeyMap = store.read('keymap', null);
  if (savedKeyMap) direct.setKeyMap(savedKeyMap);

  // Effet réactif : frappe réelle -> touche allumée.
  // Cas AltGr : Windows synthétise un appui Ctrl gauche juste avant Alt
  // droit. On retient Ctrl gauche 30 ms ; si Alt droit suit, c'est le
  // doublon synthétique et on le jette (sinon l'onde de choc part de
  // l'emplacement de Ctrl gauche à chaque AltGr).
  let pendingLCtrl = null;
  const deliverKey = (key) => {
    ledEngine.keyActivity(key);
    send('macro:key-activity', { key });
  };
  macroEngine.on('key-activity', ({ key, down, shift, ctrl, alt, meta }) => {
    if (!down || !key) return;
    // Statistiques : seulement les frappes de l'utilisateur
    if (settings.keyStats && !calibrating && turboRunning.size === 0 && !macroEngine.busy) {
      keyStats.counts[key] = (keyStats.counts[key] || 0) + 1;
      keyStats.total++;
      if (!keyStats.since) keyStats.since = new Date().toISOString();
      store.writeLater('key-stats', keyStats, 5000);
    }
    // Expansion de texte : uniquement la frappe naturelle de l'utilisateur
    // (pas pendant un enregistrement, une calibration, une macro ou un turbo)
    if (settings.macrosEnabled && !macroEngine.recording && !calibrating
      && turboRunning.size === 0 && !macroEngine.busy) {
      snippetEngine.feed(key, { shift, ctrl, alt, meta });
    }
    if (key === 'lctrl') {
      clearTimeout(pendingLCtrl);
      pendingLCtrl = setTimeout(() => {
        pendingLCtrl = null;
        deliverKey('lctrl');
      }, 30);
      return;
    }
    if (key === 'ralt' && pendingLCtrl) {
      clearTimeout(pendingLCtrl);
      pendingLCtrl = null;
    }
    deliverKey(key);
  });
  // Un clic = l'utilisateur change probablement de champ de saisie
  macroEngine.on('mouse-activity', () => snippetEngine.reset());
  macroEngine.on('record-event', (step) => send('macro:record-event', step));
  macroEngine.on('play-state', (s) => {
    send('macro:play-state', s);
    if (settings.flashOnMacro) flashKeyboard(s.playing ? [0, 255, 120] : [255, 40, 40]);
  });
  // Étape « Attendre une touche » : l'écoute globale suit le besoin
  macroEngine.on('wait-change', () => updateHookNeed());
  macroEngine.on('play-error', (e) => {
    console.log('[macro]', e.id, e.message);
    send('macro:play-error', e);
  });

  applySettings();
}

const streamingKeyboard = () => settings.ledsEnabled && !isDimmed() && !!direct.kb
  && direct.isStreamed(hwState('keyboard'));

// Active ou coupe les modules selon les paramètres, à chaud.
function applySettings() {
  // --- Éclairage ---
  if (settings.ledsEnabled) {
    ledEngine.start();
    direct.detect();
    applyLeds();
    if (!detectTimer) {
      detectTimer = setInterval(() => {
        if (!direct.kb || !direct.mouse) direct.detect();
      }, 5000);
    }
  } else {
    ledEngine.stop();
    clearInterval(detectTimer);
    detectTimer = null;
    direct.dispose();
  }

  // --- Macros, turbos et expansion de texte ---
  refreshShortcuts();

  // --- Lancement avec Windows ---
  // En développement, l'entrée pointerait vers electron.exe : on ne touche
  // au registre que pour l'application installée.
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtStartup,
      path: process.execPath,
      args: settings.startMinimized ? ['--hidden'] : [],
    });
  }

  // --- Optimiseur automatique ---
  clearInterval(autoOptTimer);
  autoOptTimer = null;
  if (settings.autoOptimize && memory.available()) {
    autoOptTimer = setInterval(autoOptimizeTick, 60000);
  }

  // --- Profils automatiques (application au premier plan, horaires) ---
  clearInterval(fgTimer);
  fgTimer = null;
  if (settings.appProfiles) {
    fgTimer = setInterval(foregroundTick, 3000);
  }

  // --- Extinction automatique des LED ---
  clearInterval(idleTimer);
  idleTimer = null;
  if (settings.idleOff && settings.ledsEnabled && idle.available()) {
    idleTimer = setInterval(idleTick, 2000);
  } else {
    setDim('idle', false);
  }
  if (!settings.offOnLock) setDim('lock', false);

  // --- Mode nuit programmé ---
  clearInterval(nightTimer);
  nightTimer = null;
  if (settings.nightMode && settings.ledsEnabled) {
    nightTimer = setInterval(nightTick, 30000);
  }
  nightTick();

  // --- Témoins Verr. Maj / Verr. Num ---
  clearInterval(lockTimer);
  lockTimer = null;
  if (settings.lockIndicators && settings.ledsEnabled && locks.available()) {
    lockTimer = setInterval(lockTick, 250);
    lockTick();
  } else {
    ledEngine.setIndicators({});
    refreshLiveLayers();
  }

  // --- Sauvegarde automatique (au plus une par jour, données modifiées) ---
  if (settings.autoBackup && !backupTimer) {
    backupTimer = setInterval(() => autoBackup(), 3 * 3600 * 1000);
    setTimeout(() => { if (settings.autoBackup) autoBackup(); }, 20000);
  } else if (!settings.autoBackup) {
    clearInterval(backupTimer);
    backupTimer = null;
  }

  updateHookNeed();
  updateSysmon();
  updateCapture();
  rebuildTrayMenu();
  send('settings:changed', settings);
}

// ----------------------------------------------------- Raccourcis globaux --

// Forme normalisée d'un accélérateur pour repérer les doublons
// (« Shift+Ctrl+A » = « ctrl+shift+a »)
function normAccel(a) {
  const parts = String(a || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const alias = { control: 'ctrl', cmdorctrl: 'ctrl', commandorcontrol: 'ctrl', option: 'alt', meta: 'super', cmd: 'super', command: 'super' };
  const norm = parts.map((p) => alias[p] || p);
  const key = norm.pop();
  return [...new Set(norm)].sort().concat(key).join('+');
}

// Raccourcis globaux : macros puis turbos (setMacros efface tout avant de
// réenregistrer, les turbos doivent donc toujours passer après). Les
// raccourcis refusés (doublon, pris par une autre application) sont
// signalés à l'interface.
function refreshShortcuts() {
  shortcutErrors = [];
  if (settings.macrosEnabled) {
    const owners = new Map(); // accélérateur normalisé -> premier propriétaire
    for (const m of macros) {
      if (!m.enabled || !m.trigger || !m.trigger.accelerator) continue;
      const k = normAccel(m.trigger.accelerator);
      if (!owners.has(k)) owners.set(k, `macro « ${m.name} »`);
    }
    const describe = (err, label) => {
      const owner = owners.get(normAccel(err.accelerator));
      return {
        ...err,
        reason: owner && owner !== label
          ? `déjà utilisé par la ${owner}`
          : 'refusé par Windows (déjà pris par une autre application ?)',
      };
    };
    for (const err of macroEngine.setMacros(macros)) {
      const m = macros.find((x) => x.id === err.id);
      shortcutErrors.push(describe(err, m ? `macro « ${m.name} »` : ''));
    }
    turbos.forEach((t, i) => {
      if (!t.enabled || !t.accelerator) return;
      const label = `turbo n°${i + 1}`;
      const k = normAccel(t.accelerator);
      if (!owners.has(k)) owners.set(k, label);
      let ok = false;
      try {
        ok = globalShortcut.register(t.accelerator, () => toggleTurbo(t.id));
      } catch { /* accélérateur invalide */ }
      if (!ok) shortcutErrors.push(describe({ kind: 'turbo', id: t.id, accelerator: t.accelerator }, label));
    });
    snippetEngine.setSnippets(store.read('snippets', []));
  } else {
    macroEngine.stop();
    stopAllTurbos();
    globalShortcut.unregisterAll();
    snippetEngine.setSnippets([]);
  }
  registerAppShortcuts();
  if (shortcutErrors.length) {
    console.log('[raccourcis] refusés :', shortcutErrors.map((e) => `${e.accelerator} (${e.reason})`).join(', '));
  }
  send('shortcuts:errors', shortcutErrors);
}

// Raccourcis de l'application (Paramètres) : actifs même macros coupées.
// Enregistrés après ceux des macros et turbos, qui gardent la priorité.
const APP_ACTIONS = {
  leds: { label: 'allumer / éteindre les LED', run: () => setLedsOff(!isDimmed()) },
  nextProfile: { label: 'profil suivant', run: () => cycleProfile() },
  brightUp: { label: 'luminosité +', run: () => stepBrightness(1) },
  brightDown: { label: 'luminosité −', run: () => stepBrightness(-1) },
  stopAll: { label: 'tout arrêter', run: () => { macroEngine.stop(); stopAllTurbos(); } },
  timer: { label: 'minuteur', run: () => (timer ? stopTimer() : startTimer(settings.timerMinutes)) },
};

function registerAppShortcuts() {
  const taken = new Map();
  if (settings.macrosEnabled) {
    for (const m of macros) {
      if (m.enabled && m.trigger && m.trigger.accelerator) taken.set(normAccel(m.trigger.accelerator), `macro « ${m.name} »`);
    }
    turbos.forEach((t, i) => {
      if (t.enabled && t.accelerator) taken.set(normAccel(t.accelerator), `turbo n°${i + 1}`);
    });
  }
  const shortcuts = settings.appShortcuts || {};
  for (const [action, def] of Object.entries(APP_ACTIONS)) {
    const accel = shortcuts[action];
    if (!accel) continue;
    const k = normAccel(accel);
    const owner = taken.get(k);
    if (owner) {
      shortcutErrors.push({ kind: 'app', id: action, accelerator: accel, reason: `déjà utilisé par la ${owner}` });
      continue;
    }
    taken.set(k, `commande « ${def.label} »`);
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        try { def.run(); } catch (err) { console.log('[raccourci]', action, err.message); }
      });
    } catch { /* accélérateur invalide */ }
    if (!ok) {
      shortcutErrors.push({
        kind: 'app', id: action, accelerator: accel,
        reason: 'refusé par Windows (déjà pris par une autre application ?)',
      });
    }
  }
}

// Profil suivant (ordre de la page Profils), appliqué comme un choix manuel
function cycleProfile() {
  const profiles = store.read('profiles', []).filter((p) => p.name !== UNSAVED_PROFILE);
  if (!profiles.length) return;
  const i = profiles.findIndex((p) => p.name === sessionState.activeProfile);
  const next = profiles[(i + 1) % profiles.length];
  const res = loadProfileByName(next.name);
  if (res) send('profiles:autoApplied', { name: next.name, exe: null, manual: true, ...res });
}

// Luminosité par paliers (le clavier n'en a que 4 en mode natif) ; jamais
// jusqu'à l'extinction
const BRIGHT_STEPS = [25, 50, 75, 100];
function stepBrightness(dir) {
  for (const device of ['keyboard', 'mouse']) {
    const cur = ledEngine.state[device].brightness;
    const next = dir > 0
      ? (BRIGHT_STEPS.find((v) => v > cur) || 100)
      : ([...BRIGHT_STEPS].reverse().find((v) => v < cur) || 25);
    if (next !== cur) ledEngine.setDeviceState(device, { brightness: next });
  }
  send('led:state', ledEngine.state);
}

// Mode turbo : le raccourci démarre ou coupe la répétition automatique.
// Chaque coup est un vrai appui maintenu quelques millisecondes (les jeux
// ignorent souvent un appui de 0 ms).
function toggleTurbo(id) {
  const t = turbos.find((x) => x.id === id);
  if (!t) return;
  if (turboRunning.has(id)) {
    stopTurbo(id);
    return;
  }
  if (!input.available) return;
  const cps = Math.max(1, Math.min(50, t.cps || 10));
  const period = Math.round(1000 / cps);
  const hold = Math.max(1, Math.min(15, Math.floor(period / 3)));
  const target = t.target || { type: 'mouse', button: 'left' };
  let held = false;
  let upTimer = null;
  const release = () => {
    clearTimeout(upTimer);
    upTimer = null;
    if (!held) return;
    held = false;
    try {
      if (target.type === 'key') input.keyUp(target.key);
      else input.mouseButton(target.button || 'left', true);
    } catch { /* ignore */ }
  };
  const fire = () => {
    release();
    try {
      if (target.type === 'key') input.keyDown(target.key);
      else input.mouseButton(target.button || 'left', false);
      held = true;
    } catch { return; }
    upTimer = setTimeout(release, hold);
  };
  fire();
  turboRunning.set(id, { timer: setInterval(fire, period), release });
  send('turbo:state', { id, running: true });
  if (settings.flashOnMacro) flashKeyboard([255, 170, 0]);
}

function stopTurbo(id) {
  const st = turboRunning.get(id);
  if (!st) return;
  clearInterval(st.timer);
  st.release();
  turboRunning.delete(id);
  send('turbo:state', { id, running: false });
  if (settings.flashOnMacro) flashKeyboard([255, 40, 40]);
}

function stopAllTurbos() {
  for (const id of [...turboRunning.keys()]) stopTurbo(id);
}

// ------------------------------------------------------------ Éclairage --

// Envoie l'état d'éclairage courant au matériel (ou l'extinction si une
// raison est active). Sans `force`, un état identique au dernier écrit
// n'est pas réécrit (la flash du clavier est sollicitée à chaque écriture).
function applyLeds({ force = false } = {}) {
  if (!settings.ledsEnabled) return;
  if (isDimmed()) {
    applyDimmed();
    return;
  }
  if (force) direct.forceReapply();
  direct.applyKeyboard(hwState('keyboard'));
  direct.applyMouse(hwState('mouse'));
}

// État envoyé au matériel : luminosité réduite en mode nuit « atténuer »,
// flux temps réel tant que des calques temporaires sont affichés
function hwState(device) {
  const st = ledEngine.state[device];
  const out = nightDim ? { ...st, brightness: Math.round(st.brightness * nightDim) } : st;
  return device === 'keyboard' && ledEngine.hasLiveLayers() ? { ...out, live: true } : out;
}

// Calques temporaires (témoins, minuteur) apparus ou disparus : le clavier
// passe au flux temps réel ou revient à sa configuration enregistrée
function refreshLiveLayers() {
  const live = ledEngine.hasLiveLayers();
  if (live === liveLayers) return;
  liveLayers = live;
  if (settings.ledsEnabled && !isDimmed()) direct.applyKeyboard(hwState('keyboard'));
}

// Témoins Verr. Maj / Verr. Num : touche allumée tant que le verrou est actif
function lockTick() {
  ledEngine.setIndicators(locks.indicatorMap(locks.read(), hexToRgb(settings.lockColor)));
  refreshLiveLayers();
}

// Extinction manuelle, ou rallumage (y compris pendant la plage du mode
// nuit, jusqu'à sa fin)
function setLedsOff(off) {
  if (off) {
    setDim('manual', true);
  } else {
    if (dimReasons.has('night')) nightOverride = true;
    setDim('night', false);
    setDim('manual', false);
  }
  return isDimmed();
}

// Mode nuit : extinction (raison « night ») ou atténuation pendant la plage
function nightTick() {
  const inWindow = !!(settings.nightMode && settings.ledsEnabled
    && inTimeWindow(settings.nightFrom, settings.nightTo));
  if (!inWindow) nightOverride = false;
  const active = inWindow && !nightOverride;
  const dim = active && settings.nightAction === 'dim'
    ? Math.max(0.05, Math.min(1, (settings.nightLevel || 30) / 100)) : null;
  setDim('night', active && settings.nightAction !== 'dim');
  if (dim !== nightDim) {
    nightDim = dim;
    ledEngine.setDimFactor(dim || 1);
    applyLeds();
  }
}

// Réapplique l'état courant au matériel (après une extinction, une veille)
const reapplyLeds = () => applyLeds({ force: true });

function applyDimmed() {
  if (!settings.ledsEnabled) return;
  direct.applyKeyboard({ ...ledEngine.state.keyboard, effect: 'off' });
  direct.applyMouse({ ...ledEngine.state.mouse, effect: 'off' });
}

// Ajoute ou retire une raison d'extinction ; n'agit qu'au changement
function setDim(reason, on) {
  const was = isDimmed();
  if (on) dimReasons.add(reason);
  else dimReasons.delete(reason);
  const now = isDimmed();
  if (!was && now) applyDimmed();
  else if (was && !now) reapplyLeds();
  if (was !== now) {
    updateCapture();
    rebuildTrayMenu();
    send('leds:dimmed', { dimmed: now, reasons: [...dimReasons] });
  }
}

// Flash bref de retour visuel (macros, turbos)
function flashKeyboard(rgb) {
  if (quitting || !settings.ledsEnabled || isDimmed()) return;
  ledEngine.flash(rgb);
  if (!direct.isStreamed(hwState('keyboard'))) direct.kbFlash(rgb);
}

// ------------------------------------------------------------- Minuteur --
// Barre de progression sur F1-F12, puis clignotement et notification

function timerPayload() {
  return timer
    ? { running: !timer.done, done: !!timer.done, t0: timer.t0, ms: timer.ms, minutes: timer.minutes }
    : { running: false, done: false };
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') }).show();
  } catch { /* notifications indisponibles */ }
}

function startTimer(minutes) {
  stopTimer({ silent: true });
  const m = Math.max(1, Math.min(180, Math.round(Number(minutes) || settings.timerMinutes || 25)));
  timer = { t0: Date.now(), ms: m * 60000, minutes: m, done: false };
  timer.endTimer = setTimeout(timerFinished, timer.ms);
  ledEngine.setTimer({ t0: timer.t0, ms: timer.ms });
  refreshLiveLayers();
  if (settings.timerMinutes !== m) {
    settings = { ...settings, timerMinutes: m };
    store.write('settings', settings);
  }
  rebuildTrayMenu();
  send('timer:state', timerPayload());
  return timerPayload();
}

function timerFinished() {
  if (!timer) return;
  timer.done = true;
  notify('Minuteur terminé', `${timer.minutes} min écoulée${timer.minutes > 1 ? 's' : ''}.`);
  send('timer:state', timerPayload());
  timer.clearTimer = setTimeout(() => stopTimer(), TIMER_DONE_MS + 200);
}

function stopTimer({ silent = false } = {}) {
  if (!timer) return timerPayload();
  clearTimeout(timer.endTimer);
  clearTimeout(timer.clearTimer);
  timer = null;
  ledEngine.setTimer(null);
  refreshLiveLayers();
  if (!silent) {
    rebuildTrayMenu();
    send('timer:state', timerPayload());
  }
  return timerPayload();
}

// Jauge système : échantillonnage processeur / mémoire chaque seconde,
// seulement quand l'effet est affiché
function updateSysmon() {
  const need = settings.ledsEnabled && ledEngine.state.keyboard.effect === 'sysmon';
  if (need && !sysmonTimer) {
    const sample = () => {
      const cpus = os.cpus();
      const tot = cpus.reduce((acc, c) => {
        const t = c.times;
        acc.idle += t.idle;
        acc.all += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      }, { idle: 0, all: 0 });
      let cpu = 0;
      if (lastCpu && tot.all > lastCpu.all) cpu = 1 - (tot.idle - lastCpu.idle) / (tot.all - lastCpu.all);
      lastCpu = tot;
      const ram = 1 - os.freemem() / os.totalmem();
      ledEngine.setSystemStats({ cpu, ram });
    };
    sample();
    sysmonTimer = setInterval(sample, 1000);
  } else if (!need && sysmonTimer) {
    clearInterval(sysmonTimer);
    sysmonTimer = null;
    lastCpu = null;
  }
}

// Effets capturés dans l'interface : le visualiseur audio (son de Windows,
// spectre 30 fois/s) et l'ambiance écran (couleurs de l'écran 10 fois/s).
const CAPTURE_EFFECTS = { audio: '__satellaAudio', screen: '__satellaScreen' };

function startCaptureInRenderer() {
  if (!win || win.isDestroyed() || !captureKind) return;
  const obj = CAPTURE_EFFECTS[captureKind];
  // userGesture = true : getDisplayMedia exige une action utilisateur
  win.webContents.executeJavaScript(`window.${obj} && window.${obj}.start()`, true)
    .catch((err) => console.log(`[capture ${captureKind}] démarrage impossible :`, err.message));
}

function updateCapture() {
  const eff = ledEngine.state.keyboard.effect;
  const want = settings.ledsEnabled && !isDimmed() && CAPTURE_EFFECTS[eff] ? eff : null;
  if (want === captureKind) return;
  if (captureKind) send('capture:stop', captureKind);
  captureKind = want;
  startCaptureInRenderer();
}

// --------------------------------------------------------------- Profils --

function saveSession() {
  store.write('session', sessionState);
}

function profilesPayload() {
  return { profiles: store.read('profiles', []), active: sessionState.activeProfile };
}

function upsertProfile(profiles, profile) {
  const idx = profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  return profiles;
}

// Une modification d'éclairage ou de macros vient d'avoir lieu
function profileChanged() {
  if (applyingProfile) return;
  if (sessionState.activeProfile) {
    clearTimeout(profileSyncTimer);
    profileSyncTimer = setTimeout(syncActiveProfile, 800);
  } else if (!sessionState.dirty) {
    sessionState.dirty = true;
    saveSession();
  }
}

// Recopie les réglages courants dans le profil actif
function syncActiveProfile() {
  clearTimeout(profileSyncTimer);
  profileSyncTimer = null;
  if (!sessionState.activeProfile) return;
  const profiles = store.read('profiles', []);
  const p = profiles.find((x) => x.name === sessionState.activeProfile);
  if (!p) {
    sessionState.activeProfile = null;
    saveSession();
    return;
  }
  p.ledState = ledEngine.state;
  p.macros = macros;
  p.savedAt = new Date().toISOString();
  store.write('profiles', profiles);
  send('profiles:changed', profilesPayload());
}

// Réglages modifiés hors de tout profil : sauvegardés avant d'être
// remplacés par un profil
function backupUnsavedState() {
  if (sessionState.activeProfile || !sessionState.dirty) return;
  const profiles = store.read('profiles', []);
  upsertProfile(profiles, {
    name: UNSAVED_PROFILE,
    savedAt: new Date().toISOString(),
    ledState: ledEngine.state,
    macros,
    apps: [],
    isDefault: false,
  });
  store.write('profiles', profiles);
  console.log('[profils] réglages courants sauvegardés dans « ' + UNSAVED_PROFILE + ' »');
}

// Applique un profil (chargement manuel ou bascule automatique)
function applyProfile(p) {
  // Ne pas perdre la dernière retouche : elle est d'abord recopiée dans le
  // profil actif, qui est alors relu (sinon recharger ce même profil juste
  // après une retouche l'annulerait à l'écran mais pas dans le profil)
  if (profileSyncTimer) {
    syncActiveProfile();
    p = store.read('profiles', []).find((x) => x.name === p.name) || p;
  }
  backupUnsavedState();
  applyingProfile = true;
  try {
    ledEngine.loadState(p.ledState);
    macros = p.macros || [];
    store.write('macros', macros);
    refreshShortcuts();
  } finally {
    applyingProfile = false;
  }
  sessionState = { activeProfile: p.name, dirty: false };
  saveSession();
  rebuildTrayMenu();
}

function loadProfileByName(name) {
  const p = store.read('profiles', []).find((x) => x.name === name);
  if (!p) return null;
  applyProfile(p);
  return { ledState: ledEngine.state, macros, ...profilesPayload() };
}

// Bascule automatique. Elle n'agit que quand le profil voulu change
// (autre application, début ou fin d'une plage horaire) : un choix manuel
// est conservé jusque-là.
function foregroundTick() {
  const exe = foreground.available() ? foreground.currentExe() : null;
  if (exe && exe !== lastFgExe) {
    snippetEngine.reset(); // autre fenêtre, autre saisie
    if (exe === 'satella.exe' || exe === 'electron.exe') return; // pas de bascule en réglant Satella
    lastFgExe = exe;
    lastAutoTarget = null;
  }
  const pick = autoProfileFor(store.read('profiles', []), lastFgExe);
  if (!pick || pick.profile.name === lastAutoTarget) return;
  lastAutoTarget = pick.profile.name;
  if (pick.profile.name === sessionState.activeProfile) return;
  applyProfile(pick.profile);
  send('profiles:autoApplied', {
    name: pick.profile.name,
    exe: pick.reason === 'app' ? lastFgExe : null,
    schedule: pick.reason === 'schedule' ? pick.profile.schedule : null,
    ledState: ledEngine.state,
    macros,
    ...profilesPayload(),
  });
}

// --------------------------------------------------------------- Système --

// Extinction des LED après inactivité, rallumage à la première activité
function idleTick() {
  const ms = idle.idleMs();
  if (ms === null) return;
  const threshold = Math.max(1, settings.idleMinutes) * 60000;
  if (ms >= threshold && !dimReasons.has('idle')) setDim('idle', true);
  else if (ms < threshold && dimReasons.has('idle')) setDim('idle', false);
}

// Nettoyage mémoire automatique : au plus une fois toutes les 10 minutes,
// en épargnant l'application au premier plan (un jeu ne doit pas saccader)
function autoOptimizeTick() {
  if (Date.now() - lastAutoOpt < AUTO_OPT_COOLDOWN) return;
  const st = memory.readStatus();
  if (!st || st.load < settings.autoOptimizeThreshold) return;
  lastAutoOpt = Date.now();
  const fgPid = foreground.currentPid();
  const res = memory.optimize({ excludePids: [fgPid, process.pid] });
  send('memory:auto', res);
}

function setupPowerEvents() {
  // Sortie de veille : les poignées USB sont souvent mortes sans erreur
  powerMonitor.on('resume', () => {
    console.log('[système] sortie de veille');
    setTimeout(() => {
      if (!settings.ledsEnabled) return;
      direct.resetHandles();
      reapplyLeds();
    }, 2500);
  });
  powerMonitor.on('lock-screen', () => { if (settings.offOnLock) setDim('lock', true); });
  powerMonitor.on('unlock-screen', () => setDim('lock', false));
}

// L'écoute clavier globale (uiohook) ne tourne que lorsqu'elle sert :
// effet réactif ou onde de choc, enregistrement de macro, calibration.
function updateHookNeed() {
  const eff = ledEngine.state.keyboard.effect;
  const forLeds = settings.ledsEnabled && (eff === 'reactive' || eff === 'ripple');
  const forMacros = settings.macrosEnabled && (macroEngine.recording || snippetEngine.active);
  const needed = forLeds || forMacros || calibrating || hookDebug || settings.keyStats
    || macroEngine.waitingForKey;
  if (needed) macroEngine.startActivityFeed();
  else macroEngine.stopActivityFeed();
}

// Notes de version d'une mise à jour (texte de latest.yml, éventuellement
// une liste par version, ou du HTML venant de GitHub) -> texte simple
function notesText(releaseNotes) {
  const raw = Array.isArray(releaseNotes)
    ? releaseNotes.map((n) => (n && n.note) || '').join('\n\n')
    : String(releaseNotes || '');
  return raw.replace(/<[^>]+>/g, '').slice(0, 20000);
}

function setupUpdater() {
  autoUpdater.on('download-progress', (p) => {
    send('update:progress', { percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloading = false;
    updateReadyVersion = info.version;
    rebuildTrayMenu();
    send('update:ready', { version: info.version, auto: !!settings.autoInstallUpdates });
  });
  autoUpdater.on('error', (err) => {
    updateDownloading = false;
    console.log('[mise à jour]', err.message);
    send('update:error', { message: err.message });
  });
}

// Vérification discrète (au démarrage puis toutes les 6 heures : Satella
// reste souvent ouverte des jours). Avec l'installation automatique, la
// mise à jour est téléchargée en arrière-plan et installée à la fermeture.
async function backgroundUpdateCheck() {
  if (!app.isPackaged || !settings.autoCheckUpdates || updateReadyVersion || updateDownloading) return;
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.updateInfo || autoUpdater.currentVersion.compare(r.updateInfo.version) >= 0) return;
    const info = { latest: r.updateInfo.version, notes: notesText(r.updateInfo.releaseNotes) };
    if (settings.autoInstallUpdates) {
      updateDownloading = true;
      console.log('[mise à jour] téléchargement automatique de la version', info.latest);
      autoUpdater.downloadUpdate().catch((err) => {
        updateDownloading = false;
        console.log('[mise à jour] téléchargement impossible :', err.message);
      });
    } else {
      send('update:available', info);
    }
  } catch { /* hors ligne ou GitHub injoignable : silencieux */ }
}

// Première ouverture après une mise à jour : les nouveautés de la version
// (fichier embarqué) sont proposées une fois
function checkWhatsNew() {
  const meta = store.read('app-meta', {});
  const current = app.getVersion();
  // Pas de trace de version mais des données existantes (session.json est
  // écrit dès le premier lancement de la 1.5.0) : mise à jour depuis une
  // version qui ne notait pas encore son numéro. Appelé avant toute
  // écriture de session, une installation neuve n'a encore rien.
  const hadData = ['session', 'settings', 'led-state', 'macros'].some((n) => store.read(n, null) !== null);
  const previous = meta.lastVersion || (hadData ? 'précédente' : null);
  if (previous && previous !== current) {
    let notes = '';
    try { notes = fs.readFileSync(path.join(__dirname, 'build', 'release-notes.md'), 'utf8'); } catch { /* absent */ }
    if (notes.trim()) whatsNew = { version: current, previous, notes };
  }
  if (meta.lastVersion !== current) store.write('app-meta', { ...meta, lastVersion: current });
}

// Captures (visualiseur audio, ambiance écran) : écran principal et, si
// demandé, boucle de la sortie son de Windows ; sans fenêtre de choix.
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback({});
      const primary = String(screen.getPrimaryDisplay().id);
      const grant = { video: sources.find((s) => s.display_id === primary) || sources[0] };
      if (process.platform === 'win32' && request.audioRequested) grant.audio = 'loopback';
      callback(grant);
    }).catch(() => callback({}));
  });
}

// ------------------------------------------------- Import / export / diag --

const KEY_NAMES = Object.keys(keys.VK);

function backupData() {
  return {
    macros,
    profiles: store.read('profiles', []),
    snippets: store.read('snippets', []),
    turbos,
    settings,
    keymap: store.read('keymap', {}),
    ledState: ledEngine.state,
  };
}

// Sauvegardes automatiques : satella-data/sauvegardes/sauvegarde-AAAA-MM-JJ-HHhMM.satella,
// les 10 plus récentes sont gardées
const BACKUP_RE = /^sauvegarde-(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})\.satella$/;
const BACKUP_KEEP = 10;
const backupDir = () => path.join(app.getPath('userData'), 'satella-data', 'sauvegardes');
const pad2 = (n) => String(n).padStart(2, '0');

function listBackups() {
  let names = [];
  try { names = fs.readdirSync(backupDir()).filter((n) => BACKUP_RE.test(n)); } catch { /* aucun dossier */ }
  return names.sort().reverse().map((name) => {
    const [, y, mo, d, h, mi] = BACKUP_RE.exec(name);
    let size = 0;
    try { size = fs.statSync(path.join(backupDir(), name)).size; } catch { /* supprimé entre-temps */ }
    return { name, date: `${y}-${mo}-${d}T${h}:${mi}`, size };
  });
}

// `force` : sauvegarde immédiate (bouton) ; sinon au plus une par jour, et
// seulement si les données ont changé depuis la précédente
function autoBackup({ force = false } = {}) {
  const data = backupData();
  const sig = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
  const meta = store.read('app-meta', {});
  const now = new Date();
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const existing = listBackups();
  if (!force) {
    if (existing.some((b) => b.date.startsWith(day))) return null;
    if (meta.lastBackupSig === sig && existing.length) return null;
  }
  try {
    fs.mkdirSync(backupDir(), { recursive: true });
    const name = `sauvegarde-${day}-${pad2(now.getHours())}h${pad2(now.getMinutes())}.satella`;
    fs.writeFileSync(path.join(backupDir(), name), sanitize.makeExport('backup', data, app.getVersion()), 'utf8');
    store.write('app-meta', { ...meta, lastBackupSig: sig });
    for (const old of listBackups().slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(backupDir(), old.name)); } catch { /* déjà supprimé */ }
    }
    console.log('[sauvegarde] créée :', name);
    return name;
  } catch (err) {
    console.log('[sauvegarde] impossible :', err.message);
    return null;
  }
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'profil';
}

async function exportData(kind, name) {
  let payload;
  let defaultName;
  if (kind === 'profile') {
    payload = store.read('profiles', []).find((p) => p.name === name);
    if (!payload) return { ok: false, error: 'profil introuvable' };
    defaultName = `${safeFileName(name)}.satella`;
  } else {
    payload = backupData();
    defaultName = `Satella-sauvegarde-${new Date().toISOString().slice(0, 10)}.satella`;
  }
  const res = await dialog.showSaveDialog(win, {
    title: kind === 'profile' ? 'Exporter le profil' : 'Sauvegarder toutes les données',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Fichier Satella', extensions: ['satella'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, sanitize.makeExport(kind, payload, app.getVersion()), 'utf8');
    return { ok: true, file: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Étape de macro « Ouvrir » : lien (navigateur, messagerie) ou programme /
// fichier (application associée). La cible est revalidée à chaque fois.
async function openTargetSafely(target) {
  const t = sanitize.openTarget(target);
  if (!t) throw new Error(`cible à ouvrir invalide : « ${String(target || '').slice(0, 80)} »`);
  if (/^(https?:|mailto:)/i.test(t)) {
    await shell.openExternal(t);
    return;
  }
  const err = await shell.openPath(t);
  if (err) throw new Error(`ouverture de « ${t} » impossible : ${err}`);
}

function uniqueProfileName(profiles, name) {
  if (!profiles.some((p) => p.name === name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`.slice(0, 60);
    if (!profiles.some((p) => p.name === candidate)) return candidate;
  }
}

// `file` : fichier imposé (glissé-déposé, ou sauvegarde automatique :
// `trusted`, déjà de confiance) ; sinon l'utilisateur choisit le fichier
async function importData({ file = null, trusted = false } = {}) {
  if (!file) {
    const res = await dialog.showOpenDialog(win, {
      title: 'Importer un fichier Satella',
      properties: ['openFile'],
      filters: [{ name: 'Fichier Satella', extensions: ['satella', 'json'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    file = res.filePaths[0];
  }
  let parsed;
  try {
    const stat = fs.statSync(file);
    if (stat.size > 20 * 1024 * 1024) throw new Error('fichier trop volumineux');
    parsed = sanitize.parseImport(fs.readFileSync(file, 'utf8'), KEY_NAMES);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Étapes « Ouvrir » (programmes, liens) : jamais importées sans accord
  // (sauf depuis les sauvegardes automatiques de Satella elle-même)
  const imported = parsed.kind === 'profile'
    ? [parsed.profile]
    : [{ macros: parsed.data.macros }, ...parsed.data.profiles];
  const targets = trusted ? [] : [...new Set(imported.flatMap((x) => sanitize.openTargets(x.macros)))];
  if (targets.length) {
    const ans = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Importer sans ces étapes', 'Tout importer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      title: 'Programmes et liens dans le fichier',
      message: 'Ce fichier contient des macros qui ouvrent des programmes, des fichiers ou des liens.',
      detail: 'N\'importe ces étapes que si tu fais confiance à la personne qui t\'a envoyé le fichier :\n\n'
        + targets.slice(0, 12).join('\n') + (targets.length > 12 ? `\n… et ${targets.length - 12} autre(s)` : ''),
    });
    if (ans.response === 2) return { ok: false, canceled: true };
    if (ans.response === 0) {
      for (const x of imported) x.macros = sanitize.stripOpenSteps(x.macros);
      if (parsed.kind === 'backup') parsed.data.macros = imported[0].macros;
    }
  }

  if (parsed.kind === 'profile') {
    const profiles = store.read('profiles', []);
    const p = parsed.profile;
    p.name = uniqueProfileName(profiles, p.name);
    profiles.push(p);
    store.write('profiles', profiles);
    return { ok: true, kind: 'profile', name: p.name, ...profilesPayload() };
  }

  // Sauvegarde complète : remplace les données actuelles, après confirmation
  const d = parsed.data;
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Restaurer', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
    title: 'Restaurer une sauvegarde',
    message: 'Remplacer toutes les données actuelles par cette sauvegarde ?',
    detail: `${d.profiles.length} profil(s), ${d.macros.length} macro(s), ${d.snippets.length} abréviation(s), `
      + `${d.turbos.length} turbo(s). Les données actuelles sont d'abord enregistrées dans le dossier de données.`,
  });
  if (answer.response !== 0) return { ok: false, canceled: true };

  // Filet de sécurité : sauvegarde des données actuelles avant écrasement
  try {
    const dir = path.join(app.getPath('userData'), 'satella-data');
    fs.writeFileSync(path.join(dir, `avant-restauration-${Date.now()}.satella`),
      sanitize.makeExport('backup', backupData(), app.getVersion()), 'utf8');
  } catch (err) {
    console.log('[import] copie de sécurité impossible :', err.message);
  }

  stopAllTurbos();
  macroEngine.stop();
  store.write('profiles', d.profiles);
  store.write('snippets', d.snippets);
  turbos = d.turbos;
  store.write('turbos', turbos);
  if (Object.keys(d.keymap).length) {
    store.write('keymap', d.keymap);
    direct.setKeyMap(d.keymap);
  }
  applyingProfile = true;
  try {
    ledEngine.loadState(d.ledState);
    macros = d.macros;
    store.write('macros', macros);
  } finally {
    applyingProfile = false;
  }
  sessionState = { activeProfile: null, dirty: false };
  const cur = canonLed(ledEngine.state) + JSON.stringify(macros);
  const match = d.profiles.find((p) => canonLed(p.ledState) + JSON.stringify(p.macros) === cur);
  if (match) sessionState.activeProfile = match.name;
  saveSession();
  settings = { ...settings, ...d.settings };
  store.write('settings', settings);
  applySettings();
  return {
    ok: true,
    kind: 'backup',
    ledState: ledEngine.state,
    macros,
    snippets: store.read('snippets', []),
    turbos,
    ...profilesPayload(),
  };
}

function diagnosticText() {
  const ids = (d) => `${d.vid}:${d.pid}`;
  const hidInfo = hid.listDevices();
  const st = direct.status();
  const lines = [
    `Satella ${app.getVersion()} — Electron ${process.versions.electron}, Node ${process.versions.node}`,
    `Système : ${os.type()} ${os.release()} (${os.arch()}), ${Math.round(os.totalmem() / 1073741824)} Go`,
    `Installée : ${app.isPackaged ? 'oui' : 'non (développement)'}`,
    `Clavier : ${st.keyboard ? 'connecté' : 'absent'} · Souris : ${st.mouse ? 'connectée' : 'absente'}`
      + (st.error ? ` · HID : ${st.error}` : ''),
    `Modules : injection ${input.available ? 'ok' : 'indisponible'}, écoute ${hookAvailable() ? 'ok' : 'indisponible'}, `
      + `mémoire ${memory.available() ? 'ok' : 'indisponible'}`,
    `Effet clavier : ${ledEngine.state.keyboard.effect} · souris : ${ledEngine.state.mouse.effect}`
      + (isDimmed() ? ` · LED éteintes (${[...dimReasons].join(', ')})` : ''),
    `Profil actif : ${sessionState.activeProfile || 'aucun'} · ${macros.length} macro(s) · ${turbos.length} turbo(s)`,
    `Raccourcis refusés : ${shortcutErrors.length ? shortcutErrors.map((e) => e.accelerator).join(', ') : 'aucun'}`,
    `Paramètres : ${JSON.stringify(settings)}`,
    `Périphériques USB repérés : ${(hidInfo.devices || []).filter((d) => d.isLikelyTarget || d.hasVendorInterface).map(ids).join(', ') || 'aucun'}`,
    '',
    '--- Fin du journal ---',
    logger.tail(16 * 1024),
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------- IPC --

function setupIpc() {
  ipcMain.handle('app:ready', () => { ledEngine.renderOnce(); return true; });

  ipcMain.handle('app:checkUpdate', async () => {
    const current = app.getVersion();
    if (!app.isPackaged) {
      return { ok: false, current, error: 'version de développement (pas de mise à jour)' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result && result.updateInfo ? result.updateInfo.version : current;
      const newer = !!(result && result.updateInfo)
        && autoUpdater.currentVersion.compare(result.updateInfo.version) < 0;
      const notes = newer ? notesText(result.updateInfo.releaseNotes) : '';
      return { ok: true, current, latest, newer, notes };
    } catch (err) {
      return { ok: false, current, error: err.message };
    }
  });

  ipcMain.handle('app:downloadUpdate', async () => {
    try {
      updateDownloading = true;
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:installUpdate', () => {
    quitting = true;
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle('app:init', () => ({
    version: app.getVersion(),
    settings,
    packaged: app.isPackaged,
    platform: process.platform,
    memoryAvailable: memory.available(),
    layout,
    ledState: ledEngine.state,
    dimmed: isDimmed(),
    macros,
    snippets: store.read('snippets', []),
    turbos,
    shortcutErrors,
    ...profilesPayload(),
    direct: direct.status(),
    hid: hid.listDevices(),
    capabilities: {
      input: input.available,
      inputError: input.loadError ? input.loadError.message : null,
      uiohook: hookAvailable(),
    },
    whatsNew,
    timer: timerPayload(),
    locksAvailable: locks.available(),
    keyNames: KEY_NAMES,
    keyLabels: Object.fromEntries(KEY_NAMES.map((k) => [k, keys.labelFor(k)])),
  }));

  ipcMain.handle('app:diagnostic', () => {
    const text = diagnosticText();
    clipboard.writeText(text);
    return text;
  });
  ipcMain.handle('app:openLogs', () => shell.openPath(logger.dir || app.getPath('userData')));
  ipcMain.handle('app:openData', () => shell.openPath(path.join(app.getPath('userData'), 'satella-data')));

  // Page affichée : l'aperçu n'est calculé que pour les pages qui le montrent
  ipcMain.on('ui:page', (e, page) => {
    uiPage = String(page || '');
    if (previewVisible()) ledEngine.renderOnce();
  });

  // ---- LEDs ----
  ipcMain.handle('led:set', (e, device, patch) => ledEngine.setDeviceState(device, patch));
  ipcMain.handle('led:setKeys', (e, device, colors) => ledEngine.setKeys(device, colors));
  ipcMain.handle('led:clearKeys', (e, device) => ledEngine.clearKeys(device));
  ipcMain.handle('led:setOverlay', (e, device, colors) => ledEngine.setOverlay(device, colors));
  ipcMain.handle('led:removeOverlay', (e, device, ids) => ledEngine.removeOverlay(device, ids));
  ipcMain.handle('leds:setManualOff', (e, on) => setLedsOff(!!on));
  ipcMain.on('audio:bands', (e, bands) => ledEngine.setAudioBands(bands));
  ipcMain.on('screen:grid', (e, grid) => ledEngine.setScreenGrid(grid));
  ipcMain.on('capture:error', (e, kind, message) => console.log(`[capture ${kind}]`, message));

  // ---- Périphériques ----
  ipcMain.handle('devices:refreshHid', () => {
    direct.detect();
    return hid.listDevices();
  });
  ipcMain.handle('devices:directStatus', () => direct.status());
  ipcMain.handle('devices:hookDebug', (e, on) => {
    hookDebug = !!on;
    updateHookNeed();
    return hookDebug;
  });
  // (moteur OpenRGB supprimé en 1.1.0 : le pilote direct suffit)
  ipcMain.handle('devices:testKeyboard', (e, r, g, b) => {
    try { direct.testKeyboard(r, g, b); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('devices:testMouse', (e, mode) => {
    try { direct.testMouse(mode); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- Calibration de la carte des touches ----
  ipcMain.handle('calib:light', async (e, slot) => {
    try {
      calibrating = true;
      updateHookNeed();
      await direct.kbCalibLight(slot);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('calib:finish', (e, map) => {
    calibrating = false;
    direct.kbCalibEnd();
    if (map && Object.keys(map).length) {
      store.write('keymap', map);
      direct.setKeyMap(map);
    }
    direct.applyKeyboard(hwState('keyboard'));
    updateHookNeed();
    return true;
  });
  ipcMain.handle('calib:cancel', () => {
    calibrating = false;
    direct.kbCalibEnd();
    direct.applyKeyboard(hwState('keyboard'));
    updateHookNeed();
    return true;
  });

  // ---- Macros ----
  ipcMain.handle('macros:save', (e, macro) => {
    const idx = macros.findIndex((m) => m.id === macro.id);
    if (idx >= 0) macros[idx] = macro;
    else macros.push(macro);
    store.write('macros', macros);
    refreshShortcuts();
    profileChanged();
    return macros;
  });
  ipcMain.handle('macros:remove', (e, id) => {
    macros = macros.filter((m) => m.id !== id);
    store.write('macros', macros);
    refreshShortcuts();
    profileChanged();
    return macros;
  });
  // `draft` : version en cours d'édition (bouton « Tester »)
  ipcMain.handle('macros:play', async (e, id, draft) => {
    try {
      await macroEngine.play(id, draft || null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('macros:stop', (e, id) => macroEngine.stop(id));
  ipcMain.handle('macros:recordStart', (e, opts) => {
    macroEngine.startRecording(opts);
    updateHookNeed();
    return true;
  });
  ipcMain.handle('macros:recordStop', () => {
    const steps = macroEngine.stopRecording();
    updateHookNeed();
    return steps;
  });

  // ---- Expansion de texte ----
  ipcMain.handle('snippets:get', () => store.read('snippets', []));
  ipcMain.handle('snippets:set', (e, list) => {
    store.write('snippets', list || []);
    if (settings.macrosEnabled) snippetEngine.setSnippets(list);
    updateHookNeed();
    return list;
  });

  // ---- Mode turbo ----
  ipcMain.handle('turbos:get', () => turbos);
  ipcMain.handle('turbos:set', (e, list) => {
    turbos = list || [];
    store.write('turbos', turbos);
    stopAllTurbos();
    refreshShortcuts();
    return turbos;
  });
  ipcMain.handle('shortcuts:errors', () => shortcutErrors);

  // ---- Statistiques de frappe ----
  ipcMain.handle('stats:get', () => keyStats);
  ipcMain.handle('stats:reset', () => {
    keyStats = { counts: {}, total: 0, since: settings.keyStats ? new Date().toISOString() : null };
    ledEngine.setHeatmap(keyStats.counts);
    store.write('key-stats', keyStats);
    ledEngine.renderOnce();
    return keyStats;
  });

  // Commandes de l'application (palette de commandes de l'interface)
  ipcMain.handle('app:action', (e, name) => {
    const def = Object.prototype.hasOwnProperty.call(APP_ACTIONS, name) ? APP_ACTIONS[name] : null;
    if (!def) return false;
    def.run();
    return true;
  });

  // ---- Minuteur ----
  ipcMain.handle('timer:get', () => timerPayload());
  ipcMain.handle('timer:start', (e, minutes) => startTimer(minutes));
  ipcMain.handle('timer:stop', () => stopTimer());

  // ---- Sauvegardes automatiques ----
  ipcMain.handle('backups:list', () => listBackups());
  ipcMain.handle('backups:now', () => {
    const name = autoBackup({ force: true });
    return { ok: !!name, name, list: listBackups() };
  });
  ipcMain.handle('backups:openFolder', () => {
    fs.mkdirSync(backupDir(), { recursive: true });
    return shell.openPath(backupDir());
  });
  ipcMain.handle('backups:restore', (e, name) => {
    if (!BACKUP_RE.test(String(name)) || !listBackups().some((b) => b.name === name)) {
      return { ok: false, error: 'sauvegarde introuvable' };
    }
    return importData({ file: path.join(backupDir(), name), trusted: true });
  });

  // ---- Optimiseur mémoire ----
  ipcMain.handle('memory:status', () => memory.readStatus());
  ipcMain.handle('memory:optimize', () => memory.optimize());

  // ---- Paramètres ----
  ipcMain.handle('settings:get', () => settings);
  // État réel côté Windows : l'utilisateur peut avoir désactivé l'entrée
  // depuis le gestionnaire des tâches.
  ipcMain.handle('settings:startupState', () => (
    app.isPackaged ? app.getLoginItemSettings().openAtLogin : false
  ));
  ipcMain.handle('settings:set', (e, patch) => {
    settings = { ...settings, ...patch };
    store.write('settings', settings);
    applySettings();
    return settings;
  });

  // ---- Profils (éclairage + macros ; le profil actif suit les retouches) ----
  ipcMain.handle('profiles:list', () => profilesPayload());
  ipcMain.handle('profiles:save', (e, name) => {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return profilesPayload();
    if (profileSyncTimer) syncActiveProfile();
    const profiles = store.read('profiles', []);
    const previous = profiles.find((p) => p.name === name) || {};
    upsertProfile(profiles, {
      name,
      savedAt: new Date().toISOString(),
      ledState: ledEngine.state,
      macros,
      apps: previous.apps || [],
      isDefault: !!previous.isDefault,
      schedule: previous.schedule || null,
    });
    store.write('profiles', profiles);
    sessionState = { activeProfile: name, dirty: false };
    saveSession();
    rebuildTrayMenu();
    return profilesPayload();
  });
  // Choix manuel : conservé jusqu'au passage à une autre application
  ipcMain.handle('profiles:load', (e, name) => loadProfileByName(name));
  ipcMain.handle('profiles:rename', (e, oldName, newName) => {
    newName = String(newName || '').trim().slice(0, 60);
    const profiles = store.read('profiles', []);
    const p = profiles.find((x) => x.name === oldName);
    if (!p || !newName) return { ok: false, error: 'nom invalide', ...profilesPayload() };
    if (newName !== oldName && profiles.some((x) => x.name === newName)) {
      return { ok: false, error: 'un profil porte déjà ce nom', ...profilesPayload() };
    }
    p.name = newName;
    store.write('profiles', profiles);
    if (sessionState.activeProfile === oldName) {
      sessionState.activeProfile = newName;
      saveSession();
    }
    rebuildTrayMenu();
    return { ok: true, ...profilesPayload() };
  });
  // Applications liées et profil par défaut (bascule automatique)
  ipcMain.handle('profiles:setMeta', (e, name, meta) => {
    const profiles = store.read('profiles', []);
    const p = profiles.find((x) => x.name === name);
    if (!p) return profilesPayload();
    if (meta.apps !== undefined) {
      p.apps = meta.apps.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    }
    if (meta.isDefault !== undefined) {
      profiles.forEach((x) => { x.isDefault = false; });
      p.isDefault = !!meta.isDefault;
    }
    if (meta.schedule !== undefined) p.schedule = sanitize.schedule(meta.schedule);
    store.write('profiles', profiles);
    lastFgExe = ''; // réévaluer la bascule avec les nouvelles règles
    lastAutoTarget = null;
    return profilesPayload();
  });
  ipcMain.handle('profiles:remove', (e, name) => {
    const profiles = store.read('profiles', []).filter((p) => p.name !== name);
    store.write('profiles', profiles);
    if (sessionState.activeProfile === name) {
      clearTimeout(profileSyncTimer);
      profileSyncTimer = null;
      sessionState = { activeProfile: null, dirty: false };
      saveSession();
    }
    rebuildTrayMenu();
    return profilesPayload();
  });

  // ---- Import / export ----
  ipcMain.handle('data:export', (e, kind, name) => exportData(kind === 'profile' ? 'profile' : 'backup', name));
  ipcMain.handle('data:import', () => importData());
  // Fichier glissé-déposé sur la fenêtre
  ipcMain.handle('data:importFile', (e, file) => {
    if (typeof file !== 'string' || !/\.(satella|json)$/i.test(file) || !path.isAbsolute(file)) {
      return { ok: false, error: 'seuls les fichiers .satella peuvent être importés' };
    }
    return importData({ file });
  });

  // Choix d'un programme ou d'un fichier (étape « Ouvrir »)
  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Programme ou fichier à ouvrir',
      properties: ['openFile'],
      filters: [
        { name: 'Programmes et raccourcis', extensions: ['exe', 'lnk', 'bat', 'cmd', 'url'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
}

// ------------------------------------------------ Zone de notification --

function rebuildTrayMenu() {
  if (!tray) return;
  const profiles = store.read('profiles', []);
  const active = sessionState.activeProfile;
  const template = [
    { label: 'Ouvrir Satella', click: revealWindow },
    { type: 'separator' },
    {
      label: 'Profil',
      enabled: profiles.length > 0,
      submenu: profiles.length
        ? profiles.map((p) => ({
          label: p.name,
          type: 'radio',
          checked: p.name === active,
          click: () => {
            const res = loadProfileByName(p.name);
            if (res) send('profiles:autoApplied', { name: p.name, exe: null, manual: true, ...res });
          },
        }))
        : [{ label: 'Aucun profil', enabled: false }],
    },
    {
      label: 'Éteindre les LED',
      type: 'checkbox',
      checked: dimReasons.has('manual'),
      enabled: settings.ledsEnabled,
      click: (item) => setDim('manual', item.checked),
    },
    {
      label: timer && !timer.done ? `Minuteur (${timer.minutes} min, en cours)` : 'Minuteur',
      submenu: [
        ...[5, 15, 25, 45, 60].map((m) => ({ label: `${m} min`, click: () => startTimer(m) })),
        { type: 'separator' },
        { label: 'Arrêter', enabled: !!timer, click: () => stopTimer() },
      ],
    },
    {
      label: 'Macros actives',
      type: 'checkbox',
      checked: settings.macrosEnabled,
      click: (item) => {
        settings = { ...settings, macrosEnabled: item.checked };
        store.write('settings', settings);
        applySettings();
      },
    },
    { type: 'separator' },
    ...(updateReadyVersion ? [{
      label: `Installer la version ${updateReadyVersion} et redémarrer`,
      click: () => { quitting = true; autoUpdater.quitAndInstall(); },
    }] : []),
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(active ? `Satella — ${active}` : 'Satella');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', revealWindow);
  tray.on('double-click', revealWindow);
  rebuildTrayMenu();
}

// ------------------------------------------------------------- Cycle de vie --

app.on('second-instance', () => revealWindow());

app.whenReady().then(() => {
  if (!gotLock) return;
  // Notifications Windows (fin du minuteur) : même identifiant que le
  // raccourci créé par l'installeur
  if (process.platform === 'win32') app.setAppUserModelId('com.satella.rgb');
  // Un échec au démarrage ne doit pas laisser un processus invisible qui
  // garderait le verrou d'instance unique (plus aucun lancement possible)
  try {
    setupEngines();
    setupUpdater();
    setupIpc();
    setupPowerEvents();
    setupDisplayMedia();
    createWindow();
    createTray();
  } catch (err) {
    console.error('Démarrage impossible :', err && err.stack ? err.stack : err);
    dialog.showErrorBox('Satella — démarrage impossible',
      `${err && err.message ? err.message : err}\n\nJournal : ${logger.dir || app.getPath('userData')}`);
    app.exit(1);
    return;
  }

  // Vérification discrète des mises à jour : au démarrage, puis toutes les 6 h
  setTimeout(backgroundUpdateCheck, 15000);
  setInterval(backgroundUpdateCheck, 6 * 3600 * 1000);
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  if (!gotLock || !store) return;
  stopAllTurbos();
  stopTimer({ silent: true });
  globalShortcut.unregisterAll();
  if (profileSyncTimer) syncActiveProfile();
  store.flush();
  if (macroEngine) macroEngine.dispose();
  if (direct) direct.dispose();
});

app.on('window-all-closed', () => {
  // La fenêtre se cache au lieu de se fermer : ne quitter que si demandé
  if (quitting) app.quit();
});
