import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamChat, complete } from './llm.js';
import { TOOLS, buildSystemPrompt, parseActions, splitThinking, formatResult, isToolEnabled } from './protocol.js';
import { executeAction, runShell, truncateMiddle } from './tools.js';
import {
  COMPACT_AT, KEEP_RECENT, SUMMARY_MAX_TOKENS, DEFAULT_CHARS_PER_TOKEN,
  makeEstimator, historyBudget, historyTokens, splitForCompaction, extractFacts, buildSummaryRequest, cleanSummary,
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
  testCommand: '',
  searxngUrl: '',
};

const PROJECT_NOTE_FILES = ['AGENTS.md', 'LOCAL_CODEX.md', 'CLAUDE.md'];
/** The user request carried by a message (unwraps a compaction summary). */
function taskFromMessage(content) {
  if (!content.startsWith(SUMMARY_MARKER)) return content;
  const m = content.match(/\[CURRENT TASK\]\n([\s\S]*?)\n\nContinue the task from here\./);
  return m ? m[1] : null;
}

let nextId = Date.now(); // unique across restarts, since saved conversations are replayed by id

export class Agent extends EventEmitter {
  constructor({ cwd, config, approve }) {
    super();
    this.cwd = cwd;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.approve = approve || (async () => true);
    this.messages = [];
    this.untested = false; // files changed since the last successful command
    this.running = false;
    this.abort = null;
    this.systemPrompt = null; // custom prompt for this conversation; null = generated default
    this.charsPerToken = DEFAULT_CHARS_PER_TOKEN; // calibrated from real token counts
    this.calibratedFor = null;
    this.lastUsage = null; // last token counts reported by the server
  }

  /** Token estimator for the current model (calibration is reset when the model changes). */
  get est() {
    if (this.calibratedFor !== this.config.model) {
      this.calibratedFor = this.config.model;
      this.charsPerToken = DEFAULT_CHARS_PER_TOKEN;
    }
    return makeEstimator(this.charsPerToken);
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
    });
  }

  get maxResultChars() {
    return Math.max(2000, Math.floor(this.config.numCtx * 3.2 * 0.2));
  }

  reset() {
    this.stop();
    this.messages = [];
    this.untested = false;
    this.systemPrompt = null;
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
  buildPrompt(system) {
    // Normally maybeCompact() keeps the history within budget; the passes below
    // are a safety net (e.g. a single huge message, or a failed compaction).
    const est = this.est;
    const msgs = this.messages.map((m) => ({ ...m }));
    const budget = historyBudget(this.config, est(system));
    const total = () => historyTokens(msgs, est);
    if (total() <= budget) return [{ role: 'system', content: system }, ...msgs];

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
    // Models expect alternating roles; merge consecutive same-role messages.
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ role: m.role, content: m.content });
    }
    if (merged[0]?.role === 'assistant') merged.unshift({ role: 'user', content: '(earlier conversation removed)' });
    return [{ role: 'system', content: system }, ...merged];
  }

  // ----- context gauge & compaction -----

  /** Current context usage, for the UI gauge. */
  async contextStats(system) {
    system ??= this.systemPrompt ?? await this.defaultSystemPrompt();
    const est = this.est;
    const systemTokens = est(system);
    const budget = historyBudget(this.config, systemTokens);
    return {
      type: 'context',
      used: systemTokens + historyTokens(this.messages, est),
      numCtx: this.config.numCtx,
      compactAt: systemTokens + Math.floor(budget * COMPACT_AT),
      limit: systemTokens + budget,
      measured: this.lastUsage ? this.lastUsage.promptTokens + this.lastUsage.outputTokens : null,
    };
  }

  async emitContext(system) {
    this.emit('event', await this.contextStats(system));
  }

  /**
   * Replaces the oldest messages with a summary when the history passes
   * COMPACT_AT of its budget (or always, with force). Returns a result object.
   */
  async maybeCompact(system, signal, { force = false } = {}) {
    const est = this.est;
    const budget = historyBudget(this.config, est(system));
    const before = historyTokens(this.messages, est);
    if (!force && before <= budget * COMPACT_AT) return { compacted: false };

    const { old, recent } = splitForCompaction(this.messages, Math.floor(budget * KEEP_RECENT), est);
    if (old.length < 2) return { compacted: false, reason: 'Pas assez de messages anciens à résumer.' };

    this.emit('event', { type: 'compaction_start' });
    const turnStart = this.turnStartIndex ?? this.messages.length;
    // The request of the current task, if it is about to be summarized. After a
    // previous compaction the first message is a summary: take the request it carries.
    const task = turnStart < old.length ? (this.currentTask ?? taskFromMessage(this.messages[turnStart].content)) : null;

    // The summarizer sees the old part only; leave room for its own answer.
    const maxChars = Math.max(4000, Math.floor((this.config.numCtx - SUMMARY_MAX_TOKENS - 600) * this.charsPerToken * 0.85));
    // Two attempts; if the model still copies the transcript or ignores the
    // format, keep only the mechanical facts (files changed, commands).
    let summary = null;
    for (let attempt = 0; attempt < 2 && !summary; attempt++) {
      try {
        const r = await complete({
          ...this.config,
          maxTokens: SUMMARY_MAX_TOKENS,
          temperature: attempt === 0 ? 0.1 : 0.4,
          signal,
          messages: buildSummaryRequest(old, maxChars),
        });
        summary = cleanSummary(r.text);
      } catch (e) {
        if (signal?.aborted) throw e;
        break;
      }
    }
    summary ??= '(automatic summary unavailable: see the facts below)';

    const content = buildSummaryMessage({ summary, facts: extractFacts(old), task });
    this.messages = [{ role: 'user', content }, ...recent];
    this.turnStartIndex = task ? 0 : turnStart - old.length + 1;
    const after = historyTokens(this.messages, est);
    this.emit('event', { type: 'compaction', before, after, removed: old.length, summary: content });
    await this.emitContext(system);
    return { compacted: true, before, after };
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

  // ----- generation -----

  async generate(system, signal) {
    const id = nextId++;
    this.emit('event', { type: 'assistant_start', id });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort);
    let text = '';
    let thinking = '';
    let cutAt = -1;
    const prompt = this.buildPrompt(system);
    const promptChars = prompt.reduce((n, m) => n + m.content.length, 0);
    try {
      for await (const chunk of streamChat({
        ...this.config,
        messages: prompt,
        signal: ctrl.signal,
      })) {
        if (chunk.type === 'usage') {
          this.lastUsage = chunk;
          this.charsPerToken = calibrate(this.charsPerToken, promptChars, chunk.promptTokens);
          continue;
        }
        if (chunk.type === 'thinking') {
          thinking += chunk.text;
          this.emit('event', { type: 'delta', id, kind: 'thinking', text: chunk.text });
          continue;
        }
        text += chunk.text;
        this.emit('event', { type: 'delta', id, kind: 'text', text: chunk.text });
        // Stop early once the model has asked for something it needs to see the
        // result of, or starts inventing a result. Saves time on slow hardware
        // and prevents hallucinated follow-up actions.
        const visible = splitThinking(text).text;
        const fake = visible.search(/<result\b|^\s*(User|Human):/m);
        if (fake >= 0) { cutAt = fake; break; }
        const { actions } = parseActions(visible, { final: false });
        const obs = actions.find((a) => a.complete && TOOLS[a.tool].observes);
        if (obs) { cutAt = obs.end; break; }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (e.name !== 'AbortError') throw e;
    } finally {
      ctrl.abort();
      signal.removeEventListener('abort', onAbort);
    }
    const split = splitThinking(text);
    let visible = split.text;
    if (cutAt >= 0) visible = visible.slice(0, cutAt);
    thinking += split.thinking;
    return { id, text: visible, thinking };
  }

  // ----- main loop -----

  async send(userText) {
    if (this.running) throw new Error('Agent is already running.');
    this.running = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    const config = this.config;
    this.turnStartIndex = this.messages.length;
    this.currentTask = userText;
    this.messages.push({ role: 'user', content: userText });
    this.emit('event', { type: 'turn_start' });

    const system = this.systemPrompt ?? await this.defaultSystemPrompt();
    const shellOn = config.shellEnabled !== false;

    let changedThisTurn = false;
    let gateNudges = 0;
    let testFailures = 0;
    let emptyReplies = 0;
    let codeDumpNudged = false;
    const recent = [];
    let reason = 'done';

    const notice = (text) => this.emit('event', { type: 'notice', text });

    try {
      for (let step = 0; ; step++) {
        if (step >= config.maxSteps) {
          reason = 'max_steps';
          notice(`Limite de ${config.maxSteps} étapes atteinte. Envoyez "continue" pour poursuivre.`);
          break;
        }
        const c = await this.maybeCompact(system, signal);
        if (!c.compacted) await this.emitContext(system);
        const gen = await this.generate(system, signal);
        const { actions, text: prose } = parseActions(gen.text);
        this.emit('event', { type: 'assistant_end', id: gen.id, text: prose, thinking: gen.thinking, hasActions: actions.length > 0 });

        // ---------- no action: the model thinks it's done ----------
        if (!actions.length) {
          if (!gen.text.trim()) {
            if (++emptyReplies > 2) { reason = 'empty'; notice('Le modèle ne répond plus.'); break; }
            this.messages.push({ role: 'assistant', content: '(empty)' });
            this.messages.push({ role: 'user', content: 'Your reply was empty. Continue the task using a tool tag, or give your final summary.' });
            continue;
          }
          this.messages.push({ role: 'assistant', content: gen.text });

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
        const toRun = [];
        for (const a of actions) {
          toRun.push(a);
          if (TOOLS[a.tool].observes) break;
        }
        const last = toRun[toRun.length - 1];
        this.messages.push({ role: 'assistant', content: gen.text.slice(0, last.end).trim() });

        const results = [];
        let stopBatch = false;
        // Files the model can see the content of (the current message has no results yet).
        const seenFiles = filesInContext(this.messages);
        for (const action of toRun) {
          if (stopBatch) break;
          const actId = nextId++;
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
            onOutput: (t) => this.emit('event', { type: 'action_output', id: actId, text: t }),
          });
          this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.output, diff: r.diff, meta: r.meta });
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
      this.emit('event', { type: 'turn_end', reason });
    }
  }
}
