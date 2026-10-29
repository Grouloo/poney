import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamChat, complete, serverContextLength } from './llm.js';
import { liveAction, partialEditPairs, TOOLS, buildSystemPrompt, parseActions, splitThinking, formatResult, isToolEnabled, withReasoning, findRepetition, normalizeToolCalls, stripReasoning, legacyReasoningToNotes, stripChannelMarkers, toolSchemas, answerInReasoning } from './protocol.js';
import { executeAction, runShell, truncateMiddle, checkOldBlock } from './tools.js';
import { remember, forget, memoryBlock, standingInstructions, instructionNote, replacedAutoNote } from './memory.js';
import { recall, autoRecall, recalledBlock, keywordsOf } from './history.js';
import { linksToRead, readLinks } from './autofetch.js';
import { TRIAGE_SCHEMA, TRIAGE_ATTEMPTS, TRIAGE_RETRY, TRIAGE_RETRY_CUT, fallbackTriage, ROUTE_SOURCES, SOURCE_TOOLS, MAX_REFUSALS, triageRequest, triageInstruction, triageUpdateInstruction, needsUpdate, parseTriage, triageBlock, triageReminder, triageRefusal } from './triage.js';
import { parsePlan, mergePlan, nextGroup, setStatus, formatPlan, subAgentTask, turnDigest } from './plan.js';
import {
  summaryTokens, summaryWords, mechanicalSummary, DEFAULT_CHARS_PER_TOKEN,
  makeEstimator, contextPlan, answerTokens, isValidSample, historyTokens, splitForCompaction, extractFacts, buildSummaryRequest, cleanSummary,
  buildInlineSummaryRequest,
  buildSummaryMessage, calibrate, SUMMARY_MARKER, filesInContext, splitChapter, chapterDates, capChapters,
} from './context.js';

export const DEFAULT_CONFIG = {
  provider: 'ollama', // 'ollama' | 'openai'
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: '',
  numCtx: 16384,
  maxTokens: 4096,
  temperature: null, // null: the model's own (server/model preset); 0.2 made answers flat and loops likelier
  maxSteps: 40,
  commandTimeout: 120,
  approval: 'ask', // 'ask' | 'auto'
  shellEnabled: true, // the agent may run terminal commands
  webEnabled: true, // the agent may search the web and fetch pages
  autoFetch: true, // the links of the user's messages are read before the model answers
  torEnabled: false, // web requests go through Tor (refused if Tor is unreachable)
  torProxy: '', // empty: auto (127.0.0.1:9050 tor daemon, then 9150 Tor Browser)
  torShell: false, // also give terminal commands the proxy variables
  subagentsEnabled: true, // the agent may delegate tasks to sub-agents (<agent>)
  maxParallelAgents: 2, // sub-agents running at the same time (one GPU: speed is shared)
  parallelAgents: true, // false: sub-agents one at a time (on weak machines, parallel generations slow down a lot)
  testCommand: '',
  searxngUrl: '',
};

const PROJECT_NOTE_FILES = ['AGENTS.md', 'PONEY.md', 'LOCAL_CODEX.md', 'CLAUDE.md'];
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
  const m = content.match(/\[CURRENT TASK\]\n([\s\S]*?)\n\nContinue (?:the task )?from here\./);
  return m ? m[1] : null;
}

// After the server has read (and cached) the prompt, delay without any visible output before we give up.
const INVISIBLE_TIMEOUT_MS = 45_000;

// Non-space characters of prose allowed after a completed action before we stop the generation.
const NARRATION_LIMIT = 400;

/**
 * Whether a changed file is something to run before finishing: not documentation,
 * nor data/config formats (JSON gets a syntax check; YAML, TOML… have nothing to run).
 */
export function needsRun(file) {
  return !/\.(md|markdown|mdx|txt|rst|adoc|org|csv|tsv|log|json|jsonc|ya?ml|toml|ini|cfg|conf)$/i.test(file)
    && !/(^|\/)(LICENSE|NOTICE|AUTHORS|COPYING|CHANGELOG)$/i.test(file);
}

/** "[Thu 2026-10-22 14:05]": when a user message was sent (local time). */
export function messageStamp(d) {
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `[${day} ${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}]`;
}

let nextId = Date.now(); // unique across restarts, since saved conversations are replayed by id

export class Agent extends EventEmitter {
  constructor({ cwd, config, approve, shared, role = 'main', offProject = false, triage = false }) {
    super();
    this.triageByDefault = triage; // the assessment before acting when the steps do not say (the app: on)
    this.cwd = cwd;
    this.offProject = offProject; // a conversation outside any project: cwd is its own folder
    this.role = role; // 'main' or 'sub' (a sub-agent cannot start sub-agents)
    this.config = { ...DEFAULT_CONFIG, ...config, ...(role === 'sub' ? { subagentsEnabled: false } : {}) };
    this.approve = approve || (async () => true);
    // State shared by an agent and its sub-agents: versions of the files they
    // write (to refuse writing over another agent's changes) and per-file locks.
    this.shared = shared || { versions: new Map(), locks: new Map() };
    this.subWork = new Map(); // sub-agent id -> what it changed (see runSubAgent)
    this.readVersions = new Map(); // file -> version this agent last read or wrote
    this.messages = [];
    this.untested = false; // files changed since the last successful command
    this.taskPlan = null; // the task list written with <plan> (see plan.js)
    this.memory = []; // notes kept with <remember> for the whole conversation (see memory.js)
    this.memoryShownAt = 0; // index of the last message showing the whole memory
    this.chapters = []; // index of the compacted parts (see maybeCompact)
    // Steps set by the user for this conversation: { before, after, afterOnlyIfChanged, triage }
    // (before: done first at each message; after: once, before the final answer;
    // triage: the assessment before acting, see triage.js; when unset, triageByDefault).
    this.steps = null;
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
      offProject: this.offProject,
      memory: this.config.memoryEnabled !== false,
      platform: os.platform() === 'win32' ? `Windows ${os.arch()}, commands run in cmd.exe` : `${os.platform()} ${os.arch()}`,
      ...(await this.loadProjectNotes()),
      testCommand: this.config.testCommand,
      shell: this.config.shellEnabled !== false,
      web: this.config.webEnabled !== false,
      subagents: this.config.subagentsEnabled !== false,
      parallel: this.config.parallelAgents !== false,
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
    this.taskPlan = null;
    this.memory = [];
    this.memoryShownAt = 0;
    this.chapters = [];
    this.steps = null;
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
      this.taskPlan = null;
      this.memoryShownAt = -1;
      this.chapters = [];
      this.emit('event', { type: 'plan', tasks: [] });
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
    this.taskPlan = null;
    this.memoryShownAt = -1;
    this.chapters = [];
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
    this.taskPlan = cp.plan ? structuredClone(cp.plan) : null;
    if (cp.chapters) this.chapters = [...cp.chapters];
    if (cp.memory) {
      this.memory = [...cp.memory];
      this.memoryShownAt = Math.min(cp.memoryShownAt ?? 0, this.messages.length);
      this.emit('event', { type: 'memory', notes: this.memory });
    }
    this.emit('event', { type: 'plan', tasks: this.taskPlan?.tasks ?? [] });
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

  /** The project's notes file, for the system prompt: { projectNotes, notesFile } (its name). */
  async loadProjectNotes() {
    for (const name of PROJECT_NOTE_FILES) {
      try {
        const text = await fs.readFile(path.join(this.cwd, name), 'utf8');
        return { projectNotes: truncateMiddle(text.trim(), 3000), notesFile: name };
      } catch {}
    }
    return { projectNotes: '', notesFile: null };
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
    const words = summaryWords(cfg.numCtx);
    let maxChars = Math.max(3000, Math.floor((cfg.numCtx - maxTokens - 800) * this.charsPerToken * 0.85));
    let summary = null;
    let failure = null;
    for (const attempt of attempts) {
      if (summary) break;
      try {
        const r = await complete({
          ...cfg,
          ...(attempt.inline ? { toolSchemas: toolSchemas(this.config, { subagentRole: this.role === 'sub' }) } : {}),
          maxTokens: attempt.maxTokens ?? maxTokens,
          temperature: attempt.retry ? 0.4 : 0.1,
          signal,
          onProgress: (progress) => this.emit('event', { type: 'prompt_progress', id: 'compaction', progress }),
          messages: attempt.inline ? buildInlineSummaryRequest(prompt, { words }) : buildSummaryRequest(old, maxChars, { retry: attempt.retry, words }),
        });
        const c = cleanSummary(r.text, { maxChars: words * 9 });
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

    // Chapter index: one line per compacted part (dates, topics, keywords), so the model
    // knows what is out of view and what to look for with <recall>.
    const split = splitChapter(summary);
    const own = old.filter((m) => !m.content.startsWith(SUMMARY_MARKER));
    let topic = split.chapter.replace(/\s+/g, ' ').trim().slice(0, 200);
    const kw = keywordsOf(own, { count: 6, exclude: topic });
    const present = kw.filter((w) => topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(w)).length;
    if (!topic) topic = kw.join(', ');
    else if (present < 2 && kw.length) topic += ` — ${kw.slice(0, 5).join(', ')}`; // vague line: add the part's own words
    const dates = chapterDates(own);
    if (topic || dates) this.chapters = capChapters([...this.chapters, [dates, topic].filter(Boolean).join(' — ')]);
    let content = buildSummaryMessage({ summary: split.summary, facts: extractFacts(old), task, chapters: this.chapters });
    if (this.taskPlan?.tasks.length) content += `\n\nCURRENT PLAN:\n${formatPlan(this.taskPlan)}`;
    if (this.memory.length) content += `\n\n${memoryBlock(this.memory)}`; // the notes survive the compaction, word for word
    // Keep the history being replaced: for <recall>, and for the rewind points that point into it.
    const k = this.archives.push(this.messages) - 1;
    for (const c of this.checkpoints) if (c.archive == null) c.archive = k;
    this.messages = [{ role: 'user', content }, ...recent];
    this.memoryShownAt = 0;
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
    const limit = this.config.parallelAgents === false ? 1 : Math.max(1, Math.min(Number(this.config.maxParallelAgents) || 2, 8));
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
      offProject: this.offProject,
      config: this.config,
      role: 'sub',
      shared: this.shared,
      triage: this.steps?.triage ?? this.triageByDefault, // its own assessment, as its parent's conversation says
      approve: (req) => this.approve({ ...req, agentTitle: title }),
    });
    child.serverCtx = this.serverCtx;
    child.virtualFiles = action.outputs ?? null; // the main agent's steps in full (see turnDigest)
    child.serverCtxKey = this.serverCtxKey;
    child.serverCtxAt = this.serverCtxAt;
    let report = null;
    let error = null;
    let stats = null;
    let endReason = null;
    // What it changed (files, commands), whatever its report says: for the
    // next agents of a plan, which may find their task already done.
    const started = new Map();
    const work = [];
    this.subWork.set(id, work);
    let context = null; // its latest context figures (kept with its result: shown again on reload)
    child.on('event', (ev) => {
      if (ev.type === 'context') context = ev;
      if (ev.type === 'action_start') started.set(ev.id, ev);
      if (ev.type === 'action_end' && ev.ok) {
        const a = started.get(ev.id);
        if (a?.tool === 'write' || a?.tool === 'edit') work.push(`${a.tool === 'write' ? 'wrote' : 'edited'} ${String(a.args.path || '').trim()}`);
        if (a?.tool === 'run') work.push(`ran \`${String(a.args.command || '').replace(/\s+/g, ' ').slice(0, 160)}\`${ev.meta?.exit !== undefined ? ` (exit ${ev.meta.exit})` : ''}`);
      }
      if (ev.type === 'final') report = ev.text;
      if (ev.type === 'error') error = ev.message;
      if (ev.type === 'turn_end') { stats = ev.stats; endReason = ev.reason; return; }
      if (ev.type === 'turn_start') return;
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
    this.emit('event', { type: 'action_end', id, ok, output: text, meta: { title, steps: stats?.steps, tokens: stats?.tokens, ms: stats?.totalMs, context } });
    return formatResult('agent', { title, status: ok ? 'done' : endReason || 'failed' }, truncateMiddle(text, Math.max(1000, maxReportChars)));
  }

  // ----- memory -----

  /** Changes made by the user in the memory panel: shown to the model with its next message. */
  setMemory(notes) {
    this.memory = notes.map((n) => String(n).replace(/\s+/g, ' ').trim()).filter(Boolean);
    this.memoryShownAt = -1;
    this.emit('event', { type: 'memory', notes: this.memory });
  }

  // ----- plan -----

  /**
   * Carries out a <plan>: each task in a sub-agent, in order (consecutive
   * @parallel tasks at the same time); a task is done when its sub-agent stops.
   * A failure stops the plan there: the model gets the reports and may write a
   * new plan (tasks already done are not run again).
   */
  async runPlan(action, signal, stepPoint = () => {}) {
    const written = parsePlan(action.args.body);
    if (!written.length) {
      const text = 'Empty plan: write one task per line, like "- task".';
      return { ok: false, text, result: formatResult('plan', {}, text) };
    }
    if (this.role === 'sub') {
      // Seen with Gemma: a sub-agent copies the plan of its task message, gets it
      // back as a list, and writes it again, in a loop. Its task is one task.
      const mine = (this.currentTask || '').match(/YOUR TASK: (.+)$/)?.[1];
      const text = `No <plan> here: the plan is already written, and run by the main agent. You are a sub-agent with ONE task${mine ? `: ${mine}` : ''}.\nDo it now with the tools (<search>, <read>, <edit>…), then answer with your report.`;
      return { ok: false, text, result: formatResult('plan', {}, text) };
    }
    this.taskPlan = mergePlan(this.taskPlan, written);
    const plan = this.taskPlan;
    this.emit('event', { type: 'plan', tasks: plan.tasks });
    if (!isToolEnabled('agent', this.config)) {
      // No sub-agents: a list for the model, which does the tasks itself.
      const text = `${formatPlan(plan)}\n(Sub-agents are not available: do these tasks yourself, in order.)`;
      return { ok: true, text, result: formatResult('plan', {}, text) };
    }
    const reports = [...(action.planReports ?? [])]; // (resumed: those of the steps kept)
    let failed = false;
    // (sub-agents one at a time: @parallel tasks too, so that only the one running shows as such)
    const next = () => (this.config.parallelAgents === false ? nextGroup(plan).slice(0, 1) : nextGroup(plan));
    for (let group = next(); group.length && !failed; group = next()) {
      const ids = group.map(() => nextId++);
      // Resuming from one of these sub-agents runs the plan again from this step:
      // the tasks done before it (and their reports) are kept.
      stepPoint(ids, plan, reports);
      for (const t of group) setStatus(plan, t, 'running');
      this.emit('event', { type: 'plan', tasks: plan.tasks });
      // (the turn after the request, without the message with the plan)
      // Each sub-agent its own digest: the steps that concern its task are kept longer.
      // Sized from the window (the same model), and every step readable in full.
      const turn = this.messages.slice((this.turnStartIndex ?? this.messages.length) + 1, -1);
      const maxChars = Math.max(6000, Math.min(40000, Math.floor(this.cfg.numCtx * this.charsPerToken * 0.25)));
      const agents = group.map((t) => {
        const outputs = new Map();
        const digest = turnDigest(turn, { maxChars, task: `${t.text}\n${this.currentTask ?? ''}`, outputs });
        return { tool: 'agent', args: { title: t.text.slice(0, 60), task: subAgentTask(plan, t, this.currentTask, digest) }, outputs };
      });
      let results;
      try {
        results = await this.runSubAgents(agents, signal, ids);
      } catch (e) {
        for (const t of group) setStatus(plan, t, 'pending'); // stopped: to be started again
        this.emit('event', { type: 'plan', tasks: plan.tasks });
        throw e;
      }
      group.forEach((t, k) => {
        const ok = /\bstatus="done"/.test(results[k]);
        const report = results[k].replace(/^<result[^>]*>\n?|\n?<\/result>$/g, '').trim();
        const work = [...new Set(this.subWork.get(ids[k]) || [])];
        this.subWork.delete(ids[k]);
        if (work.length) plan.work.push({ task: t.text, items: work });
        setStatus(plan, t, ok ? 'done' : 'failed', report);
        if (!ok) failed = true;
        reports.push(`${ok ? '' : '[FAILED] '}${t.text}:\n${report}`);
      });
      this.emit('event', { type: 'plan', tasks: plan.tasks });
    }
    const left = plan.tasks.filter((t) => t.status !== 'done').length;
    const end = failed
      ? `\nA task failed, the plan stopped there (${left} task(s) not done). Fix it with a new <plan> (done tasks are not run again), or tell the user.`
      : '\nAll the tasks are done: check the reports, then answer the user (or write a new <plan> if something is missing).';
    const text = `${formatPlan(plan)}${reports.length ? `\n\nReports:\n${reports.join('\n\n')}` : ''}${end}`;
    return { ok: !failed, text, result: formatResult('plan', {}, text) };
  }

  // ----- generation -----

  /** Assistant message for the history: the answer, preceded by its reasoning (capped). */
  assistantContent(gen, text) {
    return withReasoning(stripChannelMarkers(text), stripChannelMarkers(gen.thinking));
  }

  /** Puts reasoning saved by older versions in the current form (see withReasoning). */
  upgradeReasoning() {
    const fix = (list) => list?.forEach((m) => {
      if (m && m.role === 'assistant' && /<reasoning>|^\(My notes: /.test(m.content)) m.content = legacyReasoningToNotes(m.content);
      // Leaked Gemma channel markers: seen again at each request, they made the model
      // reopen its reasoning (and loop). Removing them costs one full prompt read.
      if (m && m.role === 'assistant' && /<\|channel>|<channel\|>/.test(m.content)) m.content = stripChannelMarkers(m.content);
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
    // A model looping on the same passage is stopped (checked every ~200 characters).
    let looped = false;
    // The edit being written: each <old> is checked as soon as it is closed; a block not
    // found (or ambiguous) stops the generation there, before the model writes its <new>.
    const oldChecks = new Set();
    let seenClosings = 0;
    let earlyEdit = null;
    let reopens = 0; // reasoning channel reopened while reasoning (Gemma): a restart, often a loop
    let firstReopenAt = -1;
    let checkedThinking = 0;
    let checkedText = 0;
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
      for await (const chunk of (this.streamChat ?? streamChat)({ // (replaceable in tests)
        ...this.cfg,
        toolSchemas: toolSchemas(this.config, { subagentRole: this.role === 'sub' }),
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
        if (chunk.type === 'reopen') {
          if (firstReopenAt < 0) firstReopenAt = thinking.length;
          // Restarted three times: a loop. Keep the reasoning up to the first restart.
          if (++reopens >= 3) { thinking = thinking.slice(0, firstReopenAt); looped = true; break; }
          continue;
        }
        if (chunk.type === 'thinking') {
          thinking += chunk.text;
          this.emit('event', { type: 'delta', id, kind: 'thinking', text: chunk.text });
          if (thinking.length - checkedThinking >= 200) {
            checkedThinking = thinking.length;
            const r = findRepetition(thinking);
            if (r >= 0) { thinking = thinking.slice(0, r); looped = true; break; }
          }
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
        // (a closing may be cut between two pieces: counted on the whole answer so far)
        const closings = (visible.match(/<\/old>|<\|"\|>/g) || []).length;
        if (closings !== seenClosings) {
          seenClosings = closings;
          const live = liveAction(visible);
          // (only the first action of the answer: actions before it would not run if it stopped here)
          if (live?.tool === 'edit' && live.path && !live.complete && !parseActions(visible.slice(0, live.start)).actions.length) {
            const pairs = partialEditPairs(live.body);
            for (const [k, pair] of pairs.entries()) {
              const key = `${live.start}:${k}`;
              if (!pair.oldClosed || oldChecks.has(key)) continue;
              oldChecks.add(key);
              const r = await checkOldBlock(this.cwd, live.path, pair.old);
              if (r.ok) this.emit('event', { type: 'edit_located', id, pair: k, path: r.rel, startLine: r.startLine, endLine: r.endLine });
              else { earlyEdit = { path: live.path, old: pair.old, message: r.message }; break; }
            }
            if (earlyEdit) { cutAt = live.start; break; }
          }
        }
        // After a <write>/<edit>, small models often go on narrating ("the tests
        // pass...") instead of waiting for the result: minutes of invented text
        // on local hardware. Stop once a long text follows the last action
        // without starting a new one.
        const last = actions[actions.length - 1];
        // (not inside an action being written: a file may repeat lines on purpose)
        if (text.length - checkedText >= 200 && (!last || last.complete)) {
          checkedText = text.length;
          const r = findRepetition(visible);
          if (r >= 0) { cutAt = r; looped = true; break; }
        }
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
    const leaked = earlyEdit ? null : answerInReasoning(thinking);
    if (leaked) {
      // Its calls written after a made-up end of reasoning: run them, before those
      // of the answer (minus the ones written again there).
      const same = (a) => a.raw.replace(/\s+/g, ' ').trim();
      const done = new Set(parseActions(leaked.text).actions.map(same));
      const rest = parseActions(visible).actions.filter((a) => done.has(same(a)));
      for (const a of rest.reverse()) visible = visible.slice(0, a.start) + visible.slice(a.end);
      thinking = leaked.thinking;
      visible = `${leaked.text}\n${visible.trim()}`.trim();
      this.emit('event', { type: 'notice', text: 'Le modèle a écrit ses appels dans sa réflexion (après une fausse fin de réflexion) : ils sont exécutés.' });
    }
    // After a stall, the call ending the reasoning; at a normal end, only if the
    // model wrote no real answer (a call left at the end of a plan is not run).
    const noAction = !parseActions(visible).actions.length;
    const endCall = noAction && !earlyEdit ? (stallCall || (visible.trim().length < 200 ? trailingCall(thinking) : null)) : null;
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
    } else if (!earlyEdit && !parseActions(visible).actions.length) {
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
    if (looped) this.emit('event', { type: 'notice', text: 'Le modèle répétait le même passage en boucle : génération arrêtée, la répétition est retirée.' });
    return { id, text: visible, thinking, truncated, looped, earlyEdit, contextLimited: truncated && !streamError && maxTokens < this.config.maxTokens, stats, invisible };
  }

  /**
   * The assessment before acting (see triage.js): a dedicated call on the cached
   * conversation, whose output can only be the JSON assessment. Null when the
   * model gave none that can be read (the turn then goes on without it).
   * instruction: the first assessment of the message, or its update after results.
   */
  async assess(system, signal, instruction = triageInstruction()) {
    const prompt = this.buildPrompt(system);
    let cut = false; // the previous reply ran out of room while reasoning
    const ask = async (jsonSchema, attempt) => {
      let text = '';
      let thinking = '';
      let done = null;
      for await (const chunk of (this.streamChat ?? streamChat)({ // (replaceable in tests)
        ...this.cfg,
        // Same tools as the turn's calls, so that the server reuses its cached prompt.
        toolSchemas: toolSchemas(this.config, { subagentRole: this.role === 'sub' }),
        temperature: attempt.temperature,
        maxTokens: attempt.maxTokens,
        messages: triageRequest(prompt, attempt.retry ? `${instruction}\n${cut ? TRIAGE_RETRY_CUT : TRIAGE_RETRY}` : instruction),
        jsonSchema,
        signal,
      })) {
        if (chunk.type === 'text') text += chunk.text;
        else if (chunk.type === 'thinking') thinking += chunk.text;
        else if (chunk.type === 'done') done = chunk.reason;
        else if (chunk.type === 'progress') this.emit('event', { type: 'prompt_progress', id: 'triage', progress: chunk.progress });
      }
      cut = done === 'length' && Boolean(thinking.trim()) && !text.trim();
      return parseTriage(text);
    };
    let schema = TRIAGE_SCHEMA;
    for (const [k, attempt] of TRIAGE_ATTEMPTS.entries()) {
      if (k) this.emit('event', { type: 'notice', text: `${cut ? 'Bilan coupé pendant la réflexion du modèle' : 'Bilan illisible'} : nouvel essai (${k + 1}/${TRIAGE_ATTEMPTS.length}).` });
      let t = null;
      try {
        t = await ask(schema, attempt);
      } catch (e) {
        if (signal.aborted) throw e;
        if (!schema) continue;
        // A server without structured output: the same request, the JSON only asked for.
        schema = undefined;
        t = await ask(undefined, attempt).catch((e2) => { if (signal.aborted) throw e2; return null; });
      }
      if (t) return t;
    }
    return null;
  }

  // ----- main loop -----

  async send(userText, { turnId, resume } = {}) {
    if (this.running) throw new Error('Agent is already running.');
    if (turnId && !resume) this.checkpoints.push({ turnId, archive: null, length: this.messages.length, untested: this.untested, plan: structuredClone(this.taskPlan), memory: [...this.memory], memoryShownAt: this.memoryShownAt, chapters: [...this.chapters] });
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
    // A plan is the plan of one request: a new message starts without one
    // (a resumed turn keeps the plan of its resume point).
    if (!resume) this.taskPlan = null;
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
    // Each message carries its date and time: the model cannot know them, and here
    // (unlike in the system prompt) they never change the cached start of the prompt.
    let preRead = 0; // sources read by the app for this message (links, recalled passages)
    if (!resume) {
      // Lasting instructions ("answer in English", "from now on…") are noted by the app
      // itself, in the user's words: small models rarely note them, then drift back.
      if (this.role === 'main' && this.config.memoryEnabled !== false) {
        const added = [];
        for (const s of standingInstructions(userText)) {
          const r = remember(this.memory, instructionNote(s));
          if (r.notes !== this.memory) { this.memory = r.notes; added.push(s); }
        }
        if (added.length) {
          this.emit('event', { type: 'memory', notes: this.memory });
          this.emit('event', { type: 'noted', turnId, notes: added });
        }
      }
      let content = `${messageStamp(this.now?.() ?? new Date())} ${userText}`;
      // The memory is recalled with the message when its last full view is far back
      // (a third of the window): it stays in view without costing room at every message.
      // (-1: changed by the user since, to be shown again)
      if (this.memory.length && (this.memoryShownAt < 0 || historyTokens(this.messages.slice(this.memoryShownAt), this.est) > this.cfg.numCtx / 3)) {
        content += `\n\n(${memoryBlock(this.memory)})`;
        this.memoryShownAt = this.messages.length;
      }
      // Passages of the out-of-context history this message clearly refers to.
      if (this.role === 'main' && this.config.autoRecall !== false && this.archives.length) {
        const passages = autoRecall(this.archives, this.messages, userText);
        if (passages.length) {
          content += `\n\n${recalledBlock(passages)}`;
          preRead++;
          this.emit('event', { type: 'recalled', turnId, passages });
        }
      }
      // Links of the message read by the app (marked as page content), so that the model
      // does not answer from memory about a page it never opened.
      if (this.role === 'main' && config.webEnabled !== false && config.autoFetch !== false) {
        const urls = linksToRead(userText);
        if (urls.length) {
          this.emit('event', { type: 'fetching', urls }); // (shown while it lasts, not kept)
          const { pages, block } = await readLinks(urls, { cwd: this.cwd, config, signal, maxChars: Math.min(4800, Math.floor(this.maxResultChars / urls.length)) });
          content += `\n\n${block}`;
          preRead += pages.filter((p) => p.ok).length;
          this.emit('event', { type: 'fetched', turnId, pages });
        }
      }
      // The step the user set to be done first, at each message of this conversation.
      const before = this.role === 'main' ? this.steps?.before?.trim() : '';
      if (before) {
        content += `\n\n(Step to do first, set by the user for this conversation: ${before})`;
        this.emit('event', { type: 'step', phase: 'before', turnId, text: before });
      }
      this.messages.push({ role: 'user', content });
    }
    this.emit('event', { type: 'turn_start' });

    const system = this.systemPrompt ?? await this.defaultSystemPrompt();
    await this.refreshServerContext();
    const shellOn = config.shellEnabled !== false;

    let changedThisTurn = false;
    let codeChangedThisTurn = false; // the test gates only ask to test this turn's code
    let gateNudges = 0;
    let loopNudges = 0;
    let testFailures = 0;
    let emptyReplies = 0;
    let codeDumpNudged = false;
    let afterStepDone = false;
    let invisibleRetried = false;
    let triage = null; // the assessment before acting (or its latest update), and the route the app chose from it
    let triageRefusals = 0; // final answers refused for the current assessment
    let turnRefusals = 0; // … for all of them, this turn
    let triageUpdates = 0;
    let sourcesRead = 0; // sources read this turn (for the route of the assessment)
    let triageBase = 0; // sources already read when the current assessment was made
    const recent = [];
    let reason = 'done';

    const notice = (text) => this.emit('event', { type: 'notice', text });
    // Resuming from an action: its batch is run first, without generating.
    let pending = resume ? { actions: resume.remaining, results: resume.priorResults } : null;

    try {
      const stopped = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      // The assessment before acting: what the model knows, doubts and does not know.
      // The route (act directly, check, read several sources) is the app's decision.
      if (!resume && (this.steps?.triage ?? this.triageByDefault)) {
        await this.maybeCompact(system, signal);
        this.emit('event', { type: 'triage_start', turnId });
        const t = await this.assess(system, signal);
        // None could be read: a careful route all the same (failing it never skips it).
        triage = t ?? fallbackTriage();
        sourcesRead = preRead;
        const last = this.messages[this.messages.length - 1];
        last.content += `\n\n${triageBlock(triage)}`;
        this.emit('event', { type: 'triage', turnId, ...triage, ...(t ? {} : { failed: true }) });
      }
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

        // ---------- an edit whose <old> block failed while it was being written ----------
        if (gen.earlyEdit) {
          const { path: p, old, message } = gen.earlyEdit;
          const attempt = `<edit path="${p}">\n<old>${old}</old>`;
          this.messages.push({ role: 'assistant', content: this.assistantContent(gen, `${gen.text.trim()}\n${attempt}`.trim()) });
          const actId = nextId++;
          this.emit('event', { type: 'action_start', id: actId, tool: 'edit', args: { path: p, body: `<old>${old}</old>` } });
          this.emit('event', { type: 'action_end', id: actId, ok: false, output: message, meta: { path: p } });
          notice('Bloc <old> introuvable ou ambigu : génération arrêtée avant la fin de la modification.');
          this.messages.push({ role: 'user', content: `${formatResult('edit', { path: p }, message)}\n(You were stopped as soon as this <old> block was written: the edit was not applied. Fix the <old> block, it must match the file exactly.)` });
          continue;
        }

        // ---------- looping without acting: not an answer, push it to act ----------
        if (!actions.length && gen.looped) {
          this.messages.push({ role: 'assistant', content: this.assistantContent(gen, gen.text.trim() || '(…)') });
          if (++loopNudges > 2) { reason = 'loop'; notice('Le modèle reste bloqué dans une boucle : arrêt. Reformulez la demande ou découpez la tâche.'); break; }
          notice('Relance du modèle pour qu’il passe à l’action.');
          this.messages.push({ role: 'user', content: 'You started repeating the same text over and over. Do not restate your plan. Do the next step now with one tool tag (for example <write path="...">...</write>), or give your final summary if the task is done.' });
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

          // The assessment said something was doubtful or unknown: no final answer before
          // the sources its route asks for were read (asked twice at most, then let through).
          const since = sourcesRead - triageBase;
          if (triage && since < ROUTE_SOURCES[triage.route] && triageRefusals < (triage.route === 'investigate' ? 2 : 1) && turnRefusals < MAX_REFUSALS) {
            triageRefusals++;
            turnRefusals++;
            notice(`Réponse finale refusée : le bilan ${triage.unknowns.length ? 'signalait des inconnues' : 'signalait des doutes'} et ${since ? `seulement ${since} source lue` : 'aucune source n’a été lue'} depuis (${since}/${ROUTE_SOURCES[triage.route]}). Le modèle est relancé.`);
            this.messages.push({ role: 'user', content: triageRefusal(triage, since) });
            continue;
          }
          // Test gate 1: project test command must pass.
          if (config.testCommand && codeChangedThisTurn && shellOn) {
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
          } else if (this.untested && codeChangedThisTurn && shellOn && gateNudges < 2) {
            // Test gate 2: no unverified changes.
            gateNudges++;
            notice('Code modifié mais pas testé : le modèle est relancé pour tester.');
            this.messages.push({ role: 'user', content: 'You changed files but did not successfully run them since. Test your work now with <run> (run the program, a quick check, or the tests). If testing is really impossible, say why in your final summary.' });
            continue;
          }
          // The step the user set to be done before finishing (once per turn; optionally only
          // when files were changed): asked now, the answer after it is the final one.
          const after = this.role === 'main' ? this.steps?.after?.trim() : '';
          if (after && !afterStepDone && (!this.steps.afterOnlyIfChanged || changedThisTurn)) {
            afterStepDone = true;
            this.emit('event', { type: 'step', phase: 'after', text: after });
            this.messages.push({ role: 'user', content: `(Step to do before finishing, set by the user for this conversation: ${after})\nDo it now, then give your final answer.` });
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
          if (a.tool === 'plan') break; // its tasks run now: the reports are needed first
        }
        const last = toRun[toRun.length - 1];
        this.messages.push({ role: 'assistant', content: this.assistantContent(gen, gen.text.slice(0, last.end).trim()) });
        } // end of the generation step (skipped when resuming a batch)

        let stopBatch = false;
        const received = []; // results of this batch (to update the assessment after outside information)
        // Resume point for the actions of this batch: the history up to the
        // message that asked for them, and the results already obtained.
        const remainingOf = ({ tool, args, raw, start, end, complete }) => ({ tool, args, raw, start, end, complete });
        const resumePoint = (actIds, fromIndex, over = {}) => this.checkpoints.push({
          kind: 'action',
          actIds,
          archive: null,
          length: this.messages.length,
          untested: this.untested,
          plan: structuredClone(this.taskPlan),
          memory: [...this.memory],
          memoryShownAt: this.memoryShownAt,
          chapters: [...this.chapters],
          remaining: toRun.slice(fromIndex).map(remainingOf),
          priorResults: [...results],
          turnStartIndex: this.turnStartIndex,
          currentTask: this.currentTask,
          ...over,
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
            sourcesRead += toRun.length;
            changedThisTurn = true; // sub-agents may have changed files
          }
          toRun.length = 0;
        }
        for (const [k, action] of toRun.entries()) {
          if (stopBatch) break;
          // (a plan resumed from one of its steps goes on in its card: same id, its resume point kept)
          const actId = action.resumeId ?? nextId++;
          if (!action.resumeId) {
            resumePoint([actId], k);
            this.emit('event', { type: 'action_start', id: actId, tool: action.tool, args: action.args });
          }
          if (!isToolEnabled(action.tool, config)) {
            const what = action.tool === 'run' ? 'Running commands' : 'Internet access';
            this.emit('event', { type: 'action_end', id: actId, ok: false, output: 'Outil désactivé dans les réglages.', meta: {} });
            results.push(formatResult(action.tool, {}, `${what} is disabled by the user. Do not use <${action.tool}>. Continue without it.`));
            continue;
          }
          if (action.tool === 'run' && config.approval !== 'auto') {
            // (true / false, or { ok: false, reason } when the user said why)
            const answer = await this.approve({ id: actId, tool: action.tool, command: action.args.command });
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            if (answer !== true && !answer?.ok) {
              const reason = String(answer?.reason ?? '').trim().slice(0, 2000);
              const out = reason
                ? `The user refused to run this command, and said why: "${reason}"\nTake this into account: change your approach accordingly, or ask the user.`
                : 'The user refused to run this command. Try another way, or ask the user.';
              this.emit('event', { type: 'action_end', id: actId, ok: false, output: reason ? `Refusé par l’utilisateur : ${reason}` : 'Refusé par l’utilisateur.', meta: {} });
              results.push(formatResult(action.tool, { command: action.args.command }, out));
              stopBatch = true;
              continue;
            }
          }
          if (action.tool === 'recall') {
            const r = recall(this.archives, this.messages, action.args.query, { maxChars: Math.min(3000, this.maxResultChars) });
            if (r.ok) sourcesRead++;
            this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.text, meta: {} });
            results.push(formatResult('recall', { query: action.args.query }, r.text));
            continue;
          }
          if (action.tool === 'remember' || action.tool === 'forget') {
            let base = this.memory;
            if (action.tool === 'remember') {
              const k = replacedAutoNote(base, String(action.args.note ?? ''));
              if (k >= 0) base = base.filter((_, i) => i !== k); // the model's own wording replaces the app's note
            }
            const r = (action.tool === 'remember' ? remember : forget)(base, action.tool === 'remember' ? action.args.note : action.args.id);
            if (r.notes !== this.memory) {
              this.memory = r.notes;
              this.emit('event', { type: 'memory', notes: this.memory });
            }
            if (/\nMEMORY:\n/.test(r.text)) this.memoryShownAt = this.messages.length; // this result shows it all
            this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.text, meta: {} });
            results.push(formatResult(action.tool, {}, r.text));
            continue;
          }
          if (action.tool === 'plan') {
            const stepPoint = (ids, plan, reports) => resumePoint(ids, k, {
              plan: structuredClone(plan),
              remaining: [{ ...remainingOf(action), resumeId: actId, planReports: [...reports] }, ...toRun.slice(k + 1).map(remainingOf)],
            });
            const out = await this.runPlan(action, signal, stepPoint);
            sourcesRead++;
            this.emit('event', { type: 'action_end', id: actId, ok: out.ok, output: out.text, meta: { tasks: this.taskPlan?.tasks.length ?? 0 } });
            results.push(out.result);
            continue;
          }
          const r = await executeAction(action, {
            cwd: this.cwd,
            config,
            signal,
            maxResultChars: this.maxResultChars,
            seenFiles,
            shared: this.shared,
            readVersions: this.readVersions,
            virtualFiles: this.virtualFiles,
            onOutput: (t) => this.emit('event', { type: 'action_output', id: actId, text: t }),
          });
          this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.output, diff: r.diff, meta: r.meta });
          if (signal.aborted) throw stopped(); // the action was interrupted: keep it as the resume point
          if (action.tool === 'write' && r.changed) seenFiles.add(r.changed);
          if (r.ok && SOURCE_TOOLS.has(action.tool)) sourcesRead++;
          received.push({ tool: action.tool, ok: r.ok, output: r.output });

          if (r.changed) {
            changedThisTurn = true;
            if (needsRun(r.changed)) { this.untested = true; codeChangedThisTurn = true; }
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
        // The assessment recalled while its route is not satisfied (it is at the start of
        // the turn, far up once results pile up).
        // Outside information (web, commands) may settle a doubt or raise one: the assessment
        // is updated, about the current task only (see triage.js). Otherwise, what is
        // still to check is recalled.
        const update = triage && needsUpdate(received, triageUpdates);
        const reminder = triage && !update ? triageReminder(triage, sourcesRead - triageBase) : '';
        if (reminder) content += `\n${reminder}`;
        this.messages.push({ role: 'user', content });
        if (update) {
          triageUpdates++;
          this.emit('event', { type: 'triage_start', update: true });
          const t = await this.assess(system, signal, triageUpdateInstruction(this.currentTask));
          if (t) {
            triage = t;
            triageBase = sourcesRead;
            triageRefusals = 0;
            this.messages[this.messages.length - 1].content += `\n\n${triageBlock(t, { update: true, web: received.some((x) => x.ok && (x.tool === 'web_search' || x.tool === 'fetch')) })}`;
          }
          this.emit('event', t ? { type: 'triage', update: true, ...t } : { type: 'triage', update: true, failed: true });
        }
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
