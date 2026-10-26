import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';

async function refused(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const content = requests.length === 1 ? '<run>rm -rf build</run>' : 'OK.';
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  const agent = new Agent({
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-approval-')),
    config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', approval: 'ask' },
    approve: async () => answer,
  });
  const ends = [];
  agent.on('event', (e) => e.type === 'action_end' && ends.push(e.output));
  try {
    await agent.send('clean up');
  } finally {
    server.close();
  }
  return { result: requests[1].messages.at(-1).content, card: ends[0] };
}

test('a refused command tells the model why, when the user said so', async () => {
  const r = await refused({ ok: false, reason: 'build/ holds my release, use make clean' });
  assert.match(r.result, /refused to run this command, and said why: "build\/ holds my release, use make clean"/);
  assert.equal(r.card, 'Refusé par l’utilisateur : build/ holds my release, use make clean');
});

test('a refusal without a reason stays as before', async () => {
  const r = await refused(false);
  assert.match(r.result, /The user refused to run this command\. Try another way, or ask the user\./);
  assert.equal(r.card, 'Refusé par l’utilisateur.');
});
