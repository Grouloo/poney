import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStatus, parseLog, gitStatus, gitDiff, gitSync } from '../src/git.js';

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);

function repo(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poney-git-'))) {
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.email', 'test@example.com');
  run(dir, 'config', 'user.name', 'Test');
  return dir;
}
function commit(dir, name, text, message = `add ${name}`) {
  write(dir, name, text);
  run(dir, 'add', name);
  run(dir, 'commit', '-q', '-m', message);
}
/** A repository cloned from a bare remote, with one commit pushed, and a second clone to work on the remote. */
function withRemote() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'poney-bare-'));
  run(bare, 'init', '-q', '--bare', '-b', 'main');
  const a = repo();
  commit(a, 'a.txt', 'a\n');
  run(a, 'remote', 'add', 'origin', bare);
  run(a, 'push', '-q', '-u', 'origin', 'main');
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'poney-other-'));
  run(b, 'clone', '-q', bare, '.');
  run(b, 'config', 'user.email', 'test@example.com');
  run(b, 'config', 'user.name', 'Test');
  return { a, b, bare };
}

test('the status separates the two sides of the index, renames and paths with spaces included', () => {
  const st = parseStatus([
    '# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
    '1 .M N... 100644 100644 100644 aaa bbb src/worktree.js',
    '1 MM N... 100644 100644 100644 aaa bbb both.js',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.js', 'old name.js',
    'u UU N... 100644 100644 100644 100644 a b c conflict.js',
    '',
  ].join('\0'));
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.deepEqual([st.ahead, st.behind], [2, 1]);
  assert.deepEqual(st.staged.map((f) => f.path), ['staged only.txt', 'both.js', 'new name.js']);
  assert.equal(st.staged[2].oldPath, 'old name.js');
  assert.deepEqual(st.unstaged.map((f) => [f.path, f.status]), [['src/worktree.js', 'M'], ['both.js', 'M'], ['conflict.js', 'U']]);
});

test('a detached head has no branch', () => {
  assert.equal(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch, null);
});

test('a commit subject can hold anything', () => {
  const [c] = parseLog('abc\0fix: a | b\0Ann\x001700000000\0\n');
  assert.deepEqual(c, { hash: 'abc', subject: 'fix: a | b', author: 'Ann', time: 1700000000000 });
});

test('outside a repository there is no status', async () => {
  assert.deepEqual(await gitStatus(fs.mkdtempSync(path.join(os.tmpdir(), 'poney-norepo-'))), { repo: false });
  assert.deepEqual(await gitStatus(''), { repo: false });
});

test('a repository without commits still has a status', async () => {
  const st = await gitStatus(repo());
  assert.equal(st.repo, true);
  assert.deepEqual(st.commits, []);
  assert.equal(st.hasRemote, false);
});

test('staged, tracked changes and history; untracked files are left out', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'one\n');
  commit(dir, 'b.txt', 'two\n');
  write(dir, 'a.txt', 'one changed\n');
  run(dir, 'add', 'a.txt');
  write(dir, 'b.txt', 'two changed\n');
  write(dir, 'new.txt', 'untracked\n');
  const st = await gitStatus(dir);
  assert.deepEqual(st.staged.map((f) => f.path), ['a.txt']);
  assert.deepEqual(st.unstaged.map((f) => f.path), ['b.txt']);
  assert.deepEqual(st.commits.map((c) => c.subject), ['add b.txt', 'add a.txt']);
});

test('the diff shows the side asked for', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'one\n');
  write(dir, 'a.txt', 'staged\n');
  run(dir, 'add', 'a.txt');
  write(dir, 'a.txt', 'worktree\n');
  assert.match((await gitDiff(dir, 'a.txt', { staged: true })).diff, /\+staged/);
  assert.match((await gitDiff(dir, 'a.txt')).diff, /-staged\n\+worktree/);
});

test('from a subfolder, the diff finds the paths of the status; names are taken literally', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  commit(dir, 'sub/x.txt', 'x\n');
  commit(dir, '*.txt', 'star\n');
  write(dir, 'sub/x.txt', 'x changed\n');
  write(dir, '*.txt', 'star changed\n');
  const st = await gitStatus(path.join(dir, 'sub'));
  assert.deepEqual(st.unstaged.map((f) => f.path).sort(), ['*.txt', 'sub/x.txt']);
  assert.match((await gitDiff(path.join(dir, 'sub'), 'sub/x.txt')).diff, /\+x changed/);
  const star = (await gitDiff(dir, '*.txt')).diff;
  assert.match(star, /\+star changed/);
  assert.doesNotMatch(star, /x changed/);
});

test('a staged rename shows as a rename', async () => {
  const dir = repo();
  commit(dir, 'old.txt', 'content\n'.repeat(5));
  run(dir, 'mv', 'old.txt', 'new.txt');
  const [f] = (await gitStatus(dir)).staged;
  assert.deepEqual([f.path, f.oldPath, f.status], ['new.txt', 'old.txt', 'R']);
  assert.match((await gitDiff(dir, f.path, { staged: true, oldPath: f.oldPath })).diff, /rename from old\.txt/);
});

test('the sync brings down, then sends up', async () => {
  const { a, b, bare } = withRemote();
  commit(b, 'b.txt', 'b\n');
  run(b, 'push', '-q');
  await gitSync(a);
  assert.ok(fs.existsSync(path.join(a, 'b.txt')));
  commit(a, 'c.txt', 'c\n');
  assert.equal((await gitStatus(a)).ahead, 1);
  await gitSync(a);
  const st = await gitStatus(a);
  assert.deepEqual([st.ahead, st.behind], [0, 0]);
  assert.match(run(bare, 'log', '--oneline', 'main'), /add c\.txt/);
});

test('a diverged branch is refused and left as it is', async () => {
  const { a, b, bare } = withRemote();
  commit(b, 'b.txt', 'b\n');
  run(b, 'push', '-q');
  commit(a, 'c.txt', 'c\n');
  const head = run(a, 'rev-parse', 'HEAD');
  await assert.rejects(gitSync(a), /divergé/);
  assert.equal(run(a, 'rev-parse', 'HEAD'), head);
  assert.doesNotMatch(run(bare, 'log', '--oneline', 'main'), /add c\.txt/);
});

test('a branch without upstream is published', async () => {
  const { a, bare } = withRemote();
  run(a, 'switch', '-q', '-c', 'topic');
  commit(a, 'd.txt', 'd\n');
  await gitSync(a);
  assert.equal((await gitStatus(a)).upstream, 'origin/topic');
  assert.match(run(bare, 'branch', '--list', 'topic'), /topic/);
});

test('without a remote, the sync says so', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  await assert.rejects(gitSync(dir), /Aucun dépôt distant/);
});
