// What changed inside a line of a diff: its words, so that a long paragraph shows the
// few words an edit touched, not only that the whole line changed.

/** A piece of a line, and whether it changed. */
export type Piece = [text: string, changed: boolean];

const MAX_CELLS = 2_000_000; // (beyond, the lines are marked whole: the table would be too big)

const tokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

/** Pieces in order, neighbours of the same kind joined; a space between two changes is one with them. */
function pieces(toks: string[], changed: boolean[]): Piece[] {
  const out: Piece[] = [];
  toks.forEach((t, i) => {
    const c = changed[i] || (/^\s+$/.test(t) && changed[i - 1] === true && changed[i + 1] === true);
    const last = out.at(-1);
    if (last && last[1] === c) last[0] += t;
    else out.push([t, c]);
  });
  return out;
}

/**
 * The words of `before` gone and of `after` new (the longest common sequence of words
 * stays). Null when the lines share too little for the marks to help.
 */
export function wordDiff(before: string, after: string): { before: Piece[]; after: Piece[] } | null {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // (lengths of the common sequences of the middle parts, from their ends)
  const w = m + 1;
  const table = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const goneA = a.map((_, k) => k >= start && k < endA);
  const newB = b.map((_, k) => k >= start && k < endB);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[start + i] === b[start + j]) { goneA[start + i] = false; newB[start + j] = false; i++; j++; }
    else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
    else j++;
  }
  const kept = a.reduce((sum, t, k) => sum + (goneA[k] ? 0 : t.trim().length), 0);
  const total = Math.max(before.replace(/\s/g, '').length, after.replace(/\s/g, '').length);
  if (total && kept / total < 0.3) return null; // (rewritten: nothing to point at)
  return { before: pieces(a, goneA), after: pieces(b, newB) };
}
