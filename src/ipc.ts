// What the main process and the window say to each other: for each channel, its
// arguments and its reply. Types only. `src/main.ts` checks the arguments it
// receives against these, `src/preload.cts` builds `window.api` from them.
import type { AgyModel } from './agent/antigravity.ts';
import type { claudeModels, claudeUsage } from './agent/claude.ts';
import type { Skill } from './agent/skills.ts';
import type { TorStatus } from './agent/tor.ts';
import type { ModelEngine } from './engine/engine.ts';
import type { listDir, OpeningApp, ViewedFile } from './files.ts';
import type { GitBranches, GitRepoStatus, gitFileStates } from './git.ts';
import type { AgentEvent, ApprovalRequest, AskDraft, Choice, Config, ConversationPair, ContextStats, ConversationSummary, EngineSettings, ProjectIcon, Provider, ProviderType, PublicSettings, QuestionAnswer, Steps, ToolArgs, Viewing } from './types.ts';

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
  askDraft: AskDraft | null;
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

/** Antigravity (agy): its models, or why there are none. */
export interface AntigravityStatus {
  installed: boolean;
  enabled: boolean;
  models: AgyModel[];
  error: string | null;
}

export interface ClaudeStatus {
  installed: boolean;
  accounts: ClaudeAccount[];
}

/** gh's login, and the tokens saved for remote repositories (never the tokens themselves). */
export interface RemotesStatus {
  ghInstalled: boolean;
  gh: string | null;
  tokens: { id: string; url: string; user: string; account: string | null }[];
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
/** The applications that can open a file, each with its icon (a data URL). */
export type OpeningApps = { default: OpeningAppView | null; others: OpeningAppView[] };
export type OpeningAppView = OpeningApp & { icon: string };
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
  'agent:send': [[text: string, turnId?: string, viewing?: Viewing | null], boolean];
  'agent:rewind': [[turnId: string], { events: AgentEvent[] }];
  'agent:resumeFrom': [[actId: number, edited?: ToolArgs], { events: AgentEvent[] }];
  'agent:stop': [[], void];
  'agent:reset': [[], PublicSettings];
  'agent:retryText': [[], string];
  'agent:approve': [[answer: { id: number; ok: boolean; always?: boolean; reason?: string; answers?: QuestionAnswer[] }], PublicSettings];
  'conversations:list': [[], { current: string | null; partner: string | null; all: ConversationSummary[] }];
  'conversations:newOffProject': [[], PublicSettings];
  'conversations:open': [[id: string], SessionView];
  'conversations:rename': [[id: string, title: string], string];
  'conversations:delete': [[id: string], void];
  'conversations:markRead': [[ids: string[]], void];
  'session:current': [[], SessionView];
  'session:view': [[key: string], SessionView];
  'session:focus': [[key: string], void];
  'session:split': [[], void];
  'session:unsplit': [[keep: string | null], PublicSettings];
  'session:setPairs': [[pairs: ConversationPair[], shown: string | null], void];
  'session:setChoice': [[patch: Choice], PublicSettings];
  'session:setDraft': [[text: string], void];
  'session:setAskDraft': [[draft: AskDraft | null], void];
  'claude:status': [[], ClaudeStatus];
  'antigravity:status': [[], AntigravityStatus];
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
  'files:image': [[src: string], string | null];
  'files:openExternal': [[rel: string], string];
  'files:reveal': [[rel: string], void];
  'files:apps': [[rel: string], OpeningApps];
  'files:busy': [[], boolean];
  'files:rename': [[rel: string, name: string], string];
  'files:trash': [[rel: string], void];
  'app:desktop': [[], string];
  'files:openWith': [[rel: string, app: string | null], void];
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
  'remotes:status': [[], RemotesStatus];
  'github:openTokenPage': [[], void];
  'remotes:addToken': [[token: { url: string; token: string; user?: string }], RemotesStatus];
  'remotes:removeToken': [[id: string], RemotesStatus];
  'git:clone': [[url: string, parent: string], string];
  'dialog:folder': [[from: string | null], string | null];
}

export type Channel = keyof Channels;
export type Args<C extends Channel> = Channels[C][0];
export type Reply<C extends Channel> = Channels[C][1];
