// Context window bookkeeping and compaction helpers (pure functions, no I/O).
//
// Strategy: let the history grow untouched for as long as the next call still
// fits in the window (with room for an answer and a safety margin), then replace
// the oldest part with one summary message so it drops to about KEEP_RECENT of
// the budget. Compacting rarely but a lot keeps the prompt prefix stable between
// compactions, so the model server can reuse its KV cache instead of re-reading
// the whole prompt at every step (which is slow on local hardware).
import { parseActions, stripReasoning } from './protocol.js';

export const KEEP_RECENT = 0.5; // fraction of the budget kept verbatim (most recent messages)
export const MIN_OUTPUT = 2048; // answer room guaranteed before compacting (capped by maxTokens and numCtx/4)
/** Answer room for the summary: generous, because reasoning models think before writing it. */
export function summaryTokens(numCtx) {
  return Math.min(3000, Math.max(600, Math.floor(numCtx / 5)));
}
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
      for (const a of parseActions(stripReasoning(m.content)).actions) {
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
      c = stripReasoning(c);
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

/**
 * Length of the summary, in words: about 4% of the window (a 200-word cap made it
 * too thin to go on with, above all in a conversation rather than a task).
 */
export function summaryWords(numCtx = 16384) {
  return Math.max(250, Math.min(900, Math.round(numCtx * 0.03)));
}

// Headings that suit a task as well as a conversation.
const SUMMARY_FORMAT = (words) => `at most ${words} words, under exactly these headings:
Context: who the user is and what this conversation is about (their goals, preferences, constraints).
Discussion: the main points in order: what the user said and asked, what was answered, explained or decided, and why. Keep the specifics: names, numbers, dates, versions, the user's exact wording when it matters.
Work done: files changed, commands run and their results, what works, what fails (exact errors). "None" if there was no work.
Open: questions not settled, what the user expects next.
Then a last line: "Chapter: " followed by the topics of this part in a few words, " — ", and 5 to 8 keywords (names, tools, files).
Write facts, not commentary. Never invent anything. An earlier summary in the conversation must be carried over, not dropped.`;

/**
 * Messages for the summarizer. The instruction comes AFTER the conversation:
 * small models tend to continue a transcript instead of following an
 * instruction placed before it.
 */
export function buildSummaryRequest(messages, maxChars, { retry = false, words = summaryWords() } = {}) {
  return [
    { role: 'system', content: `You summarize a conversation between a user and an assistant (which may use tools on files), so that it can go on with a fresh memory. Write ${SUMMARY_FORMAT(words)}` },
    {
      role: 'user',
      content: `<conversation>\n${renderTranscript(messages, maxChars)}\n</conversation>\n\n` +
        'Now write the summary of the conversation above, with the 4 headings Context:, Discussion:, Work done:, Open:, then the Chapter: line. ' +
        'Do not copy the conversation and do not write any tool tag.' +
        (retry ? ' Write the summary directly, without long reasoning.' : ''),
    },
  ];
}

export const SUMMARY_INLINE_INSTRUCTION = 'PAUSE THE TASK: do not use any tool now. ' +
  'Write only a summary of the whole conversation so far, so that it can go on with a fresh memory: ';
const inlineInstruction = (words) => `${SUMMARY_INLINE_INSTRUCTION}${SUMMARY_FORMAT(words)}`;

/**
 * Summary request that reuses the server's prompt cache: the exact prompt of the
 * conversation (already read by the server) plus the instruction at the end.
 * Reading a whole new transcript instead can take minutes on local hardware.
 * The instruction is appended to the last user message when there is one, to
 * keep roles alternating (some chat templates, e.g. Gemma's, require it).
 */
export function buildInlineSummaryRequest(prompt, { words = summaryWords() } = {}) {
  const msgs = prompt.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  if (last.role === 'user') last.content = `${last.content}\n\n${inlineInstruction(words)}`;
  else msgs.push({ role: 'user', content: inlineInstruction(words) });
  return msgs;
}

// Headings in English or French (small models often answer in the user's language),
// current ones and those of older versions.
const SUMMARY_HEADINGS = [
  /context|contexte|goal|objecti|but\s*:/i,
  /discussion|échanges|done so far|déjà fait|fait jusqu|accompli/i,
  /work done|travail|réalisé|current state|état actuel|etat actuel|situation/i,
  /open|en suspens|ouvert|questions|next step|prochaine|étape suivante|à faire/i,
];

/** Returns {summary} when usable, else {summary: null, reason} (reason in French, shown in the UI). */
export function cleanSummary(text, { maxChars = 8000 } = {}) {
  let t = (text || '').replace(/<(think|reasoning)>[\s\S]*?<\/\1>/g, '').trim();
  t = t.replace(/^```\w*\n?|\n?```$/g, '').trim();
  if (!t) return { summary: null, reason: 'réponse vide' };
  const toolTags = (t.match(/<(read|write|edit|run|list|search|web_search|fetch)\b[^>]*>/g) || []).length;
  if (/<result\b|^### (USER|ASSISTANT)/m.test(t) || toolTags > 2) {
    return { summary: null, reason: 'le modèle a recopié la conversation au lieu de la résumer' };
  }
  if (SUMMARY_HEADINGS.filter((h) => h.test(t)).length < 2) {
    return { summary: null, reason: 'format non respecté (rubriques manquantes)' };
  }
  return { summary: t.length > maxChars ? `${t.slice(0, maxChars)}…` : t };
}

const HARNESS_PREFIXES = ['You showed code', 'You changed files', 'Your reply was empty', 'Your message was cut', '(stopped', '(earlier conversation'];

/**
 * Backup summary when the model cannot write one: the user's requests, the
 * previous summary if any, and the assistant's last notes. No model involved.
 */
export function mechanicalSummary(messages) {
  const parts = ['(The automatic summary failed. Notes extracted from the conversation:)'];
  const prev = messages.find((m) => m.content.startsWith(SUMMARY_MARKER));
  if (prev) {
    const body = prev.content.split('\n').slice(1).join('\n').split(/\n(?:Files changed:|Last commands:|\[CURRENT TASK\]|MEMORY \(|CURRENT PLAN:|Continue (?:the task )?from here)/)[0].trim();
    if (body) parts.push(`Earlier summary:\n${body.slice(0, 1500)}`);
  }
  const requests = messages
    .filter((m) => m.role === 'user' && !m.content.includes('<result') && !m.content.startsWith(SUMMARY_MARKER) && !HARNESS_PREFIXES.some((p) => m.content.startsWith(p)))
    .map((m) => `- ${m.content.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
  if (requests.length) parts.push(`User requests:\n${requests.slice(-5).join('\n')}`);
  const notes = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => parseActions(stripReasoning(m.content)).text.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 20)
    .slice(-3)
    .map((t) => `- ${t.slice(0, 400)}`);
  if (notes.length) parts.push(`Last notes from the assistant:\n${notes.join('\n')}`);
  return parts.join('\n\n');
}

/** The "Chapter:" line of a summary, taken out of it: { summary, chapter }. */
export function splitChapter(summary) {
  let chapter = '';
  const rest = String(summary || '').replace(/^\W{0,4}(?:chapter|chapitre)\W{0,4}\s*:\s*(.+)$/gim, (_, c) => { chapter = c.replace(/[*_`]+/g, '').trim(); return ''; });
  return { summary: rest.trim(), chapter };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19 10:00–12:30" from the stamps of the user messages of a part ('' without stamps). */
export function chapterDates(messages) {
  const stamps = messages
    .map((m) => m.role === 'user' && m.content.match(/^\[\w{3} (\d{4})-(\d\d)-(\d\d) (\d\d:\d\d)\]/))
    .filter(Boolean)
    .map(([, y, mo, d, t]) => ({ day: `${MONTHS[+mo - 1]} ${+d}`, t, key: `${y}${mo}${d}` }));
  if (!stamps.length) return '';
  const a = stamps[0];
  const b = stamps[stamps.length - 1];
  return a.key === b.key ? `${a.day} ${a.t}–${b.t}` : `${a.day} ${a.t}–${b.day} ${b.t}`;
}

/** Index lines, at most `max` (the oldest ones merged). */
export function capChapters(chapters, max = 15) {
  const out = [...chapters];
  while (out.length > max) out.splice(0, 2, `${out[0]} / ${out[1]}`.slice(0, 240));
  return out;
}

export function buildSummaryMessage({ summary, facts, task, chapters = [] }) {
  const parts = [`${SUMMARY_MARKER} — older messages were replaced by this summary]`];
  if (chapters.length) parts.push(`EARLIER CHAPTERS (out of view, search them with <recall>):\n${chapters.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  parts.push(summary.trim() || '(no summary)');
  if (facts) parts.push(facts);
  if (task) parts.push(`[CURRENT TASK]\n${task}`);
  parts.push('Continue from here. Re-read files if you need their exact content; find the details of older messages with <recall>.');
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
