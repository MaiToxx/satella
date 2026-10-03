// Satella — processus principal Electron.
// Assemble : moteur d'effets LED, pilote USB direct, moteur de macros,
// persistance et IPC vers l'interface.

const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage,
  powerMonitor, dialog, shell, clipboard, screen, session, desktopCapturer,
} = require('electron');
const { autoUpdater } = require('electron-updater');

// Mise à jour automatique via les releases GitHub du dépôt MaiToxx/satella
// (configuré dans package.json, section build.publish). Publier une version :
// bump de version, puis `npx electron-builder --win --publish always`.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./src/store');
const logger = require('./src/system/logger');
const { LedEngine, DEFAULT_DEVICE_STATE } = require('./src/led/engine');
const { DirectBackend } = require('./src/led/direct');
const hid = require('./src/led/hid');
const memory = require('./src/system/memory');
const foreground = require('./src/system/foreground');
const idle = require('./src/system/idle');
const { MacroEngine, hookAvailable } = require('./src/macros/engine');
const { SnippetEngine } = require('./src/macros/snippets');
const input = require('./src/macros/input');
const keys = require('./src/macros/keys');
const layout = require('./src/shared/layout');
const sanitize = require('./src/shared/sanitize');

// Une seule instance : un deuxième lancement (raccourci, démarrage de
// Windows) réaffiche simplement la fenêtre existante au lieu de piloter
// le même clavier en parallèle.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

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
let sysmonTimer = null;
let lastCpu = null;
let lastFgExe = '';
let uiPage = 'home';
let audioCapturing = false;
let shortcutErrors = [];
let boundsTimer = null;

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
  offOnLock: false,
  flashOnMacro: false,
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
    if (audioCapturing) startAudioCaptureInRenderer();
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
  macroEngine = new MacroEngine({ globalShortcut });
  snippetEngine = new SnippetEngine();
  turbos = store.read('turbos', []);

  // État LED sauvegardé
  ledEngine.loadState(store.read('led-state', null));

  // Macros sauvegardées (déclencheurs enregistrés par applySettings)
  macros = store.read('macros', []);

  settings = { ...DEFAULT_SETTINGS, ...store.read('settings', {}) };

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
      direct.applyKeyboard(state.keyboard);
      direct.applyMouse(state.mouse);
    }
    updateHookNeed();
    updateSysmon();
    updateAudioCapture();
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
  macroEngine.on('play-error', (e) => {
    console.log('[macro]', e.id, e.message);
    send('macro:play-error', e);
  });

  applySettings();
}

const streamingKeyboard = () => settings.ledsEnabled && !isDimmed() && !!direct.kb
  && direct.isStreamed(ledEngine.state.keyboard);

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

  // --- Profils par application ---
  clearInterval(fgTimer);
  fgTimer = null;
  if (settings.appProfiles && foreground.available()) {
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

  updateHookNeed();
  updateSysmon();
  updateAudioCapture();
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
  if (shortcutErrors.length) {
    console.log('[raccourcis] refusés :', shortcutErrors.map((e) => `${e.accelerator} (${e.reason})`).join(', '));
  }
  send('shortcuts:errors', shortcutErrors);
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
  direct.applyKeyboard(ledEngine.state.keyboard);
  direct.applyMouse(ledEngine.state.mouse);
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
    updateAudioCapture();
    rebuildTrayMenu();
    send('leds:dimmed', { dimmed: now, reasons: [...dimReasons] });
  }
}

// Flash bref de retour visuel (macros, turbos)
function flashKeyboard(rgb) {
  if (quitting || !settings.ledsEnabled || isDimmed()) return;
  ledEngine.flash(rgb);
  if (!direct.isStreamed(ledEngine.state.keyboard)) direct.kbFlash(rgb);
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

// Visualiseur audio : la capture du son de Windows (boucle de sortie) se
// fait dans l'interface (Web Audio), qui renvoie un spectre 30 fois/s.
function startAudioCaptureInRenderer() {
  if (!win || win.isDestroyed()) return;
  // userGesture = true : getDisplayMedia exige une action utilisateur
  win.webContents.executeJavaScript('window.__satellaAudio && window.__satellaAudio.start()', true)
    .catch((err) => console.log('[audio] démarrage impossible :', err.message));
}

function updateAudioCapture() {
  const need = settings.ledsEnabled && !isDimmed() && ledEngine.state.keyboard.effect === 'audio';
  if (need === audioCapturing) return;
  audioCapturing = need;
  if (need) startAudioCaptureInRenderer();
  else send('audio:stop');
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
  if (profileSyncTimer) syncActiveProfile(); // ne pas perdre la dernière retouche
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

// Bascule de profil selon l'application au premier plan
function foregroundTick() {
  const exe = foreground.currentExe();
  if (!exe || exe === lastFgExe) return;
  snippetEngine.reset(); // autre fenêtre, autre saisie
  if (exe === 'satella.exe' || exe === 'electron.exe') return; // pas de bascule en réglant Satella
  lastFgExe = exe;
  const profiles = store.read('profiles', []);
  const match = profiles.find((p) => (p.apps || []).includes(exe));
  const target = match || profiles.find((p) => p.isDefault);
  if (!target || target.name === sessionState.activeProfile) return;
  applyProfile(target);
  send('profiles:autoApplied', {
    name: target.name, exe: match ? exe : null, ledState: ledEngine.state, macros, ...profilesPayload(),
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
  const needed = forLeds || forMacros || calibrating || hookDebug;
  if (needed) macroEngine.startActivityFeed();
  else macroEngine.stopActivityFeed();
}

function setupUpdater() {
  autoUpdater.on('download-progress', (p) => {
    send('update:progress', { percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send('update:ready', { version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.log('[mise à jour]', err.message);
    send('update:error', { message: err.message });
  });
}

// Capture audio (visualiseur) : boucle de la sortie son de Windows, sans
// fenêtre de choix pour l'utilisateur.
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback({});
      const grant = { video: sources[0] };
      if (process.platform === 'win32') grant.audio = 'loopback';
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

function uniqueProfileName(profiles, name) {
  if (!profiles.some((p) => p.name === name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`.slice(0, 60);
    if (!profiles.some((p) => p.name === candidate)) return candidate;
  }
}

async function importData() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importer un fichier Satella',
    properties: ['openFile'],
    filters: [{ name: 'Fichier Satella', extensions: ['satella', 'json'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  let parsed;
  try {
    const stat = fs.statSync(res.filePaths[0]);
    if (stat.size > 20 * 1024 * 1024) throw new Error('fichier trop volumineux');
    parsed = sanitize.parseImport(fs.readFileSync(res.filePaths[0], 'utf8'), KEY_NAMES);
  } catch (err) {
    return { ok: false, error: err.message };
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
      return { ok: true, current, latest, newer };
    } catch (err) {
      return { ok: false, current, error: err.message };
    }
  });

  ipcMain.handle('app:downloadUpdate', async () => {
    try {
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
  ipcMain.handle('leds:setManualOff', (e, on) => { setDim('manual', !!on); return isDimmed(); });
  ipcMain.on('audio:bands', (e, bands) => ledEngine.setAudioBands(bands));
  ipcMain.on('audio:error', (e, message) => console.log('[audio]', message));

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
    direct.applyKeyboard(ledEngine.state.keyboard);
    updateHookNeed();
    return true;
  });
  ipcMain.handle('calib:cancel', () => {
    calibrating = false;
    direct.kbCalibEnd();
    direct.applyKeyboard(ledEngine.state.keyboard);
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
    store.write('profiles', profiles);
    lastFgExe = ''; // réévaluer la bascule avec les nouvelles règles
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
  setupEngines();
  setupUpdater();
  setupIpc();
  setupPowerEvents();
  setupDisplayMedia();
  createWindow();
  createTray();

  // Vérification discrète des mises à jour au démarrage
  if (app.isPackaged && settings.autoCheckUpdates) {
    setTimeout(async () => {
      try {
        const r = await autoUpdater.checkForUpdates();
        if (r && r.updateInfo && autoUpdater.currentVersion.compare(r.updateInfo.version) < 0) {
          send('update:available', { latest: r.updateInfo.version });
        }
      } catch { /* hors ligne ou GitHub injoignable : silencieux */ }
    }, 15000);
  }
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  if (!gotLock || !store) return;
  stopAllTurbos();
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
