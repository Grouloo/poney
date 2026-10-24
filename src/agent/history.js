// <recall>: search the part of the conversation that is no longer in the
// context (replaced by compaction summaries, kept in the archives) and bring
// back excerpts of the matching messages.
import { stripReasoning, parseActions } from './protocol.js';
import { SUMMARY_MARKER } from './context.js';

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'les', 'des', 'une', 'pour', 'avec', 'dans', 'que', 'qui', 'est', 'sur', 'pas', 'par',
  // words of the tool protocol, everywhere in a history
  'path', 'tool', 'result', 'read', 'write', 'edit', 'list', 'search', 'fetch', 'recall', 'remember', 'forget', 'plan', 'agent', 'lines', 'exit', 'command', 'created']);

/** A word's root, so that "déploie" finds "déploiement" (phrases are kept whole). */
const stem = (t) => (t.includes(' ') || t.length < 6 ? t : t.slice(0, Math.max(5, t.length - 2)));

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
  const terms = [...new Set(searchTerms(query).map(stem))];
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

// ---------- automatic recall ----------

/**
 * Passages of the out-of-context history that the user's new message refers to,
 * attached to it so the model does not have to think of searching (small models
 * rarely do, and make the rest up). The message's most distinctive words (the
 * rarest in the whole conversation) are looked for; a passage counts when it has
 * several of them, or one very rare one. A passage is skipped when the same words
 * are together in a message still in view (the information is there), or when it
 * was already attached. Returns [{ n, role, excerpt }] (at most `max`).
 */
const MIN_SHARE = 0.45;

export function autoRecall(archives, current, userText, { max = 2, maxChars = 1000, distinctive = 8 } = {}) {
  // What was said (the user's messages, the assistant's prose), not tool outputs: they
  // are most of the archive and match almost anything. (<recall> searches everything.)
  const pool = outOfContext(archives, current)
    .filter((m) => !m.text.includes('<result'))
    .map((m) => ({ ...m, text: m.role === 'assistant' ? parseActions(m.text).text : m.text.replace(/^\[[^\]]*\d{4}-\d\d-\d\d[^\]]*\]\s*/, '') }))
    .filter((m) => m.text.trim().length >= 20);
  const terms = [...new Set(searchTerms(userText).map(stem))];
  if (!pool.length || !terms.length) return [];
  const folded = pool.map((m) => fold(m.text));
  const view = current.map((m) => fold(m.content));
  const N = pool.length + view.length;
  // Rarity over the whole conversation (in view and out of it).
  const rare = terms
    .map((t) => {
      const dfPool = folded.filter((f) => f.includes(t)).length;
      const df = dfPool + view.filter((f) => f.includes(t)).length;
      return { t, dfPool, df, idf: Math.log((N + 1) / (df + 1)) };
    })
    .filter((x) => x.dfPool > 0 && x.t.length >= 4)
    .sort((a, b) => b.idf - a.idf)
    .slice(0, distinctive);
  if (!rare.length) return [];
  const veryRare = (x) => x.df <= 2 && x.t.length >= 5;
  const total = rare.reduce((s, x) => s + x.idf, 0);
  const scored = [];
  pool.forEach((m, i) => {
    const hit = rare.filter((x) => folded[i].includes(x.t));
    if (!(hit.length >= 2 || hit.some(veryRare))) return;
    // Already in view: a visible message has these words together.
    if (hit.length >= 2 && view.some((v) => hit.every((x) => v.includes(x.t)))) return;
    const score = hit.reduce((s, x) => s + x.idf, 0);
    // (a good share of the message's distinctive words, or a very rare one)
    if (score < MIN_SHARE * total && !hit.some(veryRare)) return;
    scored.push({ m, hit, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const radius = Math.floor(maxChars / max / 2) - 10;
  const inView = view.join('\n');
  for (const { m, hit } of scored) {
    const excerpt = excerpts(m.text, hit.map((x) => x.t), radius);
    if (!excerpt || inView.includes(fold(excerpt.replace(/^…|…$/g, '').slice(0, 80)))) continue; // already attached
    out.push({ n: m.n, role: m.role, excerpt });
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The passages as attached to the user's message. */
export const recalledBlock = (passages) => (passages.length
  ? `(From earlier in this conversation, maybe relevant:\n${passages.map((p) => `[message ${p.n}, ${p.role === 'assistant' ? 'you' : 'user'}] ${p.excerpt}`).join('\n')})`
  : '');

// ---------- chapter index ----------

/** The most distinctive words of some messages (frequent there, not everywhere). */
export function keywordsOf(messages, { count = 6, exclude = '' } = {}) {
  const ex = fold(exclude);
  const freq = new Map();
  for (const m of messages) {
    const text = (m.role === 'assistant' ? stripReasoning(m.content) : m.content).replace(/<result[^>]*>[\s\S]*?<\/result>/g, ' ');
    for (const w of new Set(searchTerms(text).filter((t) => !t.includes(' ') && t.length >= 4 && !/^\d+$/.test(t)))) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq].filter(([w, n]) => n >= 1 && !ex.includes(w)).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, count).map(([w]) => w);
}
