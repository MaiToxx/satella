// Satella — processus principal Electron.
// Assemble : moteur d'effets LED, backends (OpenRGB, HID), moteur de macros,
// persistance et IPC vers l'interface.

const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron');
const https = require('https');

// Dépôt GitHub interrogé par le bouton « Vérifier les mises à jour ».
// Publier une nouvelle version = créer une release taguée vX.Y.Z sur ce
// dépôt avec l'exécutable en pièce jointe.
const UPDATE_REPO = 'MaiToxx/satella';
const path = require('path');
const { Store } = require('./src/store');
const { LedEngine } = require('./src/led/engine');
const { OpenRGB } = require('./src/led/openrgb');
const { DirectBackend, SOFT_EFFECTS } = require('./src/led/direct');
const hid = require('./src/led/hid');
const { MacroEngine, uiohookAvailable } = require('./src/macros/engine');
const input = require('./src/macros/input');
const keys = require('./src/macros/keys');
const layout = require('./src/shared/layout');

let win = null;
let store, ledEngine, openrgb, direct, macroEngine;
let macros = [];
let lastHwPush = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'Satella',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

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
  openrgb = new OpenRGB();
  direct = new DirectBackend();
  macroEngine = new MacroEngine({ globalShortcut });

  // État LED sauvegardé
  ledEngine.loadState(store.read('led-state', null));

  // Macros sauvegardées
  macros = store.read('macros', []);
  macroEngine.setMacros(macros);

  // Diffusion des images : aperçu UI + OpenRGB en secours (20 img/s max).
  // Le pilote direct n'utilise PAS ce flux : il programme les effets natifs
  // du matériel lors des changements d'état (économise la flash du clavier).
  ledEngine.on('frame', (frame) => {
    send('led:frame', frame);
    // Effets logiciels : flux temps réel vers le clavier (mode dynamique)
    if (direct.kb && SOFT_EFFECTS.has(ledEngine.state.keyboard.effect)) {
      direct.streamKeyboard(frame.keyboard);
    }
    const now = Date.now();
    if (openrgb.connected && now - lastHwPush >= 50) {
      lastHwPush = now;
      if (!direct.kb) openrgb.pushKeyboard(frame.keyboard, layout.keyboard);
      if (!direct.mouse) openrgb.pushMouse(frame.mouse, layout.mouse);
    }
  });
  ledEngine.on('state', (state) => {
    store.write('led-state', state);
    direct.applyKeyboard(state.keyboard);
    direct.applyMouse(state.mouse);
  });

  openrgb.on('status', (s) => send('devices:openrgb', s));
  direct.on('status', (s) => send('devices:direct', s));
  direct.on('log', (msg) => console.log('[direct]', msg));

  // Carte des touches calibrée par l'utilisateur, si présente
  const savedKeyMap = store.read('keymap', null);
  if (savedKeyMap) direct.setKeyMap(savedKeyMap);

  // Détection du matériel en pilotage direct + application de l'état sauvegardé
  direct.detect();
  direct.applyKeyboard(ledEngine.state.keyboard);
  direct.applyMouse(ledEngine.state.mouse);

  // Re-détection périodique si un périphérique manque (branchement à chaud)
  setInterval(() => {
    if (!direct.kb || !direct.mouse) direct.detect();
  }, 5000);

  // Effet réactif : frappe réelle -> touche allumée
  macroEngine.on('key-activity', ({ key, down }) => {
    if (!down || !key) return;
    ledEngine.keyActivity(key);
    send('macro:key-activity', { key });
  });
  macroEngine.on('record-event', (step) => send('macro:record-event', step));
  macroEngine.on('play-state', (s) => send('macro:play-state', s));
  macroEngine.on('play-error', (e) => send('macro:play-error', e));

  // Connexion OpenRGB en arrière-plan + écoute globale pour l'effet réactif
  openrgb.connect();
  macroEngine.startActivityFeed();
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'User-Agent': 'Satella-Updater', Accept: 'application/vnd.github+json' },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return reject(new Error('aucune version publiée pour le moment'));
        if (res.statusCode !== 200) return reject(new Error(`GitHub a répondu ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('délai dépassé')); });
    req.on('error', reject);
  });
}

function newerVersion(current, latest) {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

function setupIpc() {
  ipcMain.handle('app:ready', () => { ledEngine.renderOnce(); return true; });

  ipcMain.handle('app:checkUpdate', async () => {
    const current = app.getVersion();
    try {
      const release = await fetchLatestRelease();
      const latest = String(release.tag_name || '').replace(/^v/i, '');
      const asset = (release.assets || []).find((x) => /\.exe$/i.test(x.name));
      return {
        ok: true,
        current,
        latest,
        newer: latest ? newerVersion(current, latest) : false,
        url: (asset && asset.browser_download_url) || release.html_url,
      };
    } catch (err) {
      return { ok: false, current, error: err.message };
    }
  });

  ipcMain.handle('app:openUpdatePage', (e, url) => {
    if (typeof url === 'string' && /^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('app:init', () => ({
    version: app.getVersion(),
    layout,
    ledState: ledEngine.state,
    macros,
    openrgb: openrgb.status(),
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
    try { direct.kbCalibLight(slot); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('calib:finish', (e, map) => {
    direct.kbCalibEnd();
    if (map && Object.keys(map).length) {
      store.write('keymap', map);
      direct.setKeyMap(map);
    }
    direct.applyKeyboard(ledEngine.state.keyboard);
    return true;
  });
  ipcMain.handle('calib:cancel', () => {
    direct.kbCalibEnd();
    direct.applyKeyboard(ledEngine.state.keyboard);
    return true;
  });
  ipcMain.handle('devices:reconnectOpenrgb', async (e, host, port) => openrgb.connect(host, port));

  // ---- Macros ----
  ipcMain.handle('macros:save', (e, macro) => {
    const idx = macros.findIndex((m) => m.id === macro.id);
    if (idx >= 0) macros[idx] = macro;
    else macros.push(macro);
    store.write('macros', macros);
    macroEngine.setMacros(macros);
    return macros;
  });
  ipcMain.handle('macros:remove', (e, id) => {
    macros = macros.filter((m) => m.id !== id);
    store.write('macros', macros);
    macroEngine.setMacros(macros);
    return macros;
  });
  ipcMain.handle('macros:play', (e, id) => macroEngine.play(id));
  ipcMain.handle('macros:stop', (e, id) => macroEngine.stop(id));
  ipcMain.handle('macros:recordStart', (e, opts) => {
    macroEngine.startRecording(opts);
    return true;
  });
  ipcMain.handle('macros:recordStop', () => macroEngine.stopRecording());

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

app.whenReady().then(() => {
  setupEngines();
  setupIpc();
  createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (macroEngine) macroEngine.dispose();
  if (direct) direct.dispose();
  if (openrgb) openrgb.disconnect();
});

app.on('window-all-closed', () => {
  app.quit();
});
