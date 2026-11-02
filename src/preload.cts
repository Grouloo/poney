import type { AppAlert, Args, Channel, ContextMenuParams, Reply, SessionApproval, SessionEvent } from './ipc.ts' with { 'resolution-mode': 'import' };

const { contextBridge, ipcRenderer } = require('electron') as typeof Electron;

/** A call to the main process, typed by the contract of src/ipc.ts (which main.ts checks). */
const call = <C extends Channel>(channel: C) => (...args: Args<C>) => ipcRenderer.invoke(channel, ...args) as Promise<Reply<C>>;

/** Tells when the main process says something on this channel. */
const on = (channel: string) => (fn: () => void) => ipcRenderer.on(channel, () => fn());
const onValue = <T,>(channel: string) => (fn: (value: T) => void) => ipcRenderer.on(channel, (_, value: T) => fn(value));

const api = {
  platform: process.platform,
  getSettings: call('settings:get'),
  setConfig: call('settings:setConfig'),
  chooseWorkspace: call('workspace:choose'),
  setWorkspace: call('workspace:set'),
  revealWorkspace: call('workspace:reveal'),
  setProjectIcon: call('project:setIcon'),
  setProjectName: call('project:setName'),
  setProjectOrder: call('project:setOrder'),
  setProjectHidden: call('project:setHidden'),
  pickProjectIcon: call('project:pickIcon'),
  deleteProject: call('project:delete'),
  providerModels: call('providers:models'),
  addProvider: call('providers:add'),
  updateProvider: call('providers:update'),
  removeProvider: call('providers:remove'),
  engineStatus: call('engine:status'),
  onModelsChanged: on('models:changed'),
  openModelsFolder: call('engine:openModels'),
  setModelContext: call('engine:setContext'),
  setEngineOptions: call('engine:setOptions'),
  send: call('agent:send'),
  rewind: call('agent:rewind'),
  resumeFrom: call('agent:resumeFrom'),
  stop: call('agent:stop'),
  reset: call('agent:reset'),
  newOffProject: call('conversations:newOffProject'),
  approve: (id: number, ok: boolean, always?: boolean, reason?: string) => ipcRenderer.invoke('agent:approve', { id, ok, always, reason }) as Promise<Reply<'agent:approve'>>,
  onEvent: onValue<SessionEvent>('agent:event'),
  onApproval: onValue<SessionApproval>('agent:approval'),

  currentSession: call('session:current'),
  listConversations: call('conversations:list'),
  openConversation: call('conversations:open'),
  renameConversation: call('conversations:rename'),
  deleteConversation: call('conversations:delete'),
  markConversationsRead: call('conversations:markRead'),
  onConversationsChanged: onValue<string>('conversations:changed'),
  onSessionsChanged: on('sessions:changed'),
  onRenameConversation: on('ui:renameConversation'),
  claudeStatus: call('claude:status'),
  claudeUsage: call('claude:usage'),
  addClaudeAccount: call('claude:addAccount'),
  claudeLogin: call('claude:login'),
  claudeLoginCode: call('claude:loginCode'),
  claudeLoginCancel: call('claude:loginCancel'),
  retryText: call('agent:retryText'),
  setChoice: call('session:setChoice'),
  listSkills: call('skills:list'),
  setDraft: call('session:setDraft'),
  onOpenSettings: on('ui:openSettings'),
  onContextMenu: onValue<ContextMenuParams>('ui:contextMenu'),
  onSwipe: onValue<'left' | 'right'>('ui:swipe'),
  onAlert: onValue<AppAlert>('ui:alert'),
  onOpenConversation: onValue<string>('ui:openConversation'),
  edit: call('ui:edit'),

  getMemory: call('memory:get'),
  setMemory: call('memory:set'),
  getSteps: call('steps:get'),
  setSteps: call('steps:set'),
  getSystemPrompt: call('prompt:get'),
  setSystemPrompt: call('prompt:set'),

  checkTor: call('tor:check'),
  torStatus: call('tor:status'),
  torNewCircuits: call('tor:newnym'),
  getContext: call('context:get'),
  compactContext: call('context:compact'),

  observeProject: call('files:observe'),
  listFiles: call('files:list'),
  readFile: call('files:read'),
  openFileExternal: call('files:openExternal'),
  revealFile: call('files:reveal'),

  gitStatus: call('git:status'),
  gitFileStates: call('git:fileStates'),
  gitDiff: call('git:diff'),
  gitFetch: call('git:fetch'),
  gitSync: call('git:sync'),
  gitConnect: call('git:connect'),
  gitRemote: call('git:remote'),
  gitSetRemote: call('git:setRemote'),
  gitRemoveRemote: call('git:removeRemote'),
  githubStatus: call('github:status'),
  githubOpenTokenPage: call('github:openTokenPage'),
  githubSetToken: call('github:setToken'),
  githubRemoveToken: call('github:removeToken'),
  gitCreateGithub: call('git:createGithub'),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
