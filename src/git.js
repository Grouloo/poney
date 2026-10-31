// Git for the sidebar: the state of the repository, a file's diff, and the sync.
// No Electron here. Nothing prompts, and reading a repository runs none of the
// programs its config can name (fsmonitor, external diff, textconv).
import { execFile } from 'node:child_process';

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

const reason = (e) => (e.killed ? 'délai dépassé' : e.stderr?.trim().split('\n').slice(-3).join('\n') || e.message);

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
