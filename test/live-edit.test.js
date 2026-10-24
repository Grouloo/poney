import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { liveAction, partialEditPairs } from '../src/agent/protocol.js';

test('the action being written is read from the stream, tags and Gemma native calls', () => {
  assert.deepEqual(liveAction('Ok.\n<write path="a.py">\nprint(1)\nprint('), { tool: 'write', path: 'a.py', content: 'print(1)\nprint(', body: undefined, start: 4, complete: false });
  assert.equal(liveAction('ok <|tool_call>call:write{path:<|"|>b.py<|"|>,content:<|"|>x = 1').content, 'x = 1');
  assert.equal(liveAction('ok <|tool_call>call:edit{path:<|"|>a.py<|"|>,old:<|"|>x = 1<|"|>,new:<|"|>x = 2').body, '<old>x = 1</old><new>x = 2');
  assert.equal(liveAction('just text <read path="a" />'), null);
  assert.deepEqual(partialEditPairs('<old>a</old>\n<new>b</new>\n<old>c'), [
    { old: 'a', oldClosed: true, new: 'b', newOpen: true, newClosed: true },
    { old: 'c', oldClosed: false, new: '', newOpen: false, newClosed: false },
  ]);
});

// Streams the reply piece by piece (as a model does), then counts what was sent.
function streamer(replies) {
  const requests = [];
  let sent = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      requests.push(JSON.parse(body));
      const reply = replies.shift() ?? 'Done.';
      for (const piece of reply.match(/[\s\S]{1,12}/g)) {
        if (res.destroyed) return;
        res.write(`${JSON.stringify({ message: { content: piece }, done: false })}\n`);
        sent += piece.length;
        await new Promise((ok) => setTimeout(ok, 5));
      }
      res.end(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}`, sent: () => sent })));
}

test('an <old> block not in the file stops the generation as soon as it is written', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-live-'));
  await fs.writeFile(path.join(cwd, 'a.py'), 'def f():\n    x = 1\n    return x\n');
  const longNew = 'y = 2\n'.repeat(400);
  const s = await streamer([`Fixing it.\n<edit path="a.py">\n<old>\n    x = 42\n</old>\n<new>\n${longNew}</new>\n</edit>`, 'Done.']);
  const agent = new Agent({ cwd, config: { baseUrl: s.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('fix a.py');
  } finally {
    s.server.close();
  }
  assert.ok(events.some((e) => e.type === 'notice' && /génération arrêtée avant la fin/.test(e.text)));
  const failed = events.find((e) => e.type === 'action_end' && !e.ok);
  assert.match(failed.output, /^The <old> text was not found in a\.py/);
  assert.match(s.requests[1].messages.at(-1).content, /<result tool="edit" path="a\.py">[\s\S]*You were stopped as soon as this <old> block was written/);
  assert.match(s.requests[1].messages.at(-2).content, /Fixing it\.\n<edit path="a\.py">\n<old>\n {4}x = 42\n<\/old>$/);
  assert.equal(await fs.readFile(path.join(cwd, 'a.py'), 'utf8'), 'def f():\n    x = 1\n    return x\n');
});

test('an <old> block found is located (lines) while the edit goes on, then applied', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-live-'));
  await fs.writeFile(path.join(cwd, 'a.py'), 'def f():\n    x = 1\n    return x\n');
  const s = await streamer(['<edit path="a.py">\n<old>\n    x = 1\n</old>\n<new>\n    x = 2\n</new>\n</edit>', 'Done.']);
  const agent = new Agent({ cwd, config: { baseUrl: s.url, model: 'm', shellEnabled: false } });
  const located = [];
  agent.on('event', (e) => e.type === 'edit_located' && located.push(e));
  try {
    await agent.send('set x to 2');
  } finally {
    s.server.close();
  }
  assert.deepEqual(located.map((e) => [e.path, e.startLine, e.endLine]), [['a.py', 2, 2]]);
  assert.equal(await fs.readFile(path.join(cwd, 'a.py'), 'utf8'), 'def f():\n    x = 2\n    return x\n');
});
