import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff } from '../src/renderer/word-diff.ts';

const marked = (pieces: [string, boolean][]) => pieces.filter(([, c]) => c).map(([t]) => t);

test('a long line: only the words that changed are marked', () => {
  const before = 'Le modèle lit le fichier, puis il écrit une réponse courte et précise pour l’utilisateur.';
  const after = 'Le modèle lit le fichier, puis il écrit une réponse longue et précise pour la personne.';
  const d = wordDiff(before, after);
  assert.ok(d);
  assert.deepEqual(marked(d.before), ['courte', 'l’utilisateur']);
  assert.deepEqual(marked(d.after), ['longue', 'la personne']);
  assert.equal(d.before.map(([t]) => t).join(''), before);
  assert.equal(d.after.map(([t]) => t).join(''), after);
});

test('words added or removed in the middle; a rewritten line is not marked', () => {
  const d = wordDiff('un deux trois', 'un deux et demi trois');
  assert.ok(d);
  assert.deepEqual(marked(d.before), []);
  assert.deepEqual(marked(d.after), ['et demi ']);
  assert.equal(wordDiff('tout autre chose ici', 'rien de commun là-bas'), null);
});
