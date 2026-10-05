// Pont sécurisé entre l'interface et le processus principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel) {
  return (cb) => {
    const listener = (e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('satella', {
  init: () => ipcRenderer.invoke('app:init'),
  ready: () => ipcRenderer.invoke('app:ready'),
  setPage: (page) => ipcRenderer.send('ui:page', page),
  diagnostic: () => ipcRenderer.invoke('app:diagnostic'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  openData: () => ipcRenderer.invoke('app:openData'),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  runAction: (name) => ipcRenderer.invoke('app:action', name),
  onPaletteOpen: on('palette:open'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdateAvailable: on('update:available'),
  onUpdateProgress: on('update:progress'),
  onUpdateReady: on('update:ready'),
  onUpdateError: on('update:error'),

  led: {
    set: (device, patch) => ipcRenderer.invoke('led:set', device, patch),
    setKeys: (device, colors) => ipcRenderer.invoke('led:setKeys', device, colors),
    clearKeys: (device) => ipcRenderer.invoke('led:clearKeys', device),
    setOverlay: (device, colors) => ipcRenderer.invoke('led:setOverlay', device, colors),
    removeOverlay: (device, ids) => ipcRenderer.invoke('led:removeOverlay', device, ids),
    setManualOff: (on) => ipcRenderer.invoke('leds:setManualOff', on),
    onFrame: on('led:frame'),
    onDimmed: on('leds:dimmed'),
    onState: on('led:state'),
  },

  // Effets capturés dans l'interface (son, écran) : les données calculées
  // partent vers le moteur
  capture: {
    sendBands: (bands) => ipcRenderer.send('audio:bands', bands),
    sendGrid: (grid) => ipcRenderer.send('screen:grid', grid),
    reportError: (kind, message) => ipcRenderer.send('capture:error', kind, message),
    onStop: on('capture:stop'),
  },

  devices: {
    refreshHid: () => ipcRenderer.invoke('devices:refreshHid'),
    directStatus: () => ipcRenderer.invoke('devices:directStatus'),
    testKeyboard: (r, g, b) => ipcRenderer.invoke('devices:testKeyboard', r, g, b),
    hookDebug: (on) => ipcRenderer.invoke('devices:hookDebug', on),
    testMouse: (mode) => ipcRenderer.invoke('devices:testMouse', mode),
    onDirectStatus: on('devices:direct'),
  },

  macros: {
    save: (macro) => ipcRenderer.invoke('macros:save', macro),
    remove: (id) => ipcRenderer.invoke('macros:remove', id),
    play: (id, draft) => ipcRenderer.invoke('macros:play', id, draft),
    stop: (id) => ipcRenderer.invoke('macros:stop', id),
    recordStart: (opts) => ipcRenderer.invoke('macros:recordStart', opts),
    recordStop: () => ipcRenderer.invoke('macros:recordStop'),
    onRecordEvent: on('macro:record-event'),
    onPlayState: on('macro:play-state'),
    onPlayError: on('macro:play-error'),
    onKeyActivity: on('macro:key-activity'),
  },

  shortcuts: {
    errors: () => ipcRenderer.invoke('shortcuts:errors'),
    onErrors: on('shortcuts:errors'),
  },

  snippets: {
    get: () => ipcRenderer.invoke('snippets:get'),
    set: (list) => ipcRenderer.invoke('snippets:set', list),
  },

  turbos: {
    get: () => ipcRenderer.invoke('turbos:get'),
    set: (list) => ipcRenderer.invoke('turbos:set', list),
    onState: on('turbo:state'),
  },

  // Statistiques de frappe (comptage par touche, stocké sur ce PC)
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
    reset: () => ipcRenderer.invoke('stats:reset'),
  },

  // Minuteur visuel (rangée F1-F12)
  timer: {
    get: () => ipcRenderer.invoke('timer:get'),
    start: (minutes) => ipcRenderer.invoke('timer:start', minutes),
    stop: () => ipcRenderer.invoke('timer:stop'),
    onState: on('timer:state'),
  },

  // Sauvegardes automatiques (dossier satella-data/sauvegardes)
  backups: {
    list: () => ipcRenderer.invoke('backups:list'),
    now: () => ipcRenderer.invoke('backups:now'),
    openFolder: () => ipcRenderer.invoke('backups:openFolder'),
    restore: (name) => ipcRenderer.invoke('backups:restore', name),
  },

  memory: {
    status: () => ipcRenderer.invoke('memory:status'),
    optimize: () => ipcRenderer.invoke('memory:optimize'),
    onAuto: on('memory:auto'),
  },

  // Réglages de performance de Windows (page Optimiseur)
  tuning: {
    probe: () => ipcRenderer.invoke('tuning:probe'),
    set: (key, value) => ipcRenderer.invoke('tuning:set', key, value),
    createUltimate: () => ipcRenderer.invoke('tuning:createUltimate'),
    preset: (id) => ipcRenderer.invoke('tuning:preset', id),
    gpuPref: (exe, pref) => ipcRenderer.invoke('tuning:gpuPref', exe, pref),
    pickExe: () => ipcRenderer.invoke('tuning:pickExe'),
    startup: (id, enabled) => ipcRenderer.invoke('tuning:startup', id, enabled),
    tempInfo: () => ipcRenderer.invoke('tuning:tempInfo'),
    tempClean: () => ipcRenderer.invoke('tuning:tempClean'),
    onApplied: on('tuning:applied'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    startupState: () => ipcRenderer.invoke('settings:startupState'),
    onChanged: on('settings:changed'),
  },

  calib: {
    light: (slot) => ipcRenderer.invoke('calib:light', slot),
    finish: (map) => ipcRenderer.invoke('calib:finish', map),
    cancel: () => ipcRenderer.invoke('calib:cancel'),
  },

  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (name) => ipcRenderer.invoke('profiles:save', name),
    load: (name) => ipcRenderer.invoke('profiles:load', name),
    rename: (oldName, newName) => ipcRenderer.invoke('profiles:rename', oldName, newName),
    remove: (name) => ipcRenderer.invoke('profiles:remove', name),
    restore: (profile) => ipcRenderer.invoke('profiles:restore', profile),
    duplicate: (name) => ipcRenderer.invoke('profiles:duplicate', name),
    setMeta: (name, meta) => ipcRenderer.invoke('profiles:setMeta', name, meta),
    onAutoApplied: on('profiles:autoApplied'),
    onChanged: on('profiles:changed'),
  },

  data: {
    exportProfile: (name) => ipcRenderer.invoke('data:export', 'profile', name),
    exportAll: () => ipcRenderer.invoke('data:export', 'backup'),
    exportMacro: (macro) => ipcRenderer.invoke('data:export', 'macro', macro),
    import: () => ipcRenderer.invoke('data:import'),
    // Fichier glissé-déposé : son chemin n'est connu que du pont
    importFile: (file) => ipcRenderer.invoke('data:importFile', webUtils.getPathForFile(file)),
  },
});
