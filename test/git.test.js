import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStatus, parseLog, gitStatus, gitDiff, gitSync, gitConnect, createGithubRepo, readyGh } from '../src/git.js';

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

// ---------- setting a remote ----------
const bareRepo = () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'poney-bare-'));
  run(bare, 'init', '-q', '--bare', '-b', 'main');
  return bare;
};
const remoteLog = (bare, ref = 'main') => run(bare, 'log', '--format=%s', ref).trim().split('\n');

test('an empty remote gets the branch, which then follows it', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  const bare = bareRepo();
  await gitConnect(dir, bare);
  const st = await gitStatus(dir);
  assert.equal(st.hasRemote, true);
  assert.equal(st.upstream, 'origin/main');
  assert.deepEqual(remoteLog(bare), ['add a.txt']);
});

test('a remote with history: nothing is sent, the branch follows its namesake and the difference shows', async () => {
  const { bare } = withRemote();
  const dir = repo();
  commit(dir, 'mine.txt', 'x\n');
  await gitConnect(dir, bare);
  const st = await gitStatus(dir);
  assert.equal(st.upstream, 'origin/main');
  assert.deepEqual([st.ahead, st.behind], [1, 1]);
  assert.deepEqual(remoteLog(bare), ['add a.txt']);
});

test('a remote whose branches have other names gets nothing either', async () => {
  const { bare } = withRemote();
  const dir = repo();
  run(dir, 'checkout', '-q', '-b', 'other');
  commit(dir, 'mine.txt', 'x\n');
  await gitConnect(dir, bare);
  const st = await gitStatus(dir);
  assert.equal(st.upstream, null);
  assert.equal(run(bare, 'branch', '--list', 'other'), '');
});

test('a repository without a commit takes the history of the remote', async () => {
  const { bare } = withRemote();
  const dir = repo();
  await gitConnect(dir, bare);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal((await gitStatus(dir)).upstream, 'origin/main');
});

test('a remote out of reach is not kept, unless it was just created', async () => {
  const dir = repo();
  commit(dir, 'a.txt', 'a\n');
  await assert.rejects(gitConnect(dir, '/nonexistent/repo.git'), /inaccessible/);
  assert.equal((await gitStatus(dir)).hasRemote, false);
  await assert.rejects(gitConnect(dir, '/nonexistent/repo.git', undefined, { keep: true }), /créé et raccordé/);
  assert.equal((await gitStatus(dir)).hasRemote, true);
});

test('a remote is never replaced, and an address cannot be an option', async () => {
  const { a, bare } = withRemote();
  await assert.rejects(gitConnect(a, bare), /déjà/);
  const dir = repo();
  await assert.rejects(gitConnect(dir, '--upload-pack=touch x'), /adresse/);
  await assert.rejects(gitConnect(dir, '  '), /adresse/);
  assert.equal((await gitStatus(dir)).hasRemote, false);
});

const answer = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('a token creates the repository through the API, and stays out of the messages', async () => {
  const calls = [];
  const fetchFn = async (url, o) => { calls.push({ url, o }); return answer(201, { clone_url: 'https://github.com/me/p.git', ssh_url: 'git@github.com:me/p.git' }); };
  assert.equal(await createGithubRepo({ name: 'p', token: 'tok', fetchFn }), 'https://github.com/me/p.git');
  assert.equal(calls[0].url, 'https://api.github.com/user/repos');
  assert.equal(calls[0].o.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].o.body), { name: 'p', private: true });
  await createGithubRepo({ name: 'org/p', isPrivate: false, token: 'tok', fetchFn });
  assert.equal(calls[1].url, 'https://api.github.com/orgs/org/repos');
  assert.equal(JSON.parse(calls[1].o.body).private, false);
  const taken = async () => answer(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
  await assert.rejects(createGithubRepo({ name: 'p', token: 'tok', fetchFn: taken }), (e) => /already exists/.test(e.message) && !e.message.includes('tok'));
});

test('nothing goes to GitHub without a valid name and a way in', async () => {
  const fetchFn = async () => assert.fail('called');
  await assert.rejects(createGithubRepo({ name: 'a b', token: 't', fetchFn }), /invalide/);
  await assert.rejects(createGithubRepo({ name: '-x', token: 't', fetchFn }), /invalide/);
  await assert.rejects(createGithubRepo({ name: 'p', fetchFn }), /jeton/);
});

test('gh, logged in, creates it with its own login and says which protocol to use', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poney-gh-'));
  const gh = path.join(dir, 'gh');
  const log = path.join(dir, 'log');
  fs.writeFileSync(gh, `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  auth) [ -f "${dir}/in" ] ;;
  api) echo '{"clone_url":"https://github.com/me/p.git","ssh_url":"git@github.com:me/p.git"}' ;;
  config) echo ssh ;;
esac
`, { mode: 0o755 });
  assert.equal(await readyGh(gh), null);
  fs.writeFileSync(path.join(dir, 'in'), '');
  assert.equal(await readyGh(gh), gh);
  assert.equal(await createGithubRepo({ name: 'p', gh }), 'git@github.com:me/p.git');
  assert.match(fs.readFileSync(log, 'utf8'), /api --method POST user\/repos -f name=p -F private=true/);
});
