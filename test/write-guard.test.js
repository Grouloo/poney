import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeAction } from '../src/agent/tools.js';
import { filesInContext } from '../src/agent/context.js';
import { Agent } from '../src/agent/agent.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-guard-'));
const big = Array.from({ length: 97 }, (_, i) => `def f${i}():\n    return ${i}`).join('\n') + '\n';

test('filesInContext only counts successful reads and writes', () => {
  const seen = filesInContext([
    { role: 'user', content: '<result tool="read" path="a.py" lines="1-20">\n1| x\n</result>' },
    { role: 'user', content: '<result tool="read" path="missing.py">\nFile "missing.py" does not exist.\n</result>' },
    { role: 'user', content: '<result tool="write" path="b.py">\nCreated b.py (3 lines).\n</result>' },
    { role: 'user', content: '<result tool="write" path="c.py">\nRefused: c.py already exists\n</result>' },
    { role: 'assistant', content: '<read path="d.py" />' },
  ]);
  assert.deepEqual([...seen].sort(), ['a.py', 'b.py']);
});

test('write refuses to overwrite an unread existing file and leaves it intact', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'inv.py'), big);
  const r = await executeAction({ tool: 'write', args: { path: './inv.py', content: 'def f0():\n    return 0\n' } }, { cwd, config: {}, seenFiles: new Set() });
  assert.equal(r.ok, false);
  assert.match(r.output, /Refused: inv\.py already exists \(194 lines\)/);
  assert.match(r.output, /<read path="inv\.py" \/>/);
  assert.equal(await fs.readFile(path.join(cwd, 'inv.py'), 'utf8'), big);
});

test('write is allowed after a read, with a warning when the file shrinks a lot', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'inv.py'), big);
  const r = await executeAction({ tool: 'write', args: { path: 'inv.py', content: 'def f0():\n    return 0\n' } }, { cwd, config: {}, seenFiles: new Set(['inv.py']) });
  assert.equal(r.ok, true);
  assert.match(r.output, /WARNING: inv\.py went from 194 to 2 lines/);
});

test('new files and tiny files are not blocked', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'tiny.txt'), 'a\nb\n');
  const seenFiles = new Set();
  for (const p of ['new.py', 'tiny.txt']) {
    const r = await executeAction({ tool: 'write', args: { path: p, content: 'print(1)\n' } }, { cwd, config: {}, seenFiles });
    assert.equal(r.ok, true, r.output);
    assert.doesNotMatch(r.output, /WARNING/);
  }
});

function fakeOllama(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.end(`${JSON.stringify({ message: { content: replies.shift() ?? 'Done.' }, done: true })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}

test('agent: rewrite from memory is refused, then allowed after reading', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'inv.py'), big);
  const short = 'def f0():\n    return 0\n\ndef total():\n    return 1\n';
  const fake = await fakeOllama([
    `<write path="inv.py">\n${short}</write>`, // from memory: must be refused
    '<read path="inv.py" />',
    `<write path="inv.py">\n${big}def total():\n    return 1\n</write>`, // complete file: allowed
    'Done.',
  ]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', approval: 'auto', shellEnabled: false } });
  const ends = [];
  agent.on('event', (e) => e.type === 'action_end' && ends.push(e));
  await agent.send('add a total() function to inv.py');
  fake.server.close();

  assert.equal(ends[0].ok, false);
  assert.match(fake.requests[1].messages.at(-1).content, /Refused: inv\.py already exists/);
  assert.equal(ends[2].ok, true);
  const final = await fs.readFile(path.join(cwd, 'inv.py'), 'utf8');
  assert.ok(final.startsWith(big), 'existing code preserved');
  assert.match(final, /def total/);
});

test('agent: content removed by a compaction must be read again', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'inv.py'), big);
  const fake = await fakeOllama([`<write path="inv.py">\nx = 1\n</write>`, 'Done.']);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', approval: 'auto', shellEnabled: false } });
  // The read happened, but only a summary remains of it.
  agent.messages.push({ role: 'user', content: '[CONTEXT SUMMARY — older messages were replaced by this summary]\n\nGoal: g\n\nFiles changed: inv.py (edited)' });
  const ends = [];
  agent.on('event', (e) => e.type === 'action_end' && ends.push(e));
  await agent.send('simplify inv.py');
  fake.server.close();
  assert.equal(ends[0].ok, false);
  assert.equal(await fs.readFile(path.join(cwd, 'inv.py'), 'utf8'), big);
});

test('agent: explaining "I will use the <write> tag" before the real call writes the file', async () => {
  const cwd = await tmp();
  const fake = await fakeOllama([
    'There was a parsing problem. I will write the file again using the `<write>` tag, making sure the <write> tag is clean.\n<write path="deploy/main.py">\nprint("ok")\n</write>',
    'Done.',
  ]);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', approval: 'auto', shellEnabled: false } });
  const ends = [];
  agent.on('event', (e) => e.type === 'action_end' && ends.push(e));
  await agent.send('write deploy/main.py');
  fake.server.close();
  assert.equal(ends.length, 1);
  assert.equal(ends[0].ok, true, ends[0].output);
  assert.equal(await fs.readFile(path.join(cwd, 'deploy/main.py'), 'utf8'), 'print("ok")\n');
});
