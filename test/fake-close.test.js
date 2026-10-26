import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { answerInReasoning, reasoningNote } from '../src/agent/protocol.js';

// As seen with Gemma: a made-up "</thought>", its calls, then the real end of the reasoning.
const THOUGHT = 'Wait, let me check the config first.\n</thought>\n<run command="echo set" />\n<run command="echo name" />\n';

test('calls written after a made-up end of reasoning are its answer', () => {
  assert.deepEqual(answerInReasoning(THOUGHT), {
    thinking: 'Wait, let me check the config first.\n',
    text: '<run command="echo set" />\n<run command="echo name" />',
  });
  assert.equal(answerInReasoning('I could use <run>ls</run> here. Then answer.'), null); // no made-up end
  assert.equal(answerInReasoning('Done.</thought>\nNothing more.'), null); // no call after it
});

test('the reasoning kept in the history has no calls (they looked done)', () => {
  assert.equal(reasoningNote('I will set it. <run>git config user.name x</run> Then check.'), 'I will set it. Then check.');
});

test('the agent runs those calls (the first one, whose result it needs, as for any answer)', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const content = requests.length === 1 ? `<think>${THOUGHT}</think>\n<run command="echo name" />` : 'Done.';
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-fake-close-')), config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', approval: 'auto' } });
  const runs = [];
  agent.on('event', (e) => e.type === 'action_start' && runs.push(e.args.command));
  try {
    await agent.send('set my git name');
  } finally {
    server.close();
  }
  assert.deepEqual(runs, ['echo set']); // (it was never run before: only written in the reasoning)
  // In the history: the call that ran, and no call in the reasoning kept.
  const said = requests[1].messages.find((m) => m.role === 'assistant').content;
  assert.match(said, /^<reasoning>\nWait, let me check the config first\.\n<\/reasoning>\n<run command="echo set" \/>$/);
});
