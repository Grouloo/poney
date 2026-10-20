const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setConfig: (patch) => ipcRenderer.invoke('settings:setConfig', patch),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),
  revealWorkspace: () => ipcRenderer.invoke('workspace:reveal'),
  listModels: (cfg) => ipcRenderer.invoke('models:list', cfg),
  send: (text, turnId) => ipcRenderer.invoke('agent:send', text, turnId),
  rewind: (turnId) => ipcRenderer.invoke('agent:rewind', turnId),
  stop: () => ipcRenderer.invoke('agent:stop'),
  reset: () => ipcRenderer.invoke('agent:reset'),
  approve: (id, ok, always) => ipcRenderer.invoke('agent:approve', { id, ok, always }),
  onEvent: (fn) => ipcRenderer.on('agent:event', (_, ev) => fn(ev)),
  onApproval: (fn) => ipcRenderer.on('agent:approval', (_, req) => fn(req)),

  listConversations: () => ipcRenderer.invoke('conversations:list'),
  openConversation: (id) => ipcRenderer.invoke('conversations:open', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  onConversationsChanged: (fn) => ipcRenderer.on('conversations:changed', (_, id) => fn(id)),

  getSystemPrompt: () => ipcRenderer.invoke('prompt:get'),
  setSystemPrompt: (text) => ipcRenderer.invoke('prompt:set', text),

  checkTor: () => ipcRenderer.invoke('tor:check'),
  torStatus: () => ipcRenderer.invoke('tor:status'),
  torNewCircuits: () => ipcRenderer.invoke('tor:newnym'),
  getContext: () => ipcRenderer.invoke('context:get'),
  compactContext: () => ipcRenderer.invoke('context:compact'),

  listFiles: (rel) => ipcRenderer.invoke('files:list', rel),
  readFile: (rel) => ipcRenderer.invoke('files:read', rel),
  openFileExternal: (rel) => ipcRenderer.invoke('files:openExternal', rel),
  revealFile: (rel) => ipcRenderer.invoke('files:reveal', rel),
});
