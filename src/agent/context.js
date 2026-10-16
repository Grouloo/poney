// Context window bookkeeping and compaction helpers (pure functions, no I/O).
//
// Strategy: let the history grow untouched for as long as the next call still
// fits in the window (with room for an answer and a safety margin), then replace
// the oldest part with one summary message so it drops to about KEEP_RECENT of
// the budget. Compacting rarely but a lot keeps the prompt prefix stable between
// compactions, so the model server can reuse its KV cache instead of re-reading
// the whole prompt at every step (which is slow on local hardware).
import { parseActions } from './protocol.js';

export const KEEP_RECENT = 0.5; // fraction of the budget kept verbatim (most recent messages)
export const MIN_OUTPUT = 2048; // answer room guaranteed before compacting (capped by maxTokens and numCtx/4)
export const SUMMARY_MAX_TOKENS = 700;
export const SUMMARY_MARKER = '[CONTEXT SUMMARY';

export const DEFAULT_CHARS_PER_TOKEN = 3.2;

export function makeEstimator(charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return (s) => Math.ceil((s?.length || 0) / charsPerToken);
}

/**
 * How the window is shared. The history may grow up to `budget`; past that the
 * next call would not leave `minOutput` tokens for the answer plus a `margin`
 * for estimation errors (smaller once the estimate is calibrated on real counts).
 */
export function contextPlan(config, systemTokens, calibrated = false) {
  const margin = Math.max(256, Math.floor(config.numCtx * (calibrated ? 0.04 : 0.08)));
  const minOutput = Math.min(config.maxTokens, MIN_OUTPUT, Math.floor(config.numCtx / 4));
  const budget = config.numCtx - systemTokens - minOutput - margin;
  return { margin, minOutput, budget, keep: Math.floor(budget * KEEP_RECENT) };
}

/** Answer size for a prompt: as much as fits, between minOutput and maxTokens. */
export function answerTokens(config, plan, promptTokens) {
  const room = config.numCtx - promptTokens - plan.margin;
  return Math.max(plan.minOutput, Math.min(config.maxTokens, room));
}

export function historyTokens(messages, est) {
  return messages.reduce((n, m) => n + est(m.content) + 4, 0);
}

/**
 * Splits messages into the part to summarize and the recent part kept verbatim
 * (as many trailing messages as fit in keepTokens, at least 2).
 */
export function splitForCompaction(messages, keepTokens, est) {
  let i = messages.length;
  let used = 0;
  while (i > 0) {
    const t = est(messages[i - 1].content) + 4;
    if (messages.length - i >= 2 && used + t > keepTokens) break;
    used += t;
    i--;
  }
  return { old: messages.slice(0, i), recent: messages.slice(i) };
}

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

/**
 * Facts extracted mechanically (no model involved, so they are reliable even
 * when the summary is poor): files changed and the last commands with their exit code.
 */
export function extractFacts(messages) {
  const files = new Map();
  const commands = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const a of parseActions(m.content).actions) {
        const p = a.args.path?.trim();
        if (a.tool === 'write' && p) files.set(p, 'written');
        if (a.tool === 'edit' && p && files.get(p) !== 'written') files.set(p, 'edited');
      }
    } else if (m.content.startsWith(SUMMARY_MARKER)) {
      // Carry forward facts from a previous compaction.
      const line = m.content.match(/^Files changed: (.*)$/m);
      if (line) {
        for (const part of line[1].split(', ')) {
          const f = part.match(/^(.*) \((written|edited)\)$/);
          if (f && !files.has(f[1])) files.set(f[1], f[2]);
        }
      }
    } else {
      for (const tag of m.content.match(/<result tool="run"[^>]*>/g) || []) {
        const command = attr(tag, 'command');
        if (command) commands.push(`\`${command}\` -> exit ${attr(tag, 'exit') ?? '?'}`);
      }
    }
  }
  const lines = [];
  if (files.size) lines.push(`Files changed: ${[...files].map(([f, how]) => `${f} (${how})`).join(', ')}`);
  if (commands.length) lines.push(`Last commands: ${commands.slice(-5).join('; ')}`);
  return lines.join('\n');
}

/**
 * Files whose content is actually visible in the history: successfully read
 * (the result has a line range) or written by the model. Results removed by a
 * compaction no longer count, since the model can no longer see that content.
 */
export function filesInContext(messages) {
  const seen = new Set();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const re = /<result tool="(read|write)" path="([^"]*)"([^>]*)>\n([^\n]*)/g;
    let r;
    while ((r = re.exec(m.content))) {
      const [, tool, file, rest, firstLine] = r;
      if (tool === 'read' && / lines="/.test(rest)) seen.add(file);
      if (tool === 'write' && /^(Created|Overwrote) /.test(firstLine)) seen.add(file);
    }
  }
  return seen;
}

/** Renders messages as a compact transcript for the summarizer. */
export function renderTranscript(messages, maxChars) {
  const parts = messages.map((m) => {
    let c = m.content;
    if (m.role === 'assistant') {
      c = c.replace(/(<(write|edit)\b[^>]*>)([\s\S]*?)(<\/\2>)/g, (_, open, __, body, close) =>
        `${open}[${body.split('\n').length} lines]${close}`);
    } else {
      c = c.replace(/(<result[^>]*>\n)([\s\S]*?)(\n<\/result>)/g, (_, a, body, z) =>
        body.length > 600 ? `${a}${body.slice(0, 250)}\n[...]\n${body.slice(-250)}${z}` : `${a}${body}${z}`);
    }
    return `### ${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}\n${c}`;
  });
  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    // Keep the beginning (the goal) and favour the end (the current state).
    const head = Math.floor(maxChars * 0.25);
    text = `${text.slice(0, head)}\n\n[... middle of the conversation omitted ...]\n\n${text.slice(-(maxChars - head))}`;
  }
  return text;
}

export const SUMMARY_SYSTEM_PROMPT = `You summarize a coding session so that the work can continue with a fresh memory.
Write at most 200 words, as short bullet points under exactly these headings:
Goal:
Done so far:
Current state: (what works, what fails, exact error messages)
Next step:
Be concrete: file names, function names, commands. Never invent anything.`;

/**
 * Messages for the summarizer. The instruction comes AFTER the conversation:
 * small models tend to continue a transcript instead of following an
 * instruction placed before it.
 */
export function buildSummaryRequest(messages, maxChars) {
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `<conversation>\n${renderTranscript(messages, maxChars)}\n</conversation>\n\n` +
        'Now write the summary of the conversation above, with the 4 headings Goal:, Done so far:, Current state:, Next step:. ' +
        'Do not copy the conversation and do not write any tool tag.',
    },
  ];
}

/** Returns a usable summary, or null if the model copied the transcript or ignored the format. */
export function cleanSummary(text) {
  let t = (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  t = t.replace(/^```\w*\n?|\n?```$/g, '').trim();
  if (!t) return null;
  if (/<(result|read|write|edit|run|list|search|web_search|fetch)\b|^### (USER|ASSISTANT)/m.test(t)) return null;
  if (!/goal/i.test(t) || !/next step/i.test(t)) return null;
  return t.length > 3000 ? `${t.slice(0, 3000)}…` : t;
}

export function buildSummaryMessage({ summary, facts, task }) {
  const parts = [`${SUMMARY_MARKER} — older messages were replaced by this summary]`, summary.trim() || '(no summary)'];
  if (facts) parts.push(facts);
  if (task) parts.push(`[CURRENT TASK]\n${task}`);
  parts.push('Continue the task from here. Re-read files if you need their exact content.');
  return parts.join('\n\n');
}

/**
 * Updates the chars-per-token ratio from a real prompt token count.
 * Ignores samples that look reduced by the server's prompt cache.
 */
export function isValidSample(current, promptChars, promptTokens) {
  if (!promptTokens || promptChars < 2000) return false;
  if (promptTokens < 0.6 * (promptChars / current)) return false; // probably a cache-reduced count
  const ratio = promptChars / promptTokens;
  return ratio >= 1.8 && ratio <= 5;
}

export function calibrate(current, promptChars, promptTokens) {
  if (!isValidSample(current, promptChars, promptTokens)) return current;
  return current * 0.6 + (promptChars / promptTokens) * 0.4;
}
