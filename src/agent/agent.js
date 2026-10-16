import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { streamChat } from './llm.js';
import { TOOLS, buildSystemPrompt, parseActions, splitThinking, formatResult } from './protocol.js';
import { executeAction, runShell, truncateMiddle } from './tools.js';

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
  testCommand: '',
  searxngUrl: '',
};

const PROJECT_NOTE_FILES = ['AGENTS.md', 'LOCAL_CODEX.md', 'CLAUDE.md'];
const estimateTokens = (s) => Math.ceil(s.length / 3.2);
let nextId = 1;

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
  }

  get maxResultChars() {
    return Math.max(2000, Math.floor(this.config.numCtx * 3.2 * 0.2));
  }

  reset() {
    this.stop();
    this.messages = [];
    this.untested = false;
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
    const msgs = this.messages.map((m) => ({ ...m }));
    const reserve = Math.min(this.config.maxTokens, Math.floor(this.config.numCtx / 3));
    const budget = this.config.numCtx - reserve - estimateTokens(system) - 200;
    const total = () => msgs.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
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
    try {
      for await (const chunk of streamChat({
        ...this.config,
        messages: this.buildPrompt(system),
        signal: ctrl.signal,
      })) {
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
    this.messages.push({ role: 'user', content: userText });
    this.emit('event', { type: 'turn_start' });

    const system = buildSystemPrompt({
      cwd: this.cwd,
      platform: `${os.platform()} ${os.arch()}`,
      projectNotes: await this.loadProjectNotes(),
      testCommand: config.testCommand,
    });

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
            this.messages.push({ role: 'user', content: 'You showed code in your message but did not save it. Save it with <write path="...">...</write>, then test it with <run>.' });
            continue;
          }

          // Test gate 1: project test command must pass.
          if (config.testCommand && changedThisTurn) {
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
          } else if (this.untested && gateNudges < 2) {
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
        for (const action of toRun) {
          if (stopBatch) break;
          const actId = nextId++;
          this.emit('event', { type: 'action_start', id: actId, tool: action.tool, args: action.args });
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
            onOutput: (t) => this.emit('event', { type: 'action_output', id: actId, text: t }),
          });
          this.emit('event', { type: 'action_end', id: actId, ok: r.ok, output: r.output, diff: r.diff, meta: r.meta });

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
      this.emit('event', { type: 'turn_end', reason });
    }
  }
}
