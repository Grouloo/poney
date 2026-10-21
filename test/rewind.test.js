import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';

function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      res.end(`${JSON.stringify({ message: { content: reply(data) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-rewind-'));
// (user messages start with their date and time)
const plain = (s) => s.replace(/^\[[^\]]+\] /, '');
const userTexts = (agent) => agent.messages.filter((m) => m.role === 'user').map((m) => plain(m.content));

test('rewind removes the edited message and everything after it', async () => {
  const f = await fake((d) => `answer to ${d.messages.at(-1).content}`);
  const agent = new Agent({ cwd: await tmp(), config: { baseUrl: f.url, model: 'm' } });
  await agent.send('one', { turnId: 't1' });
  await agent.send('two', { turnId: 't2' });
  await agent.send('three', { turnId: 't3' });
  agent.rewind('t2');
  assert.deepEqual(userTexts(agent), ['one']);
  assert.deepEqual(agent.checkpoints.map((c) => c.turnId), ['t1']);
  await agent.send('two, edited', { turnId: 't2b' });
  f.server.close();
  assert.deepEqual(userTexts(agent), ['one', 'two, edited']);
  assert.equal(plain(f.requests.at(-1).messages.at(-1).content), 'two, edited');
});

test('rewind works across a compaction, using the archived history', async () => {
  const f = await fake((d) => (d.messages.at(-1).content.includes('PAUSE THE TASK') || d.messages[0].content.startsWith('You summarize')
    ? 'Goal: g\nNext step: s'
    : 'ok'));
  const agent = new Agent({ cwd: await tmp(), config: { baseUrl: f.url, model: 'm', numCtx: 4096, maxTokens: 512 } });
  await agent.send('first request', { turnId: 'a' });
  for (let i = 0; i < 8; i++) {
    agent.messages.push({ role: 'user', content: `<result tool="read" path="f${i}" lines="1-2">\n${'data '.repeat(300)}\n</result>` });
    agent.messages.push({ role: 'assistant', content: 'noted' });
  }
  await agent.send('second request', { turnId: 'b' }); // triggers a compaction
  f.server.close();
  assert.match(agent.messages[0].content, /^\[CONTEXT SUMMARY/);
  assert.equal(agent.archives.filter(Boolean).length, 1);

  agent.rewind('b'); // just before "second request": the full, uncompacted history
  assert.equal(plain(agent.messages[0].content), 'first request');
  assert.equal(agent.messages.length, 2 + 16);
  assert.ok(agent.messages.every((m) => !m.content.startsWith('[CONTEXT SUMMARY')));
  assert.equal(agent.archives.filter(Boolean).length, 0, 'archive no longer needed');
  assert.equal(agent.checkpoints[0].archive, null);

  agent.rewind('a');
  assert.equal(agent.messages.length, 0);
});

test('unknown rewind point is refused', async () => {
  const agent = new Agent({ cwd: await tmp(), config: { model: 'm' } });
  assert.throws(() => agent.rewind('nope'), /point de reprise/);
});
