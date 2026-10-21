import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rebuildHistory, migrateLegacy, actionTag } from '../src/agent/rebuild.js';
import { parseActions } from '../src/agent/protocol.js';
import { Agent } from '../src/agent/agent.js';

// Transcript events as saved by older versions (no turnId).
const events = [
  { type: 'user_message', text: 'Crée hello.py' },
  { type: 'assistant_start', id: 1 },
  { type: 'assistant_end', id: 1, text: 'Je le crée.', thinking: 'need a file', hasActions: true },
  { type: 'action_start', id: 2, tool: 'write', args: { path: 'hello.py', content: 'print("hi")' } },
  { type: 'action_end', id: 2, ok: true, output: 'Created hello.py (1 lines).', meta: { path: 'hello.py' } },
  { type: 'action_start', id: 3, tool: 'run', args: { command: 'python3 hello.py' } },
  { type: 'action_end', id: 3, ok: true, output: 'hi', meta: { exit: 0 } },
  { type: 'assistant_start', id: 4 },
  { type: 'assistant_end', id: 4, text: 'Fait.', thinking: '', hasActions: false },
  { type: 'final', text: 'Fait.' },
  { type: 'turn_end', reason: 'done' },
  { type: 'user_message', text: 'Ajoute un test' },
  { type: 'compaction', before: 9000, after: 2000, removed: 12, summary: '...' },
  { type: 'assistant_start', id: 5 },
  { type: 'assistant_end', id: 5, text: '', thinking: '', hasActions: true },
  { type: 'action_start', id: 6, tool: 'read', args: { path: 'hello.py' } },
  { type: 'action_end', id: 6, ok: true, output: '1| print("hi")', meta: { path: 'hello.py', lines: '1-1' } },
  { type: 'action_start', id: 7, tool: 'run', args: { command: 'pytest -q' }, auto: true },
  { type: 'action_end', id: 7, ok: false, output: '1 failed', meta: { exit: 1 } },
];

test('the model history is rebuilt from the transcript', () => {
  const h = rebuildHistory(events);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(h[0].content, 'Crée hello.py');
  assert.match(h[1].content, /^<reasoning>\nneed a file\n<\/reasoning>\nJe le crée\.\n<write path="hello\.py">\nprint\("hi"\)\n<\/write>\n<run>python3 hello\.py<\/run>$/);
  assert.match(h[2].content, /<result tool="write" path="hello\.py">\nCreated hello\.py/);
  assert.match(h[2].content, /<result tool="run" exit="0" command="python3 hello\.py">\nhi\n<\/result>/);
  assert.equal(h[3].content, 'Fait.');
  assert.equal(h[4].content, 'Ajoute un test');
  assert.equal(h[5].content, '<read path="hello.py" />');
  assert.match(h[6].content, /<result tool="read"[^>]*>\n1\| print/);
  assert.match(h[6].content, /<result tool="run" exit="1" command="pytest -q">\n1 failed/);
});

test('rebuilt actions parse back to the same actions', () => {
  for (const [tool, args] of [['write', { path: 'a.py', content: 'x = "1"' }], ['run', { command: 'ls -la' }], ['read', { path: 'a.py', start: '3', end: '9' }], ['search', { pattern: 'foo', path: 'src' }], ['web_search', { query: 'node lts' }]]) {
    const a = parseActions(actionTag(tool, args)).actions[0];
    assert.equal(a.tool, tool);
    for (const [k, v] of Object.entries(args)) assert.equal(a.args[k], v, `${tool}.${k}`);
  }
});

test('migration: exact checkpoint when the message is still in the history, rebuild otherwise', () => {
  const conv = {
    events: structuredClone(events),
    // After a compaction, only the 2nd request is still verbatim.
    messages: [{ role: 'user', content: '[CONTEXT SUMMARY — ...]' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Ajoute un test' }, { role: 'assistant', content: '<read path="hello.py" />' }],
  };
  assert.equal(migrateLegacy(conv), true);
  const ids = conv.events.filter((e) => e.type === 'user_message').map((e) => e.turnId);
  assert.deepEqual(ids, ['legacy-0', 'legacy-11']);
  assert.deepEqual(conv.checkpoints, [
    { turnId: 'legacy-0', rebuild: true },
    { turnId: 'legacy-11', archive: null, length: 2, untested: false },
  ]);
  assert.equal(migrateLegacy(conv), false, 'idempotent');
});

test('rewinding to a rebuilt checkpoint restores the rebuilt history', async () => {
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-legacy-')), config: { model: 'm' } });
  const conv = { events: structuredClone(events), messages: [{ role: 'user', content: 'x' }] };
  migrateLegacy(conv);
  agent.messages = conv.messages;
  agent.checkpoints = conv.checkpoints;
  const at = conv.events.findIndex((e) => e.turnId === 'legacy-11');
  agent.rewind('legacy-11', { rebuilt: rebuildHistory(conv.events.slice(0, at)) });
  assert.deepEqual(agent.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(agent.checkpoints, [{ turnId: 'legacy-0', rebuild: true }]);
  assert.throws(() => agent.rewind('legacy-0'), /Rebuilt history required/);
});

test('a message whose rewind point was lost (crash) can still be edited: history rebuilt', async () => {
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-legacy-')), config: { model: 'm' } });
  const evs = [
    { type: 'user_message', text: 'Crée hello.py', turnId: 't1' },
    ...events.slice(1, 9),
    { type: 'user_message', text: 'Récapitule', turnId: 't2' }, // saved without its checkpoint
  ];
  agent.messages = [{ role: 'user', content: 'x' }];
  agent.checkpoints = [{ turnId: 't1', archive: null, length: 0, untested: false }, { kind: 'action', actIds: [2], length: 1 }];
  assert.throws(() => agent.rewind('t2'), /point de reprise/);
  const before = evs.slice(0, -1);
  agent.rewind('t2', { rebuilt: rebuildHistory(before), keepTurnIds: new Set(['t1']) });
  assert.deepEqual(agent.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(agent.checkpoints, [{ turnId: 't1', rebuild: true }]);
});

// ---------- resuming from an old action (no resume point) ----------
import { rebuildForAction } from '../src/agent/rebuild.js';
import http from 'node:http';

test('the resume state of an old action is rebuilt from the transcript', () => {
  // Action 3 (run) comes after action 2 (write) in the same message.
  const r = rebuildForAction(events, 3);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(r.messages[1].content, /<write path="hello\.py">[\s\S]*<run>python3 hello\.py<\/run>$/);
  assert.equal(r.priorResults.length, 1);
  assert.match(r.priorResults[0], /<result tool="write" path="hello\.py">\nCreated hello\.py/);
  assert.deepEqual(r.remaining, [{ tool: 'run', args: { command: 'python3 hello.py' } }]);
  assert.equal(r.cutAt, events.findIndex((e) => e.type === 'action_start' && e.id === 3));
  assert.equal(r.currentTask, 'Crée hello.py');
  assert.equal(r.turnStartIndex, 0);

  // Action 6 (read) in the second request; the app's own check (7) is not re-run.
  const r2 = rebuildForAction(events, 6);
  assert.deepEqual(r2.remaining, [{ tool: 'read', args: { path: 'hello.py' } }]);
  assert.equal(r2.priorResults.length, 0);
  assert.equal(r2.currentTask, 'Ajoute un test');
  assert.equal(r2.messages[r2.turnStartIndex].content, 'Ajoute un test');
  assert.equal(r2.messages.at(-1).content, '<read path="hello.py" />');
  assert.equal(rebuildForAction(events, 999), null);
});

test('an old failed action is re-run and the agent goes on', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-legacy-'));
  const old = [
    { type: 'user_message', text: 'Que contient a.txt ?' },
    { type: 'assistant_start', id: 1 },
    { type: 'assistant_end', id: 1, text: 'Je lis.', thinking: '' },
    { type: 'action_start', id: 2, tool: 'read', args: { path: 'a.txt' } },
    { type: 'action_end', id: 2, ok: false, output: 'File "a.txt" does not exist.', meta: { path: 'a.txt' } },
    { type: 'assistant_start', id: 3 },
    { type: 'assistant_end', id: 3, text: 'Impossible.', thinking: '' },
    { type: 'turn_end', reason: 'done' },
  ];
  await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      const content = /1\| A/.test(data.messages.at(-1).content) ? 'Contenu : A' : 'Impossible.';
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm' } });
  const evs = [];
  agent.on('event', (e) => evs.push(e));
  await agent.resumeFromRebuilt(rebuildForAction(old, 2));
  server.close();
  assert.deepEqual(evs.filter((e) => e.type === 'action_start').map((e) => e.tool), ['read']);
  assert.equal(evs.find((e) => e.type === 'final').text, 'Contenu : A');
  assert.deepEqual(requests[0].messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /does not exist/);
});
