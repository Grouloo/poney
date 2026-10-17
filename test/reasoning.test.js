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

test('reasoning is kept across tool calls of a turn, and dropped at the next request', async () => {
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
  assert.match(assistantMsgs(fake.requests[1])[0], /^<reasoning>\nPLAN: first read a\.txt, then answer\.\n<\/reasoning>\n<read path="a\.txt" \/>/);
  // Next request: earlier reasoning removed, actions kept.
  const third = assistantMsgs(fake.requests[2]).join('\n');
  assert.doesNotMatch(third, /reasoning|PLAN/);
  assert.match(third, /<read path="a\.txt" \/>/);
});

test('inline <think> blocks are kept the same way', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x\n');
  const fake = await fakeOllama([{ content: '<think>need the file</think><read path="a.txt" />' }, { content: 'ok' }]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake' } });
  await agent.send('go');
  fake.server.close();
  assert.match(assistantMsgs(fake.requests[1])[0], /<reasoning>\nneed the file\n<\/reasoning>/);
});

test('long reasoning keeps its end; reasoning is treated as thinking if imitated', () => {
  const r = withReasoning('<run>ls</run>', `${'a'.repeat(5000)}CONCLUSION`, 100);
  assert.match(r, /^<reasoning>\n\[\.\.\.\]a+CONCLUSION\n<\/reasoning>\n<run>ls<\/run>$/);
  assert.equal(splitThinking('<reasoning>x</reasoning>answer').text, 'answer');
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
