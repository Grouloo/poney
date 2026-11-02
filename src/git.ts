// Git for the sidebar: the state of the repository, a file's diff, and the sync.
// No Electron here. Nothing prompts, no credential is read here (GitHub goes through
// gh's own login, or a token the caller gives), and reading a repository runs none of the
// programs its config can name (fsmonitor, external diff, textconv).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, list, parseJson, rec, str } from './unknown.ts';

type Env = Record<string, string | undefined>;

export interface GitFile {
  path: string;
  oldPath?: string;
  status: string;
}

export interface GitParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: string[];
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  time: number;
}

export type GitRepoStatus = { repo: false } | (GitParsedStatus & { repo: true; hasRemote: boolean; commits: GitCommit[] });

type FileState = 'U' | 'M' | 'A';

/** The part of fetch GitHub's calls use. */
type FetchFn = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const COMMITS = 30;
const MAX_DIFF = 500_000; // characters: beyond, the panel would crawl

function git(cwd: string, args: string[], { timeout = 15000, env = {} }: { timeout?: number; env?: Env } = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile('git', [...SAFE, ...args], {
      cwd, timeout, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

/** `git status --porcelain=v2 --branch -z`: the branch, then the files on each side of the index. */
export function parseStatus(out: string): GitParsedStatus {
  const st: GitParsedStatus = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
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
    } else if (r[0] === '?') {
      st.untracked.push(r.slice(2));
    } else if (r[0] === 'u') {
      st.unstaged.push({ path: r.split(' ').slice(10).join(' '), status: 'U' });
    }
  }
  return st;
}

/** `git log` with %h %s %an %ct, separated by NUL. */
export function parseLog(out: string): GitCommit[] {
  const fields = out.split('\0');
  const commits: GitCommit[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    commits.push({ hash: fields[i].trim(), subject: fields[i + 1], author: fields[i + 2], time: Number(fields[i + 3]) * 1000 });
  }
  return commits;
}

const remotes = async (cwd: string) => (await git(cwd, ['remote'])).split('\n').filter(Boolean);

/** The repository's state, or { repo: false } outside a repository (or without git). */
export async function gitStatus(cwd: string | null | undefined): Promise<GitRepoStatus> {
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

const RANK: Record<FileState, number> = { U: 3, M: 2, A: 1 }; // (a folder shows the most urgent of what it holds)

/**
 * The state of each file and folder from a status: 'U' conflict, 'M' changed,
 * 'A' new, staged or not. Paths relative to `prefix`, the folder asked about.
 */
export function fileStates(st: Pick<GitParsedStatus, 'staged' | 'unstaged' | 'untracked'>, prefix = ''): Record<string, FileState> {
  const states: Record<string, FileState | undefined> = {};
  const mark = (file: string, state: FileState) => {
    if (!file.startsWith(prefix)) return;
    const parts = file.slice(prefix.length).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const known = states[p];
      if ((known ? RANK[known] : 0) < RANK[state]) states[p] = state;
    }
  };
  for (const f of [...st.staged, ...st.unstaged]) mark(f.path, f.status === 'U' ? 'U' : f.status === 'A' ? 'A' : 'M');
  for (const f of st.untracked) mark(f, 'A');
  return Object.fromEntries(Object.entries(states).flatMap(([k, v]) => (v ? [[k, v]] : [])));
}

/** For the file tree: { path: state } under cwd, untracked files included. Empty outside a repository. */
export async function gitFileStates(cwd: string | null | undefined): Promise<Record<string, FileState>> {
  if (!cwd) return {};
  try {
    const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).trim();
    return fileStates(parseStatus(await git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])), prefix);
  } catch {
    return {};
  }
}

/** A file's changes, in the index (staged) or in the working tree. Paths come from the root: the status gives them so. */
export async function gitDiff(cwd: string, file: string, { staged = false, oldPath }: { staged?: boolean; oldPath?: string } = {}) {
  const spec = [file, ...(oldPath ? [oldPath] : [])].map((p) => `:(top,literal)${p}`);
  const out = await git(cwd, ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--', ...spec]);
  return out.length > MAX_DIFF ? { diff: out.slice(0, MAX_DIFF), truncated: true } : { diff: out, truncated: false };
}

/** Updates the remote branches, for the count of what comes down. */
export async function gitFetch(cwd: string, env?: Env): Promise<void> {
  await git(cwd, ['fetch', '--quiet'], { timeout: 30000, env });
}

const reason = (e: unknown) => {
  const { killed, stderr } = rec(e);
  return killed ? 'délai dépassé' : str(stderr).split('\n').filter((l) => l.trim()).slice(-3).join('\n') || errorMessage(e);
};

/**
 * Brings down what the remote has, then sends up what it lacks. Only a
 * fast-forward: it never makes a merge, so it never leaves conflicts behind.
 * Without an upstream, the branch is published.
 */
export async function gitSync(cwd: string, env?: Env): Promise<void> {
  const network = { timeout: 120000, env };
  try {
    const st = await gitStatus(cwd);
    if (!st.repo || !st.branch) throw plain('Aucune branche : la tête est détachée.');
    const [remote] = await remotes(cwd);
    if (!remote) throw plain('Aucun dépôt distant.');
    if (!st.upstream) {
      await git(cwd, ['push', '-u', remote, 'HEAD'], network);
      return;
    }
    await git(cwd, ['fetch', '--quiet'], network);
    const after = await gitStatus(cwd);
    const { ahead, behind } = after.repo ? after : { ahead: 0, behind: 0 };
    if (ahead && behind) throw plain(`La branche a divergé (↑${ahead} ↓${behind}) : intégrez les changements distants avant de synchroniser.`);
    if (behind) await git(cwd, ['pull', '--quiet', '--no-rebase', '--ff-only'], network);
    if (ahead) await git(cwd, ['push', '--quiet'], network);
  } catch (e) {
    throw rec(e).plain ? e : new Error(`Échec de la synchronisation : ${reason(e)}`);
  }
}

const plain = (message: string) => Object.assign(new Error(message), { plain: true });
const REMOTE = 'origin';

/**
 * Sets the remote of a repository that has none. Its history is not touched: an
 * empty remote gets the branch; otherwise the branch follows its namesake if there
 * is one, and any difference is left to the sync, which never merges.
 * A remote that cannot be reached is not kept, unless keep (it exists for sure: just made).
 */
export async function gitConnect(cwd: string, url: unknown, env?: Env, { keep = false } = {}): Promise<void> {
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
  if (!st.repo || !st.branch) return;
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

const firstRemote = async (cwd: string) => {
  const list = await remotes(cwd);
  return list.includes(REMOTE) ? REMOTE : list[0] ?? null;
};

/** The remote of a project: its address, '' without one, null outside a repository. */
export async function gitRemote(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
  const name = await firstRemote(cwd);
  return name ? (await git(cwd, ['remote', 'get-url', name])).trim() : '';
}

/** Moves a project to another address, once it answers there (or sets its first remote, see gitConnect). */
export async function gitChangeRemote(cwd: string, url: unknown, env?: Env): Promise<void> {
  const name = await firstRemote(cwd);
  if (!name) return gitConnect(cwd, url, env);
  const target = String(url ?? '').trim();
  if (!target || target.startsWith('-')) throw plain('Indiquez l’adresse du dépôt distant.');
  try {
    await git(cwd, ['ls-remote', '--quiet', target, 'HEAD'], { timeout: 60000, env });
  } catch (e) {
    throw plain(`Dépôt inaccessible : ${reason(e)}`);
  }
  await git(cwd, ['remote', 'set-url', name, target]);
}

/** Removes the remote: nothing changes on its side, nor in the local history. */
export async function gitRemoveRemote(cwd: string): Promise<void> {
  const name = await firstRemote(cwd);
  if (name) await git(cwd, ['remote', 'remove', name]);
}

export interface GitBranches {
  current: string | null;
  local: string[];
  /** branches only on the remote, without the remote's name: switching to one makes it local */
  remote: string[];
}

/** The branches to switch to: the local ones, then those of the remotes not yet here. */
export async function gitBranches(cwd: string): Promise<GitBranches> {
  const st = await gitStatus(cwd);
  if (!st.repo) return { current: null, local: [], remote: [] };
  const refs = (prefix: string) => git(cwd, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', prefix]).then((out) => out.split('\n').filter(Boolean));
  const local = await refs('refs/heads');
  const names = new Set(local);
  const remote: string[] = [];
  for (const ref of await refs('refs/remotes')) {
    const name = ref.slice(ref.indexOf('/') + 1);
    if (ref.indexOf('/') < 0 || name === 'HEAD' || names.has(name)) continue;
    names.add(name);
    remote.push(name);
  }
  return { current: st.branch, local, remote };
}

/** A branch name git accepts, which cannot pass for an option. */
async function branchName(cwd: string, name: unknown) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.startsWith('-')) throw plain('Indiquez le nom de la branche.');
  try {
    await git(cwd, ['check-ref-format', '--branch', clean]);
  } catch {
    throw plain(`« ${clean} » n’est pas un nom de branche valable.`);
  }
  return clean;
}

/**
 * Switches to a branch, local or only on the remote (it then follows it). Git refuses
 * when changes in progress would be lost: they stay, and the reason is given.
 */
export async function gitSwitch(cwd: string, name: unknown): Promise<void> {
  const branch = await branchName(cwd, name);
  try {
    await git(cwd, ['switch', '--quiet', branch]);
  } catch (e) {
    throw plain(`Impossible de passer sur ${branch} : ${reason(e)}`);
  }
}

/** Creates a branch from where the project stands, and switches to it (changes in progress come along). */
export async function gitCreateBranch(cwd: string, name: unknown): Promise<void> {
  const branch = await branchName(cwd, name);
  try {
    await git(cwd, ['switch', '--quiet', '-c', branch]);
  } catch (e) {
    throw plain(`Impossible de créer ${branch} : ${reason(e)}`);
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

const runGh = (gh: string, args: string[], env?: Env) => new Promise<string>((resolve, reject) => {
  execFile(gh, args, { timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1', ...env } }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(err, { stderr }));
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
 * name: "repo", or "organization/repo". With gh, its login; else the token (the
 * push then uses git's own login: https).
 */
export async function createGithubRepo({ name, isPrivate = true, gh = null, token = '', fetchFn = fetch, env }: { name: unknown; isPrivate?: boolean; gh?: string | null; token?: string; fetchFn?: FetchFn; env?: Env }): Promise<string> {
  const m = String(name ?? '').trim().match(/^(?:([\w-]+)\/)?([\w.][\w.-]*)$/);
  if (!m) throw plain('Nom de dépôt invalide : lettres, chiffres, « . », « - » et « _ ».');
  const [, owner, repo] = m;
  const route = owner ? `orgs/${owner}/repos` : 'user/repos';
  if (gh) {
    let out: string;
    try {
      out = await runGh(gh, ['api', '--method', 'POST', route, '-f', `name=${repo}`, '-F', `private=${Boolean(isPrivate)}`], env);
    } catch (e) {
      throw plain(`Création impossible : ${githubMessage(rec(e).stderr) || reason(e)}`);
    }
    const made = rec(parseJson(out));
    const ssh = (await runGh(gh, ['config', 'get', 'git_protocol'], env).catch(() => '')).trim() === 'ssh';
    return str(ssh ? made.ssh_url : made.clone_url);
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
  return str(rec(parseJson(text)).clone_url);
}

// GitHub's form for a new token, filled in: only what creating a repository needs.
// (it cannot be told which repositories: the interface asks for all of them)
const TOKEN_FORM = { name: 'Poney', description: 'Création de dépôts depuis Poney', expires_in: '90', administration: 'write' };
export const GITHUB_TOKEN_PAGE = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams(TOKEN_FORM)}`;

/** The account behind gh or a token: its login. Throws when GitHub refuses it. */
export async function githubAccount({ gh = null, token = '', fetchFn = fetch, env }: { gh?: string | null; token?: string; fetchFn?: FetchFn; env?: Env }): Promise<string> {
  if (gh) return str(rec(parseJson(await runGh(gh, ['api', 'user'], env))).login);
  const res = await fetchFn('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw plain(`Jeton refusé par GitHub : ${githubMessage(text) || `HTTP ${res.status}`}`);
  return str(rec(parseJson(text)).login);
}

/** What GitHub says went wrong, from its JSON. ("name already exists" comes in errors.) */
function githubMessage(text: unknown): string {
  const json = String(text ?? '').match(/\{[\s\S]*\}/)?.[0];
  try {
    const data = rec(parseJson(json ?? ''));
    return str(rec(list(data.errors)[0]).message ?? data.message);
  } catch {
    return String(text ?? '').trim().split('\n')[0];
  }
}
