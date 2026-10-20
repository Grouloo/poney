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

// Regression: a model talking about the tools looped on "Missing path" (gemma-4).
test('tool names mentioned in prose are not calls, and do not swallow the real call', () => {
  const cases = [
    ['It seems like there was a parsing error. I will rewrite the file again using the `<write>` tag.\n<write path="src/main.py">\nprint(1)\n</write>', 'write', 'src/main.py'],
    ['Since the environment seems to have trouble parsing the <write> tag, let me look.\n<run>cat src/main.py</run>', 'run', undefined],
    ['The edit failed, so I decided to use <edit> again.\n<read path="a.py" />', 'read', 'a.py'],
    ['Use `<read path="x" />` to read. Now:\n<list />', 'list', undefined],
  ];
  for (const [text, tool, p] of cases) {
    const { actions, text: prose } = parseActions(text);
    assert.equal(actions.length, 1, text);
    assert.equal(actions[0].tool, tool);
    assert.equal(actions[0].args.path, p);
    assert.ok(prose.length > 20, 'the explanation stays visible');
  }
});

test('real calls keep working: mid-line closed, fenced, child-tag path, line start', () => {
  assert.equal(parseActions('Checking: <run>ls -la</run>').actions[0].args.command, 'ls -la');
  assert.equal(parseActions('```xml\n<write path="a.py">\nx = 1\n</write>\n```').actions[0].args.content, 'x = 1');
  assert.equal(parseActions('<write>\n<path>a.py</path>\nx\n</write>').actions[0].args.path, 'a.py');
  assert.equal(parseActions('<web_search>node lts</web_search>').actions[0].args.query, 'node lts');
});

test('a real write without path gets the exact format back', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-'));
  const r = await executeAction({ tool: 'write', args: { content: 'x' } }, { cwd, config: {} });
  assert.equal(r.ok, false);
  assert.match(r.output, /path="\.\.\."/);
  assert.match(r.output, /<write path="dir\/file\.py">/);
});

// Regression: a multi-line command glued to the end of a sentence was taken for a mention.
test('a call glued to a sentence and spanning lines is a real call', () => {
  const t = 'I will check the configuration files.<run>curl -X POST http://localhost:8081/v1/chat/completions \\\n-H "Content-Type: application/json" \\\n-d \'{\n"messages": [{"role": "user", "content": "Hello!"}]\n}\'</run>';
  const { actions } = parseActions(t);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].tool, 'run');
  assert.match(actions[0].args.command, /^curl -X POST[\s\S]*"Hello!"[\s\S]*\}'$/);
});

test('edit on a file with Windows line endings: matched with "\\n", written back with "\\r\\n"', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-crlf-'));
  await fs.writeFile(path.join(cwd, 'w.py'), 'def f():\r\n    a = 1\r\n    return a\r\n');
  const r = await executeAction({ tool: 'edit', args: { path: 'w.py', body: '<old>    a = 1\n    return a</old><new>    a = 2\n    b = 3\n    return a + b</new>' } }, { cwd, config: {} });
  assert.equal(r.ok, true, r.output);
  assert.equal(await fs.readFile(path.join(cwd, 'w.py'), 'utf8'), 'def f():\r\n    a = 2\r\n    b = 3\r\n    return a + b\r\n');
});

test('relative paths use "/" whatever the system', async () => {
  const { resolveInside } = await import('../src/agent/tools.js');
  assert.equal(resolveInside('/proj', 'src/sub/a.py').rel, 'src/sub/a.py');
  assert.throws(() => resolveInside('/proj', '../x'), /outside/);
});
