const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aceAgent', {
  login: (payload) => ipcRenderer.invoke('agent:login', payload),
  acceptConsent: (accepted) => ipcRenderer.invoke('agent:consent', accepted),
  setApiBase: (apiBase) => ipcRenderer.invoke('agent:set-api', apiBase),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  withdraw: () => ipcRenderer.invoke('agent:withdraw'),
  getStatus: () => ipcRenderer.invoke('agent:status'),
  installUpdate: () => ipcRenderer.invoke('agent:install-update'),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:update-status', listener);
    return () => ipcRenderer.removeListener('agent:update-status', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:status-update', listener);
    return () => ipcRenderer.removeListener('agent:status-update', listener);
  },
});
