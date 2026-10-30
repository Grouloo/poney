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

import { splitChapter, chapterDates, capChapters, SUMMARY_MARKER } from '../src/agent/context.js';
import { autoRecall } from '../src/agent/history.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';

test('automatic recall: a rare word or a root finds the passage; words in view and small talk do not', () => {
  const current = [{ role: 'user', content: `${SUMMARY_MARKER}] Context: web project. Discussion: tests of the parser` }];
  // (an archive of a realistic size: the topics above among other, unrelated ones)
  const other = ['On renomme le module utils en helpers.', 'Le logo doit être plus contrasté.', 'Ajoute un bouton pour exporter en CSV.', 'Les images sont trop lourdes, compresse-les.'].map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t }));
  const hit = (q) => autoRecall([[...old, ...other]], current, q).map((p) => p.n);
  assert.deepEqual(hit('pourquoi on a écarté MySQL ?'), [1]);
  assert.deepEqual(hit('quel jour on déploie déjà ?'), [3, 4]);
  assert.deepEqual(hit('merci beaucoup'), []);
  assert.deepEqual(hit('and the parser tests?'), []); // in view (the summary)
  // Already attached and still in view: not attached again.
  const again = [...current, { role: 'user', content: '(From earlier…\n[message 1, user] On part sur PostgreSQL pour la base, pas MySQL.)' }];
  assert.deepEqual(autoRecall([old], again, 'MySQL ?'), []);
});

test('chapter lines: taken out of the summary, dated from the stamps, capped', () => {
  assert.deepEqual(splitChapter('Context: x\nOpen: y\n**Chapter:** db choice — PostgreSQL, MySQL'), { summary: 'Context: x\nOpen: y', chapter: 'db choice — PostgreSQL, MySQL' });
  assert.equal(chapterDates(old), 'Oct 19 10:00–10:05');
  const capped = capChapters(Array.from({ length: 17 }, (_, i) => `c${i}`), 15);
  assert.equal(capped.length, 15);
  assert.equal(capped[0], 'c0 / c1 / c2');
});

test('compaction adds a chapter to the index; a later message about it gets the passage attached', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const d = JSON.parse(body);
      requests.push(d);
      const summary = d.messages.at(-1).content.includes('PAUSE THE TASK') || d.messages[0].content.startsWith('You summarize');
      res.end(`${JSON.stringify({ message: { content: summary ? 'Context: a web app\nDiscussion: the database was chosen\nWork done: None\nOpen: deployment\nChapter: database choice' : 'ok' }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-chap-')), config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', numCtx: 4096 } });
  agent.messages = [...old, ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `filler ${i} `.repeat(300) }))];
  const recalled = [];
  agent.on('event', (e) => e.type === 'recalled' && recalled.push(e.passages));
  try {
    await agent.compact();
    const head = agent.messages[0].content;
    assert.match(head, /EARLIER CHAPTERS \(out of view, search them with <recall>\):\n1\. Oct 19 10:00–10:05 — database choice — [^\n]*postgresql/);
    assert.doesNotMatch(head, /Chapter:/);
    await agent.send('tu te souviens pourquoi pas MySQL ?');
  } finally {
    server.close();
  }
  assert.deepEqual(recalled[0].map((p) => p.n), [1]);
  assert.match(requests.at(-1).messages.at(-1).content, /\(From earlier in this conversation, maybe relevant:\n\[message 1, user\] [^\n]*pas MySQL/);
});

test('automatic recall: words also in the summary do not block it; what was said is recalled, not tool outputs', () => {
  const archive = [
    { role: 'user', content: '[Mon 2026-10-19 10:00] We keep PostgreSQL 16 for the database, on port 5433 because 5432 is taken.' },
    { role: 'assistant', content: 'Noted: PostgreSQL 16 on port 5433.' },
    { role: 'user', content: '<result tool="read" path="docker-compose.yml">\nports: ["5433:5432"] postgres image\n</result>' },
    ...['Rename utils to helpers.', 'The logo needs more contrast.', 'Add a CSV export button.', 'Compress the images.'].map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t })),
  ];
  const current = [{ role: 'user', content: `${SUMMARY_MARKER}] Context: a web app on PostgreSQL. Discussion: the database and the deployment were set up.` }];
  const got = autoRecall([archive], current, 'remind me, which port does PostgreSQL use here?');
  assert.ok(got.length >= 1);
  assert.ok(got.every((p) => !/<result/.test(p.excerpt)));
  assert.match(got.map((p) => p.excerpt).join(' '), /port 5433/);
  assert.doesNotMatch(got[0].excerpt, /^\[Mon/); // (the stamp is not content)
});

test('a sub-agent recalls the conversation of its parent, compacted part included', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  const { buildSystemPrompt } = await import('../src/agent/protocol.js');
  const subs = [];
  let main = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const d = JSON.parse(body);
      let content;
      if (d.messages[0].content.startsWith('You are a sub-agent')) {
        subs.push(d);
        content = subs.length === 1 ? '<recall>asyncpg</recall>' : 'Report.';
      } else content = ++main === 1 ? '<agent title="notes">Note the database choice.</agent>' : 'Done.';
      res.end(`${JSON.stringify({ message: { content }, done: true, prompt_eval_count: 0, eval_count: 1 })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-rec-')), config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', numCtx: 16384, maxTokens: 1024, subagentsEnabled: true } });
  agent.archives = [old];
  agent.messages = [{ role: 'user', content: 'in view' }, { role: 'assistant', content: 'yes' }];
  await agent.send('take notes');
  server.close();
  const result = subs[1].messages.at(-1).content;
  assert.match(result, /asyncpg/);
  assert.match(result, /main agent\]/);
  assert.match(buildSystemPrompt({ cwd: '/p', platform: 'x', subagentRole: true }), /<recall>/);
});
