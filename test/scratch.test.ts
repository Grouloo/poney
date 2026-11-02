import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeAction, scratchCommand } from '../src/agent/tools.ts';
import { buildSystemPrompt } from '../src/agent/protocol.ts';
import { listDir, readFileForViewer } from '../src/files.ts';
import { Agent } from '../src/agent/agent.ts';
import { cfg, port } from './helpers.ts';
import type { Fake, ModelRequest } from './helpers.ts';
import type { EventOf } from '../src/types.ts';

// The private folder's real path has a space, as under "Application Support".
async function folders() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-scratch-'));
  const cwd = path.join(root, 'project');
  const scratch = path.join(root, 'App Support', 'scratch', 'conv1');
  await fs.mkdir(cwd);
  return { cwd, scratch };
}

test('.poney/ paths go to the private folder, outside the project', async () => {
  const { cwd, scratch } = await folders();
  const ctx = { cwd, scratch, config: cfg() };
  const w = await executeAction({ tool: 'write', args: { path: '.poney/notes.md', content: 'port 8080\n' } }, ctx);
  assert.equal(w.ok, true, w.output);
  assert.equal(w.changed, '.poney/notes.md');
  assert.equal(await fs.readFile(path.join(scratch, 'notes.md'), 'utf8'), 'port 8080\n');
  await assert.rejects(fs.access(path.join(cwd, '.poney')));

  const r = await executeAction({ tool: 'read', args: { path: './.poney/notes.md' } }, ctx);
  assert.match(r.output, /1\| port 8080/);
  assert.equal(r.meta.path, '.poney/notes.md');
  const l = await executeAction({ tool: 'list', args: { path: '.poney' } }, ctx);
  assert.equal(l.output, 'notes.md');
  const s = await executeAction({ tool: 'search', args: { pattern: '8080', path: '.poney' } }, ctx);
  assert.equal(s.output, '.poney/notes.md:1: port 8080');
  const k = await executeAction({ tool: 'search', args: { query: 'port', path: '.poney' } }, ctx);
  assert.match(k.output, /\n\.poney\/notes\.md \(/);
  const e = await executeAction({ tool: 'edit', args: { path: '.poney/notes.md', body: '<old>port 8080</old><new>port 9090</new>' } }, ctx);
  assert.equal(e.ok, true, e.output);
  assert.equal(await fs.readFile(path.join(scratch, 'notes.md'), 'utf8'), 'port 9090\n');

  const out = await executeAction({ tool: 'write', args: { path: '.poney/../../escape.txt', content: 'x' } }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.output, /outside \.poney\//);
});

test('an unused private folder lists as empty; without one, .poney is a project path', async () => {
  const { cwd, scratch } = await folders();
  const l = await executeAction({ tool: 'list', args: { path: '.poney' } }, { cwd, scratch, config: cfg() });
  assert.equal(l.output, '(empty folder)');
  const w = await executeAction({ tool: 'write', args: { path: '.poney/a.txt', content: 'a' } }, { cwd, config: cfg() });
  assert.equal(w.ok, true);
  assert.equal(await fs.readFile(path.join(cwd, '.poney', 'a.txt'), 'utf8'), 'a\n');
});

test('scratchCommand quotes the real path for where .poney stands', () => {
  const dir = "/a b/it's";
  assert.equal(scratchCommand('python3 .poney/x.py', dir, false), `python3 '/a b/it'\\''s'/x.py`);
  assert.equal(scratchCommand('cat "./.poney/x y.txt"', dir, false), `cat "/a b/it's/x y.txt"`);
  assert.equal(scratchCommand("ls '.poney'", dir, false), `ls '/a b/it'\\''s'`);
  assert.equal(scratchCommand('echo hi > .poney/out.txt && ls .poney', '/s', false), `echo hi > '/s'/out.txt && ls '/s'`);
  // Not a path of its own: left alone.
  assert.equal(scratchCommand('ls src/.poney a.poney .poneyrc', '/s', false), 'ls src/.poney a.poney .poneyrc');
  assert.equal(scratchCommand('echo \\.poney', '/s', false), 'echo \\.poney');
  assert.equal(scratchCommand('type .poney\\x.txt', 'C:\\a b', true), 'type .poney\\x.txt');
  assert.equal(scratchCommand('type .poney/x.txt', 'C:\\a b', true), 'type "C:\\a b"/x.txt');
});

test('commands reach the private folder, and see its path as .poney', async () => {
  const { cwd, scratch } = await folders();
  const ctx = { cwd, scratch, config: cfg({ commandTimeout: 20 }) };
  const r = await executeAction({ tool: 'run', args: { command: 'echo hello > .poney/out.txt && cat .poney/out.txt && echo "$PONEY_TMP" && pwd' } }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(await fs.readFile(path.join(scratch, 'out.txt'), 'utf8'), 'hello\n');
  const lines = r.output.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['hello', '.poney']);
  assert.equal(await fs.realpath(lines[2]), await fs.realpath(cwd)); // (commands still run in the project)
});

test('the file browser shows the private folder first, once used', async () => {
  const { cwd, scratch } = await folders();
  await fs.writeFile(path.join(cwd, 'a.py'), 'x');
  assert.deepEqual((await listDir(cwd, '.', scratch)).map((e) => e.path), ['a.py']);
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, 'notes.md'), 'n');
  const root = await listDir(cwd, '.', scratch);
  assert.deepEqual(root.map((e) => [e.path, e.scratch]), [['.poney', true], ['a.py', false]]);
  assert.deepEqual((await listDir(cwd, '.poney', scratch)).map((e) => e.path), ['.poney/notes.md']);
  const f = await readFileForViewer(cwd, '.poney/notes.md', scratch);
  assert.equal(f.kind === 'text' && f.content, 'n');
});

test('the system prompt names .poney/ only when there is a private folder', () => {
  const base = { cwd: '/p', platform: 'darwin arm64' };
  assert.match(buildSystemPrompt({ ...base, scratch: true }), /\.poney\/ is your private folder/);
  assert.doesNotMatch(buildSystemPrompt(base), /\.poney/);
  assert.doesNotMatch(buildSystemPrompt({ ...base, scratch: true, offProject: true }), /\.poney/);
});

function fakeOllama(replies: string[]) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body) as ModelRequest);
      res.end(`${JSON.stringify({ message: { content: replies.shift() ?? 'Done.' }, done: true })}\n`);
    });
  });
  return new Promise<Fake>((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${port(server)}` })));
}

test('agent: notes written in .poney/ land in the conversation folder, for its sub-agents too', async () => {
  const { cwd, scratch } = await folders();
  const fake = await fakeOllama([
    '<write path=".poney/plan.md">\nstep 1\n</write>',
    '<agent title="lecteur">\nRead .poney/plan.md and report it.\n</agent>',
    '<read path=".poney/plan.md" />',
    'It says step 1.',
    'Done.',
  ]);
  const agent = new Agent({ cwd, scratch, config: cfg({ baseUrl: fake.url, model: 'fake', approval: 'auto', shellEnabled: false, subagentsEnabled: true }) });
  const ends: EventOf<'action_end'>[] = [];
  agent.on('event', (e) => e.type === 'action_end' && ends.push(e));
  await agent.send('plan it');
  fake.server.close();
  assert.equal(await fs.readFile(path.join(scratch, 'plan.md'), 'utf8'), 'step 1\n');
  await assert.rejects(fs.access(path.join(cwd, '.poney')));
  assert.match(fake.requests[0].messages[0].content, /\.poney\/ is your private folder/);
  const read = ends.find((e) => e.meta.path === '.poney/plan.md' && /1\| step 1/.test(e.output));
  assert.ok(read, 'the sub-agent read the note');
});
