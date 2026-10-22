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
