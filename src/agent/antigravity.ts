// Antigravity models, through its command-line program (agy) in headless mode: the
// Antigravity harness does the work, this file only turns the events it prints
// (stream-json) into those of Poney's interface, as claude.ts does for Claude. It runs
// with the machine's own login. Nothing of Poney's own harness runs here, except the
// skills, added to the message the same way.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadSkills, skillDirs, withSkills, type Skill } from './skills.ts';
import { errorMessage, isRecord, isString, list, num, parseJson, rec, str } from '../unknown.ts';
import type { AgentEvent, Checkpoint, Choice, Config, ContextStats, Message, Plan, Steps, TurnStats, ToolArgs } from '../types.ts';

type ExecFn = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }, callback: (error: unknown, stdout: string, stderr: string) => void) => unknown;
const defaultExec: ExecFn = (file, args, options, callback) => execFile(file, args, options, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));

/** The installed `agy` program, or null. (From the Finder, the PATH lacks the usual folders.) */
export function findAgy(env = process.env) {
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const names = process.platform === 'win32' ? ['agy.exe', 'agy.cmd'] : ['agy'];
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

const NOT_LOGGED_IN = 'Antigravity n’est pas connecté : lancez « agy » une fois dans un terminal pour vous connecter avec votre compte Google.';

/** An error of the Antigravity harness, in the words of the interface. */
export function agyError(message: unknown): string {
  const text = String(message ?? '').trim();
  return /auth(entication|orization)? required|not (logged|signed) in|sign in|log in|unauthenticated/i.test(text) ? NOT_LOGGED_IN : text || 'Antigravity n’a pas pu terminer.';
}

export interface AgyModel {
  value: string;
  name: string;
}

const SLUG = /^[a-z0-9][\w.:/-]*$/i;

/**
 * The models of `agy models`: JSON if it prints some, else one per line, the slug first
 * (headers, rules and blank lines skipped).
 */
export function parseModels(stdout: string): AgyModel[] {
  try {
    const parsed = parseJson(stdout);
    const items = Array.isArray(parsed) ? parsed : list(rec(parsed).models);
    const models = items.map((m) => (isString(m) ? { value: m, name: m } : { value: str(rec(m).slug) || str(rec(m).id) || str(rec(m).name), name: str(rec(m).displayName) || str(rec(m).display_name) || str(rec(m).name) }));
    const found = models.filter((m) => m.value).map((m) => ({ value: m.value, name: m.name || m.value }));
    if (found.length) return found;
  } catch {}
  const out: AgyModel[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/^[\s*>•|-]+/, '').trim();
    const [slug, ...rest] = line.split(/\s+/);
    if (!slug || !SLUG.test(slug) || !/[\d-]/.test(slug) || /^(models?|slug|name|available)$/i.test(slug)) continue;
    const name = rest.join(' ').replace(/^[|:–—-]+\s*/, '').replace(/\s*\|\s*$/, '').replace(/\((current|default)\)/i, '').trim();
    if (!out.some((m) => m.value === slug)) out.push({ value: slug, name: name || slug });
  }
  return out;
}

/** The models the local login can use, or why there are none (not logged in, mostly). */
export function agyModels(executable: string, run: ExecFn = defaultExec) {
  return new Promise<{ models: AgyModel[]; error: string | null }>((resolve) => {
    run(executable, ['models'], { timeout: 20000, env: process.env }, (error, stdout, stderr) => {
      const models = parseModels(stdout);
      resolve({ models, error: models.length ? null : agyError(stderr || (error ? errorMessage(error) : '')) });
    });
  });
}

// Parameters arrive with the names of the harness (AbsolutePath, CommandLine…), sometimes as JSON strings.
const value = (v: unknown): unknown => {
  if (!isString(v) || !/^".*"$/s.test(v)) return v;
  try { return parseJson(v); } catch { return v; }
};
function arg(params: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const [k, v] of Object.entries(params)) {
    const key = k.toLowerCase().replace(/_/g, '');
    const found = value(v);
    if (names.includes(key) && isString(found)) return found;
  }
  return undefined;
}

const inside = (cwd: string, file: string | undefined) => {
  if (!file) return undefined;
  const rel = path.relative(cwd, file.replace(/^file:\/\//, ''));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
};

/** A tool of the Antigravity harness as a card of Poney. */
export function toolView(name: string, input: unknown, cwd: string): { tool: string; args: ToolArgs } {
  const i = rec(input);
  const file = () => inside(cwd, arg(i, 'absolutepath', 'targetfile', 'filepath', 'file', 'path', 'uri'));
  const n = name.toLowerCase();
  if (/^(view_file|read_file|view_code_item|view_file_outline)$/.test(n)) return { tool: 'read', args: { path: file() } };
  if (/^(write_to_file|write_file|create_file)$/.test(n)) return { tool: 'write', args: { path: file() } };
  if (/replace_file_content|edit_file|multi_edit/.test(n)) return { tool: 'edit', args: { path: file() } };
  if (/^(run_command|run_terminal_command|shell)$/.test(n)) return { tool: 'run', args: { command: arg(i, 'commandline', 'command') ?? '' } };
  if (/^(grep_search|codebase_search|find_by_name)$/.test(n)) return { tool: 'search', args: { pattern: arg(i, 'query', 'pattern'), path: inside(cwd, arg(i, 'searchpath', 'searchdirectory', 'directorypath', 'path')) } };
  if (/^(list_dir|list_directory)$/.test(n)) return { tool: 'list', args: { path: inside(cwd, arg(i, 'directorypath', 'searchpath', 'path')) } };
  if (/^(search_web|web_search)$/.test(n)) return { tool: 'web_search', args: { query: arg(i, 'query') ?? '' } };
  if (/^(read_url_content|fetch|read_url)$/.test(n)) return { tool: 'fetch', args: { url: arg(i, 'url') ?? '' } };
  if (n === 'invoke_subagent') return { tool: 'agent', args: { title: arg(i, 'role', 'typename') || 'Sous-agent', task: arg(i, 'prompt') ?? '' } };
  if (n === 'generate_image') return { tool: 'image', args: { path: (arg(i, 'imagename') ?? arg(i, 'prompt') ?? '').slice(0, 120) } };
  const detail = Object.values(i).map(value).find(isString) ?? '';
  return { tool: name, args: { path: detail.replace(/\s+/g, ' ').slice(0, 120) } };
}

const outputOf = (v: unknown) => (v === undefined || v === null ? '' : isString(v) ? v : JSON.stringify(v, null, 2));

interface Gen {
  id: number;
  text: string;
  thinking: string;
  agentId?: number;
}

interface Tool {
  id: number;
  agentId?: number;
  done: boolean;
}

interface TurnState {
  main: string | null;
  gens: Map<string, Gen>;
  tools: Map<string, Tool>;
  subagents: Map<string, number>;
  tokens: number;
}

let nextId = Date.now();

export class AntigravityAgent extends EventEmitter<{ event: [AgentEvent] }> {
  readonly harness = 'antigravity';
  cwd: string;
  executable: string | null;
  skillsDir: string | null;
  choice: Choice;
  sessionId: string | null;
  config: Partial<Config>;
  context: ContextStats | null;
  autoSkills?: boolean;
  child: ReturnType<typeof spawn> | null;
  stopped = false;
  // (what the app reads from any agent: all empty here, the Antigravity harness keeps its own)
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

  constructor({ cwd, executable, skillsDir = null }: { cwd: string; executable: string | null; skillsDir?: string | null }) {
    super();
    this.cwd = cwd;
    this.executable = executable;
    this.skillsDir = skillsDir;
    this.choice = {};
    this.sessionId = null; // the Antigravity conversation, resumed at each message
    this.config = {};
    this.context = null;
    this.child = null;
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
  }

  get running() { return Boolean(this.child); }

  stop() {
    if (!this.child) return;
    this.stopped = true;
    this.child.kill('SIGINT');
  }
  reset() { this.stop(); }
  upgradeReasoning() {}
  contextStats() { return this.context; }

  /** The message with its skills: Poney's, called like its local models do. */
  prompt(text: string, turnId?: string): string {
    const inView = (s: Skill) => this.messages.some((m) => m.content.includes(`(Skill "${s.name}"`));
    const { text: out, shown } = withSkills(text, loadSkills(skillDirs(this.cwd, this.skillsDir)), { auto: this.autoSkills !== false, inView });
    if (shown.length) this.emit('event', { type: 'skill', turnId, skills: shown });
    return out;
  }

  /** The command line of a message. Headless, agy cannot ask: Auto approves everything, Manual keeps its own rules (edits in the project, no command without a rule). */
  args(content: string): string[] {
    const args = ['-p', content, '--output-format', 'stream-json', '--print-timeout', '0s'];
    if (this.sessionId) args.push('--conversation', this.sessionId);
    if (this.choice.model) args.push('--model', this.choice.model);
    if (this.choice.effort) args.push('--effort', this.choice.effort);
    if (this.choice.mode === 'auto') args.push('--dangerously-skip-permissions');
    else if (this.choice.mode === 'plan') args.push('--mode', 'plan');
    return args;
  }

  async send(text: string, { turnId }: { turnId?: string } = {}): Promise<void> {
    if (this.running) throw new Error('L’agent est déjà en cours d’exécution.');
    this.stopped = false;
    this.emit('event', { type: 'turn_start' });
    const state: TurnState = { main: this.sessionId, gens: new Map(), tools: new Map(), subagents: new Map(), tokens: 0 };
    let reason = 'done';
    let stats: TurnStats | null = null;
    let errorShown = false;
    const started = Date.now();
    try {
      if (!this.executable) throw new Error('Antigravity n’est pas installé sur cette machine (programme « agy »).');
      const content = this.prompt(text, turnId);
      this.messages.push({ role: 'user', content });
      const child = spawn(this.executable, this.args(content), { cwd: this.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      });
      if (child.stdout) {
        for await (const line of readline.createInterface({ input: child.stdout })) {
          if (!line.trim()) continue;
          let event: unknown;
          try { event = parseJson(line); } catch { continue; }
          const end = this.onEvent(state, event, started);
          if (end) {
            ({ reason, stats } = end);
            errorShown = reason === 'error';
          }
        }
      }
      const code = await exited;
      if (this.stopped) reason = 'stopped';
      else if (!stats && code !== 0) {
        reason = 'error';
        throw new Error(agyError(stderr.trim().split('\n').slice(-3).join('\n') || `agy s’est arrêté (code ${code}).`));
      }
      // Tools it could not ask for: refused, said on stderr.
      for (const l of stderr.split('\n')) if (/permission|denied/i.test(l) && l.trim()) this.emit('event', { type: 'notice', text: `Antigravity : ${l.trim()}` });
    } catch (e) {
      if (this.stopped) reason = 'stopped';
      else {
        reason = 'error';
        if (!errorShown) this.emit('event', { type: 'error', message: agyError(errorMessage(e)) });
      }
    }
    if (reason === 'stopped') this.emit('event', { type: 'notice', text: 'Arrêté.' });
    for (const [key, gen] of state.gens) this.endGen(state, key, gen); // (cut short)
    for (const t of state.tools.values()) if (!t.done) this.emitAs(t.agentId, { type: 'action_end', id: t.id, ok: false, output: 'Arrêté.' });
    this.child = null;
    this.emit('event', { type: 'turn_end', reason, stats });
  }

  emitAs(agentId: number | undefined, ev: AgentEvent): void {
    this.emit('event', agentId === undefined ? ev : { ...ev, agentId });
  }

  endGen(state: TurnState, key: string, gen: Gen): void {
    state.gens.delete(key);
    this.emitAs(gen.agentId, { type: 'assistant_end', id: gen.id, text: gen.text, thinking: gen.thinking, hasActions: false });
  }

  /** One line of agy's stream. Its end (the result) gives the reason and the numbers of the turn. */
  onEvent(state: TurnState, event: unknown, started: number): { reason: string; stats: TurnStats } | null {
    const m = rec(event);
    const kind = str(m.type) || str(m.event);
    const p = isRecord(m.payload) ? m.payload : isRecord(m.data) ? m.data : m;
    if (kind === 'init') return null;
    if (kind === 'step_update') {
      this.onStep(state, p);
      return null;
    }
    if (kind !== 'result') return null;
    const conversation = str(p.conversation_id);
    if (conversation) this.sessionId = conversation;
    const ok = str(p.status, 'SUCCESS') === 'SUCCESS';
    const response = str(p.response);
    if (ok && response) {
      this.messages.push({ role: 'assistant', content: response });
      this.emit('event', { type: 'final', text: response });
    } else if (!ok) {
      const error = isString(p.error) ? p.error : str(rec(p.error).message) || str(p.status);
      this.emit('event', { type: 'error', message: agyError(error) });
    }
    const usage = rec(p.usage);
    const tokens = num(usage.output_tokens) + num(usage.thinking_tokens) || state.tokens;
    const totalMs = num(p.duration_seconds) * 1000 || Date.now() - started;
    return {
      reason: ok ? 'done' : str(p.status) === 'CANCELED' || str(p.status) === 'INTERRUPTED' ? 'stopped' : 'error',
      stats: { totalMs, genMs: totalMs, promptMs: 0, tokens, exact: Boolean(usage.output_tokens), tps: totalMs ? tokens / (totalMs / 1000) : 0, steps: num(p.num_turns, 1) },
    };
  }

  /** A step of the conversation (or of a sub-agent's: shown in its card). */
  onStep(state: TurnState, p: Record<string, unknown>): void {
    const conversation = str(p.conversation_id);
    state.main ??= conversation || null;
    const agentId = conversation && conversation !== state.main ? state.subagents.get(conversation) : undefined;
    if (conversation && conversation !== state.main && agentId === undefined) return; // (a conversation of which nothing is known)
    const key = `${conversation}:${num(p.step_index)}`;
    const type = str(p.step_type).toLowerCase();
    const done = str(p.state).toUpperCase() === 'DONE';
    state.tokens += num(rec(p.usage).output_tokens);
    if (type === 'tool' || p.tool_info || p.tool_name) {
      const info = rec(p.tool_info);
      let t = state.tools.get(key);
      if (!t) {
        const { tool, args } = toolView(str(p.tool_name) || str(info.name), info.parameters, this.cwd);
        t = { id: nextId++, agentId, done: false };
        state.tools.set(key, t);
        this.emitAs(agentId, { type: 'action_start', id: t.id, tool, args });
      }
      for (const s of list(rec(p.subagent_info).subagents).map(rec)) if (str(s.conversation_id)) state.subagents.set(str(s.conversation_id), t.id);
      if (done && !t.done) {
        t.done = true;
        const error = rec(info.error);
        const ok = !info.error;
        this.emitAs(agentId, { type: 'action_end', id: t.id, ok, output: ok ? outputOf(info.output) : str(error.message) || outputOf(info.error) });
      }
      return;
    }
    if (type !== 'agent_response' && !p.text_delta && !p.thinking_delta) return; // (the user's message, checkpoints)
    let gen = state.gens.get(key);
    if (!gen) {
      gen = { id: nextId++, text: '', thinking: '', agentId };
      state.gens.set(key, gen);
      this.emitAs(agentId, { type: 'assistant_start', id: gen.id });
    }
    const thinking = str(p.thinking_delta);
    if (thinking) {
      gen.thinking += thinking;
      this.emitAs(agentId, { type: 'delta', id: gen.id, kind: 'thinking', text: thinking, summary: true });
    }
    const text = str(p.text_delta);
    if (text) {
      gen.text += text;
      this.emitAs(agentId, { type: 'delta', id: gen.id, kind: 'text', text });
    }
    if (done) this.endGen(state, key, gen);
  }
}
