import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-resume-'));

/** Fake Ollama: `reply(messages, n)` gives the answer text. */
function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      const isSummary = data.messages.at(-1).content.includes('PAUSE THE TASK') || data.messages[0].content.startsWith('You summarize');
      const content = isSummary ? 'Goal: g\nNext step: s' : reply(data.messages, requests.length);
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}

const lastResult = (messages) => messages.at(-1).content;
const actionsOf = (events, from = 0) => events.slice(from).filter((e) => e.type === 'action_start' && !e.agentId);

test('resuming from a failed action re-runs it and continues; the failed result is gone', async () => {
  const cwd = await tmp();
  const m = await fake((messages) => {
    const last = lastResult(messages);
    if (!last.includes('<result')) return '<run>cat data.txt</run>';
    return last.includes('hello') ? 'The file says hello.' : 'I could not read data.txt.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', approval: 'auto' } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('What is in data.txt?', { turnId: 't1' });
  const runId = actionsOf(events)[0].id;
  assert.match(events.find((e) => e.type === 'final').text, /could not read/);

  await fs.writeFile(path.join(cwd, 'data.txt'), 'hello\n'); // the cause is fixed
  const before = events.length;
  await agent.resumeFrom(runId);
  m.server.close();
  assert.deepEqual(actionsOf(events, before).map((e) => e.tool), ['run'], 'the action ran again');
  assert.equal(events.filter((e) => e.type === 'final').at(-1).text, 'The file says hello.');
  assert.deepEqual(agent.messages.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(agent.messages), /No such file|could not read/);
});

test('in a batch, resuming from a later action keeps the earlier results and does not re-run them', async () => {
  const cwd = await tmp();
  let reads = 0;
  const m = await fake((messages) => (lastResult(messages).includes('<result') ? `Done (${++reads}).` : '<write path="x.txt">\none\n</write>\n<read path="x.txt" />'));
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go', { turnId: 't1' });
  const [write, read] = actionsOf(events);
  assert.deepEqual([write.tool, read.tool], ['write', 'read']);
  const before = events.length;
  await agent.resumeFrom(read.id);
  m.server.close();
  assert.deepEqual(actionsOf(events, before).map((e) => e.tool), ['read'], 'only the read ran again');
  const results = m.requests.at(-1).messages.at(-1).content;
  assert.match(results, /<result tool="write"[^>]*>\nCreated x\.txt/, 'the write result was kept');
  assert.match(results, /<result tool="read"[^>]*>\n1\| one/);
});

test('resume after the user stopped in the middle of an action', async () => {
  const cwd = await tmp();
  let n = 0;
  const m = await fake((messages) => (lastResult(messages).includes('<result') ? 'Finished.' : (++n === 1 ? '<run>sleep 5; echo slow</run>' : 'unused')));
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', approval: 'auto' } });
  const events = [];
  agent.on('event', (e) => { events.push(e); if (e.type === 'action_start') setTimeout(() => agent.stop(), 300); });
  await agent.send('go', { turnId: 't1' });
  const runId = actionsOf(events)[0].id;
  assert.equal(events.filter((e) => e.type === 'turn_end').at(-1).reason, 'stopped');
  agent.removeAllListeners('event');
  const after = [];
  agent.on('event', (e) => after.push(e));
  await agent.resumeFrom(runId);
  m.server.close();
  assert.equal(after.find((e) => e.type === 'action_end').ok, true);
  assert.equal(after.find((e) => e.type === 'final').text, 'Finished.');
});

test('resume works across a compaction (the archived history is used)', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
  const m = await fake((messages) => (lastResult(messages).includes('<result') ? 'ok' : '<read path="a.txt" />'));
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', numCtx: 32768 } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('first', { turnId: 't1' });
  const readId = actionsOf(events)[0].id;
  for (let i = 0; i < 6; i++) await agent.send(`more ${i} ${'x'.repeat(400)}`, { turnId: `t${i + 2}` });
  await agent.compact();
  assert.match(agent.messages[0].content, /^\[CONTEXT SUMMARY/);
  await agent.resumeFrom(readId);
  m.server.close();
  assert.equal(agent.messages[0].content.replace(/^\[[^\]]+\] /, ''), 'first', 'back to the full history');
  assert.deepEqual(agent.messages.slice(0, 2).map((x) => x.role), ['user', 'assistant']);
});

test('an unknown action cannot be resumed from', async () => {
  const agent = new Agent({ cwd: await tmp(), config: { model: 'm' } });
  assert.throws(() => agent.resumeFrom(12345), /point de reprise/);
});
