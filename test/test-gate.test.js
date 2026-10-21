import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, needsRun } from '../src/agent/agent.js';

// Fake Ollama answering the given contents in order, then "Done."
function fake(replies) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(`${JSON.stringify({ message: { content: replies.shift() ?? 'Done.' }, done: true, done_reason: 'stop' })}\n`));
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://localhost:${server.address().port}` })));
}

async function turns(...replyLists) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-gate-'));
  const all = replyLists.flat();
  const f = await fake(all);
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', approval: 'auto' } });
  const notices = [];
  agent.on('event', (e) => e.type === 'notice' && notices.push(e.text));
  for (let i = 0; i < replyLists.length; i++) await agent.send(`task ${i}`);
  f.server.close();
  return notices.filter((n) => /pas testé/.test(n));
}

test('documentation and config files do not need a run', () => {
  for (const f of ['README.md', 'docs/guide.MD', 'notes.txt', 'config.json', 'ci.yml', 'pyproject.toml', 'LICENSE']) assert.equal(needsRun(f), false, f);
  for (const f of ['app.py', 'src/main.js', 'Makefile', 'Dockerfile', 'index.html']) assert.equal(needsRun(f), true, f);
});

test('changing only Markdown and JSON does not ask to test', async () => {
  const gates = await turns(['<write path="README.md">\n# Doc\n</write>\n<write path="data.json">\n{"a": 1}\n</write>', 'Done.']);
  assert.deepEqual(gates, []);
});

test('changing code still asks to test it', async () => {
  const gates = await turns(['<write path="app.py">\nprint(1)\n</write>', 'Done.', 'Done.']);
  assert.ok(gates.length >= 1);
});

test('a Markdown-only turn is not asked to test code left untested by an earlier turn', async () => {
  // Turn 1: code written, the model insists on finishing twice (gate gives up after 2 nudges).
  // Turn 2: only the README.
  const gates = await turns(['<write path="app.py">\nprint(1)\n</write>', 'Done.', 'Done.', 'Done.'], ['<write path="README.md">\n# Doc\n</write>', 'Done.']);
  assert.equal(gates.length, 2); // both from turn 1
});
