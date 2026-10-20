import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../src/renderer/markdown.js';

test('markdown: GitHub tables with alignment and inline formatting', () => {
  const html = markdown('Résultats :\n\n| Nom | Score |\n|:-|---:|\n| **a** | `1|2` |\n| b | 3 |\n\nFin.');
  assert.match(html, /<table><thead><tr><th style="text-align:left">Nom<\/th><th style="text-align:right">Score<\/th><\/tr><\/thead>/);
  assert.match(html, /<td style="text-align:left"><strong>a<\/strong><\/td><td style="text-align:right"><code>1\|2<\/code><\/td>/);
  assert.match(html, /<td style="text-align:left">b<\/td>/);
  assert.match(html, /<p>Fin\.<\/p>$/);
});

test('markdown: a pipe without separator row is not a table', () => {
  assert.doesNotMatch(markdown('a | b\nc | d'), /<table>/);
});

test('markdown: inline and display LaTeX', () => {
  const html = markdown('Soit $E = mc^2$ et \\(x_1\\).\n\n$$\\int_0^1 x\\,dx = \\frac12$$');
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /<div class="math"><span class="katex-display">/);
  assert.doesNotMatch(html, /\$/);
});

test('markdown: prices and code are not math', () => {
  const html = markdown('Ça coûte $5 et $10. Code : `echo $HOME $PATH`');
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /<code>echo \$HOME \$PATH<\/code>/);
});

test('markdown: an unclosed formula while streaming stays text, bad LaTeX does not throw', () => {
  assert.doesNotMatch(markdown('On a $$x^2'), /katex/);
  assert.match(markdown('$\\frac{$'), /./);
  assert.match(markdown('<script>alert(1)</script>'), /&lt;script&gt;/);
});
