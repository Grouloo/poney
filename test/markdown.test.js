import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../src/renderer/markdown.js';

test('markdown: GitHub tables with alignment and inline formatting, in a scrolling frame', () => {
  const html = markdown('Résultats :\n\n| Nom | Score |\n|:-|---:|\n| **a** | `1\\|2` |\n| b | 3 |\n\nFin.');
  assert.match(html, /<div class="table-wrap"><table>\n<thead>\n<tr>\n<th align="left">Nom<\/th>\n<th align="right">Score<\/th>/);
  assert.match(html, /<td align="left"><strong>a<\/strong><\/td>\n<td align="right"><code>1\|2<\/code><\/td>/);
  assert.match(html, /<\/table><\/div>\n<p>Fin\.<\/p>/);
});

test('markdown: a pipe without separator row is not a table', () => {
  assert.doesNotMatch(markdown('a | b\nc | d'), /<table>/);
});

test('markdown: italics, quotes, numbered and nested lists, line breaks, links', () => {
  const html = markdown('Un *italique* et _aussi_, du **gras**.\n\n> une citation\n> sur deux lignes\n\n1. premier\n2. second\n   - imbriqué\n3. troisième\n\nLigne une\nligne deux, [lien](https://ex.org)');
  assert.match(html, /<em>italique<\/em> et <em>aussi<\/em>, du <strong>gras<\/strong>/);
  assert.match(html, /<blockquote>\n<p>une citation<br>sur deux lignes<\/p>\n<\/blockquote>/);
  assert.match(html, /<ol>\n<li>premier<\/li>\n<li>second<ul>\n<li>imbriqué<\/li>\n<\/ul>\n<\/li>\n<li>troisième<\/li>\n<\/ol>/);
  assert.match(html, /<p>Ligne une<br>ligne deux, <a href="https:\/\/ex\.org">lien<\/a><\/p>/);
});

test('markdown: inline and display LaTeX', () => {
  const html = markdown('Soit $E = mc^2$ et \\(x_1\\).\n\n$$\\int_0^1 x\\,dx = \\frac12$$');
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /<span class="math"><span class="katex-display">/);
  assert.doesNotMatch(html, /\$/);
});

test('markdown: prices and code are not math', () => {
  const html = markdown('Ça coûte $5 et $10. Code : `echo $HOME $PATH`');
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /<code>echo \$HOME \$PATH<\/code>/);
});

test('markdown: no raw HTML in an answer; an unclosed formula stays text; bad LaTeX does not throw', () => {
  assert.doesNotMatch(markdown('On a $$x^2'), /katex/);
  assert.match(markdown('$\\frac{$'), /./);
  const html = markdown('<script>alert(1)</script> puis `<b>x</b>` et **gras**');
  assert.match(html, /^<p>&lt;script&gt;alert\(1\)&lt;\/script&gt; puis <code>&lt;b&gt;x&lt;\/b&gt;<\/code> et <strong>gras<\/strong><\/p>/);
  assert.doesNotMatch(html, /<script|<b>/);
});

test('documents: full Markdown with formulas; "$" in code stays code', async () => {
  const { documentHtml } = await import('../src/renderer/document.js');
  const html = documentHtml('# T\n\n*it* $x^2$ `$HOME`\n\n> quote $$\\sum i$$\n\n```sh\necho $PATH $HOME\n```\n\n1. one\n- [x] done');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<em>it<\/em> <span class="katex">/);
  assert.match(html, /<code>\$HOME<\/code>/);
  assert.match(html, /<blockquote>\s*<p>quote <span class="math"><span class="katex-display">/);
  assert.match(html, /<code class="language-sh">echo \$PATH \$HOME/);
  assert.match(html, /<ol>\s*<li>one<\/li>/);
  assert.match(html, /<input checked="" disabled="" type="checkbox"> done/);
});
