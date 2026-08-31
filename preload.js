// Pont sécurisé entre l'interface et le processus principal.
const { contextBridge, ipcRenderer } = require('electron');

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
    onFrame: on('led:frame'),
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
    play: (id) => ipcRenderer.invoke('macros:play', id),
    stop: (id) => ipcRenderer.invoke('macros:stop', id),
    recordStart: (opts) => ipcRenderer.invoke('macros:recordStart', opts),
    recordStop: () => ipcRenderer.invoke('macros:recordStop'),
    onRecordEvent: on('macro:record-event'),
    onPlayState: on('macro:play-state'),
    onPlayError: on('macro:play-error'),
    onKeyActivity: on('macro:key-activity'),
  },

  memory: {
    status: () => ipcRenderer.invoke('memory:status'),
    optimize: () => ipcRenderer.invoke('memory:optimize'),
    onAuto: on('memory:auto'),
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
    remove: (name) => ipcRenderer.invoke('profiles:remove', name),
    setMeta: (name, meta) => ipcRenderer.invoke('profiles:setMeta', name, meta),
    onAutoApplied: on('profiles:autoApplied'),
  },
});
