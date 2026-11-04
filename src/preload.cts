import type { AppAlert, Args, Channel, ContextMenuParams, Reply, SessionApproval, SessionEvent } from './ipc.ts' with { 'resolution-mode': 'import' };
import type { QuestionAnswer } from './types.ts' with { 'resolution-mode': 'import' };

const { contextBridge, ipcRenderer, webUtils } = require('electron') as typeof Electron;

// Before each call: the window says which conversation it comes from (its split view's pane).
let beforeCall = () => {};
/** A call to the main process, typed by the contract of src/ipc.ts (which main.ts checks). */
const call = <C extends Channel>(channel: C) => (...args: Args<C>) => {
  beforeCall();
  return ipcRenderer.invoke(channel, ...args) as Promise<Reply<C>>;
};

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
  approve: (id: number, ok: boolean, always?: boolean, reason?: string) => call('agent:approve')({ id, ok, always, reason }),
  answer: (id: number, answers: QuestionAnswer[] | null) => call('agent:approve')({ id, ok: Boolean(answers), answers: answers ?? undefined }),
  onEvent: onValue<SessionEvent>('agent:event'),
  onApproval: onValue<SessionApproval>('agent:approval'),

  currentSession: call('session:current'),
  sessionView: call('session:view'),
  focusSession: (key: string) => ipcRenderer.invoke('session:focus', key) as Promise<Reply<'session:focus'>>, // (itself not preceded)
  beforeCalls: (fn: () => void) => { beforeCall = fn; },
  split: call('session:split'),
  unsplit: call('session:unsplit'),
  setPairs: call('session:setPairs'),
  listConversations: call('conversations:list'),
  openConversation: call('conversations:open'),
  renameConversation: call('conversations:rename'),
  deleteConversation: call('conversations:delete'),
  markConversationsRead: call('conversations:markRead'),
  onConversationsChanged: onValue<string>('conversations:changed'),
  onSessionsChanged: on('sessions:changed'),
  onRenameConversation: on('ui:renameConversation'),
  claudeStatus: call('claude:status'),
  antigravityStatus: call('antigravity:status'),
  claudeUsage: call('claude:usage'),
  antigravityUsage: call('antigravity:usage'),
  antigravityUsageGroups: call('antigravity:usageGroups'),
  addClaudeAccount: call('claude:addAccount'),
  claudeLogin: call('claude:login'),
  claudeLoginCode: call('claude:loginCode'),
  claudeLoginCancel: call('claude:loginCancel'),
  retryText: call('agent:retryText'),
  setChoice: call('session:setChoice'),
  listSkills: call('skills:list'),
  setDraft: call('session:setDraft'),
  setAskDraft: call('session:setAskDraft'),
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
  readImage: call('files:image'),
  saveImage: call('files:saveImage'),
  imageInto: call('files:imageInto'),
  moveInto: call('files:moveInto'),
  /** The path of a file dropped from the Finder. */
  pathOf: (file: File) => webUtils.getPathForFile(file),
  openFileExternal: call('files:openExternal'),
  revealFile: call('files:reveal'),
  makeFolder: call('files:mkdir'),
  attachFiles: call('files:attach'),
  projectFiles: call('files:all'),
  attachPick: call('files:attachPick'),
  attachData: call('files:attachData'),
  moveFiles: call('files:move'),
  appsToOpen: call('files:apps'),
  projectBusy: call('files:busy'),
  renameFile: call('files:rename'),
  trashFile: call('files:trash'),
  desktopPath: call('app:desktop'),
  openFileWith: call('files:openWith'),

  gitStatus: call('git:status'),
  gitFileStates: call('git:fileStates'),
  gitDiff: call('git:diff'),
  gitFetch: call('git:fetch'),
  gitBranches: call('git:branches'),
  gitSwitch: call('git:switch'),
  gitCreateBranch: call('git:createBranch'),
  gitSync: call('git:sync'),
  gitConnect: call('git:connect'),
  gitRemote: call('git:remote'),
  gitSetRemote: call('git:setRemote'),
  gitRemoveRemote: call('git:removeRemote'),
  remotesStatus: call('remotes:status'),
  githubOpenTokenPage: call('github:openTokenPage'),
  addRemoteToken: call('remotes:addToken'),
  removeRemoteToken: call('remotes:removeToken'),
  gitClone: call('git:clone'),
  chooseFolder: call('dialog:folder'),
  gitCreateGithub: call('git:createGithub'),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
