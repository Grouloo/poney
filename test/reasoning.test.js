import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, generationStats } from '../src/agent/agent.js';
import { withReasoning, splitThinking } from '../src/agent/protocol.js';
import { extractFacts, makeEstimator } from '../src/agent/context.js';

// Fake Ollama: each reply is {thinking?, content, done?}; reports counts and durations.
function fakeOllama(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const r = replies.shift() ?? { content: 'Done.' };
      const lines = [];
      if (r.thinking) lines.push({ message: { thinking: r.thinking }, done: false });
      lines.push({ message: { content: r.content }, done: false });
      lines.push({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1000, eval_count: 50, prompt_eval_duration: 2e9, eval_duration: 5e8 });
      res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-think-'));
const assistantMsgs = (req) => req.messages.filter((m) => m.role === 'assistant').map((m) => m.content);

test('reasoning is kept across tool calls and turns, so the prompt start never changes', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n');
  const fake = await fakeOllama([
    { thinking: 'PLAN: first read a.txt, then answer.', content: '<read path="a.txt" />' },
    { thinking: 'I read it, it says hello.', content: 'It says hello.' },
    { content: 'Second answer.' },
  ]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake' } });
  await agent.send('what is in a.txt?');
  await agent.send('thanks');
  fake.server.close();

  // Step 2 sees the reasoning of step 1.
  assert.equal(assistantMsgs(fake.requests[1])[0], '(My notes: PLAN: first read a.txt, then answer.)\n<read path="a.txt" />');
  // Next request: the previous messages are unchanged (server cache reusable).
  const prev = fake.requests[1].messages;
  assert.deepEqual(fake.requests[2].messages.slice(0, prev.length), prev);
  assert.match(assistantMsgs(fake.requests[2]).join('\n'), /PLAN/);
});

test('inline <think> blocks are kept the same way', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x\n');
  const fake = await fakeOllama([{ content: '<think>need the file</think><read path="a.txt" />' }, { content: 'ok' }]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake' } });
  await agent.send('go');
  fake.server.close();
  assert.match(assistantMsgs(fake.requests[1])[0], /^\(My notes: need the file\)\n/);
});

test('long reasoning becomes a short note keeping its end; imitations are treated as thinking', () => {
  const r = withReasoning('<run>ls</run>', `${'a'.repeat(5000)}\n\nCONCLUSION`);
  assert.match(r, /^\(My notes: …a+ CONCLUSION\)\n<run>ls<\/run>$/);
  assert.ok(r.length < 700);
  assert.equal(splitThinking('<reasoning>x</reasoning>answer').text, 'answer');
  assert.deepEqual(splitThinking('(My notes: plan)\nanswer'), { text: 'answer', thinking: 'plan' });
});

test('reasoning blocks saved by older versions are converted to short notes', async () => {
  const { legacyReasoningToNotes, stripReasoning } = await import('../src/agent/protocol.js');
  const old = `<reasoning>\n${'think '.repeat(400)}DONE\n</reasoning>\n<run>ls</run>`;
  const notes = legacyReasoningToNotes(old);
  assert.match(notes, /^\(My notes: ….*DONE\)\n<run>ls<\/run>$/);
  assert.equal(stripReasoning(notes), '<run>ls</run>');
  const agent = new Agent({ cwd: await tmp(), config: { model: 'm' } });
  agent.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: old }];
  agent.archives = [[{ role: 'assistant', content: old }], null];
  agent.upgradeReasoning();
  assert.match(agent.messages[1].content, /^\(My notes:/);
  assert.match(agent.archives[0][0].content, /^\(My notes:/);
});

test('a generation with tokens but nothing visible is retried once without the notes', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x\n');
  let n = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      n++;
      // 1: reads (with reasoning); 2: invisible tokens only; 3: answers.
      const lines = n === 1
        ? [{ message: { thinking: 'plan' }, done: false }, { message: { content: '<read path="a.txt" />' }, done: false }]
        : n === 2 ? [] : [{ message: { content: 'Done.' }, done: false }];
      lines.push({ message: { content: '' }, done: true, done_reason: n === 2 ? 'length' : 'stop', eval_count: n === 2 ? 400 : 10 });
      res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm' } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('read a.txt');
  server.close();
  assert.ok(events.some((e) => e.type === 'notice' && /rien produire de visible/.test(e.text)));
  assert.equal(events.find((e) => e.type === 'final')?.text, 'Done.');
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /My notes/);
});

test('actions only mentioned in the reasoning are not counted as done', () => {
  const facts = extractFacts([{ role: 'assistant', content: withReasoning('<write path="real.py">\nx\n</write>', 'maybe <write path="imagined.py">', 1000) }]);
  assert.match(facts, /real\.py/);
  assert.doesNotMatch(facts, /imagined/);
});

test('generation stats: server counts when available, estimate otherwise', async () => {
  const exact = generationStats({ t0: 0, tFirst: 100, tEnd: 2100, usage: { outputTokens: 50, evalMs: 500, promptMs: 2000 }, est: makeEstimator(), text: 'x' });
  assert.deepEqual(exact, { totalMs: 2100, promptMs: 2000, genMs: 500, tokens: 50, tps: 100, exact: true });
  const est = generationStats({ t0: 0, tFirst: 1000, tEnd: 3000, usage: null, est: makeEstimator(3.2), text: 'x'.repeat(320) });
  assert.deepEqual(est, { totalMs: 3000, promptMs: 1000, genMs: 2000, tokens: 100, tps: 50, exact: false });

  const cwd = await tmp();
  const fake = await fakeOllama([{ content: 'Hi.' }]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake' } });
  const ends = [];
  agent.on('event', (e) => e.type === 'assistant_end' && ends.push(e));
  await agent.send('hi');
  fake.server.close();
  assert.equal(ends[0].stats.tokens, 50);
  assert.equal(ends[0].stats.tps, 100);
  assert.equal(ends[0].stats.exact, true);
});

test('one stats total per turn, over all model calls', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x\n');
  const fake = await fakeOllama([{ content: '<read path="a.txt" />' }, { content: 'Done.' }]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake' } });
  let end;
  agent.on('event', (e) => e.type === 'turn_end' && (end = e));
  await agent.send('go');
  fake.server.close();
  assert.equal(end.stats.steps, 2);
  assert.equal(end.stats.exact, false, 'first call was stopped early after the action');
  assert.ok(end.stats.tokens > 50);
  assert.ok(end.stats.tps > 0);
});
