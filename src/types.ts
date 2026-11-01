// The shapes shared by the agents, the main process and the window. Types only:
// nothing here exists at run time.

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
  keep?: boolean;
}

export type Theme = 'system' | 'light' | 'dark';

export interface Config {
  autoSkills: boolean;
  theme: Theme;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  numCtx: number;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  commandTimeout: number;
  approval: string;
  shellEnabled: boolean;
  webEnabled: boolean;
  autoFetch: boolean;
  torEnabled: boolean;
  torProxy: string;
  torShell: boolean;
  subagentsEnabled: boolean;
  maxParallelAgents: number;
  parallelAgents: boolean;
  maxInferences: number;
  testCommand: string;
  searxngUrl: string;
  memoryEnabled?: boolean;
  autoRecall?: boolean;
}

export type EngineName = 'local' | 'claude';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The model of a conversation. */
export interface Choice {
  engine?: EngineName;
  model?: string | null;
  effort?: Effort;
  mode?: string;
  provider?: string;
}

export type ToolArgs = Record<string, string | undefined>;

/** Something the agent is to run. */
export interface Action {
  tool: string;
  args: ToolArgs;
  raw?: string;
  start?: number;
  end?: number;
  complete?: boolean;
  calledAs?: string | null;
  outputs?: Map<string, string> | null;
  resumeId?: number;
  planReports?: string[];
}

/** An action found in a model's answer. */
export interface ParsedAction extends Action {
  raw: string;
  start: number;
  end: number;
  complete: boolean;
}

export type Meta = Record<string, unknown>;

export interface ApprovalRequest {
  id: number;
  tool: string;
  command?: string;
  claude?: boolean;
  agentTitle?: string;
}

export type ApprovalAnswer = boolean | { ok: boolean; reason?: string };
export type Approve = (req: ApprovalRequest) => Promise<ApprovalAnswer>;

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PlanTask {
  text: string;
  status: TaskStatus;
  parallel?: boolean;
  report?: string;
}

export interface Plan {
  tasks: PlanTask[];
  done: Record<string, string>;
  work: { task: string; items: string[] }[];
  carried?: boolean;
}

export interface Steps {
  before?: string;
  after?: string;
  afterOnlyIfChanged?: boolean;
  triage?: boolean;
}

export interface Checkpoint {
  turnId?: string;
  kind?: 'action';
  actIds?: number[];
  archive?: number | null;
  length?: number;
  untested?: boolean;
  plan?: Plan | null;
  memory?: string[];
  memoryShownAt?: number;
  chapters?: string[];
  remaining?: Action[];
  priorResults?: string[];
  turnStartIndex?: number;
  currentTask?: string | null;
  rebuild?: boolean;
}

/** Where a turn starts again from, a checkpoint or a state rebuilt from the transcript. */
export interface ResumeState {
  remaining?: Action[];
  priorResults?: string[];
  turnStartIndex?: number;
  currentTask?: string | null;
}

export interface RebuiltAction extends ResumeState {
  messages: Message[];
  remaining: Action[];
  priorResults: string[];
  turnStartIndex: number;
  currentTask: string | null;
  turnId: string | null;
  cutAt: number;
}

export interface GenerationStats {
  totalMs: number;
  promptMs: number;
  genMs: number;
  tokens: number;
  tps: number;
  exact: boolean;
}

export interface TurnStats {
  totalMs: number;
  genMs: number;
  promptMs: number;
  tokens: number;
  exact: boolean;
  steps: number;
  tps?: number;
}

export interface ContextStats {
  type: 'context';
  used?: number;
  numCtx?: number;
  settingCtx?: number;
  serverCtx?: number | null;
  compactAt?: number;
  limit?: number;
  calibrated?: boolean;
  measured?: number | null;
  claude?: boolean;
}

export interface TriageItem {
  point: string;
  why: string;
}

export type TriageRoute = 'direct' | 'check' | 'investigate';

export interface Triage {
  known: TriageItem[];
  doubts: TriageItem[];
  unknowns: TriageItem[];
  route: TriageRoute;
}

export interface SkillView {
  name: string;
  description: string;
  author: string;
  source: string;
  auto: boolean;
}

export interface RecalledPassage {
  n: number;
  role: Role;
  excerpt: string;
}

export interface FetchedPage {
  url: string;
  ok: boolean;
  chars?: number;
  error?: string;
}

interface Scoped {
  agentId?: number;
  session?: string;
}

export type AgentEvent = Scoped & (
  | { type: 'turn_start' }
  | { type: 'turn_end'; reason: string; stats: TurnStats | null }
  | { type: 'assistant_start'; id: number }
  | { type: 'delta'; id: number; kind: 'text' | 'thinking' | 'tool'; text: string; name?: string; summary?: boolean }
  | { type: 'assistant_end'; id: number; text: string; thinking: string; hasActions: boolean; interrupted?: boolean; stats?: GenerationStats | null; rawText?: string }
  | { type: 'model_status'; id: number | string; text: string }
  | { type: 'prompt_progress'; id: number | string; progress: number }
  | { type: 'action_start'; id: number; tool: string; args?: ToolArgs; calledAs?: string | null; auto?: boolean }
  | { type: 'action_output'; id: number; text: string }
  | { type: 'action_end'; id: number; ok: boolean; output: string; diff?: string; meta?: Meta }
  | { type: 'edit_located'; id: number; pair: number; path: string; startLine: number; endLine: number }
  | { type: 'plan'; tasks: PlanTask[] }
  | { type: 'memory'; notes: string[] }
  | { type: 'noted'; turnId?: string; notes: string[] }
  | { type: 'recalled'; turnId?: string; passages: RecalledPassage[] }
  | { type: 'skill'; turnId?: string; skills: SkillView[] }
  | { type: 'fetching'; urls: string[] }
  | { type: 'fetched'; turnId?: string; pages: FetchedPage[] }
  | { type: 'step'; phase: 'before' | 'after'; turnId?: string; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'notice'; text: string }
  | { type: 'triage_start'; turnId?: string; update?: boolean }
  | ({ type: 'triage'; turnId?: string; update?: boolean; failed?: boolean } & Partial<Triage>)
  | { type: 'compaction_start' }
  | { type: 'compaction'; before: number; after: number; removed: number; summary: string; fallback: boolean; failure: string | null }
  | ContextStats
  | { type: 'sleeping'; on: boolean }
  | { type: 'user_message'; text: string; turnId?: string }
);

export type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

export interface ConversationFile {
  id: string;
  offProject?: boolean;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  events: AgentEvent[];
  untested: boolean;
  titleFromDraft?: boolean;
  unread?: number;
  failed?: boolean;
  draft?: string;
  choice?: Choice;
  inProgress?: boolean;
  plan?: Plan | null;
  memory?: string[];
  memoryShownAt?: number;
  chapters?: string[];
  steps?: Steps | null;
  systemPrompt?: string | null;
  checkpoints?: Checkpoint[];
  archives?: (Message[] | null)[];
  claudeSession?: string | null;
  claudeContext?: ContextStats | null;
}

/** A conversation in the lists. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  workspace: string;
  offProject: boolean;
  draft: boolean;
  engine?: EngineName;
  provider?: string;
  failed: boolean;
  unread: number;
  approvals?: number;
  running?: boolean;
  sleeping?: boolean;
  finished?: boolean;
  workingSince?: number | null;
}

export type ProviderType = 'poney' | 'openai' | 'ollama' | 'claude';

export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
}

export interface ProjectIcon {
  emoji?: string;
  icon?: string;
  color?: string;
  image?: string;
}

export interface EngineSettings {
  idleMinutes: number;
  cacheGb: number;
}

export interface Settings {
  config: Config;
  workspace: string;
  recent: string[];
  projectIcons: Record<string, ProjectIcon>;
  modelContexts: Record<string, number>;
  engine: EngineSettings;
  projectNames: Record<string, string>;
  hiddenProjects: string[];
  projectOrder: string[];
  providers: Provider[];
  lastChoice?: Choice;
  temperatureFromModel?: boolean;
}

export interface PublicSettings extends Settings {
  active: {
    offProject: boolean;
    cwd: string;
    session: string | null;
    choice: Choice;
    blocked: string | null;
    started: boolean;
  };
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, { type: string; description?: string; items?: unknown }>; required?: string[] };
  };
}

export type ModelChunk =
  | { type: 'text'; text: string; native?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'raw'; text: string }
  | { type: 'status'; text: string }
  | { type: 'progress'; progress: number }
  | { type: 'tool_progress'; name: string; text: string }
  | { type: 'prompt_read' }
  | { type: 'reopen' }
  | { type: 'done'; reason: string }
  | Usage;

export interface Usage {
  type: 'usage';
  promptTokens: number;
  outputTokens: number;
  promptMs?: number | null;
  evalMs?: number | null;
}

export interface GgufInfo {
  arch: string | null;
  contextLength: number | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | number[] | null;
  keyLength: number | null;
  valueLength: number | null;
  slidingWindow: number | null;
  slidingPattern: boolean[] | null;
  keyLengthSwa: number | null;
  valueLengthSwa: number | null;
}

export interface LocalModel {
  id: string;
  name: string;
  file: string;
  size: number;
  mtimeMs: number;
  folder: string;
  info: GgufInfo;
}

/** What a call holds while it runs on Poney's engine (see src/engine/). */
export interface Lease {
  baseUrl?: string;
  apiKey?: string;
  model?: Pick<LocalModel, 'id'> & { info?: GgufInfo | null };
  slots?: number;
  numCtx?: number;
  release: () => void;
}

export interface ChatOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: Message[];
  numCtx?: number;
  temperature?: number | null;
  maxTokens?: number;
  signal?: AbortSignal;
  toolSchemas?: ToolSchema[];
  tools?: ToolSchema[];
  jsonSchema?: Record<string, unknown>;
  noThinking?: boolean;
  onProgress?: (progress: number) => void;
  onStatus?: (text: string) => void;
  lease?: Lease | null;
  extra?: Record<string, unknown>;
  prompt?: string;
}

export type StreamChat = (opts: ChatOptions) => AsyncIterable<ModelChunk>;
