import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { remember, forget, MEMORY_MAX_NOTES } from '../src/agent/memory.js';

test('notes are added, numbered, deduplicated, bounded, and forgotten by number', () => {
  let r = remember([], '  The user wants   answers in French ');
  assert.deepEqual(r.notes, ['The user wants answers in French']);
  assert.match(r.text, /Noted \(#1\)\.\nMEMORY:\n1\. The user wants answers in French/);
  assert.equal(remember(r.notes, 'the user wants answers in french').notes, r.notes);
  assert.equal(remember(r.notes, 'x'.repeat(201)).ok, false);
  const full = Array.from({ length: MEMORY_MAX_NOTES }, (_, i) => `note ${i}`);
  assert.match(remember(full, 'one more').text, /Memory full: <forget>/);
  const f = forget(['a', 'b', 'c'], '#2');
  assert.deepEqual(f.notes, ['a', 'c']);
  assert.equal(forget(['a'], '5').ok, false);
});

function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const d = JSON.parse(body);
      requests.push(d);
      res.end(`${JSON.stringify({ message: { content: reply(d, requests.length) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}` })));
}
const isSummary = (d) => d.messages.at(-1).content.includes('PAUSE THE TASK') || d.messages[0].content.startsWith('You summarize');

test('the memory survives a compaction word for word, and comes back with a message once far behind', async () => {
  const f = await fake((d, n) => (isSummary(d) ? 'Goal: g\nNext step: s' : n === 1 ? '<remember>Deploy only on Fridays</remember>' : 'ok'));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-mem-')), config: { baseUrl: f.url, model: 'm', numCtx: 8192 } });
  const events = [];
  agent.on('event', (e) => e.type === 'memory' && events.push(e.notes));
  try {
    await agent.send('remember that we deploy on fridays');
    assert.deepEqual(agent.memory, ['Deploy only on Fridays']);
    assert.deepEqual(events.at(-1), ['Deploy only on Fridays']);
    // Close by: not repeated with the next message.
    await agent.send('ok thanks');
    assert.doesNotMatch(agent.messages.filter((m) => m.role === 'user').at(-1).content, /MEMORY/);
    // Far behind (a third of the window): recalled with the message.
    for (let i = 0; i < 6; i++) agent.messages.push({ role: 'user', content: 'filler '.repeat(400) }, { role: 'assistant', content: 'ok' });
    await agent.send('what was the rule again?');
    assert.match(f.requests.at(-1).messages.at(-1).content, /what was the rule again\?\n\n\(MEMORY [^\n]*\n1\. Deploy only on Fridays\)$/);
    // Compaction: kept in the summary.
    await agent.compact();
    assert.match(agent.messages[0].content, /MEMORY \(your notes[^\n]*\n1\. Deploy only on Fridays/);
    // Edited by the user: shown again with the next message.
    agent.setMemory(['Deploy only on Fridays', 'Use pnpm']);
    await agent.send('go on');
    assert.match(f.requests.at(-1).messages.at(-1).content, /2\. Use pnpm\)$/);
  } finally {
    f.server.close();
  }
});

test('lasting instructions of the user are spotted (French and English); questions, quotes and complaints are not', async () => {
  const { standingInstructions } = await import('../src/agent/memory.js');
  const yes = ['Réponds toujours en anglais, et sois concis. Peux-tu regarder le parseur ?', 'À partir de maintenant, pas d’emojis.', 'Tutoie-moi', 'retiens que la prod est sur le port 8080', 'From now on, answer in French.', 'Je veux que tu commentes ton code en français'];
  for (const t of yes) assert.equal(standingInstructions(t).length, 1, t);
  assert.deepEqual(standingInstructions(yes[0]), ['Réponds toujours en anglais, et sois concis.']);
  for (const t of ['ça ne marche jamais ce truc', 'Is it always slow?', 'Corrige le bug du parseur', '> réponds toujours en anglais\nok merci']) assert.deepEqual(standingInstructions(t), [], t);
});

test('the app notes a lasting instruction itself, in the user\'s words, once', async () => {
  const f = await fake(() => 'ok');
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-mem-')), config: { baseUrl: f.url, model: 'm' } });
  const noted = [];
  agent.on('event', (e) => e.type === 'noted' && noted.push(e.notes));
  try {
    await agent.send('Salut ! Réponds toujours en anglais. On commence ?');
    await agent.send('Réponds toujours en anglais.');
  } finally {
    f.server.close();
  }
  assert.deepEqual(agent.memory, ['The user asked: « Réponds toujours en anglais. »']);
  assert.deepEqual(noted, [['Réponds toujours en anglais.']]);
});
