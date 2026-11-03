import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { changesNote, citedLines, nearestPaths, projectSnapshot } from '../src/agent/hints.ts';
import { cfg, port } from './helpers.ts';
import type { Fake, ModelRequest, Reply } from './helpers.ts';
import type { AgentEvent, Config, EventOf } from '../src/types.ts';

function fake(reply: Reply<string>) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body) as ModelRequest;
      requests.push(r);
      res.end(`${JSON.stringify({ message: { content: reply(r, requests.length) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise<Fake>((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${port(server)}` })));
}

async function project(files: Record<string, string>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-hints-'));
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(cwd, f)), { recursive: true });
    await fs.writeFile(path.join(cwd, f), text);
  }
  return cwd;
}

async function agentWith(reply: Reply<string>, files: Record<string, string>, config: Partial<Config> = {}) {
  const f = await fake(reply);
  const cwd = await project(files);
  const agent = new Agent({ cwd, config: cfg({ baseUrl: f.url, model: 'm', approval: 'auto', ...config }) });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  return { f, cwd, agent, events };
}

const lastUser = (r: ModelRequest) => r.messages.filter((m) => m.role === 'user').at(-1)!.content;

test('files changed between two messages, not by the agent, are said with the next one', async () => {
  const { f, cwd, agent, events } = await agentWith((r) => (/first/.test(lastUser(r)) && !/<result/.test(lastUser(r)) ? '<write path="mine.txt">\nby the agent\n</write>' : 'Done.'), { 'a.txt': 'one', 'gone.txt': 'x' });
  try {
    await agent.send('first');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'changed by the user');
    await fs.writeFile(path.join(cwd, 'new.txt'), 'new');
    await fs.rm(path.join(cwd, 'gone.txt'));
    await agent.send('second');
    await agent.send('third');
  } finally {
    f.server.close();
  }
  const second = f.requests.find((r) => /second/.test(lastUser(r)))!;
  assert.match(lastUser(second), /Files changed in the project since your last answer, not by you: a\.txt \(modified\), new\.txt \(new\), gone\.txt \(deleted\)\./);
  assert.doesNotMatch(lastUser(second), /mine\.txt/); // (written by the agent itself)
  assert.doesNotMatch(lastUser(f.requests.find((r) => /third/.test(lastUser(r)))!), /Files changed/); // (nothing since)
  const hints = events.filter((e): e is EventOf<'hint'> => e.type === 'hint');
  assert.deepEqual(hints.map((h) => h.kind), ['changes']);
  assert.match(hints[0].text, /a\.txt, new\.txt, gone\.txt/);

  // The Git branch too.
  const before = { files: new Map([['a', '1']]), branch: 'main', complete: true };
  assert.match(changesNote(before, { ...before, branch: 'feature' })!.text, /The Git branch changed: main → feature\./);
  assert.equal(changesNote(before, before), null);
});

test('the file open in the viewer is said once, its selection with each message', async () => {
  const { f, agent, events } = await agentWith(() => 'Done.', { 'src/x.ts': 'const a = 1;\n' });
  try {
    await agent.send('what is this', { viewing: { path: 'src/x.ts', visible: [1, 40] } });
    await agent.send('and now', { viewing: { path: 'src/x.ts', visible: [10, 50] } });
    await agent.send('this line?', { viewing: { path: 'src/x.ts', selection: { text: 'const a = 1;', start: 1, end: 1 } } });
    await agent.send('nothing open');
  } finally {
    f.server.close();
  }
  const user = (re: RegExp) => lastUser(f.requests.find((r) => re.test(lastUser(r)))!);
  assert.match(user(/what is this/), /\(The user has src\/x\.ts open in the viewer, lines 1-40 on screen\.\)/);
  assert.doesNotMatch(user(/and now/), /open in the viewer/);
  assert.match(user(/this line\?/), /with lines 1-1 selected:\nconst a = 1;\n\)/);
  assert.doesNotMatch(user(/nothing open/), /viewer/);
  assert.deepEqual(events.filter((e): e is EventOf<'hint'> => e.type === 'hint').map((h) => h.text), [
    'Fichier ouvert transmis à l’agent : src/x.ts, lignes 1-40',
    'Sélection transmise à l’agent : src/x.ts, lignes 1-1',
  ]);
});

test('a path that does not exist comes with the closest ones', async () => {
  const cwd = await project({ 'src/agent/agent.ts': '', 'src/agent/agents.md': '', 'test/agent.test.ts': '', 'other/far.txt': '' });
  assert.deepEqual(await nearestPaths(cwd, 'src/agnt.ts'), ['src/agent/agent.ts']);
  assert.equal((await nearestPaths(cwd, 'agent.js'))[0], 'src/agent/agent.ts'); // (another extension)
  assert.deepEqual(await nearestPaths(cwd, 'src/agen', { dirs: true }), ['src/agent']);
  assert.deepEqual(await nearestPaths(cwd, 'completely-different.py'), []);

  const { f, agent } = await agentWith((r) => (/<result/.test(lastUser(r)) ? 'Done.' : '<read path="agent.ts" />'), { 'src/agent/agent.ts': 'x' });
  try { await agent.send('read it'); } finally { f.server.close(); }
  assert.match(lastUser(f.requests[1]), /File "agent\.ts" does not exist\. Did you mean "src\/agent\/agent\.ts"\?/);
});

test('a failed command shows the lines its output points at', async () => {
  const cwd = await project({ 'src/a.ts': 'one\ntwo\nthree\nfour\nfive\nsix\n', 'app.py': 'import x\nboom()\n' });
  const out = 'src/a.ts(3,5): error TS1: bad\n  File "app.py", line 2, in <module>\nnode_modules/x/y.js:1:1\nsrc/missing.ts:4:1\n';
  const cited = await citedLines(cwd, out);
  assert.match(cited, /^Lines cited in the output:\napp\.py:2\n 1\| import x\n>2\| boom\(\)\n/m);
  assert.match(cited, /src\/a\.ts:3\n 1\| one\n 2\| two\n>3\| three\n 4\| four\n 5\| five/);
  assert.doesNotMatch(cited, /node_modules|missing/);
  assert.equal(await citedLines(cwd, 'all good'), '');

  const { f, agent } = await agentWith((r) => (/<result/.test(lastUser(r)) ? 'Done.' : '<run>echo "src/a.ts:2:1 error: no"; exit 1</run>'), { 'src/a.ts': 'one\ntwo\nthree\n' });
  try { await agent.send('build it'); } finally { f.server.close(); }
  assert.match(lastUser(f.requests[1]), /Lines cited in the output:\nsrc\/a\.ts:2\n 1\| one\n>2\| two\n 3\| three\nThe command failed/);
});

test('an action done again while its result is in view and nothing changed is not run again', async () => {
  const steps = ['<read path="a.txt" />', '<read path="./a.txt" />', '<list path="." />', '<list path="." />', '<write path="b.txt">\nb\n</write>', '<list path="." />', 'Done.'];
  const { f, cwd, agent, events } = await agentWith((_, n) => steps[n - 1] ?? 'Done.', { 'a.txt': 'hello' });
  try { await agent.send('look around'); } finally { f.server.close(); }
  const result = (n: number) => f.requests[n].messages.at(-1)!.content;
  assert.match(result(1), /hello/);
  assert.match(result(2), /You already read this at step 1, and the file has not changed since/);
  assert.doesNotMatch(result(2), /hello/);
  assert.match(result(4), /You already did exactly this at step 3, and nothing changed since/);
  assert.match(result(6), /b\.txt/); // (a file was written since: listed again)
  assert.equal(events.filter((e) => e.type === 'action_end' && e.meta?.reused).length, 2);

  // A file changed since it was read: read again, in the next message too.
  const again = await agentWith((r) => (/<result/.test(lastUser(r)) ? 'Done.' : '<read path="a.txt" />'), { 'a.txt': 'hello' });
  try {
    await again.agent.send('read a');
    await again.agent.send('read a again');
    await fs.writeFile(path.join(again.cwd, 'a.txt'), 'hello world, longer');
    await again.agent.send('and once more');
  } finally { again.f.server.close(); }
  const reads = again.f.requests.filter((r) => /<result tool="read"/.test(lastUser(r))).map(lastUser);
  assert.match(reads[1], /You already read this earlier in this conversation/);
  assert.match(reads[2], /hello world, longer/);
  void cwd;
});

test('near the step limit, the model is told how many are left, once', async () => {
  const { f, agent } = await agentWith((_, n) => `<read path="f${n}.txt" />`, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i + 1}.txt`, `file ${i + 1}`])), { maxSteps: 15 });
  try { await agent.send('read them all'); } finally { f.server.close(); }
  const told = f.requests.map((r, i) => [i, /steps left for this message/.test(r.messages.at(-1)!.content)] as const).filter(([, t]) => t);
  assert.deepEqual(told.map(([i]) => i), [10]); // (after step 10 of 15: 5 left)
  assert.match(f.requests[10].messages.at(-1)!.content, /\(5 steps left for this message: finish now, or end with what is done and what remains to do\.\)/);
});

test('a snapshot does not report what it could not see', async () => {
  const cwd = await project({ 'a.txt': '1' });
  const s = await projectSnapshot(cwd);
  assert.equal(s.complete, true);
  assert.equal(s.branch, null);
  assert.equal(changesNote({ ...s, complete: false }, { files: new Map(), branch: null, complete: true }), null); // (deleted? not known)
});
