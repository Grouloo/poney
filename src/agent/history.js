// <recall>: search the part of the conversation that is no longer in the
// context (replaced by compaction summaries, kept in the archives) and bring
// back excerpts of the matching messages.
import { stripReasoning } from './protocol.js';
import { SUMMARY_MARKER } from './context.js';

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'les', 'des', 'une', 'pour', 'avec', 'dans', 'que', 'qui', 'est', 'sur', 'pas', 'par']);

/** Search terms: quoted phrases kept whole, other words of 3 letters or more. */
export function searchTerms(query) {
  const terms = [];
  const rest = String(query ?? '').replace(/"([^"]+)"/g, (_, p) => { terms.push(fold(p.trim())); return ' '; });
  for (const w of fold(rest).split(/[^\p{L}\p{N}_.-]+/u)) if (w.length >= 3 && !STOP.has(w)) terms.push(w);
  return [...new Set(terms)].filter(Boolean);
}

/**
 * Messages of the archives that are no longer in the current history, oldest
 * first, each once: [{ n, role, text }] (n: its position in the conversation).
 */
export function outOfContext(archives, current) {
  const inView = new Set(current.map((m) => m.content));
  const seen = new Set();
  const out = [];
  for (const list of archives || []) {
    for (const m of list || []) {
      if (!m || seen.has(m.content) || inView.has(m.content) || m.content.startsWith(SUMMARY_MARKER)) continue;
      seen.add(m.content);
      const text = m.role === 'assistant' ? stripReasoning(m.content) : m.content;
      if (text.trim()) out.push({ n: out.length + 1, role: m.role, text });
    }
  }
  return out;
}

/** Excerpts around the first matches of a message (±radius characters, at most two). */
function excerpts(text, terms, radius) {
  const low = fold(text);
  const spots = [];
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0) spots.push(i);
  }
  spots.sort((a, b) => a - b);
  const windows = [];
  for (const i of spots) {
    const start = Math.max(0, i - radius);
    const end = Math.min(text.length, i + radius);
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
    if (windows.length >= 2) break;
  }
  return windows.map(({ start, end }) => `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`).join(' ');
}

/** The result of <recall>: the best matching messages (in conversation order), as excerpts. */
export function recall(archives, current, query, { maxChars = 3000, maxMessages = 6 } = {}) {
  const terms = searchTerms(query);
  if (!terms.length) return { ok: false, text: 'Give keywords to search for, like <recall>database migration</recall>.' };
  const pool = outOfContext(archives, current);
  if (!pool.length) return { ok: true, text: 'Nothing is out of context yet: the whole conversation is still in view.' };
  const scored = pool.map((m) => {
    const low = fold(m.text);
    let hits = 0;
    let count = 0;
    for (const t of terms) {
      const k = low.split(t).length - 1;
      if (k) { hits++; count += k; }
    }
    return { m, score: hits * 10 + Math.min(count, 10) };
  }).filter((x) => x.score > 0);
  if (!scored.length) return { ok: true, text: `No earlier message matches: ${terms.join(', ')}. Try other words.` };
  const best = scored.sort((a, b) => b.score - a.score).slice(0, maxMessages).map((x) => x.m).sort((a, b) => a.n - b.n);
  const radius = Math.max(120, Math.floor(maxChars / best.length / 3));
  let out = `${best.length} earlier message(s) out of ${pool.length} match:`;
  for (const m of best) {
    const piece = `\n[message ${m.n}, ${m.role === 'assistant' ? 'you' : 'user'}] ${excerpts(m.text, terms, radius)}`;
    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  return { ok: true, text: out };
}
