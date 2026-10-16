import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseActions, parseEditBody } from '../src/agent/protocol.js';
import { executeAction } from '../src/agent/tools.js';
import { unifiedDiff } from '../src/agent/diff.js';

test('parses write + run with prose', () => {
  const { actions, text } = parseActions('I will create it.\n<write path="a.py">\n```python\nprint("<hi>")\n```\n</write>\n<run>python3 a.py</run>');
  assert.equal(text, 'I will create it.');
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].args, { path: 'a.py', content: 'print("<hi>")' });
  assert.equal(actions[1].args.command, 'python3 a.py');
});

test('accepts aliases, child-tag args, unquoted attrs and missing self-close', () => {
  const r1 = parseActions('<read_file><path>src/x.js</path></read_file>');
  assert.deepEqual(r1.actions[0], { ...r1.actions[0], tool: 'read', args: { path: 'src/x.js' } });
  const r2 = parseActions('<read path=src/x.js>\nthen something');
  assert.equal(r2.actions[0].args.path, 'src/x.js');
  const r3 = parseActions('<list>');
  assert.equal(r3.actions[0].tool, 'list');
  const r4 = parseActions('<bash>ls -la</bash>');
  assert.equal(r4.actions[0].tool, 'run');
});

test('web_search is not confused with search', () => {
  const { actions } = parseActions('<web_search>node 24 release</web_search>');
  assert.equal(actions[0].tool, 'web_search');
  assert.equal(actions[0].args.query, 'node 24 release');
});

test('incomplete write while streaming', () => {
  const partial = parseActions('<write path="a.py">\nprint(1)', { final: false });
  assert.equal(partial.actions[0].complete, false);
  const done = parseActions('<run>ls</run>', { final: false });
  assert.equal(done.actions[0].complete, true);
});

test('edit body formats', () => {
  assert.deepEqual(parseEditBody('<old>a</old>\n<new>b</new><old>c</old><new>d</new>'), [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }]);
  assert.deepEqual(parseEditBody('<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE'), [{ old: 'x = 1', new: 'x = 2' }]);
});

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lcx-'));
}

test('edit tolerates wrong indentation and reindents', async () => {
  const cwd = await tmpdir();
  await fs.writeFile(path.join(cwd, 'm.py'), 'def f():\n    x = 1\n    return x\n');
  const r = await executeAction({ tool: 'edit', args: { path: 'm.py', body: '<old>\nx = 1\nreturn x\n</old>\n<new>\nx = 2\nif x:\n    return x\n</new>' } }, { cwd, config: {} });
  assert.equal(r.ok, true, r.output);
  assert.equal(await fs.readFile(path.join(cwd, 'm.py'), 'utf8'), 'def f():\n    x = 2\n    if x:\n        return x\n');
});

test('edit failure shows closest lines', async () => {
  const cwd = await tmpdir();
  await fs.writeFile(path.join(cwd, 'm.py'), 'a = 1\nb = 2\nc = 3\n');
  const r = await executeAction({ tool: 'edit', args: { path: 'm.py', body: '<old>b = 2\nc = 4</old><new>z</new>' } }, { cwd, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.output, /Closest lines/);
  assert.match(r.output, /2\| b = 2/);
});

test('write reports syntax errors and paths cannot escape', async () => {
  const cwd = await tmpdir();
  const r = await executeAction({ tool: 'write', args: { path: 'bad.py', content: 'def f(:\n  pass' } }, { cwd, config: {} });
  assert.match(r.output, /syntax error/i);
  assert.equal(r.ok, false);
  const esc = await executeAction({ tool: 'read', args: { path: '../../etc/passwd' } }, { cwd, config: {} });
  assert.match(esc.output, /outside the project/);
});

test('run captures exit code', async () => {
  const cwd = await tmpdir();
  const r = await executeAction({ tool: 'run', args: { command: 'echo hi && exit 3' } }, { cwd, config: { commandTimeout: 10 }, maxResultChars: 1000 });
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /hi/);
});

test('diff', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f');
  assert.match(d, /-b\n\+B/);
});

test('disabled tools are removed from the prompt', async () => {
  const { buildSystemPrompt, isToolEnabled } = await import('../src/agent/protocol.js');
  const full = buildSystemPrompt({ cwd: '/p', platform: 'x' });
  assert.match(full, /<run>/);
  assert.match(full, /<web_search>/);
  const bare = buildSystemPrompt({ cwd: '/p', platform: 'x', shell: false, web: false });
  assert.doesNotMatch(bare, /<run>|<web_search>|<fetch>/);
  assert.match(bare, /CANNOT run commands/);
  assert.equal(isToolEnabled('run', { shellEnabled: false }), false);
  assert.equal(isToolEnabled('fetch', { webEnabled: false }), false);
  assert.equal(isToolEnabled('write', { shellEnabled: false, webEnabled: false }), true);
  assert.equal(isToolEnabled('run', {}), true);
});
