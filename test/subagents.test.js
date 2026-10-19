import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { executeAction } from '../src/agent/tools.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-sub-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake Ollama playing the orchestrator and its sub-agents (told apart by the
 * system prompt). `orchestrator(n)` and `sub(task, n)` return the reply text.
 */
function fakeModel({ orchestrator, sub, subDelayMs = 300 }) {
  const requests = [];
  let inflight = 0;
  let maxInflight = 0;
  const subTurns = new Map();
  let orchTurn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const data = JSON.parse(body);
      requests.push(data);
      const isSub = data.messages[0].content.startsWith('You are a sub-agent');
      let content;
      if (isSub) {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep(subDelayMs);
        inflight--;
        const task = data.messages.find((m) => m.role === 'user').content;
        const n = (subTurns.get(task) || 0) + 1;
        subTurns.set(task, n);
        content = sub(task, n, data);
      } else {
        content = orchestrator(++orchTurn, data);
      }
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    server, requests, url: `http://localhost:${server.address().port}`, max: () => maxInflight,
  })));
}

const twoTasks = '<agent title="A">\nCreate a.txt containing A\n</agent>\n<agent title="B">\nCreate b.txt containing B\n</agent>';
const writer = (task, n) => {
  const name = task.includes('a.txt') ? 'a' : 'b';
  return n === 1 ? `<write path="${name}.txt">\n${name.toUpperCase()}\n</write>` : `Report ${name.toUpperCase()}: created ${name}.txt.`;
};

for (const [limit, expectedMax] of [[2, 2], [1, 1]]) {
  test(`two sub-agents, limit ${limit}: work done, reports returned, ${expectedMax} at a time`, async () => {
    const cwd = await tmp();
    const m = await fakeModel({ orchestrator: (n) => (n === 1 ? twoTasks : 'Both done.'), sub: writer });
    const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', maxParallelAgents: limit, shellEnabled: false } });
    const events = [];
    agent.on('event', (e) => events.push(e));
    await agent.send('Create a.txt and b.txt in parallel');
    m.server.close();
    assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'A\n');
    assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'B\n');
    assert.equal(m.max(), expectedMax);
    const back = m.requests.filter((r) => !r.messages[0].content.startsWith('You are a sub-agent')).at(-1);
    const results = back.messages.at(-1).content;
    assert.match(results, /<result tool="agent" title="A" status="done">\nReport A: created a\.txt\./);
    assert.match(results, /<result tool="agent" title="B" status="done">\nReport B: created b\.txt\./);
    assert.equal(events.find((e) => e.type === 'final' && !e.agentId)?.text, 'Both done.');
    // Sub-agent events are tagged with their card, for the UI.
    const cardsIds = events.filter((e) => e.type === 'action_start' && e.tool === 'agent').map((e) => e.id);
    assert.equal(cardsIds.length, 2);
    assert.ok(events.some((e) => e.agentId === cardsIds[0] && e.type === 'action_start' && e.tool === 'write'));
  });
}

test('sub-agents cannot start sub-agents', async () => {
  const cwd = await tmp();
  const m = await fakeModel({
    orchestrator: (n) => (n === 1 ? '<agent title="X">\nDo X\n</agent>' : 'ok'),
    sub: (task, n) => (n === 1 ? '<agent title="Y">\nDo Y\n</agent>' : 'Did X myself.'),
    subDelayMs: 0,
  });
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', shellEnabled: false } });
  await agent.send('go');
  m.server.close();
  const subRequests = m.requests.filter((r) => r.messages[0].content.startsWith('You are a sub-agent'));
  assert.doesNotMatch(subRequests[0].messages[0].content, /<agent/, 'no agent tool in the sub-agent prompt');
  assert.match(subRequests[1].messages.at(-1).content, /Sub-agents are disabled/);
});

test('a file changed by another agent since it was read cannot be overwritten without reading it again', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'x.py'), 'x = 1\n');
  const shared = { versions: new Map(), locks: new Map() };
  const a = { cwd, config: {}, shared, readVersions: new Map(), seenFiles: new Set(['x.py']) };
  const b = { cwd, config: {}, shared, readVersions: new Map(), seenFiles: new Set(['x.py']) };
  await executeAction({ tool: 'read', args: { path: 'x.py' } }, a);
  await executeAction({ tool: 'read', args: { path: 'x.py' } }, b);
  const wb = await executeAction({ tool: 'edit', args: { path: 'x.py', body: '<old>x = 1</old><new>x = 2</new>' } }, b);
  assert.equal(wb.ok, true);
  const wa = await executeAction({ tool: 'write', args: { path: 'x.py', content: 'x = 99\n' } }, a);
  assert.equal(wa.ok, false);
  assert.match(wa.output, /changed by another agent/);
  assert.equal(await fs.readFile(path.join(cwd, 'x.py'), 'utf8'), 'x = 2\n');
  await executeAction({ tool: 'read', args: { path: 'x.py' } }, a); // reads again: allowed now
  assert.equal((await executeAction({ tool: 'write', args: { path: 'x.py', content: 'x = 3\n' } }, a)).ok, true);
});

test('stopping the main agent stops its sub-agents', async () => {
  const cwd = await tmp();
  const m = await fakeModel({ orchestrator: () => twoTasks, sub: writer, subDelayMs: 5000 });
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', shellEnabled: false } });
  let end;
  agent.on('event', (e) => {
    if (e.type === 'action_start' && e.tool === 'agent') setTimeout(() => agent.stop(), 200);
    if (e.type === 'turn_end' && !e.agentId) end = e;
  });
  const t0 = Date.now();
  await agent.send('go');
  m.server.closeAllConnections?.();
  m.server.close();
  assert.equal(end.reason, 'stopped');
  assert.ok(Date.now() - t0 < 4000, 'did not wait for the sub-agents');
});

test('several sub-agents in one native call (tasks list), Gemma or JSON syntax', async () => {
  const { parseActions } = await import('../src/agent/protocol.js');
  const gemma = '<|tool_call>call:agent{tasks:[{title:<|"|>A<|"|>,task:<|"|>Create a.py; test with "python3 a.py"<|"|>},{title:<|"|>B<|"|>,task:<|"|>Create b.py {simple}<|"|>}]}<tool_call|>';
  assert.deepEqual(parseActions(gemma).actions.map((a) => [a.tool, a.args.title, a.args.task]), [
    ['agent', 'A', 'Create a.py; test with "python3 a.py"'],
    ['agent', 'B', 'Create b.py {simple}'],
  ]);
  const json = '<tool_call>{"name": "agent", "arguments": {"tasks": [{"title": "X", "task": "do x"}, {"title": "Y", "task": "do y"}]}}</tool_call>';
  assert.deepEqual(parseActions(json).actions.map((a) => a.args.title), ['X', 'Y']);
});

test('a one-call tasks list runs in parallel', async () => {
  const cwd = await tmp();
  const m = await fakeModel({
    orchestrator: (n) => (n === 1 ? '<|tool_call>call:agent{tasks:[{title:<|"|>A<|"|>,task:<|"|>Create a.txt containing A<|"|>},{title:<|"|>B<|"|>,task:<|"|>Create b.txt containing B<|"|>}]}<tool_call|>' : 'Both done.'),
    sub: writer,
  });
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', shellEnabled: false } });
  await agent.send('go');
  m.server.close();
  assert.equal(m.max(), 2);
  assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'B\n');
});
