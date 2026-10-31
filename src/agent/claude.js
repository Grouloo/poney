// Claude models, through the Agent SDK: the Claude harness does the work, this
// file only turns what it says into the events of Poney's interface. Nothing of
// Poney's own harness runs here (assessment, test gates, compaction, memory),
// except the skills, added to the message the same way.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff } from './diff.js';
import { loadSkills, skillDirs, mentionedSkills, matchingSkills, skillBlock } from './skills.js';

const MODES = { auto: 'auto', manual: 'default', plan: 'plan' };
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

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

const NOT_LOGGED_IN = 'Claude n’est pas connecté sur cette machine : lancez « claude auth login » dans un terminal.';

/** Whether the installed program is logged in (if it cannot tell: as if it were, the first message will say). */
export function claudeLoggedIn(executable, run = execFile) {
  return new Promise((resolve) => {
    run(executable, ['auth', 'status'], { timeout: 15000 }, (error, stdout) => {
      try {
        resolve(JSON.parse(stdout).loggedIn !== false);
      } catch {
        resolve(!error);
      }
    });
  });
}

/** An error of the Claude harness, in the words of the interface. */
export function claudeError(message) {
  const text = String(message ?? '').replace(/^Claude Code returned an error result:\s*/, '');
  return /not logged in|\/login/i.test(text) ? NOT_LOGGED_IN : text.replace(/Claude Code/g, 'Claude') || 'Claude n’a pas pu terminer.';
}

/** The models the local login can use: [{ value, name, efforts, auto }]. */
export async function claudeModels(executable, { query } = {}) {
  const run = query ?? (await sdk()).query;
  const idle = (async function* () { await new Promise(() => {}); })(); // (no message: only the list)
  const q = run({ prompt: idle, options: { pathToClaudeCodeExecutable: executable } });
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({ value: m.value, name: m.displayName, efforts: m.supportedEffortLevels ?? [], auto: Boolean(m.supportsAutoMode) }));
  } finally {
    q.close();
  }
}

const inside = (cwd, file) => {
  const rel = path.relative(cwd, String(file ?? ''));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : String(file ?? '');
};

/** A tool of the Claude harness as a card of Poney. */
export function toolView(name, input, cwd) {
  const i = input ?? {};
  switch (name) {
    case 'Read': return { tool: 'read', args: { path: inside(cwd, i.file_path) } };
    case 'Write': return { tool: 'write', args: { path: inside(cwd, i.file_path) } };
    case 'Edit': case 'NotebookEdit': return { tool: 'edit', args: { path: inside(cwd, i.file_path ?? i.notebook_path) } };
    case 'Bash': return { tool: 'run', args: { command: i.command ?? '' } };
    case 'Grep': return { tool: 'search', args: { pattern: i.pattern, path: i.path && inside(cwd, i.path) } };
    case 'Glob': return { tool: 'search', args: { query: i.pattern, path: i.path && inside(cwd, i.path) } };
    case 'WebSearch': return { tool: 'web_search', args: { query: i.query ?? '' } };
    case 'WebFetch': return { tool: 'fetch', args: { url: i.url ?? '' } };
    case 'Agent': case 'Task': return { tool: 'agent', args: { title: i.description || 'Sous-agent', task: i.prompt ?? '' } };
    default: {
      const detail = Object.values(i).find((v) => typeof v === 'string') ?? '';
      return { tool: name, args: { path: detail.replace(/\s+/g, ' ').slice(0, 120) } };
    }
  }
}

const textOf = (content) => (typeof content === 'string' ? content
  : (content ?? []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n'));

let nextId = Date.now();

export class ClaudeAgent extends EventEmitter {
  constructor({ cwd, executable, approve, skillsDir = null, query = null }) {
    super();
    this.cwd = cwd;
    this.executable = executable;
    this.approve = approve;
    this.skillsDir = skillsDir;
    this.runQuery = query;
    this.isClaude = true;
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
  }

  get running() { return Boolean(this.controller); }

  stop() { this.controller?.abort(); }
  reset() { this.stop(); }
  upgradeReasoning() {}
  contextStats() { return this.context; }

  /** The message with its skills: Poney's, called like its local models do. */
  prompt(text, turnId) {
    const skills = loadSkills(skillDirs(this.cwd, this.skillsDir));
    const named = mentionedSkills(text, skills);
    const inView = (s) => this.messages.some((m) => m.content.includes(`(Skill "${s.name}"`));
    const found = this.autoSkills === false ? [] : matchingSkills(text, skills).filter((s) => !named.includes(s) && !inView(s));
    let out = text;
    // (/name would be read as a command of the Claude harness)
    for (const s of named) out = out.replace(new RegExp(`(^|\\s)/${s.name}(?=$|[\\s.,:;!?)])`), `$1${s.name}`);
    for (const s of [...named, ...found]) out += `\n\n${skillBlock(s, 8000)}`;
    if (named.length || found.length) {
      const shown = (auto) => (s) => ({ name: s.name, description: s.description, author: s.author, source: s.source, auto });
      this.emit('event', { type: 'skill', turnId, skills: [...named.map(shown(false)), ...found.map(shown(true))] });
    }
    return out;
  }

  async send(text, { turnId } = {}) {
    if (this.running) throw new Error('L’agent est déjà en cours d’exécution.');
    this.controller = new AbortController();
    this.emit('event', { type: 'turn_start' });
    const state = { tools: new Map(), gens: new Map(), results: new Set(), tasks: 0, turnOver: false };
    this.planShown = false;
    this.resultError = false;
    let stats = null;
    let reason = 'done';
    try {
      const content = this.prompt(text, turnId);
      this.messages.push({ role: 'user', content });
      const run = this.runQuery ?? (await sdk()).query;
      const q = run({
        prompt: content,
        options: {
          cwd: this.cwd,
          model: this.choice.model,
          effort: this.choice.effort,
          thinking: { type: 'adaptive', display: 'summarized' }, // (by default, the reasoning arrives empty)
          permissionMode: MODES[this.choice.mode] ?? 'default',
          canUseTool: (name, input, opts) => this.canUse(state, name, input, opts),
          disallowedTools: ['AskUserQuestion'], // (it asks in the conversation instead)
          includePartialMessages: true,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          pathToClaudeCodeExecutable: this.executable,
          abortController: this.controller,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
        },
      });
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') await this.readContext(q);
        const end = this.onMessage(state, message);
        if (end) ({ stats, reason } = end);
      }
    } catch (e) {
      if (this.controller.signal.aborted) {
        reason = 'stopped';
        this.emit('event', { type: 'notice', text: 'Arrêté.' });
      } else {
        reason = 'error';
        if (!this.resultError) this.emit('event', { type: 'error', message: claudeError(e.message) }); // (not said twice)
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
  async readContext(q) {
    try {
      const c = await q.getContextUsage?.({ detail: 'summary' });
      if (!c) return;
      const compactAt = (c.isAutoCompactEnabled && c.autoCompactThreshold) || c.maxTokens;
      this.setContext({ used: c.totalTokens, numCtx: c.maxTokens, compactAt, limit: compactAt });
    } catch {} // (the gauge is not worth a failed turn)
  }

  setContext(c) {
    this.context = { ...this.context, ...c, type: 'context', claude: true };
    this.emit('event', this.context);
  }

  /** What a message of the conversation used, by the API's count. */
  countContext(usage) {
    if (!usage || !this.context) return;
    const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    if (used) this.setContext({ used });
  }

  /**
   * Claude ended its turn but the session lives on: it gives its result, then waits
   * for its background tasks and starts again when one ends. (Watchers do not count:
   * ambient tasks are not activity.)
   */
  updateSleep(state) {
    const sleeping = state.turnOver && state.tasks > 0;
    if (sleeping === this.sleeping) return;
    this.sleeping = sleeping;
    this.emit('event', { type: 'sleeping', on: sleeping });
  }

  emitFor(parent, state, ev) {
    const agentId = parent ? state.tools.get(parent)?.id : undefined;
    this.emit('event', agentId === undefined ? ev : { ...ev, agentId });
  }

  onMessage(state, m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.sessionId = m.session_id;
        if (m.subtype === 'background_tasks_changed') {
          state.tasks = m.tasks.filter((t) => !t.ambient).length;
          this.updateSleep(state);
        }
        return null;
      case 'stream_event': return this.onStream(state, m.event, m.parent_tool_use_id);
      case 'assistant':
        // (what the stream has not shown, as with a sub-agent's messages)
        for (const b of m.message?.content ?? []) if (b.type === 'tool_use') this.startTool(state, b.id, b.name, b.input, m.parent_tool_use_id);
        return null;
      case 'user':
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (b.type === 'tool_result') this.endTool(state, b.tool_use_id, textOf(b.content), !b.is_error);
        }
        return null;
      case 'result':
        state.turnOver = true;
        this.updateSleep(state);
        return this.onResult(m);
      default: return null;
    }
  }

  onStream(state, ev, parent) {
    const key = parent ?? 'main';
    if (ev.type === 'message_start') {
      if (!parent) {
        this.countContext(ev.message?.usage);
        state.turnOver = false;
        this.updateSleep(state);
      }
      const id = nextId++;
      state.gens.set(key, { id, key, parent, state, text: '', thinking: '', tools: 0, blocks: new Map() });
      this.emitFor(parent, state, { type: 'assistant_start', id });
      return null;
    }
    if (ev.type === 'message_delta' && !parent) this.countContext(ev.usage);
    const gen = state.gens.get(key);
    if (!gen) return null;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      gen.blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d.type === 'text_delta') {
        gen.text += d.text;
        this.emitFor(parent, state, { type: 'delta', id: gen.id, kind: 'text', text: d.text });
      } else if (d.type === 'thinking_delta') {
        if (!d.thinking) return null;
        gen.thinking += d.thinking;
        this.emitFor(parent, state, { type: 'delta', id: gen.id, kind: 'thinking', text: d.thinking, summary: true });
      } else if (d.type === 'input_json_delta' && gen.blocks.has(ev.index)) gen.blocks.get(ev.index).json += d.partial_json;
    } else if (ev.type === 'content_block_stop' && gen.blocks.has(ev.index)) {
      const b = gen.blocks.get(ev.index);
      gen.blocks.delete(ev.index);
      gen.tools++;
      let input = {};
      try { input = JSON.parse(b.json || '{}'); } catch {}
      this.endGen(gen);
      this.startTool(state, b.id, b.name, input, parent);
    } else if (ev.type === 'message_stop') this.endGen(gen);
    return null;
  }

  /** The text so far ends before a tool, as one of Poney's generations does. */
  endGen(gen) {
    const { state, parent } = gen;
    if (state.gens.get(gen.key) === gen) state.gens.delete(gen.key);
    this.emitFor(parent, state, { type: 'assistant_end', id: gen.id, text: gen.text, thinking: gen.thinking, hasActions: gen.tools > 0 });
  }

  startTool(state, toolUseId, name, input, parent) {
    if (state.tools.has(toolUseId)) return state.tools.get(toolUseId);
    const id = nextId++;
    const { tool, args } = toolView(name, input, this.cwd);
    const entry = { id, name, input, parent, tool };
    if (name === 'TodoWrite') {
      const tasks = (input.todos ?? []).map((t) => ({ text: t.content, status: { in_progress: 'running', completed: 'done' }[t.status] ?? 'pending' }));
      state.tools.set(toolUseId, { ...entry, silent: true });
      this.emitFor(parent, state, this.planShown ? { type: 'plan', tasks } : { type: 'action_start', id, tool: 'plan', args: { body: tasks.map((t) => `- ${t.text}`).join('\n') } });
      if (!this.planShown) this.emitFor(parent, state, { type: 'plan', tasks });
      this.planShown = true;
      return state.tools.get(toolUseId);
    }
    state.tools.set(toolUseId, entry);
    this.emitFor(parent, state, { type: 'action_start', id, tool, args });
    if (name === 'ExitPlanMode' && input.plan) this.emitFor(parent, state, { type: 'action_output', id, text: input.plan });
    return entry;
  }

  endTool(state, toolUseId, output, ok) {
    const t = state.tools.get(toolUseId);
    if (!t || state.results.has(toolUseId)) return;
    state.results.add(toolUseId);
    if (t.silent) return;
    const name = String(t.input.file_path ?? '');
    const diff = !ok ? undefined
      : t.name === 'Edit' ? unifiedDiff(t.input.old_string ?? '', t.input.new_string ?? '', name)
        : t.name === 'Write' ? unifiedDiff('', t.input.content ?? '', name) : undefined;
    this.emitFor(t.parent, state, { type: 'action_end', id: t.id, ok, output, ...(diff ? { diff } : {}), meta: { path: inside(this.cwd, name) } });
  }

  /** Stopped or cut short: no card goes on turning. */
  closeTools(state) {
    for (const [id, t] of state.tools) if (!state.results.has(id)) this.endTool(state, id, 'Arrêté.', false);
  }

  /** The permission of a tool: the question of Poney's interface, on the tool's card. */
  async canUse(state, name, input, { toolUseID, title } = {}) {
    const t = this.startTool(state, toolUseID, name, input, null); // (already shown, as a rule)
    const answer = await this.approve({ id: t.id, tool: t.tool, command: title ?? t.tool, claude: true });
    if (answer === true || answer?.ok) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: String(answer?.reason ?? '').trim() || 'The user refused.' };
  }

  onResult(m) {
    const reason = m.subtype === 'success' ? 'done' : m.subtype === 'error_max_turns' ? 'max_steps' : 'error';
    if (m.subtype === 'success' && m.result) {
      this.messages.push({ role: 'assistant', content: m.result });
      this.emit('event', { type: 'final', text: m.result });
    } else if (m.subtype !== 'success') {
      this.resultError = true;
      this.emit('event', { type: 'error', message: claudeError((m.errors ?? []).join(' ')) });
    }
    const tokens = m.usage?.output_tokens ?? 0;
    const genMs = m.duration_api_ms ?? 0;
    return { reason, stats: { totalMs: m.duration_ms ?? 0, genMs, promptMs: 0, tokens, exact: true, tps: genMs ? tokens / (genMs / 1000) : 0, steps: m.num_turns ?? 1 } };
  }
}
