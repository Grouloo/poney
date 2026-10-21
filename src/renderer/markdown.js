// Small Markdown renderer for the agent's answers: code, inline code, bold,
// headings, lists, tables (GitHub style) and LaTeX math (KaTeX).
import katex from '../../node_modules/katex/dist/katex.mjs';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function tex(src, displayMode) {
  try {
    return katex.renderToString(src.trim(), { displayMode, throwOnError: false, output: 'htmlAndMathml' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const isSeparator = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('|');
const isRow = (line) => /\|/.test(line);

/** GitHub tables: a header row, a separator row (`|---|:--:|`), then rows. */
function tables(s) {
  const lines = s.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
      const style = (k) => (align[k] ? ` style="text-align:${align[k]}"` : '');
      const body = [];
      i += 2;
      while (i < lines.length && isRow(lines[i]) && lines[i].trim()) body.push(splitRow(lines[i++]));
      i--;
      const tr = (cells, tag) => `<tr>${head.map((_, k) => `<${tag}${style(k)}>${cells[k] ?? ''}</${tag}>`).join('')}</tr>`;
      out.push('', `<div class="table-wrap"><table><thead>${tr(head, 'th')}</thead><tbody>${body.map((r) => tr(r, 'td')).join('')}</tbody></table></div>`, '');
    } else out.push(lines[i]);
  }
  return out.join('\n');
}

export function markdown(src) {
  const blocks = [];
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  // Kept out of the Markdown pass: code first (its `$` and `|` are literal), then math.
  let s = String(src)
    .replace(/```[\w.+-]*\n?([\s\S]*?)(```|$)/g, (_, code) => keep(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`))
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => `\n\n${keep(`<div class="math">${tex(a ?? b, true)}</div>`)}\n\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => keep(tex(m, false)))
    // Inline $…$: no space just inside the dollars, no digit right after (so "$5 and $10" stays text).
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\d$])/g, (_, pre, m) => pre + keep(tex(m, false)));
  s = tables(esc(s))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6} (.*)$/gm, '<h3>$1</h3>')
    .replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (_, list) =>
      `\n<ul>${list.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')}</ul>\n`);
  const html = s.split(/\n{2,}/).map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (/^(<ul>|<h3>|<div class="table-wrap">|\u0000\d+\u0000$)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}
