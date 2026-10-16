const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setConfig: (patch) => ipcRenderer.invoke('settings:setConfig', patch),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),
  revealWorkspace: () => ipcRenderer.invoke('workspace:reveal'),
  listModels: (cfg) => ipcRenderer.invoke('models:list', cfg),
  send: (text) => ipcRenderer.invoke('agent:send', text),
  stop: () => ipcRenderer.invoke('agent:stop'),
  reset: () => ipcRenderer.invoke('agent:reset'),
  approve: (id, ok, always) => ipcRenderer.invoke('agent:approve', { id, ok, always }),
  onEvent: (fn) => ipcRenderer.on('agent:event', (_, ev) => fn(ev)),
  onApproval: (fn) => ipcRenderer.on('agent:approval', (_, req) => fn(req)),
});
