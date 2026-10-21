// Formatted view of Markdown documents in the file viewer: full Markdown
// (GitHub flavour, via marked) plus LaTeX formulas (KaTeX). The HTML is
// sanitized by the caller (DOMPurify, which needs a DOM).
import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import { tex } from './markdown.js';

export function documentHtml(src) {
  const code = [];
  const math = [];
  const keepCode = (m) => `\u0000C${code.push(m) - 1}\u0000`;
  const keepMath = (html) => `MATHPH${math.push(html) - 1}X`;
  // Code first (a "$" in code is not math), then math, then code back for marked.
  let s = String(src)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, keepCode)
    .replace(/`[^`\n]+`/g, keepCode)
    // (a span shown as a block: a formula may sit inside a quote or a list item)
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => keepMath(`<span class="math">${tex(a ?? b, true)}</span>`))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => keepMath(tex(m, false)))
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\d$])/g, (_, pre, m) => pre + keepMath(tex(m, false)))
    .replace(/\u0000C(\d+)\u0000/g, (_, i) => code[+i]);
  const html = marked.parse(s, { gfm: true, breaks: false });
  return html
    .replace(/<p>MATHPH(\d+)X<\/p>/g, (_, i) => math[+i]) // a formula alone (block)
    .replace(/MATHPH(\d+)X/g, (_, i) => math[+i]);
}
