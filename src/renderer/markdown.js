// Markdown of the agent's answers and of documents: GitHub Markdown (marked:
// emphasis, quotes, numbered and nested lists, tables, links…) plus LaTeX
// formulas (KaTeX). In answers, raw HTML is shown as text (the model's words,
// not a page); documents keep theirs, sanitized by the viewer (DOMPurify).
import katex from '../../node_modules/katex/dist/katex.mjs';
import { Marked } from '../../node_modules/marked/lib/marked.esm.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function tex(src, displayMode) {
  try {
    return katex.renderToString(src.trim(), { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

// Answers: a single line break is a line break (models write that way).
const answers = new Marked({ gfm: true, breaks: true });
const documents = new Marked({ gfm: true, breaks: false });

/** Markdown with formulas: code is kept out of the math (a "$" in code is not math). */
export function renderMarkdown(src, { forAnswer = true } = {}) {
  const code = [];
  const math = [];
  const keepCode = (m) => `\u0000C${code.push(m) - 1}\u0000`;
  const keepMath = (html) => `MATHPH${math.push(html) - 1}X`;
  const s = String(src ?? '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, keepCode)
    .replace(/`[^`\n]+`/g, keepCode)
    // (a span shown as a block: a formula may sit inside a quote or a list item)
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keepMath(`<span class="math">${tex(a ?? b, true)}</span>`))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => keepMath(tex(m, false)))
    // Inline $…$: no space just inside the dollars, no digit right after (so "$5 and $10" stays text).
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\d$])/g, (_, pre, m) => pre + keepMath(tex(m, false)))
    // In an answer, no raw HTML at all (outside code): "<div>" is text, and never opens an HTML block.
    .replace(/</g, (lt) => (forAnswer ? '&lt;' : lt))
    .replace(/\u0000C(\d+)\u0000/g, (_, i) => code[+i]);
  const html = (forAnswer ? answers : documents).parse(s);
  return html
    .replace(/<p>MATHPH(\d+)X<\/p>/g, (_, i) => math[+i]) // a formula alone (block)
    .replace(/MATHPH(\d+)X/g, (_, i) => math[+i]);
}

/** An answer of the agent: tables in a scrolling frame (wide tables do not stretch the column). */
export function markdown(src) {
  return renderMarkdown(src, { forAnswer: true })
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
}
