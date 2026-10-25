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
      const r = JSON.parse(body);
      requests.push(r);
      res.end(`${JSON.stringify({ message: { content: reply(r, requests.length) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}` })));
}

test('the "before" step goes with each message; the "after" step is asked once, before the final answer', async () => {
  const f = await fake((r) => (/Step to do before finishing/.test(r.messages.at(-1).content) ? 'Documented.' : 'Answer.'));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-steps-')), config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  agent.steps = { before: 'Check git status.', after: 'Write what you did in NOTES.md.', afterOnlyIfChanged: false };
  const finals = [];
  agent.on('event', (e) => e.type === 'final' && finals.push(e.text));
  try {
    await agent.send('hello');
  } finally {
    f.server.close();
  }
  assert.match(f.requests[0].messages.at(-1).content, /hello\n\n\(Step to do first, set by the user for this conversation: Check git status\.\)$/);
  assert.match(f.requests[1].messages.at(-1).content, /^\(Step to do before finishing, set by the user for this conversation: Write what you did in NOTES\.md\.\)\nDo it now, then give your final answer\.$/);
  assert.equal(f.requests.length, 2); // asked once only
  assert.deepEqual(finals, ['Documented.']);
});

test('"only if files were changed": no "after" step for a turn that changed nothing', async () => {
  const f = await fake(() => 'Just an answer.');
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-steps-')), config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  agent.steps = { before: '', after: 'Document it.', afterOnlyIfChanged: true };
  try {
    await agent.send('a question');
  } finally {
    f.server.close();
  }
  assert.equal(f.requests.length, 1);
});
