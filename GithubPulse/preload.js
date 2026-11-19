const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  refresh: () => ipcRenderer.send('refresh'),
  quit: () => ipcRenderer.send('quit'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onContrib: (cb) => ipcRenderer.on('contrib', (_e, data) => cb(data)),
  onNeedSetup: (cb) => ipcRenderer.on('need-setup', (_e, data) => cb(data)),
});
