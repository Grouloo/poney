// Search in a part of the window (⌘F): the places of a text, as ranges, case and accents ignored.

const folded = new Map<string, string>();
/** A character without its case and accents ("É" → "e"). */
function fold(c: string) {
  let f = folded.get(c);
  if (f === undefined) folded.set(c, f = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
  return f;
}

/** The ranges of root's visible text where query is (skip: a selector of parts not searched). */
export function findRanges(root: HTMLElement, query: string, skip = ''): Range[] {
  const q = [...query].map(fold).join('');
  if (!q.trim()) return [];
  let text = '';
  const at: [Text, number][] = []; // (for each character of text: its node and place there)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const el = n.parentElement;
      return !el || (skip && el.closest(skip)) || !el.getClientRects().length ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n instanceof Text)) continue;
    for (let i = 0; i < n.data.length; i++) {
      for (const c of fold(n.data[i])) {
        text += c;
        at.push([n, i]);
      }
    }
  }
  const ranges: Range[] = [];
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
    const [startNode, start] = at[i];
    const [endNode, end] = at[i + q.length - 1];
    const r = document.createRange();
    r.setStart(startNode, start);
    r.setEnd(endNode, end + 1);
    ranges.push(r);
  }
  return ranges;
}
