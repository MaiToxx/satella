// Satella — processus principal Electron.
// Assemble : moteur d'effets LED, pilote USB direct, moteur de macros,
// persistance et IPC vers l'interface.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');

// Mise à jour automatique via les releases GitHub du dépôt MaiToxx/satella
// (configuré dans package.json, section build.publish). Publier une version :
// bump de version, puis `npx electron-builder --win --publish always`.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
const path = require('path');
const { Store } = require('./src/store');
const { LedEngine } = require('./src/led/engine');
const { DirectBackend, SOFT_EFFECTS } = require('./src/led/direct');
const hid = require('./src/led/hid');
const memory = require('./src/system/memory');
const { MacroEngine, uiohookAvailable } = require('./src/macros/engine');
const input = require('./src/macros/input');
const keys = require('./src/macros/keys');
const layout = require('./src/shared/layout');

let win = null;
let tray = null;
let quitting = false;
let store, ledEngine, direct, macroEngine;
let macros = [];
let calibrating = false;
let hookDebug = false;
let detectTimer = null;
let autoOptTimer = null;

// Modules activables (page Paramètres) : couper un module libère ses
// ressources (timers, écoute clavier, poignées USB).
const DEFAULT_SETTINGS = {
  ledsEnabled: true,
  macrosEnabled: true,
  autoOptimize: false,
  autoOptimizeThreshold: 80,
  launchAtStartup: false,
  startMinimized: true,
};

// Démarrage silencieux : Windows relance Satella avec ce drapeau
const startedHidden = process.argv.includes('--hidden');
let settings = { ...DEFAULT_SETTINGS };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'Satella',
    show: !startedHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Fermer la fenêtre = minimiser en zone de notification : Satella
  // continue de tourner (macros, effets). Quitter via l'icône de la zone
  // de notification, ou lors d'une mise à jour.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.on('did-finish-load', () => {
    if (ledEngine) ledEngine.renderOnce();
  });

  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[UI ${level === 3 ? 'ERREUR' : 'avert.'}] ${message} (${sourceId}:${line})`);
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
      require('fs').writeFileSync(process.env.SATELLA_SHOT, img.toPNG());
      app.quit();
    });
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function migrateLegacyData() {
  // L'application s'appelait « Lynn » : récupère les données existantes
  // (%APPDATA%/lynn-rgb/lynn-data) si le nouveau dossier n'existe pas encore.
  const fs = require('fs');
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

function setupEngines() {
  migrateLegacyData();
  store = new Store(path.join(app.getPath('userData'), 'satella-data'));
  ledEngine = new LedEngine();
  direct = new DirectBackend();
  macroEngine = new MacroEngine({ globalShortcut });

  // État LED sauvegardé
  ledEngine.loadState(store.read('led-state', null));

  // Macros sauvegardées
  macros = store.read('macros', []);
  macroEngine.setMacros(macros);

  // Diffusion des images : aperçu UI (seulement fenêtre visible) + flux
  // temps réel vers le clavier pour les effets logiciels. Les effets natifs
  // sont programmés dans le matériel lors des changements d'état.
  ledEngine.on('frame', (frame) => {
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
      win.webContents.send('led:frame', frame);
    }
    if (settings.ledsEnabled && direct.kb && SOFT_EFFECTS.has(ledEngine.state.keyboard.effect)) {
      direct.streamKeyboard(frame.keyboard);
    }
  });
  ledEngine.on('state', (state) => {
    store.write('led-state', state);
    if (settings.ledsEnabled) {
      direct.applyKeyboard(state.keyboard);
      direct.applyMouse(state.mouse);
    }
    updateHookNeed();
  });

  direct.on('status', (s) => send('devices:direct', s));
  direct.on('log', (msg) => console.log('[direct]', msg));

  // Carte des touches calibrée par l'utilisateur, si présente
  const savedKeyMap = store.read('keymap', null);
  if (savedKeyMap) direct.setKeyMap(savedKeyMap);

  settings = { ...DEFAULT_SETTINGS, ...store.read('settings', {}) };

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
  macroEngine.on('key-activity', ({ key, down }) => {
    if (!down || !key) return;
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
  macroEngine.on('record-event', (step) => send('macro:record-event', step));
  macroEngine.on('play-state', (s) => send('macro:play-state', s));
  macroEngine.on('play-error', (e) => send('macro:play-error', e));

  applySettings();
}

// Active ou coupe les modules selon les paramètres, à chaud.
function applySettings() {
  // --- Éclairage ---
  if (settings.ledsEnabled) {
    ledEngine.start();
    direct.detect();
    direct.applyKeyboard(ledEngine.state.keyboard);
    direct.applyMouse(ledEngine.state.mouse);
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

  // --- Macros ---
  if (settings.macrosEnabled) {
    macroEngine.setMacros(macros);
  } else {
    macroEngine.stop();
    globalShortcut.unregisterAll();
  }

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
    autoOptTimer = setInterval(() => {
      const st = memory.readStatus();
      if (st && st.load >= settings.autoOptimizeThreshold) {
        const res = memory.optimize();
        send('memory:auto', res);
      }
    }, 60000);
  }

  updateHookNeed();
  send('settings:changed', settings);
}

// L'écoute clavier globale (uiohook) ne tourne que lorsqu'elle sert :
// effet réactif ou onde de choc, enregistrement de macro, calibration.
function updateHookNeed() {
  const eff = ledEngine.state.keyboard.effect;
  const forLeds = settings.ledsEnabled && (eff === 'reactive' || eff === 'ripple');
  const forMacros = settings.macrosEnabled && macroEngine.recording;
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
    send('update:error', { message: err.message });
  });
}

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
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle('app:init', () => ({
    version: app.getVersion(),
    settings,
    packaged: app.isPackaged,
    memoryAvailable: memory.available(),
    layout,
    ledState: ledEngine.state,
    macros,
    direct: direct.status(),
    hid: hid.listDevices(),
    capabilities: {
      input: input.available,
      inputError: input.loadError ? input.loadError.message : null,
      uiohook: uiohookAvailable,
    },
    keyNames: Object.keys(keys.VK),
    keyLabels: Object.fromEntries(Object.keys(keys.VK).map((k) => [k, keys.labelFor(k)])),
  }));

  // ---- LEDs ----
  ipcMain.handle('led:set', (e, device, patch) => ledEngine.setDeviceState(device, patch));
  ipcMain.handle('led:setKeys', (e, device, colors) => ledEngine.setKeys(device, colors));
  ipcMain.handle('led:clearKeys', (e, device) => ledEngine.clearKeys(device));

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
  ipcMain.handle('calib:light', (e, slot) => {
    try {
      calibrating = true;
      updateHookNeed();
      direct.kbCalibLight(slot);
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
    if (settings.macrosEnabled) macroEngine.setMacros(macros);
    return macros;
  });
  ipcMain.handle('macros:remove', (e, id) => {
    macros = macros.filter((m) => m.id !== id);
    store.write('macros', macros);
    if (settings.macrosEnabled) macroEngine.setMacros(macros);
    return macros;
  });
  ipcMain.handle('macros:play', (e, id) => macroEngine.play(id));
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

  // ---- Profils (instantanés complets : LEDs + macros) ----
  ipcMain.handle('profiles:list', () => store.read('profiles', []));
  ipcMain.handle('profiles:save', (e, name) => {
    const profiles = store.read('profiles', []);
    const idx = profiles.findIndex((p) => p.name === name);
    const profile = { name, savedAt: new Date().toISOString(), ledState: ledEngine.state, macros };
    if (idx >= 0) profiles[idx] = profile;
    else profiles.push(profile);
    store.write('profiles', profiles);
    return profiles;
  });
  ipcMain.handle('profiles:load', (e, name) => {
    const profiles = store.read('profiles', []);
    const p = profiles.find((x) => x.name === name);
    if (!p) return null;
    ledEngine.loadState(p.ledState);
    macros = p.macros || [];
    store.write('macros', macros);
    macroEngine.setMacros(macros);
    return { ledState: ledEngine.state, macros };
  });
  ipcMain.handle('profiles:remove', (e, name) => {
    const profiles = store.read('profiles', []).filter((p) => p.name !== name);
    store.write('profiles', profiles);
    return profiles;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Satella');
  const reveal = () => {
    win.show();
    win.focus();
    if (ledEngine) ledEngine.renderOnce(); // l'aperçu était en veille
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Satella', click: reveal },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', reveal);
}

app.whenReady().then(() => {
  setupEngines();
  setupUpdater();
  setupIpc();
  createWindow();
  createTray();
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (macroEngine) macroEngine.dispose();
  if (direct) direct.dispose();
});

app.on('window-all-closed', () => {
  // La fenêtre se cache au lieu de se fermer : ne quitter que si demandé
  if (quitting) app.quit();
});
