// Git for the sidebar: the state of the repository, a file's diff, and the sync.
// No Electron here. Nothing prompts, no credential is read here (GitHub goes through
// gh's own login, or a token given for one call), and reading a repository runs none of the
// programs its config can name (fsmonitor, external diff, textconv).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const COMMITS = 30;
const MAX_DIFF = 500_000; // characters: beyond, the panel would crawl

function git(cwd, args, { timeout = 15000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, ...args], {
      cwd, timeout, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

/** `git status --porcelain=v2 --branch -z`: the branch, then the files on each side of the index. */
export function parseStatus(out) {
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [] };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.startsWith('# branch.head ')) {
      const head = r.slice(14);
      st.branch = head === '(detached)' ? null : head;
    } else if (r.startsWith('# branch.upstream ')) {
      st.upstream = r.slice(18);
    } else if (r.startsWith('# branch.ab ')) {
      const [, a, b] = r.match(/\+(\d+) -(\d+)/) || [];
      st.ahead = Number(a) || 0;
      st.behind = Number(b) || 0;
    } else if (r[0] === '1' || r[0] === '2') {
      const parts = r.split(' ');
      const [x, y] = parts[1];
      const path = parts.slice(r[0] === '1' ? 8 : 9).join(' ');
      const oldPath = r[0] === '2' ? records[++i] : undefined; // (a rename: the old name is the next record)
      if (x !== '.') st.staged.push({ path, oldPath, status: x });
      if (y !== '.') st.unstaged.push({ path, oldPath: y === 'R' ? oldPath : undefined, status: y });
    } else if (r[0] === 'u') {
      st.unstaged.push({ path: r.split(' ').slice(10).join(' '), status: 'U' });
    }
  }
  return st;
}

/** `git log` with %h %s %an %ct, separated by NUL. */
export function parseLog(out) {
  const fields = out.split('\0');
  const commits = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    commits.push({ hash: fields[i].trim(), subject: fields[i + 1], author: fields[i + 2], time: Number(fields[i + 3]) * 1000 });
  }
  return commits;
}

const remotes = async (cwd) => (await git(cwd, ['remote'])).split('\n').filter(Boolean);

/** The repository's state, or { repo: false } outside a repository (or without git). */
export async function gitStatus(cwd) {
  if (!cwd) return { repo: false };
  try {
    await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return { repo: false };
  }
  const st = parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']));
  const log = await git(cwd, ['log', `-n${COMMITS}`, '--format=%h%x00%s%x00%an%x00%ct%x00']).catch(() => ''); // (no commit yet)
  return { repo: true, ...st, hasRemote: (await remotes(cwd)).length > 0, commits: parseLog(log) };
}

/** A file's changes, in the index (staged) or in the working tree. Paths come from the root: the status gives them so. */
export async function gitDiff(cwd, file, { staged = false, oldPath } = {}) {
  const spec = [file, ...(oldPath ? [oldPath] : [])].map((p) => `:(top,literal)${p}`);
  const out = await git(cwd, ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--', ...spec]);
  return out.length > MAX_DIFF ? { diff: out.slice(0, MAX_DIFF), truncated: true } : { diff: out, truncated: false };
}

/** Updates the remote branches, for the count of what comes down. */
export async function gitFetch(cwd, env) {
  await git(cwd, ['fetch', '--quiet'], { timeout: 30000, env });
}

const reason = (e) => (e.killed ? 'délai dépassé' : e.stderr?.split('\n').filter((l) => l.trim()).slice(-3).join('\n') || e.message);

/**
 * Brings down what the remote has, then sends up what it lacks. Only a
 * fast-forward: it never makes a merge, so it never leaves conflicts behind.
 * Without an upstream, the branch is published.
 */
export async function gitSync(cwd, env) {
  const network = { timeout: 120000, env };
  try {
    const st = await gitStatus(cwd);
    if (!st.branch) throw Object.assign(new Error('Aucune branche : la tête est détachée.'), { plain: true });
    const [remote] = await remotes(cwd);
    if (!remote) throw Object.assign(new Error('Aucun dépôt distant.'), { plain: true });
    if (!st.upstream) {
      await git(cwd, ['push', '-u', remote, 'HEAD'], network);
      return;
    }
    await git(cwd, ['fetch', '--quiet'], network);
    const { ahead, behind } = await gitStatus(cwd);
    if (ahead && behind) throw Object.assign(new Error(`La branche a divergé (↑${ahead} ↓${behind}) : intégrez les changements distants avant de synchroniser.`), { plain: true });
    if (behind) await git(cwd, ['pull', '--quiet', '--no-rebase', '--ff-only'], network);
    if (ahead) await git(cwd, ['push', '--quiet'], network);
  } catch (e) {
    throw e.plain ? e : new Error(`Échec de la synchronisation : ${reason(e)}`);
  }
}

const plain = (message) => Object.assign(new Error(message), { plain: true });
const REMOTE = 'origin';

/**
 * Sets the remote of a repository that has none. Its history is not touched: an
 * empty remote gets the branch; otherwise the branch follows its namesake if there
 * is one, and any difference is left to the sync, which never merges.
 * A remote that cannot be reached is not kept, unless keep (it exists for sure: just made).
 */
export async function gitConnect(cwd, url, env, { keep = false } = {}) {
  const target = String(url ?? '').trim();
  if (!target || target.startsWith('-')) throw plain('Indiquez l’adresse du dépôt distant.');
  if ((await remotes(cwd)).length) throw plain('Ce dépôt a déjà un dépôt distant.');
  const network = { timeout: 120000, env };
  await git(cwd, ['remote', 'add', REMOTE, target]);
  try {
    await git(cwd, ['fetch', '--quiet', REMOTE], network);
  } catch (e) {
    if (keep) throw plain(`Dépôt ${target} créé et raccordé, mais inaccessible pour l’instant : ${reason(e)}`);
    await git(cwd, ['remote', 'remove', REMOTE]);
    throw plain(`Dépôt inaccessible : ${reason(e)}`);
  }
  const st = await gitStatus(cwd);
  if (!st.branch) return;
  const branches = (await git(cwd, ['branch', '-r', '--format=%(refname:short)'])).split('\n').filter((b) => b.startsWith(`${REMOTE}/`) && b !== `${REMOTE}/HEAD`);
  try {
    if (!branches.length) {
      if (st.commits.length) await git(cwd, ['push', '--quiet', '-u', REMOTE, 'HEAD'], network);
    } else if (branches.includes(`${REMOTE}/${st.branch}`)) {
      if (!st.commits.length) await git(cwd, ['pull', '--quiet', '--ff-only', REMOTE, st.branch], network);
      await git(cwd, ['branch', `--set-upstream-to=${REMOTE}/${st.branch}`, st.branch]);
    }
  } catch (e) {
    throw plain(`Raccordé à ${target}, mais la branche n’a pas pu être synchronisée : ${reason(e)}`);
  }
}

/** The gh program, or null. (From the Finder, the PATH lacks the usual folders.) */
export function findGh(env = process.env) {
  const dirs = [...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const file = path.join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

const runGh = (gh, args, env) => new Promise((resolve, reject) => {
  execFile(gh, args, { timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1', ...env } }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; return reject(err); }
    resolve(stdout);
  });
});

/** The gh that can act now, logged in, or null. */
export async function readyGh(gh = findGh()) {
  if (!gh) return null;
  return runGh(gh, ['auth', 'status']).then(() => gh, () => null);
}

/**
 * Creates an empty repository on GitHub and returns the address to push to.
 * name: "repo", or "organization/repo". With gh, its login; else the token, for
 * this call only (the push then uses git's own login: https).
 */
export async function createGithubRepo({ name, isPrivate = true, gh = null, token = '', fetchFn = fetch, env }) {
  const m = String(name ?? '').trim().match(/^(?:([\w-]+)\/)?([\w.][\w.-]*)$/);
  if (!m) throw plain('Nom de dépôt invalide : lettres, chiffres, « . », « - » et « _ ».');
  const [, owner, repo] = m;
  const route = owner ? `orgs/${owner}/repos` : 'user/repos';
  if (gh) {
    let out;
    try {
      out = await runGh(gh, ['api', '--method', 'POST', route, '-f', `name=${repo}`, '-F', `private=${Boolean(isPrivate)}`], env);
    } catch (e) {
      throw plain(`Création impossible : ${githubMessage(e.stderr) || reason(e)}`);
    }
    const made = JSON.parse(out);
    const ssh = (await runGh(gh, ['config', 'get', 'git_protocol'], env).catch(() => '')).trim() === 'ssh';
    return ssh ? made.ssh_url : made.clone_url;
  }
  if (!token) throw plain('Collez un jeton GitHub : gh n’est pas disponible ici.');
  const res = await fetchFn(`https://api.github.com/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ name: repo, private: Boolean(isPrivate) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw plain(`Création impossible : ${githubMessage(text) || `HTTP ${res.status}`}`);
  return JSON.parse(text).clone_url;
}

/** What GitHub says went wrong, from its JSON. ("name already exists" comes in errors.) */
function githubMessage(text) {
  const json = String(text ?? '').match(/\{[\s\S]*\}/)?.[0];
  try {
    const data = JSON.parse(json);
    return data.errors?.[0]?.message ?? data.message ?? '';
  } catch {
    return String(text ?? '').trim().split('\n')[0];
  }
}
