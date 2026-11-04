// Claude models, through the Agent SDK: the Claude harness does the work, this
// file only turns what it says into the events of Poney's interface. Nothing of
// Poney's own harness runs here (assessment, test gates, compaction, memory),
// except the skills, added to the message the same way.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff } from './diff.ts';
import { soberPath, withAttachedPaths } from './attached.ts';
import { loadSkills, skillDirs, withSkills, type Skill } from './skills.ts';
import { errorMessage, isNumber, isString, list, num, parseJson, rec, str } from '../unknown.ts';
import type { Options, PermissionMode, PermissionResult, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, Approve, Checkpoint, Choice, Config, ContextStats, Effort, Message, Plan, Steps, TaskStatus, TurnStats, ToolArgs } from '../types.ts';

/** What this file uses of a query. What comes out of it is unknown: the SDK moves fast. */
export interface ClaudeQuery extends AsyncIterable<unknown> {
  close?: () => void;
  supportedModels?: () => Promise<unknown>;
  getContextUsage?: (opts: { detail: 'summary' }) => Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts: { skipBehaviors: boolean }) => Promise<unknown>;
}

export type ClaudeRun = (params: Parameters<typeof sdkQuery>[0]) => ClaudeQuery;

type ExecFn = (file: string, args: string[], options: { timeout: number; env: Record<string, string> }, callback: (error: unknown, stdout: string) => void) => unknown;

interface Block {
  id: string;
  name: string;
  json: string;
}

interface Generation {
  id: number;
  key: string;
  parent: string | null;
  state: TurnState;
  text: string;
  thinking: string;
  tools: number;
  blocks: Map<number, Block>;
}

interface ToolEntry {
  id: number;
  name: string;
  input: Record<string, unknown>;
  parent: string | null;
  tool: string;
  silent?: boolean;
}

interface TurnState {
  tools: Map<string, ToolEntry>;
  gens: Map<string, Generation>;
  results: Set<string>;
  tasks: number;
  turnOver: boolean;
}

const isEffort = (v: unknown): v is Effort => isString(v);

const MODES: Record<string, PermissionMode | undefined> = { auto: 'auto', manual: 'default', plan: 'plan' };
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

// What a Claude session gives the programs it starts. Poney started from one (a terminal of
// Claude Code, the Claude app) would hand them on to its own Claude, which then takes itself
// for part of that session: the app's entrypoint ("claude-desktop") gives another system
// prompt, and each conversation writes its prompt cache again (about 16k tokens). Without them,
// the SDK sets its own entrypoint.
const HOST_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_\w+|CLAUDE_AGENT_SDK_\w+|CLAUDE_PREVIEW_\w+|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/;
// (what a user sets for Claude Code in their own shell: kept)
const USER_SETTINGS = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SHELL', 'CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']);

// Each request bills the whole context again, cached or not: on the 1M window a long conversation
// reaches 600k tokens a message, and its first compaction (after an account switch, uncached) costs
// a large share of a 5-hour quota. Compacting at 200k keeps both small.
const COMPACT_WINDOW = '200000';

/**
 * The environment of the Claude processes Poney starts: its own, without a host session's.
 * An account added in Poney has a folder of its own (its login, its sessions); the first one
 * is the machine's, in ~/.claude, shared with the CLI and the app.
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env, configDir: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (USER_SETTINGS.has(name) || !HOST_SESSION.test(name))) out[name] = value;
  }
  out.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= COMPACT_WINDOW;
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

// What an added account takes from the user's own folder, so that every account works the same:
// settings, instructions, skills, agents, commands, plugins. (Not the login, sessions or history.)
const SHARED = ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'output-styles', 'plugins', 'hooks'];

/** The machine's Claude folder. */
export const machineClaudeDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** A session's transcript in an account's folder (projects/<the project's folder>/<id>.jsonl), or null. */
function sessionFile(dir: string, id: string) {
  let names: string[];
  try { names = fs.readdirSync(path.join(dir, 'projects')); } catch { return null; }
  for (const name of names) {
    const file = path.join(dir, 'projects', name, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * A conversation goes on with another account: its session, as last written in any account's
 * folder, is copied into this one's (with what it keeps beside it), so that it resumes there.
 */
export function bringSession(id: string, toDir: string, dirs: string[]) {
  const copies = [...new Set([toDir, ...dirs])].flatMap((dir) => {
    const file = sessionFile(dir, id);
    return file ? [{ dir, file, at: fs.statSync(file).mtimeMs }] : [];
  });
  const newest = copies.reduce<(typeof copies)[number] | null>((a, b) => (a && a.at >= b.at ? a : b), null);
  if (!newest || newest.dir === toDir) return;
  const target = path.join(toDir, path.relative(newest.dir, newest.file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(newest.file, target);
  const beside = newest.file.slice(0, -'.jsonl'.length);
  if (fs.existsSync(beside)) fs.cpSync(beside, target.slice(0, -'.jsonl'.length), { recursive: true });
}

/** Links what the user's folder has (and the account's does not) into an added account's folder. */
export function linkUserSettings(configDir: string, userDir = path.join(os.homedir(), '.claude')) {
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of SHARED) {
    const from = path.join(userDir, name);
    const to = path.join(configDir, name);
    if (!fs.existsSync(from)) continue;
    try {
      fs.lstatSync(to);
    } catch {
      try { fs.symlinkSync(from, to); } catch {}
    }
  }
}

/** The installed `claude` program, or null. (From the Finder, the PATH lacks the usual folders.) */
export function findClaude(env = process.env) {
  const home = os.homedir();
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

const NOT_LOGGED_IN = 'Ce compte Claude n’est pas connecté : connectez-le dans Réglages › Fournisseurs.';

export interface ClaudeAuth {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
}

const defaultExec: ExecFn = (file, args, options, callback) => execFile(file, args, options, callback);

/** Who an account's folder is logged in as (if it cannot tell: as if it were, the first message will say). */
export function claudeAuth(executable: string, configDir: string | null = null, run: ExecFn = defaultExec) {
  return new Promise<ClaudeAuth>((resolve) => {
    run(executable, ['auth', 'status'], { timeout: 15000, env: claudeEnv(process.env, configDir) }, (error, stdout) => {
      try {
        const r = rec(parseJson(stdout));
        resolve({ loggedIn: r.loggedIn !== false, email: str(r.email) || null, plan: str(r.subscriptionType) || null });
      } catch {
        resolve({ loggedIn: !error, email: null, plan: null });
      }
    });
  });
}

/** Whether the machine's account is logged in. */
export const claudeLoggedIn = async (executable: string, run: ExecFn = defaultExec) => (await claudeAuth(executable, null, run)).loggedIn;

/**
 * Logs an account in: the browser opens on Claude's page, and the login comes back by
 * itself; when the page shows a code instead, `code` passes it on. `done`: logged in or not.
 */
export function claudeLogin(executable: string, configDir: string | null) {
  const child = spawn(executable, ['auth', 'login', '--claudeai'], { env: claudeEnv(process.env, configDir), stdio: ['pipe', 'ignore', 'ignore'] });
  const done = new Promise<boolean>((resolve) => {
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return {
    done,
    code: (code: string) => { child.stdin.write(`${code.trim()}\n`); },
    cancel: () => { child.kill(); },
  };
}

/** An error of the Claude harness, in the words of the interface. */
export function claudeError(message: unknown): string {
  const text = String(message ?? '').replace(/^Claude Code returned an error result:\s*/, '');
  return /not logged in|\/login/i.test(text) ? NOT_LOGGED_IN : text.replace(/Claude Code/g, 'Claude') || 'Claude n’a pas pu terminer.';
}

/** The models the local login can use: [{ value, name, efforts, auto }]. */
export async function claudeModels(executable: string, { query, configDir = null }: { query?: ClaudeRun; configDir?: string | null } = {}) {
  const run: ClaudeRun = query ?? (await sdk()).query;
  const idle = (async function* () { await new Promise(() => {}); })(); // (no message: only the list)
  const q = run({ prompt: idle, options: { pathToClaudeCodeExecutable: executable, env: claudeEnv(process.env, configDir) } });
  try {
    const models = list(await q.supportedModels?.());
    return models.map(rec).map((m) => ({ value: str(m.value), name: str(m.displayName), efforts: list(m.supportedEffortLevels).filter(isEffort), auto: Boolean(m.supportsAutoMode) }));
  } finally {
    q.close?.();
  }
}

/**
 * How much of the plan's session (its 5-hour window) is used: { utilization (0-100),
 * resetsAt }, or null where plan limits do not apply.
 * (The SDK marks this call as experimental: anything else than the expected shape counts as null.)
 */
export async function claudeUsage(executable: string, { query, configDir = null }: { query?: ClaudeRun; configDir?: string | null } = {}) {
  const run: ClaudeRun = query ?? (await sdk()).query;
  const idle = (async function* () { await new Promise(() => {}); })(); // (no message: only the numbers)
  const q = run({ prompt: idle, options: { pathToClaudeCodeExecutable: executable, env: claudeEnv(process.env, configDir) } });
  try {
    return await sessionUsage(q);
  } finally {
    q.close?.();
  }
}

/** The session usage, asked to a query (a running one too: before and after a message). */
async function sessionUsage(q: ClaudeQuery) {
  const r = rec(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true }));
  if (!r.rate_limits_available) return null;
  const limit = (raw: unknown) => {
    const l = rec(raw);
    return typeof l.utilization === 'number' ? { utilization: l.utilization, resetsAt: isString(l.resets_at) || isNumber(l.resets_at) ? l.resets_at : null } : null;
  };
  const session = limit(rec(r.rate_limits).five_hour);
  return session ? { ...session, weekly: limit(rec(r.rate_limits).seven_day) } : null; // (the session's, and the week's)
}

const insideOf = (cwd: string, file: unknown, scratch: string | null = null) => {
  const sober = soberPath(String(file ?? ''), scratch); // (the private folder, as `.poney/…`)
  if (sober) return sober;
  const rel = path.relative(cwd, String(file ?? ''));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : String(file ?? '');
};

/** A tool of the Claude harness as a card of Poney. */
export function toolView(name: string, input: unknown, cwd: string, scratch: string | null = null): { tool: string; args: ToolArgs } {
  const i = rec(input);
  const opt = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const inside = (c: string, file: unknown) => insideOf(c, file, scratch);
  const where = () => (i.path ? inside(cwd, i.path) : undefined);
  switch (name) {
    case 'Read': return { tool: 'read', args: { path: inside(cwd, i.file_path) } };
    case 'Write': return { tool: 'write', args: { path: inside(cwd, i.file_path) } };
    case 'Edit': case 'NotebookEdit': return { tool: 'edit', args: { path: inside(cwd, i.file_path ?? i.notebook_path) } };
    case 'Bash': return { tool: 'run', args: { command: str(i.command) } };
    case 'Grep': return { tool: 'search', args: { pattern: opt(i.pattern), path: where() } };
    case 'Glob': return { tool: 'search', args: { query: opt(i.pattern), path: where() } };
    case 'WebSearch': return { tool: 'web_search', args: { query: str(i.query) } };
    case 'WebFetch': return { tool: 'fetch', args: { url: str(i.url) } };
    case 'Agent': case 'Task': return { tool: 'agent', args: { title: str(i.description) || 'Sous-agent', task: str(i.prompt) } };
    default: {
      const detail = Object.values(i).find(isString) ?? '';
      return { tool: name, args: { path: detail.replace(/\s+/g, ' ').slice(0, 120) } };
    }
  }
}

const textOf = (content: unknown) => (typeof content === 'string' ? content
  : list(content).map(rec).map((b) => (b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n'));

let nextId = Date.now();

export class ClaudeAgent extends EventEmitter<{ event: [AgentEvent] }> {
  readonly harness = 'claude';
  cwd: string;
  executable: string | null;
  configDir: string | null;
  accountDirs: string[];
  approve: Approve;
  skillsDir: string | null;
  attachDir: string | null; // the conversation's private folder, where attached files are copied
  runQuery: ClaudeRun | null;
  choice: Choice;
  sessionId: string | null;
  config: Partial<Config>;
  controller: AbortController | null;
  context: ContextStats | null;
  sleeping: boolean;
  autoSkills?: boolean;
  planShown = false;
  resultError = false;
  messages: Message[];
  untested: boolean;
  taskPlan: Plan | null;
  memory: string[];
  memoryShownAt: number;
  chapters: string[];
  steps: Steps | null;
  systemPrompt: string | null;
  checkpoints: Checkpoint[];
  archives: (Message[] | null)[];
  lastUuid: string | null;
  forkAt: string | null;
  preamble: string | null;

  constructor({ cwd, executable, configDir = null, approve, skillsDir = null, query = null, attachDir = null }: { cwd: string; executable: string | null; configDir?: string | null; approve: Approve; skillsDir?: string | null; query?: ClaudeRun | null; attachDir?: string | null }) {
    super();
    this.cwd = cwd;
    this.executable = executable;
    this.configDir = configDir; // the account's folder (null: the machine's)
    this.accountDirs = []; // every account's folder: where its session may have been written last
    this.approve = approve;
    this.skillsDir = skillsDir;
    this.attachDir = attachDir;
    this.runQuery = query;
    this.choice = {};
    this.sessionId = null; // the Claude session, resumed at each message
    this.config = {};
    this.controller = null;
    this.context = null; // the context gauge: what the last message used, in the window of the model
    this.sleeping = false; // its turn is over, a background task will bring it back (see updateSleep)
    // (what the app reads from any agent: all empty here, the Claude harness keeps its own)
    this.messages = [];
    this.untested = false;
    this.taskPlan = null;
    this.memory = [];
    this.memoryShownAt = 0;
    this.chapters = [];
    this.steps = null;
    this.systemPrompt = null;
    this.checkpoints = [];
    this.archives = [];
    // Rewinding: the session's last entry when each message is sent (a point to fork it from),
    // the entry the next message forks from, or the earlier exchanges told when there is none.
    this.lastUuid = null;
    this.forkAt = null;
    this.preamble = null;
  }

  get running() { return Boolean(this.controller); }

  /**
   * Back to before a message: the session is forked at its last entry then (the original
   * stays as it was), or, without that point, a new one starts with the earlier exchanges told.
   */
  rewind(turnId: string, recap: string): void {
    const i = this.checkpoints.findIndex((c) => c.turnId === turnId);
    const cp = i >= 0 ? this.checkpoints[i] : null;
    if (cp && cp.session === null) [this.sessionId, this.forkAt, this.preamble] = [null, null, null]; // (the first message: nothing before)
    else if (cp?.session && cp.at) [this.sessionId, this.forkAt, this.preamble] = [cp.session, cp.at, null];
    else [this.sessionId, this.forkAt, this.preamble] = [null, null, recap || null];
    this.lastUuid = this.forkAt;
    if (cp?.length !== undefined) this.messages = this.messages.slice(0, cp.length);
    this.checkpoints = i >= 0 ? this.checkpoints.slice(0, i) : this.checkpoints.filter((c) => c.turnId !== turnId);
    this.context = null;
  }

  stop() { this.controller?.abort(); }
  reset() { this.stop(); }
  upgradeReasoning() {}
  contextStats() { return this.context; }

  /** The message with its skills: Poney's, called like its local models do. */
  prompt(text: string, turnId?: string): string {
    const inView = (s: Skill) => this.messages.some((m) => m.content.includes(`(Skill "${s.name}"`));
    // (the files attached, under `.poney/` in the message: read here by their absolute path)
    const { text: out, shown } = withSkills(withAttachedPaths(text, this.attachDir), loadSkills(skillDirs(this.cwd, this.skillsDir)), { auto: this.autoSkills !== false, inView });
    if (shown.length) this.emit('event', { type: 'skill', turnId, skills: shown });
    return out;
  }

  async send(text: string, { turnId }: { turnId?: string } = {}): Promise<void> {
    if (this.running) throw new Error('L’agent est déjà en cours d’exécution.');
    const controller = new AbortController();
    this.controller = controller;
    this.emit('event', { type: 'turn_start' });
    const state: TurnState = { tools: new Map(), gens: new Map(), results: new Set(), tasks: 0, turnOver: false };
    this.planShown = false;
    this.resultError = false;
    let stats: TurnStats | null = null;
    let reason = 'done';
    try {
      if (turnId) this.checkpoints.push({ turnId, session: this.preamble ? undefined : this.sessionId, at: this.sessionId ? (this.forkAt ?? this.lastUuid) : null, length: this.messages.length });
      const content = (this.preamble ?? '') + this.prompt(text, turnId);
      this.messages.push({ role: 'user', content });
      const run: ClaudeRun = this.runQuery ?? (await sdk()).query;
      // (the account changed since the last message: the session comes along)
      if (this.sessionId) {
        try { bringSession(this.sessionId, this.configDir ?? machineClaudeDir(), this.accountDirs); } catch {}
      }
      const options: Options = {
          cwd: this.cwd,
          // (the files attached to the conversation, copied into its private folder)
          ...(this.attachDir && fs.existsSync(this.attachDir) ? { additionalDirectories: [this.attachDir] } : {}),
          model: this.choice.model ?? undefined,
          effort: this.choice.effort,
          thinking: { type: 'adaptive', display: 'summarized' }, // (by default, the reasoning arrives empty)
          permissionMode: MODES[this.choice.mode ?? ''] ?? 'default',
          canUseTool: (name, input, { toolUseID, title }) => this.canUse(state, name, input, { toolUseID, title }),
          disallowedTools: ['AskUserQuestion'], // (it asks in the conversation instead)
          includePartialMessages: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          pathToClaudeCodeExecutable: this.executable ?? undefined,
          env: claudeEnv(process.env, this.configDir),
          abortController: controller,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          // (rewound: a new session from that entry of the old one, which stays as it was)
          ...(this.sessionId && this.forkAt ? { resumeSessionAt: this.forkAt, forkSession: true } : {}),
      };
      const q = run({ prompt: content, options });
      // The plan's session used before and after: what this answer cost of it (0 to 100).
      const used = () => sessionUsage(q).then((u) => u?.utilization ?? null, () => null);
      let before: number | null = null;
      for await (const message of q) {
        if (rec(message).type === 'system' && rec(message).subtype === 'init') {
          [this.forkAt, this.preamble] = [null, null]; // (the session has them now)
          await this.readContext(q);
          before = await used();
        }
        const end = this.onMessage(state, message);
        if (end) {
          ({ stats, reason } = end);
          const after = before === null ? null : await used();
          if (stats && before !== null && after !== null) stats = { ...stats, session: after >= before ? after - before : after }; // (lower: a new window started meanwhile)
        }
      }
    } catch (e) {
      if (controller.signal.aborted) {
        reason = 'stopped';
        this.emit('event', { type: 'notice', text: 'Arrêté.' });
      } else {
        reason = 'error';
        if (!this.resultError) this.emit('event', { type: 'error', message: claudeError(errorMessage(e)) }); // (not said twice)
      }
    }
    for (const gen of state.gens.values()) this.endGen(gen); // (cut short)
    this.closeTools(state);
    state.tasks = 0;
    this.updateSleep(state);
    this.controller = null;
    this.emit('event', { type: 'turn_end', reason, stats });
  }

  /** The window and the compaction threshold: only the harness knows them, and only while it runs. */
  async readContext(q: ClaudeQuery): Promise<void> {
    try {
      const usage = await q.getContextUsage?.({ detail: 'summary' });
      if (!usage) return;
      const c = rec(usage);
      const compactAt = (c.isAutoCompactEnabled ? num(c.autoCompactThreshold) : 0) || num(c.maxTokens);
      this.setContext({ used: num(c.totalTokens), numCtx: num(c.maxTokens), compactAt, limit: compactAt });
    } catch {} // (the gauge is not worth a failed turn)
  }

  setContext(c: Partial<ContextStats>): void {
    const context: ContextStats = { ...this.context, ...c, type: 'context', claude: true };
    this.context = context;
    this.emit('event', context);
  }

  /** What a message of the conversation used, by the API's count. */
  countContext(reported: unknown): void {
    if (!reported || !this.context) return;
    const usage = rec(reported);
    const used = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.output_tokens);
    if (used) this.setContext({ used });
  }

  /**
   * Claude ended its turn but the session lives on: it gives its result, then waits
   * for its background tasks and starts again when one ends. (Watchers do not count:
   * ambient tasks are not activity.)
   */
  updateSleep(state: TurnState): void {
    const sleeping = state.turnOver && state.tasks > 0;
    if (sleeping === this.sleeping) return;
    this.sleeping = sleeping;
    this.emit('event', { type: 'sleeping', on: sleeping });
  }

  emitFor(parent: string | null, state: TurnState, ev: AgentEvent): void {
    const agentId = parent ? state.tools.get(parent)?.id : undefined;
    this.emit('event', agentId === undefined ? ev : { ...ev, agentId });
  }

  onMessage(state: TurnState, message: unknown): { reason: string; stats: TurnStats } | null {
    const m = rec(message);
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    const content = rec(m.message).content;
    if ((m.type === 'assistant' || m.type === 'user') && !parent && str(m.uuid)) this.lastUuid = str(m.uuid); // (an entry of the session)
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.sessionId = str(m.session_id);
        if (m.subtype === 'background_tasks_changed') {
          state.tasks = list(m.tasks).filter((t) => !rec(t).ambient).length;
          this.updateSleep(state);
        }
        return null;
      case 'stream_event':
        this.onStream(state, rec(m.event), parent);
        return null;
      case 'assistant':
        // (what the stream has not shown, as with a sub-agent's messages)
        for (const b of list(content).map(rec)) if (b.type === 'tool_use') this.startTool(state, str(b.id), str(b.name), b.input, parent);
        return null;
      case 'user':
        for (const b of list(content).map(rec)) {
          if (b.type === 'tool_result') this.endTool(state, str(b.tool_use_id), textOf(b.content), !b.is_error);
        }
        return null;
      case 'result':
        state.turnOver = true;
        this.updateSleep(state);
        return this.onResult(m);
      default: return null;
    }
  }

  onStream(state: TurnState, ev: Record<string, unknown>, parent: string | null): void {
    const key = parent ?? 'main';
    const index = num(ev.index);
    if (ev.type === 'message_start') {
      if (!parent) {
        this.countContext(rec(ev.message).usage);
        state.turnOver = false;
        this.updateSleep(state);
      }
      const id = nextId++;
      state.gens.set(key, { id, key, parent, state, text: '', thinking: '', tools: 0, blocks: new Map() });
      this.emitFor(parent, state, { type: 'assistant_start', id });
      return;
    }
    if (ev.type === 'message_delta' && !parent) this.countContext(ev.usage);
    const gen = state.gens.get(key);
    if (!gen) return;
    const block = gen.blocks.get(index);
    const started = rec(ev.content_block);
    if (ev.type === 'content_block_start' && started.type === 'tool_use') {
      gen.blocks.set(index, { id: str(started.id), name: str(started.name), json: '' });
    } else if (ev.type === 'content_block_delta') {
      const d = rec(ev.delta);
      if (d.type === 'text_delta') {
        const text = str(d.text);
        gen.text += text;
        this.emitFor(parent, state, { type: 'delta', id: gen.id, kind: 'text', text });
      } else if (d.type === 'thinking_delta') {
        const text = str(d.thinking);
        if (!text) return;
        gen.thinking += text;
        this.emitFor(parent, state, { type: 'delta', id: gen.id, kind: 'thinking', text, summary: true });
      } else if (d.type === 'input_json_delta' && block) block.json += str(d.partial_json);
    } else if (ev.type === 'content_block_stop' && block) {
      gen.blocks.delete(index);
      gen.tools++;
      let input: unknown = {};
      try { input = parseJson(block.json || '{}'); } catch {}
      this.endGen(gen);
      this.startTool(state, block.id, block.name, input, parent);
    } else if (ev.type === 'message_stop') this.endGen(gen);
  }

  /** The text so far ends before a tool, as one of Poney's generations does. */
  endGen(gen: Generation): void {
    const { state, parent } = gen;
    if (state.gens.get(gen.key) === gen) state.gens.delete(gen.key);
    this.emitFor(parent, state, { type: 'assistant_end', id: gen.id, text: gen.text, thinking: gen.thinking, hasActions: gen.tools > 0 });
  }

  startTool(state: TurnState, toolUseId: string, name: string, rawInput: unknown, parent: string | null): ToolEntry {
    const known = state.tools.get(toolUseId);
    if (known) return known;
    const id = nextId++;
    const input = rec(rawInput);
    const { tool, args } = toolView(name, input, this.cwd, this.attachDir);
    const entry: ToolEntry = { id, name, input, parent, tool };
    if (name === 'TodoWrite') {
      const statuses: Record<string, TaskStatus | undefined> = { in_progress: 'running', completed: 'done' };
      const tasks = list(input.todos).map(rec).map((t) => ({ text: str(t.content), status: statuses[str(t.status)] ?? 'pending' }));
      const silent = { ...entry, silent: true };
      state.tools.set(toolUseId, silent);
      this.emitFor(parent, state, this.planShown ? { type: 'plan', tasks } : { type: 'action_start', id, tool: 'plan', args: { body: tasks.map((t) => `- ${t.text}`).join('\n') } });
      if (!this.planShown) this.emitFor(parent, state, { type: 'plan', tasks });
      this.planShown = true;
      return silent;
    }
    state.tools.set(toolUseId, entry);
    this.emitFor(parent, state, { type: 'action_start', id, tool, args });
    if (name === 'ExitPlanMode' && input.plan) this.emitFor(parent, state, { type: 'action_output', id, text: str(input.plan) });
    return entry;
  }

  endTool(state: TurnState, toolUseId: string, output: string, ok: boolean): void {
    const t = state.tools.get(toolUseId);
    if (!t || state.results.has(toolUseId)) return;
    state.results.add(toolUseId);
    if (t.silent) return;
    const name = String(t.input.file_path ?? '');
    const diff = !ok ? undefined
      : t.name === 'Edit' ? unifiedDiff(str(t.input.old_string), str(t.input.new_string), name)
        : t.name === 'Write' ? unifiedDiff('', str(t.input.content), name) : undefined;
    this.emitFor(t.parent, state, { type: 'action_end', id: t.id, ok, output, ...(diff ? { diff } : {}), meta: { path: insideOf(this.cwd, name, this.attachDir) } });
  }

  /** Stopped or cut short: no card goes on turning. */
  closeTools(state: TurnState): void {
    for (const [id, t] of state.tools) if (!state.results.has(id)) this.endTool(state, id, 'Arrêté.', false);
  }

  /** The permission of a tool: the question of Poney's interface, on the tool's card. */
  async canUse(state: TurnState, name: string, input: Record<string, unknown>, { toolUseID, title }: { toolUseID?: string; title?: string } = {}): Promise<PermissionResult> {
    const t = this.startTool(state, toolUseID ?? '', name, input, null); // (already shown, as a rule)
    const answer = await this.approve({ id: t.id, tool: t.tool, command: title ?? t.tool, claude: true });
    if (answer === true || (answer && answer.ok)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: String((answer ? answer.reason : '') ?? '').trim() || 'The user refused.' };
  }

  onResult(m: Record<string, unknown>): { reason: string; stats: TurnStats } {
    const reason = m.subtype === 'success' ? 'done' : m.subtype === 'error_max_turns' ? 'max_steps' : 'error';
    if (m.subtype === 'success' && m.result) {
      const result = str(m.result);
      this.messages.push({ role: 'assistant', content: result });
      this.emit('event', { type: 'final', text: result });
    } else if (m.subtype !== 'success') {
      this.resultError = true;
      this.emit('event', { type: 'error', message: claudeError(list(m.errors).join(' ')) });
    }
    const tokens = num(rec(m.usage).output_tokens);
    const genMs = num(m.duration_api_ms);
    return { reason, stats: { totalMs: num(m.duration_ms), genMs, promptMs: 0, tokens, exact: true, tps: genMs ? tokens / (genMs / 1000) : 0, steps: num(m.num_turns, 1) } };
  }
}
