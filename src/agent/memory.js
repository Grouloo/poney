// The agent's memory for one conversation: short notes it keeps with
// <remember> and drops with <forget>, so that what matters (goals, decisions,
// the user's preferences and constraints) is not lost to compaction and stays
// in view as the conversation gets long. Bounded, since it takes context room.

export const MEMORY_MAX_NOTES = 20;
export const MEMORY_NOTE_MAX_CHARS = 200;
export const MEMORY_MAX_CHARS = 2000;

/** The notes as the model sees them: "1. …" per line. */
export function formatMemory(notes) {
  return notes.map((n, i) => `${i + 1}. ${n}`).join('\n');
}

/**
 * Adds a note. Returns { notes, text } (text: the result for the model), the
 * notes unchanged when it is refused (empty, duplicate, full).
 */
export function remember(notes, raw) {
  const note = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!note) return { notes, ok: false, text: 'Empty note: write the fact between <remember> and </remember>.' };
  if (note.length > MEMORY_NOTE_MAX_CHARS) {
    return { notes, ok: false, text: `Note too long (${note.length} characters, ${MEMORY_NOTE_MAX_CHARS} at most): keep only the essential, in one sentence.` };
  }
  if (notes.some((n) => n.toLowerCase() === note.toLowerCase())) return { notes, ok: true, text: `Already in memory.\nMEMORY:\n${formatMemory(notes)}` };
  const total = notes.reduce((s, n) => s + n.length, 0) + note.length;
  if (notes.length >= MEMORY_MAX_NOTES || total > MEMORY_MAX_CHARS) {
    return { notes, ok: false, text: `Memory full: <forget> a note that is no longer useful first (by its number).\nMEMORY:\n${formatMemory(notes)}` };
  }
  const next = [...notes, note];
  return { notes: next, ok: true, text: `Noted (#${next.length}).\nMEMORY:\n${formatMemory(next)}` };
}

/** Removes a note by its number ("2", "#2") or its exact text. */
export function forget(notes, raw) {
  const arg = String(raw ?? '').trim();
  const n = Number(arg.replace(/^#/, ''));
  const i = Number.isInteger(n) && n >= 1 ? n - 1 : notes.findIndex((x) => x.toLowerCase() === arg.toLowerCase());
  if (i < 0 || i >= notes.length) {
    return { notes, ok: false, text: `No note ${arg || '(empty)'}: give its number, like <forget>2</forget>.\nMEMORY:\n${formatMemory(notes)}` };
  }
  const next = notes.filter((_, k) => k !== i);
  return { notes: next, ok: true, text: `Forgotten. ${next.length ? `MEMORY:\n${formatMemory(next)}` : 'Memory is empty.'}` };
}

/** The memory recalled in a message or a compaction summary. */
export const memoryBlock = (notes) => (notes.length ? `MEMORY (your notes for this conversation, kept with <remember>):\n${formatMemory(notes)}` : '');

// ---------- lasting instructions given by the user ----------

// Sentences that set a rule for the rest of the conversation (French and English):
// small models rarely note them on their own, and drift back to their defaults.
// (word boundaries that know accented letters: \b does not, "À partir" never matched)
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const re = (src) => new RegExp(src.replaceAll('<', B).replaceAll('>', E), 'iu');
const STANDING = [
  re("<(?:à partir de maintenant|désormais|dorénavant|à l'avenir|à l’avenir|from now on|going forward|in (?:the )?future)>"),
  re("<(?:retiens|souviens[- ]toi|n'oublie pas|n’oublie pas|garde en t[eê]te|note bien|remember that|keep in mind|don't forget|do not forget)>"),
  re("<(?:tutoie|vouvoie|appelle[- ]moi|call me|je m'appelle|je m’appelle|my name is)>"),
  re("<(?:réponds|répond|répondez|parle|parlez|écris|écrivez|answer|respond|reply|talk|write)>[^.!?\\n]{0,40}<(?:toujours|jamais|uniquement|seulement|en (?:anglais|français|espagnol|allemand|italien)|always|never|only|in (?:english|french|spanish|german))>"),
  re("<(?:toujours|jamais|always|never)>[^.!?\\n]{0,30}<(?:répon|écri|utilis|parl|answer|respond|reply|use|write|talk)"),
  re("<(?:sois|soyez|be)\\s+(?:plus\\s+|more\\s+|less\\s+|moins\\s+)?(?:bref|brève|concis|concise|direct|directe|formel|formelle|informel|informelle|brief|concise|direct|formal|informal|casual|terse)>"),
  re("<(?:je veux que tu|je voudrais que tu|j'aimerais que tu|j’aimerais que tu|je préfère que tu|i want you to|i'd like you to|please always|please never)>"),
];

/** Sentences of a user message that look like lasting instructions (at most 2, each ≤ 200 characters). */
export function standingInstructions(text) {
  const clean = String(text ?? '').replace(/^\[[^\]]+\]\s*/, '').replace(/^>.*$/gm, ''); // (not the stamp, not quotes)
  const out = [];
  for (const raw of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 8 || /\?$/.test(s) || !STANDING.some((re) => re.test(s))) continue;
    out.push(s.length > 180 ? `${s.slice(0, 179)}…` : s);
    if (out.length >= 2) break;
  }
  return out;
}

/** The note kept for an instruction: the user's own words. */
export const instructionNote = (sentence) => `The user asked: « ${sentence} »`;

const words = (s) => new Set(s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));

/**
 * The note the app took for an instruction that the model now notes in its own
 * words (most of its words in common): replaced, not kept twice. -1 if none.
 */
export function replacedAutoNote(notes, note) {
  const mine = words(note);
  if (!mine.size) return -1;
  return notes.findIndex((n) => {
    if (!n.startsWith('The user asked: «')) return false;
    const theirs = words(n.replace(/^The user asked: « | »$/g, ''));
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return shared >= 2 && shared >= 0.5 * Math.min(mine.size, theirs.size);
  });
}
