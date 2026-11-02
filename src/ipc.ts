// What the main process and the window say to each other: for each channel, its
// arguments and its reply. Types only. `src/main.ts` checks the arguments it
// receives against these, `src/preload.cts` builds `window.api` from them.
import type { claudeModels, claudeUsage } from './agent/claude.ts';
import type { Skill } from './agent/skills.ts';
import type { TorStatus } from './agent/tor.ts';
import type { ModelEngine } from './engine/engine.ts';
import type { listDir, ViewedFile } from './files.ts';
import type { GitBranches, GitRepoStatus, gitFileStates } from './git.ts';
import type { AgentEvent, ApprovalRequest, Choice, Config, ContextStats, ConversationSummary, EngineSettings, ProjectIcon, Provider, ProviderType, PublicSettings, QuestionAnswer, Steps } from './types.ts';

/** An event of the agent, with the conversation it comes from. */
export type SessionEvent = AgentEvent & { session?: string };
export type SessionApproval = ApprovalRequest & { session: string };
/** A conversation in the background finished, failed or asks for an approval. */
export interface AppAlert {
  session: string;
  kind: 'done' | 'error' | 'approval' | 'question';
  title: string;
  body: string;
}

/** What the window needs to show a conversation. */
export interface SessionView {
  events: AgentEvent[];
  running: boolean;
  partial: { id: number; text: string; thinking: string } | null;
  approvals: SessionApproval[];
  memory: string[];
  draft: string;
  session: string;
  settings: PublicSettings;
}

export interface ListedModel {
  id: string;
  name: string;
  contextLength?: number | null;
}

export interface ModelGroup {
  provider: { id: string; type: ProviderType };
  name?: string;
  icon?: string | null;
  models: ListedModel[];
  error?: string;
}

export interface EngineStatus {
  supported: boolean;
  installed: boolean;
  loaded: ReturnType<ModelEngine['status']>;
  folder: string;
}

export type ClaudeModel = Awaited<ReturnType<typeof claudeModels>>[number];
export type ClaudeUsage = Awaited<ReturnType<typeof claudeUsage>>;

/** A Claude account: the machine's (id 'claude'), or one added in Poney. */
export interface ClaudeAccount {
  id: string;
  name: string;
  email: string | null;
  plan: string | null;
  loggedIn: boolean;
  models: ClaudeModel[];
}

export interface ClaudeStatus {
  installed: boolean;
  accounts: ClaudeAccount[];
}

export interface GithubStatus {
  ghInstalled: boolean;
  gh: string | null;
  tokenSaved: boolean;
  token: string | null;
  canSave: boolean;
}

export interface SystemPromptView {
  default: string;
  custom: string | null;
  running: boolean;
}

export interface TorCheck {
  ok: boolean;
  proxy?: string;
  isTor?: boolean;
  ip?: string;
  error?: string;
}

export interface CompactResult {
  compacted: boolean;
  reason?: string;
  before?: number;
  after?: number;
  fallback?: boolean;
  failure?: string | null;
}

export interface ContextMenuParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  suggestions: string[];
  editFlags: Electron.EditFlags;
}

export type ListedSkill = Pick<Skill, 'name' | 'description' | 'author' | 'origin'>;
export type FileEntries = Awaited<ReturnType<typeof listDir>>;
export type FileStates = Awaited<ReturnType<typeof gitFileStates>>;

/** Each channel: [its arguments, its reply]. */
export interface Channels {
  'settings:get': [[], PublicSettings];
  'settings:setConfig': [[patch: Partial<Config>], PublicSettings];
  'workspace:choose': [[], PublicSettings];
  'workspace:set': [[dir: string], PublicSettings];
  'workspace:reveal': [[], string];
  'project:setIcon': [[key: string, icon: ProjectIcon | null], PublicSettings];
  'project:setName': [[dir: string, name: string], PublicSettings];
  'project:setOrder': [[keys: unknown[]], PublicSettings];
  'project:setHidden': [[dir: string, hidden: boolean], PublicSettings];
  'project:pickIcon': [[key: string], PublicSettings];
  'project:delete': [[dir: string], PublicSettings];
  'ui:edit': [[cmd: string, arg?: string], void];
  'providers:models': [[], ModelGroup[]];
  'providers:add': [[server: Partial<Provider>], PublicSettings];
  'providers:update': [[id: string, patch: Partial<Provider>], PublicSettings];
  'providers:remove': [[id: string], PublicSettings];
  'engine:status': [[], EngineStatus];
  'engine:openModels': [[], void];
  'engine:setContext': [[model: string, numCtx: number | null], PublicSettings];
  'engine:setOptions': [[patch: Partial<EngineSettings>], PublicSettings];
  'agent:send': [[text: string, turnId?: string], boolean];
  'agent:rewind': [[turnId: string], { events: AgentEvent[] }];
  'agent:resumeFrom': [[actId: number], { events: AgentEvent[] }];
  'agent:stop': [[], void];
  'agent:reset': [[], PublicSettings];
  'agent:retryText': [[], string];
  'agent:approve': [[answer: { id: number; ok: boolean; always?: boolean; reason?: string; answers?: QuestionAnswer[] }], PublicSettings];
  'conversations:list': [[], { current: string | null; all: ConversationSummary[] }];
  'conversations:newOffProject': [[], PublicSettings];
  'conversations:open': [[id: string], SessionView];
  'conversations:rename': [[id: string, title: string], string];
  'conversations:delete': [[id: string], void];
  'conversations:markRead': [[ids: string[]], void];
  'session:current': [[], SessionView];
  'session:setChoice': [[patch: Choice], PublicSettings];
  'session:setDraft': [[text: string], void];
  'claude:status': [[], ClaudeStatus];
  'claude:usage': [[], ClaudeUsage];
  'claude:addAccount': [[], { settings: PublicSettings; id: string }];
  'claude:login': [[id: string], boolean];
  'claude:loginCode': [[code: string], void];
  'claude:loginCancel': [[], void];
  'skills:list': [[], ListedSkill[]];
  'memory:get': [[], string[]];
  'memory:set': [[notes: unknown[]], string[]];
  'steps:get': [[], Steps | null];
  'steps:set': [[steps: Steps], Steps | null];
  'prompt:get': [[], SystemPromptView | null];
  'prompt:set': [[text: string | null], SystemPromptView];
  'tor:status': [[], TorStatus];
  'tor:newnym': [[], { ok: boolean }];
  'tor:check': [[], TorCheck];
  'context:get': [[], ContextStats | null];
  'context:compact': [[], CompactResult];
  'files:observe': [[dir: string | null], void];
  'files:list': [[rel?: string], FileEntries];
  'files:read': [[rel: string], ViewedFile];
  'files:openExternal': [[rel: string], string];
  'files:reveal': [[rel: string], void];
  'git:status': [[], GitRepoStatus];
  'git:fileStates': [[], FileStates];
  'git:diff': [[file: string, opts?: { staged?: boolean; oldPath?: string }], { diff: string; truncated: boolean }];
  'git:fetch': [[], void];
  'git:branches': [[], GitBranches];
  'git:switch': [[name: string], void];
  'git:createBranch': [[name: string], void];
  'git:sync': [[], void];
  'git:connect': [[url: string], void];
  'git:remote': [[dir: string | null | undefined], string | null];
  'git:setRemote': [[dir: string, url: string], void];
  'git:removeRemote': [[dir: string], void];
  'git:createGithub': [[repo: { name: string; isPrivate: boolean; token: string }], void];
  'github:status': [[], GithubStatus];
  'github:openTokenPage': [[], void];
  'github:setToken': [[token: string], GithubStatus];
  'github:removeToken': [[], GithubStatus];
}

export type Channel = keyof Channels;
export type Args<C extends Channel> = Channels[C][0];
export type Reply<C extends Channel> = Channels[C][1];
