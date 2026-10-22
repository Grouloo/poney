import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recall, searchTerms, outOfContext } from '../src/agent/history.js';
import { buildSummaryRequest, cleanSummary, summaryWords } from '../src/agent/context.js';

const old = [
  { role: 'user', content: '[Mon 2026-10-19 10:00] On part sur PostgreSQL pour la base, pas MySQL.' },
  { role: 'assistant', content: '<reasoning>\nthinking\n</reasoning>\nD’accord, PostgreSQL 16 avec le pilote asyncpg.' },
  { role: 'user', content: '[Mon 2026-10-19 10:05] Et le déploiement se fera le vendredi uniquement.' },
  { role: 'assistant', content: 'Noté pour le déploiement.' },
];

test('search terms: accents folded, short and common words dropped, quoted phrases kept', () => {
  assert.deepEqual(searchTerms('Le "pilote asyncpg" et la Base de données'), ['pilote asyncpg', 'base', 'donnees']);
});

test('recall searches only what is out of context, and brings back excerpts in order', () => {
  const current = [old[3], { role: 'user', content: 'quelle base déjà ?' }];
  assert.equal(outOfContext([old], current).length, 3); // message 4 is still in view
  const r = recall([old, old], current, 'base postgresql');
  assert.match(r.text, /^2 earlier message\(s\) out of 3 match:\n\[message 1, user\] .*On part sur PostgreSQL pour la base.*\n\[message 2, you\] .*PostgreSQL 16/);
  assert.doesNotMatch(r.text, /thinking/);
  assert.match(recall([old], current, 'kubernetes').text, /No earlier message matches/);
  assert.match(recall([], current, 'base').text, /Nothing is out of context yet/);
});

test('the summary is sized from the window and suits a conversation', () => {
  assert.equal(summaryWords(16384), 492);
  const req = buildSummaryRequest(old, 5000, { words: 492 });
  assert.match(req[0].content, /at most 492 words, under exactly these headings:\nContext:/);
  assert.match(req[0].content, /Discussion: [^\n]*exact wording/);
  assert.match(req[1].content, /Context:, Discussion:, Work done:, Open:/);
  assert.ok(cleanSummary('Context: chat about databases\nDiscussion: chose PostgreSQL\nWork done: None\nOpen: deployment day').summary);
});
