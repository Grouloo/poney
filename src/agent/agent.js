import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamChat, complete, serverContextLength } from './llm.js';
import { TOOLS, buildSystemPrompt, parseActions, splitThinking, formatResult, isToolEnabled, withReasoning, normalizeToolCalls, stripReasoning, legacyReasoningToNotes, toolSchemas } from './protocol.js';
import { executeAction, runShell, truncateMiddle } from './tools.js';
import {
  summaryTokens, mechanicalSummary, DEFAULT_CHARS_PER_TOKEN,
  makeEstimator, contextPlan, answerTokens, isValidSample, historyTokens, splitForCompaction, extractFacts, buildSummaryRequest, cleanSummary,
  buildInlineSummaryRequest,
  buildSummaryMessage, calibrate, SUMMARY_MARKER, filesInContext,
} from './context.js';

export const DEFAULT_CONFIG = {
  provider: 'ollama', // 'ollama' | 'openai'
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: '',
  numCtx: 16384,
  maxTokens: 4096,
  temperature: 0.2,
  maxSteps: 40,
  commandTimeout: 120,
  approval: 'ask', // 'ask' | 'auto'
  shellEnabled: true, // the agent may run terminal commands
  webEnabled: true, // the agent may search the web and fetch pages
  torEnabled: false, // web requests go through Tor (refused if Tor is unreachable)
  torProxy: '', // empty: auto (127.0.0.1:9050 tor daemon, then 9150 Tor Browser)
  torShell: false, // also give terminal commands the proxy variables
  subagentsEnabled: true, // the agent may delegate tasks to sub-agents (<agent>)
  maxParallelAgents: 2, // sub-agents running at the same time (one GPU: speed is shared)
  testCommand: '',
  searxngUrl: '',
};

const PROJECT_NOTE_FILES = ['AGENTS.md', 'LOCAL_CODEX.md', 'CLAUDE.md'];
/**
 * Timing of one generation. Uses the server's counts and durations when it
 * reports them (not the case when we stop the stream early), else estimates.
 */
export function generationStats({ t0, tFirst, tEnd, usage, est, text }) {
  if (tFirst == null) return null;
  const exact = Boolean(usage?.outputTokens);
  const tokens = exact ? usage.outputTokens : est(text);
  const genMs = usage?.evalMs || Math.max(1, tEnd - tFirst);
  const promptMs = usage?.promptMs ?? tFirst - t0;
  return {
    totalMs: tEnd - t0,
    promptMs: Math.round(promptMs),
    genMs: Math.round(genMs),
    tokens,
    tps: Math.round((tokens / (genMs / 1000)) * 10) / 10,
    exact,
  };
}

/** Models expect alternating roles: merge consecutive same-role messages, start with a user one. */
function mergeRoles(msgs) {
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  if (merged[0]?.role === 'assistant') merged.unshift({ role: 'user', content: '(earlier conversation removed)' });
  return merged;
}

/**
 * The complete tool call that ends the reasoning (nothing written after it), our
 * tags or a native call. Gemma sometimes "calls" a tool at the end of its
 * reasoning and then produces nothing visible any more. Read-only tools in
 * backticks count (Gemma often writes them so).
 */
function trailingCall(thinking) {
  if (!/<[a-z_|]/i.test(thinking)) return null;
  const unquoted = thinking.replace(/`(<(?:read|list|search)\b[^`\n]*?\/?>)`/g, '$1');
  const normalized = normalizeToolCalls(unquoted);
  const last = parseActions(normalized, { final: false }).actions.at(-1);
  if (!last?.complete || normalized.slice(last.end).trim()) return null;
  return { raw: last.raw, before: normalized.slice(0, last.end) };
}

// Silence after a call (in the reasoning or the answer) before we stop waiting and run it.
const STALL_MS = 10_000;

/** The user request carried by a message (unwraps a compaction summary). */
function taskFromMessage(content) {
  if (!content.startsWith(SUMMARY_MARKER)) return content;
  const m = content.match(/\[CURRENT TASK\]\n([\s\S]*?)\n\nContinue the task from here\./);
  return m ? m[1] : null;
}

// After the server has read (and cached) the prompt, delay without any visible output before we give up.
const INVISIBLE_TIMEOUT_MS = 45_000;

// Non-space characters of prose allowed after a completed action before we stop the generation.
const NARRATION_LIMIT = 400;

let nextId = Date.now(); // unique across restarts, since saved conversations are replayed by id

export class Agent extends EventEmitter {
  constructor({ cwd, config, approve, shared, role = 'main' }) {
    super();
    this.cwd = cwd;
    this.role = role; // 'main' or 'sub' (a sub-agent cannot start sub-agents)
    this.config = { ...DEFAULT_CONFIG, ...config, ...(role === 'sub' ? { subagentsEnabled: false } : {}) };
    this.approve = approve || (async () => true);
    // State shared by an agent and its sub-agents: versions of the files they
    // write (to refuse writing over another agent's changes) and per-file locks.
    this.shared = shared || { versions: new Map(), locks: new Map() };
    this.readVersions = new Map(); // file -> version this agent last read or wrote
    this.messages = [];
    this.untested = false; // files changed since the last successful command
    this.running = false;
    this.abort = null;
    this.systemPrompt = null; // custom prompt for this conversation; null = generated default
    this.charsPerToken = DEFAULT_CHARS_PER_TOKEN; // calibrated from real token counts
    this.calibratedFor = null;
    this.calibrated = false; // true once a real token count has been used
    this.lastUsage = null; // last token counts reported by the server
    // Rewind points: one per user message, to restart the conversation from an
    // edited message. A compaction rewrites the history, so the history it
    // replaces is archived and the checkpoints taken before it point there.
    this.checkpoints = []; // [{ turnId, archive: index | null (current history), length, untested }]
    this.archives = []; // pre-compaction histories (null once no checkpoint needs them)
    this.serverCtx = null; // context length actually loaded on the server, if it says
    this.serverCtxKey = null;
    this.serverCtxAt = 0;
  }

  /**
   * The config with the window the server really has: the setting may say 24k
   * while LM Studio loaded the model with 16k. Everything is sized from this.
   */
  get cfg() {
    const numCtx = this.serverCtx ? Math.min(this.config.numCtx, this.serverCtx) : this.config.numCtx;
    return { ...this.config, numCtx };
  }

  /** Asks the server for its real context length (cached 30 s per server and model). */
  async refreshServerContext() {
    const key = `${this.config.provider}|${this.config.baseUrl}|${this.config.model}`;
    if (key === this.serverCtxKey && Date.now() - this.serverCtxAt < 30_000) return this.serverCtx;
    this.serverCtx = await serverContextLength(this.config).catch(() => null);
    this.serverCtxKey = key;
    this.serverCtxAt = Date.now();
    return this.serverCtx;
  }

  /** Token estimator for the current model (calibration is reset when the model changes). */
  get est() {
    if (this.calibratedFor !== this.config.model) {
      this.calibratedFor = this.config.model;
      this.charsPerToken = DEFAULT_CHARS_PER_TOKEN;
      this.calibrated = false;
    }
    return makeEstimator(this.charsPerToken);
  }

  /** How the window is shared for this system prompt (see contextPlan). */
  plan(system) {
    const est = this.est;
    return contextPlan(this.cfg, est(system), this.calibrated);
  }

  /** The generated prompt, which follows the settings (tool toggles, test command, project notes). */
  async defaultSystemPrompt() {
    return buildSystemPrompt({
      cwd: this.cwd,
      platform: `${os.platform()} ${os.arch()}`,
      projectNotes: await this.loadProjectNotes(),
      testCommand: this.config.testCommand,
      shell: this.config.shellEnabled !== false,
      web: this.config.webEnabled !== false,
      subagents: this.config.subagentsEnabled !== false,
      subagentRole: this.role === 'sub',
    });
  }

  get maxResultChars() {
    return Math.max(2000, Math.floor(this.cfg.numCtx * 3.2 * 0.2));
  }

  reset() {
    this.stop();
    this.messages = [];
    this.untested = false;
    this.systemPrompt = null;
    this.lastUsage = null;
    this.currentTask = null;
    this.checkpoints = [];
    this.archives = [];
  }

  /**
   * Puts the conversation back as it was just before the user message `turnId`
   * (that message and everything after it are removed). Files are not restored.
   */
  rewind(turnId, { rebuilt, keepTurnIds } = {}) {
    if (this.running) throw new Error('Agent is running.');
    const i = this.checkpoints.findIndex((c) => c.turnId === turnId);
    if (i < 0 && !rebuilt) throw new Error('Ce message ne peut pas servir de point de reprise.');
    if (i < 0 || this.checkpoints[i].rebuild) {
      // Exact history gone (old conversation, or rewind point lost in a crash):
      // use the history rebuilt from the transcript (given by the caller).
      // Earlier checkpoints can no longer point into an exact history, so they
      // rebuild too; without a checkpoint, the caller says which messages came before.
      if (!rebuilt) throw new Error('Rebuilt history required.');
      const earlier = i >= 0 ? this.checkpoints.slice(0, i) : this.checkpoints.filter((c) => keepTurnIds?.has(c.turnId));
      this.messages = rebuilt;
      this.untested = false;
      // (action resume points cannot be rebuilt: they are dropped)
      this.checkpoints = earlier.filter((c) => c.turnId).map((c) => ({ turnId: c.turnId, rebuild: true }));
      this.archives = [];
      this.lastUsage = null;
      this.currentTask = null;
      return;
    }
    this.restoreCheckpoint(i);
  }

  /** The resume point of a past action (and the ids of the actions it re-runs), or null. */
  findActionCheckpoint(actId) {
    return this.checkpoints.find((c) => c.kind === 'action' && c.actIds.includes(actId)) || null;
  }

  /**
   * Resumes the conversation from a past action: back to the history just after
   * the message that asked for it, then that action (and the rest of its batch)
   * runs again and the agent goes on. Files are not restored.
   */
  resumeFrom(actId) {
    if (this.running) throw new Error('Agent is running.');
    const i = this.checkpoints.findIndex((c) => c.kind === 'action' && c.actIds.includes(actId));
    if (i < 0) throw new Error('Cette action ne peut pas servir de point de reprise.');
    const cp = this.checkpoints[i];
    this.restoreCheckpoint(i);
    return this.send(null, { resume: cp });
  }

  /**
   * Same as resumeFrom, for an action without resume point (older conversation):
   * the state is rebuilt from the transcript (see rebuildForAction).
   */
  resumeFromRebuilt(rebuilt) {
    if (this.running) throw new Error('Agent is running.');
    this.messages = rebuilt.messages;
    this.untested = false;
    // Message checkpoints up to the request being resumed stay (rebuilt on use); later ones go.
    const t = rebuilt.turnId ? this.checkpoints.findIndex((c) => c.turnId === rebuilt.turnId) : -1;
    this.checkpoints = (t >= 0 ? this.checkpoints.slice(0, t + 1) : []).filter((c) => c.turnId).map((c) => ({ turnId: c.turnId, rebuild: true }));
    this.archives = [];
    this.lastUsage = null;
    return this.send(null, { resume: rebuilt });
  }

  /** Brings the history back to checkpoint i (which is removed, with the later ones). */
  restoreCheckpoint(i) {
    const cp = this.checkpoints[i];
    const base = cp.archive == null ? this.messages : this.archives[cp.archive];
    if (!base) throw new Error('L’historique de ce point de reprise n’est plus disponible.');
    this.messages = base.slice(0, cp.length).map((m) => ({ ...m }));
    this.untested = cp.untested;
    this.checkpoints = this.checkpoints.slice(0, i);
    // Earlier checkpoints still pointing at the restored archive now match the
    // current history; archives nobody points at any more are dropped.
    for (const c of this.checkpoints) if (c.archive === cp.archive) c.archive = null;
    const used = new Set(this.checkpoints.map((c) => c.archive));
    this.archives = this.archives.map((a, k) => (used.has(k) ? a : null));
    this.lastUsage = null;
    this.currentTask = null;
  }

  stop() {
    this.abort?.abort();
  }

  async loadProjectNotes() {
    for (const name of PROJECT_NOTE_FILES) {
      try {
        const text = await fs.readFile(path.join(this.cwd, name), 'utf8');
        return truncateMiddle(text.trim(), 3000);
      } catch {}
    }
    return '';
  }

  // ----- context management -----

  /** Builds the message list sent to the model, compacting old turns to fit num_ctx. */
  buildPrompt(system, { raw = false } = {}) {
    // Normally maybeCompact() keeps the history within budget; the passes below
    // are a safety net (e.g. a single huge message, or a failed compaction).
    const est = this.est;
    const msgs = this.messages.map((m) => ({ ...m }));
    const { budget } = this.plan(system);
    const total = () => historyTokens(msgs, est);
    // raw: exactly what the server already has in cache (used for the summary request).
    if (raw || total() <= budget) return [{ role: 'system', content: system }, ...mergeRoles(msgs)];

    // Pass 1: shrink old tool results and old file bodies, oldest first, keeping the last 4 messages intact.
    for (let i = 0; i < msgs.length - 4 && total() > budget; i++) {
      const m = msgs[i];
      if (m.role === 'user' && m.content.includes('<result')) {
        m.content = m.content.replace(/(<result[^>]*>\n)([\s\S]*?)(\n<\/result>)/g, (_, a, body, c) =>
          body.length > 300 ? `${a}${body.slice(0, 200)}\n[... old output removed ...]${c}` : `${a}${body}${c}`);
      } else if (m.role === 'assistant') {
        m.content = m.content.replace(/(<(write|edit)\b[^>]*>)([\s\S]*?)(<\/\2>)/g, (_, open, __, body, close) =>
          `${open}[${body.split('\n').length} lines, removed from history]${close}`);
      }
    }
    // Pass 2: drop the oldest messages, keeping the current task's request and the last 2 messages.
    msgs[this.turnStartIndex ?? 0].keep = true;
    let dropped = 0;
    while (total() > budget) {
      const idx = msgs.findIndex((m, i) => !m.keep && i < msgs.length - 2);
      if (idx < 0) break;
      msgs.splice(idx, 1);
      dropped++;
    }
    if (dropped) {
      const task = msgs.findIndex((m) => m.keep);
      msgs[task].content = `${msgs[task].content}\n\n[${dropped} older messages were removed to save memory. Re-read files if you need them.]`;
    }
    return [{ role: 'system', content: system }, ...mergeRoles(msgs)];
  }

  // ----- context gauge & compaction -----

  /** Current context usage, for the UI gauge. */
  async contextStats(system) {
    system ??= this.systemPrompt ?? await this.defaultSystemPrompt();
    await this.refreshServerContext();
    const est = this.est;
    const systemTokens = est(system);
    const { budget } = this.plan(system);
    return {
      type: 'context',
      used: systemTokens + historyTokens(this.messages, est),
      numCtx: this.cfg.numCtx,
      settingCtx: this.config.numCtx,
      serverCtx: this.serverCtx,
      compactAt: systemTokens + budget,
      limit: systemTokens + budget,
      calibrated: this.calibrated,
      measured: this.lastUsage ? this.lastUsage.promptTokens + this.lastUsage.outputTokens : null,
    };
  }

  async emitContext(system) {
    this.emit('event', await this.contextStats(system));
  }

  /**
   * Replaces the oldest messages with a summary as late as possible: only when
   * the next call would no longer fit (or always, with force).
   */
  async maybeCompact(system, signal, { force = false } = {}) {
    const est = this.est;
    const { budget, keep } = this.plan(system);
    const before = historyTokens(this.messages, est);
    if (!force && before <= budget) return { compacted: false };

    // Forced (manual) compaction: keep only the most recent third, even when the
    // whole history would fit in the usual "recent" share.
    const keepTokens = force ? Math.min(keep, Math.floor(before * 0.3)) : keep;
    const { old, recent } = splitForCompaction(this.messages, keepTokens, est);
    if (old.length < 2) return { compacted: false, reason: 'Pas assez de messages anciens à résumer.' };

    this.emit('event', { type: 'compaction_start' });
    const turnStart = this.turnStartIndex ?? this.messages.length;
    // The request of the current task, if it is about to be summarized. After a
    // previous compaction the first message is a summary: take the request it carries.
    const task = turnStart < old.length ? (this.currentTask ?? taskFromMessage(this.messages[turnStart].content)) : null;

    // 1st try: continue the cached conversation with a summary instruction (the
    // server has already read that prompt: no long re-read). Then: a separate
    // transcript of the old part, shortened if the server rejects it.
    const cfg = this.cfg;
    const plan = this.plan(system);
    const prompt = this.buildPrompt(system, { raw: true });
    const inlineRoom = cfg.numCtx - historyTokens(prompt, est) - plan.margin - 150;
    const attempts = [];
    if (inlineRoom >= 600) attempts.push({ inline: true, maxTokens: Math.min(summaryTokens(cfg.numCtx), inlineRoom) });
    attempts.push({ inline: false }, { inline: false, retry: true });
    const maxTokens = summaryTokens(cfg.numCtx);
    let maxChars = Math.max(3000, Math.floor((cfg.numCtx - maxTokens - 800) * this.charsPerToken * 0.85));
    let summary = null;
    let failure = null;
    for (const attempt of attempts) {
      if (summary) break;
      try {
        const r = await complete({
          ...cfg,
          ...(attempt.inline ? { toolSchemas: toolSchemas(this.config) } : {}),
          maxTokens: attempt.maxTokens ?? maxTokens,
          temperature: attempt.retry ? 0.4 : 0.1,
          signal,
          onProgress: (progress) => this.emit('event', { type: 'prompt_progress', id: 'compaction', progress }),
          messages: attempt.inline ? buildInlineSummaryRequest(prompt) : buildSummaryRequest(old, maxChars, { retry: attempt.retry }),
        });
        const c = cleanSummary(r.text);
        summary = c.summary;
        if (!summary) {
          failure = !r.text.trim() && r.thinking.trim()
            ? 'le modèle a passé tout son budget à réfléchir, sans écrire de résumé'
            : c.reason;
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        failure = `erreur du serveur : ${e.message.slice(0, 200)}`;
        if (!attempt.inline) maxChars = Math.floor(maxChars / 2); // the request may have been too long for the server
      }
    }
    // Fallback without the model: requests, previous summary, last notes.
    const fallback = !summary;
    summary ??= mechanicalSummary(old);

    const content = buildSummaryMessage({ summary, facts: extractFacts(old), task });
    // Keep the history being replaced for the rewind points that need it.
    if (this.checkpoints.some((c) => c.archive == null)) {
      const k = this.archives.push(this.messages) - 1;
      for (const c of this.checkpoints) if (c.archive == null) c.archive = k;
    }
    this.messages = [{ role: 'user', content }, ...recent];
    this.turnStartIndex = task ? 0 : turnStart - old.length + 1;
    const after = historyTokens(this.messages, est);
    this.emit('event', { type: 'compaction', before, after, removed: old.length, summary: content, fallback, failure: fallback ? failure : null });
    await this.emitContext(system);
    return { compacted: true, before, after, fallback, failure };
  }

  /** Manual compaction, from the UI. */
  async compact() {
    if (this.running) throw new Error('Agent is running.');
    this.running = true;
    this.abort = new AbortController();
    try {
      const system = this.systemPrompt ?? await this.defaultSystemPrompt();
      return await this.maybeCompact(system, this.abort.signal, { force: true });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  // ----- sub-agents -----

  /**
   * Runs a group of <agent> actions, at most maxParallelAgents at a time, and
   * returns their reports as results (in the order of the tags).
   */
  async runSubAgents(group, signal, ids = group.map(() => nextId++)) {
    const limit = Math.max(1, Math.min(Number(this.config.maxParallelAgents) || 2, 8));
    const results = new Array(group.length);
    let next = 0;
    const share = Math.floor(this.maxResultChars / group.length);
    const worker = async () => {
      while (next < group.length && !signal.aborted) {
        const k = next++;
        results[k] = await this.runSubAgent(group[k], signal, share, ids[k]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return results;
  }

  async runSubAgent(action, signal, maxReportChars, id = nextId++) {
    const title = String(action.args.title || 'sous-agent').slice(0, 60);
    const task = String(action.args.task || '').trim();
    this.emit('event', { type: 'action_start', id, tool: 'agent', args: { title, task } });
    if (!task) {
      this.emit('event', { type: 'action_end', id, ok: false, output: 'Tâche vide.', meta: { title } });
      return formatResult('agent', { title }, 'Empty task: write the task between <agent> and </agent>.');
    }
    const child = new Agent({
      cwd: this.cwd,
      config: this.config,
      role: 'sub',
      shared: this.shared,
      approve: (req) => this.approve({ ...req, agentTitle: title }),
    });
    child.serverCtx = this.serverCtx;
    child.serverCtxKey = this.serverCtxKey;
    child.serverCtxAt = this.serverCtxAt;
    let report = null;
    let error = null;
    let stats = null;
    let endReason = null;
    child.on('event', (ev) => {
      if (ev.type === 'final') report = ev.text;
      if (ev.type === 'error') error = ev.message;
      if (ev.type === 'turn_end') { stats = ev.stats; endReason = ev.reason; return; }
      if (ev.type === 'turn_start' || ev.type === 'context') return;
      this.emit('event', { ...ev, agentId: id }); // shown inside the sub-agent's card
    });
    const onAbort = () => child.stop();
    signal.addEventListener('abort', onAbort);
    try {
      await child.send(task);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const ok = Boolean(report) && endReason === 'done';
    const text = report || (error ? `Error: ${error}` : endReason === 'max_steps' ? 'Stopped: step limit reached before the end.' : '(no report)');
    this.emit('event', { type: 'action_end', id, ok, output: text, meta: { title, steps: stats?.steps, tokens: stats?.tokens, ms: stats?.totalMs } });
    return formatResult('agent', { title, status: ok ? 'done' : endReason || 'failed' }, truncateMiddle(text, Math.max(1000, maxReportChars)));
  }

  // ----- generation -----

  /** Assistant message for the history: the answer, preceded by its reasoning (capped). */
  assistantContent(gen, text) {
    return withReasoning(text, gen.thinking);
  }

  /** Converts reasoning blocks saved by older versions into short notes (see withReasoning). */
  upgradeReasoning() {
    const fix = (list) => list?.forEach((m) => {
      if (m && m.role === 'assistant' && m.content.includes('<reasoning>')) m.content = legacyReasoningToNotes(m.content);
    });
    fix(this.messages);
    this.archives.forEach(fix);
  }

  async generate(system, signal) {
    const id = nextId++;
    this.emit('event', { type: 'assistant_start', id });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort);
    let text = '';
    let thinking = '';
    let cutAt = -1;
    let narrationCut = false;
    let streamError = null;
    let visibleSeen = false;
    // A call ends the output so far: if nothing visible follows for stallMs, stop and run it.
    let stallTimer = null;
    let stallCall = null; // call ending the reasoning, if that is where it is
    let stalled = false;
    const armStall = (call) => {
      clearTimeout(stallTimer);
      stallCall = call;
      stallTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, this.stallMs ?? STALL_MS);
    };
    const disarmStall = () => { clearTimeout(stallTimer); stallTimer = null; stallCall = null; };
    let invisibleTimeout = false;
    let watchdog = null;
    let doneReason = null;
    let usage = null;
    const t0 = Date.now();
    let tFirst = null;
    const prompt = this.buildPrompt(system);
    const promptChars = prompt.reduce((n, m) => n + m.content.length, 0);
    // Ask for as long an answer as fits: never more than the window, so the
    // server never has to drop the start of the prompt to make room.
    const maxTokens = answerTokens(this.cfg, this.plan(system), historyTokens(prompt, this.est));
    try {
      for await (const chunk of streamChat({
        ...this.cfg,
        toolSchemas: toolSchemas(this.config),
        maxTokens,
        messages: prompt,
        signal: ctrl.signal,
      })) {
        if (chunk.type === 'done') { doneReason = chunk.reason; continue; }
        if (chunk.type === 'tool_progress') {
          visibleSeen = true;
          tFirst ??= Date.now();
          this.emit('event', { type: 'delta', id, kind: 'tool', text: chunk.text, name: chunk.name });
          continue;
        }
        if (chunk.type === 'prompt_read') {
          // The server has read the prompt (it is cached): something visible
          // should come within seconds. If not, the model is stuck producing
          // invisible tokens: stop instead of waiting minutes.
          watchdog = setTimeout(() => {
            if (!visibleSeen) { invisibleTimeout = true; ctrl.abort(); }
          }, INVISIBLE_TIMEOUT_MS);
          continue;
        }
        if (chunk.type === 'progress') {
          this.emit('event', { type: 'prompt_progress', id, progress: chunk.progress });
          continue;
        }
        if (chunk.type === 'usage') {
          usage = chunk;
          this.lastUsage = chunk;
          if (isValidSample(this.charsPerToken, promptChars, chunk.promptTokens)) {
            this.charsPerToken = calibrate(this.charsPerToken, promptChars, chunk.promptTokens);
            this.calibrated = true;
          }
          continue;
        }
        tFirst ??= Date.now();
        if (chunk.text) visibleSeen = true;
        if (chunk.type === 'thinking') {
          thinking += chunk.text;
          this.emit('event', { type: 'delta', id, kind: 'thinking', text: chunk.text });
          // A call at the very end of the reasoning arms the stall timer; any
          // further writing (a plan that goes on) disarms it.
          if (/\S/.test(chunk.text)) {
            const call = /[>}|]/.test(chunk.text) ? trailingCall(thinking) : null;
            if (call) armStall(call);
            else disarmStall();
          }
          continue;
        }
        text += chunk.text;
        this.emit('event', { type: 'delta', id, kind: 'text', text: chunk.text });
        // Stop early once the model has asked for something it needs to see the
        // result of, or starts inventing a result. Saves time on slow hardware
        // and prevents hallucinated follow-up actions.
        // Native tool-call formats are rewritten first, so that positions found
        // here are valid in the text kept below.
        const visible = normalizeToolCalls(splitThinking(text).text);
        const fake = visible.search(/<result\b|^\s*(User|Human):/m);
        if (fake >= 0) { cutAt = fake; break; }
        const { actions } = parseActions(visible, { final: false });
        // (<agent> excepted: several in a row form one group, run together.)
        const obs = actions.find((a) => a.complete && TOOLS[a.tool].observes && a.tool !== 'agent');
        if (obs) { cutAt = obs.end; break; }
        // After a <write>/<edit>, small models often go on narrating ("the tests
        // pass...") instead of waiting for the result: minutes of invented text
        // on local hardware. Stop once a long text follows the last action
        // without starting a new one.
        const last = actions[actions.length - 1];
        // Same stall rule when the answer ends with a complete action.
        if (/\S/.test(chunk.text)) {
          if (last?.complete && !visible.slice(last.end).trim()) armStall(null);
          else disarmStall();
        }
        if (last?.complete) {
          const after = visible.slice(last.end);
          if (after.replace(/\s/g, '').length > NARRATION_LIMIT && !/<[a-z_|]/i.test(after)) {
            cutAt = last.end;
            narrationCut = true;
            break;
          }
        }
      }
    } catch (e) {
      if (signal.aborted) {
        // Stopped by the user: keep what was produced in the transcript.
        const partial = splitThinking(text);
        if (partial.text.trim() || thinking || partial.thinking) {
          this.emit('event', { type: 'assistant_end', id, text: parseActions(normalizeToolCalls(partial.text)).text, thinking: thinking + partial.thinking, hasActions: false, interrupted: true });
        }
        throw e;
      }
      if (e.name !== 'AbortError') {
        // Stream cut by the server or the network in the middle of the answer:
        // keep what came (complete actions still run), as for a length cut.
        if (!splitThinking(text).text.trim()) throw e;
        streamError = e;
      }
    } finally {
      clearTimeout(watchdog);
      clearTimeout(stallTimer);
      ctrl.abort();
      signal.removeEventListener('abort', onAbort);
    }
    // Tokens were generated but nothing visible came out.
    const invisible = !visibleSeen && (invisibleTimeout || (usage?.outputTokens ?? 0) > 20);
    const split = splitThinking(text);
    let visible = normalizeToolCalls(split.text);
    if (cutAt >= 0) visible = visible.slice(0, cutAt);
    thinking += split.thinking;
    // After a stall, the call ending the reasoning; at a normal end, only if the
    // model wrote no real answer (a call left at the end of a plan is not run).
    const noAction = !parseActions(visible).actions.length;
    const endCall = noAction ? (stallCall || (visible.trim().length < 200 ? trailingCall(thinking) : null)) : null;
    if (endCall) {
      // The reasoning ended with a call and the answer has none (or nothing
      // came out after it): that call is what the model meant to do.
      thinking = endCall.before;
      visible = `${visible.trim()}\n${endCall.raw}`.trim();
      this.emit('event', { type: 'notice', text: stalled
        ? 'Le modèle a appelé un outil à la fin de sa réflexion puis n’a plus rien produit : génération arrêtée, l’appel est exécuté.'
        : 'Appel d’outil à la fin de la réflexion du modèle : il est exécuté.' });
    } else if (stalled) {
      this.emit('event', { type: 'notice', text: 'Plus rien ne sortait après l’action : génération arrêtée, l’action est exécutée.' });
    } else if (!parseActions(visible).actions.length) {
      // Gemma sometimes makes its tool call inside its reasoning: if the answer has
      // no action, use the first complete native call found there.
      const at = thinking.indexOf('<|tool_call>');
      const first = at < 0 ? null : parseActions(normalizeToolCalls(thinking.slice(at))).actions[0];
      const action = first?.start === 0 ? first : null; // the native call itself, not a tag mentioned later
      if (action?.complete) {
        visible = `${visible.trim()}\n${action.raw}`.trim();
        this.emit('event', { type: 'notice', text: 'Appel d’outil trouvé dans la réflexion du modèle : il est exécuté.' });
      }
    }
    // Cut by the length limit (not by us): the end of the answer is missing.
    const truncated = cutAt < 0 && (doneReason === 'length' || Boolean(streamError));
    if (streamError) {
      this.emit('event', { type: 'notice', text: `Le serveur a coupé la génération (${streamError.message}) : ce qui était déjà écrit est conservé, les actions complètes sont exécutées.` });
    }
    const stats = generationStats({ t0, tFirst, tEnd: Date.now(), usage, est: this.est, text: text + thinking });
    if (narrationCut) this.emit('event', { type: 'notice', text: 'Le modèle continuait à écrire après son action au lieu d’attendre le résultat : génération arrêtée, l’action est exécutée.' });
    return { id, text: visible, thinking, truncated, contextLimited: truncated && !streamError && maxTokens < this.config.maxTokens, stats, invisible };
  }

  // ----- main loop -----

  async send(userText, { turnId, resume } = {}) {
    if (this.running) throw new Error('Agent is already running.');
    if (turnId && !resume) this.checkpoints.push({ turnId, archive: null, length: this.messages.length, untested: this.untested });
    this.running = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    const config = this.config;
    // Reasoning stays in the history (so the model does not restart its thinking
    // from scratch after each result) until a compaction summarizes it: removing
    // it here would change the start of the prompt and force the server to
    // re-read everything (minutes on local hardware).
    this.turnStartIndex = resume ? resume.turnStartIndex : this.messages.length;
    this.currentTask = resume ? resume.currentTask : userText;
    const turnT0 = Date.now();
    // Totals over all the generations of this turn, shown once under the answer.
    const turnStats = { totalMs: 0, genMs: 0, promptMs: 0, tokens: 0, exact: true, steps: 0 };
    const addStats = (st) => {
      if (!st) return;
      turnStats.genMs += st.genMs;
      turnStats.promptMs += st.promptMs;
      turnStats.tokens += st.tokens;
      turnStats.exact &&= st.exact;
      turnStats.steps++;
    };
    if (!resume) this.messages.push({ role: 'user', content: userText });
    this.emit('event', { type: 'turn_start' });

    const system = this.systemPrompt ?? await this.defaultSystemPrompt();
    await this.refreshServerContext();
    const shellOn = config.shellEnabled !== false;

    let changedThisTurn = false;
    let gateNudges = 0;
    let testFailures = 0;
    let emptyReplies = 0;
    let codeDumpNudged = false;
    let invisibleRetried = false;
    const recent = [];
    let reason = 'done';

    const notice = (text) => this.emit('event', { type: 'notice', text });
    // Resuming from an action: its batch is run first, without generating.
    let pending = resume ? { actions: resume.remaining, results: resume.priorResults } : null;

    try {
      const stopped = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      for (let step = 0; ; step++) {
        if (signal.aborted) throw stopped(); // stopped during an action: do not generate again
        if (step >= config.maxSteps) {
          reason = 'max_steps';
          notice(`Limite de ${config.maxSteps} étapes atteinte. Envoyez "continue" pour poursuivre.`);
          break;
        }
        let actions = [];
        let cutNote = '';
        let toRun = [];
        let results = [];
        if (pending) {
          toRun = pending.actions.map((a) => ({ ...a, args: { ...a.args } }));
          results = [...pending.results];
          actions = [...toRun];
          pending = null;
        } else {
        const c = await this.maybeCompact(system, signal);
        if (!c.compacted) await this.emitContext(system);
        let gen = await this.generate(system, signal);
        // Cut because the window was full: compact now and redo this step once.
        if (gen.contextLimited) {
          this.emit('event', { type: 'assistant_end', id: gen.id, text: '', thinking: '', hasActions: false });
          notice('Réponse coupée faute de place : compactage du contexte puis nouvelle tentative.');
          await this.maybeCompact(system, signal, { force: true });
          addStats(gen.stats);
          gen = await this.generate(system, signal);
        }
        addStats(gen.stats);
        if (gen.invisible) {
          this.emit('event', { type: 'assistant_end', id: gen.id, text: '', thinking: '', hasActions: false });
          if (!invisibleRetried) {
            // Seen with Gemma when earlier reasoning is in the history: retry without it.
            invisibleRetried = true;
            notice('Le modèle génère sans rien produire de visible : nouvel essai sans les notes de raisonnement de l’historique.');
            for (const m of this.messages) if (m.role === 'assistant') m.content = stripReasoning(m.content);
            continue;
          }
          reason = 'error';
          this.emit('event', { type: 'error', message: 'Le modèle génère des tokens sans rien produire de visible. Essayez de modifier votre dernier message (✎) ou de démarrer une nouvelle conversation.' });
          break;
        }
        // An answer cut by the length limit may end with an unfinished action
        // (e.g. half a file in <write>): never execute those.
        const parsed = parseActions(gen.text, { final: !gen.truncated });
        const prose = parsed.text;
        actions = parsed.actions.filter((a) => a.complete);
        const unfinished = parsed.actions.find((a) => !a.complete);
        if (gen.truncated) {
          cutNote = unfinished
            ? `Your message was cut at the length limit: the last <${unfinished.tool}> was unfinished and was NOT executed. Work in smaller pieces (use <edit>, or split big files).`
            : 'Your message was cut at the length limit. Continue from where it stopped, more briefly.';
          notice(unfinished ? `Réponse coupée (limite de longueur) : <${unfinished.tool}> incomplet, non exécuté.` : 'Réponse coupée (limite de longueur).');
        }
        this.emit('event', { type: 'assistant_end', id: gen.id, text: prose, thinking: gen.thinking, hasActions: actions.length > 0, stats: gen.stats });
        if (gen.truncated && !actions.length) {
          this.messages.push({ role: 'assistant', content: this.assistantContent(gen, gen.text.slice(0, unfinished?.start ?? gen.text.length).trim() || '(cut)') });
          this.messages.push({ role: 'user', content: cutNote });
          continue;
        }

        // ---------- no action: the model thinks it's done ----------
        if (!actions.length) {
          if (!gen.text.trim()) {
            if (++emptyReplies > 2) { reason = 'empty'; notice('Le modèle ne répond plus.'); break; }
            this.messages.push({ role: 'assistant', content: this.assistantContent(gen, '(empty)') });
            this.messages.push({ role: 'user', content: 'Your reply was empty. Continue the task using a tool tag, or give your final summary.' });
            continue;
          }
          this.messages.push({ role: 'assistant', content: this.assistantContent(gen, gen.text) });

          // Code pasted in a markdown block instead of written to a file.
          if (!codeDumpNudged && /```[\w-]*\n[\s\S]{80,}?```/.test(gen.text) && /\b(create|write|fix|implement|add|update|modify|refactor|cré|écri|ajout|modifi|corrig|implémen)/i.test(userText)) {
            codeDumpNudged = true;
            notice('Code non écrit dans un fichier : relance du modèle.');
            this.messages.push({ role: 'user', content: 'You showed code in your message but did not save it. ' +
              'For a NEW file use <write path="...">...</write>. For an EXISTING file use <edit>, or <read> it first and then <write> the COMPLETE file (never drop existing code)' +
              `${shellOn ? '. Then test it with <run>' : ''}.` });
            continue;
          }

          // Test gate 1: project test command must pass.
          if (config.testCommand && changedThisTurn && shellOn) {
            notice(`Vérification : ${config.testCommand}`);
            const actId = nextId++;
            this.emit('event', { type: 'action_start', id: actId, tool: 'run', args: { command: config.testCommand }, auto: true });
            const r = await runShell(config.testCommand, { cwd: this.cwd, timeoutSec: Math.max(config.commandTimeout, 300), signal, onOutput: (t) => this.emit('event', { type: 'action_output', id: actId, text: t }) });
            const out = truncateMiddle(r.out.trim() || '(no output)', this.maxResultChars);
            this.emit('event', { type: 'action_end', id: actId, ok: r.code === 0, output: out, meta: { exit: r.code } });
            if (r.code !== 0 && testFailures < 3) {
              testFailures++;
              this.messages.push({ role: 'user', content: `${formatResult('run', { command: config.testCommand, exit: r.code }, out)}\nThe project tests FAIL. The task is not finished: fix the code until this command passes.` });
              continue;
            }
            if (r.code === 0) this.untested = false;
          } else if (this.untested && shellOn && gateNudges < 2) {
            // Test gate 2: no unverified changes.
            gateNudges++;
            notice('Code modifié mais pas testé : le modèle est relancé pour tester.');
            this.messages.push({ role: 'user', content: 'You changed files but did not successfully run them since. Test your work now with <run> (run the program, a quick check, or the tests). If testing is really impossible, say why in your final summary.' });
            continue;
          }
          this.emit('event', { type: 'final', text: prose });
          break;
        }

        // ---------- execute actions ----------
        // Writes/edits can be batched; stop after the first action whose result
        // the model must see (it cannot know the result yet).
        for (const a of actions) {
          // Consecutive <agent> tags form a group run at the same time; other
          // actions run in order until the first one whose result is needed.
          if (toRun.length && (toRun[0].tool === 'agent') !== (a.tool === 'agent')) break;
          toRun.push(a);
          if (TOOLS[a.tool].observes && a.tool !== 'agent') break;
        }
        const last = toRun[toRun.length - 1];
        this.messages.push({ role: 'assistant', content: this.assistantContent(gen, gen.text.slice(0, last.end).trim()) });
        } // end of the generation step (skipped when resuming a batch)

        let stopBatch = false;
        // Resume point for the actions of this batch: the history up to the
        // message that asked for them, and the results already obtained.
        const resumePoint = (actIds, fromIndex) => this.checkpoints.push({
          kind: 'action',
          actIds,
          archive: null,
          length: this.messages.length,
          untested: this.untested,
          remaining: toRun.slice(fromIndex).map(({ tool, args, raw, start, end, complete }) => ({ tool, args, raw, start, end, complete })),
          priorResults: [...results],
          turnStartIndex: this.turnStartIndex,
          currentTask: this.currentTask,
        });
        // Files the model can see the content of (the current message has no results yet).
        const seenFiles = filesInContext(this.messages);
        if (toRun[0].tool === 'agent') {
          if (!isToolEnabled('agent', config)) {
            for (const action of toRun) {
              const actId = nextId++;
              this.emit('event', { type: 'action_start', id: actId, tool: 'agent', args: action.args });
              this.emit('event', { type: 'action_end', id: actId, ok: false, output: 'Sous-agents désactivés.', meta: {} });
              results.push(formatResult('agent', { title: action.args.title }, 'Sub-agents are disabled. Do the task yourself.'));
            }
          } else {
            const ids = toRun.map(() => nextId++);
            resumePoint(ids, 0); // resuming any member re-runs the whole group
            results.push(...await this.runSubAgents(toRun, signal, ids));
            changedThisTurn = true; // sub-agents may have changed files
          }
          toRun.length = 0;
        }
        for (const [k, action] of toRun.entries()) {
          if (stopBatch) break;
          const actId = nextId++;
          resumePoint([actId], k);
          this.emit('event', { type: 'action_start', id: actId, tool: action.tool, args: action.args });
          if (!isToolEnabled(action.tool, config)) {
            const what = action.tool === 'run' ? 'Running commands' : 'Internet access';
            this.emit('event', { type: 'action_end', id: actId, ok: false, output: 'Outil désactivé dans les réglages.', meta: {} });
            results.push(formatResult(action.tool, {}, `${what} is disabled by the user. Do not use <${action.tool}>. Continue without it.`));
            continue;
          }
          if (action.tool === 'run' && config.approval !== 'auto') {
            const ok = await this.approve({ id: actId, tool: action.tool, command: action.args.command });
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            if (!ok) {
              const out = 'The user refused to run this command. Try another way, or ask the user.';
              this.emit('event', { type: 'action_end', id: actId, ok: false, output: 'Refusé par l’utilisateur.', meta: {} });
              results.push(formatResult(action.tool, { command: action.args.command }, out));
              stopBatch = true;
              continue;
            }
          }
          const r = await executeAction(action, {
            cwd: this.cwd,
            config,
            signal,
            maxResultChars: this.maxResultChars,
            seenFiles,
            shared: this.shared,
            readVersions: this.readVersions,
            onOutput: (t) => this.emit('event', { type: 'action_output', id: actId, text: t }),
          });
          this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.output, diff: r.diff, meta: r.meta });
          if (signal.aborted) throw stopped(); // the action was interrupted: keep it as the resume point
          if (action.tool === 'write' && r.changed) seenFiles.add(r.changed);

          if (r.changed) {
            changedThisTurn = true;
            if (!/\.(md|txt|rst|csv|log)$/i.test(r.changed)) this.untested = true;
          }
          if (action.tool === 'run' && r.exitCode === 0) this.untested = false;

          let output = r.output;
          const sig = JSON.stringify([action.tool, action.args]);
          recent.push(sig);
          if (recent.length > 8) recent.shift();
          if (recent.filter((s) => s === sig).length >= 3) {
            output += '\nNOTE: you already did exactly this several times. Do something different.';
          }
          if (action.tool === 'run' && r.exitCode !== 0) {
            output += '\nThe command failed. Read the error, fix the cause, then run it again.';
          }
          const attrs = { ...r.meta };
          if (action.tool === 'run') attrs.command = action.args.command;
          results.push(formatResult(action.tool, attrs, output));
          if (!r.ok && !['run', 'search'].includes(action.tool)) stopBatch = true;
        }
        const skipped = actions.length - results.length;
        let content = results.join('\n');
        if (skipped > 0) content += `\n(${skipped} later action(s) were NOT run. Look at the result above first, then continue.)`;
        if (cutNote) content += `\n${cutNote}`;
        this.messages.push({ role: 'user', content });
      }
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) {
        reason = 'stopped';
        notice('Arrêté.');
        // Keep history consistent: the last message must be a user message or a full exchange.
        if (this.messages[this.messages.length - 1]?.role === 'assistant') {
          this.messages.push({ role: 'user', content: '(stopped by the user)' });
        }
      } else {
        reason = 'error';
        this.emit('event', { type: 'error', message: e.message });
      }
    } finally {
      this.running = false;
      this.abort = null;
      await this.emitContext(system).catch(() => {});
      turnStats.totalMs = Date.now() - turnT0;
      turnStats.tps = turnStats.genMs ? Math.round((turnStats.tokens / (turnStats.genMs / 1000)) * 10) / 10 : 0;
      this.emit('event', { type: 'turn_end', reason, stats: turnStats.steps ? turnStats : null });
    }
  }
}
