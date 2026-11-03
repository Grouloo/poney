// Sub-agents work in a copy of the project, merged back by the app when they
// stop. A sub-agent that rewrites a file from memory, or deletes the wrong one,
// does it in its copy; two sub-agents at the same time no longer change files
// under each other's feet (nor break each other's test runs).
//
// The merge is three-way, file by file: the project when the copy was made (the
// base), the project now (other agents may have changed it), the copy. A change
// on one side only is taken as is; changes on both sides are merged line by line
// when they touch different lines. What the app cannot decide is held for the
// main agent: changes in the same lines, a deleted file, a file that lost most of
// its lines (rewritten from memory, or cut by mistake).

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IGNORED_DIRS, SCRATCH } from './tools.ts';

// Dependencies: linked, not copied (large, and the same for every agent).
const LINKED = new Set(['node_modules', '.venv', 'venv']);
// Caches and large build outputs: left out (rebuilt when needed).
const SKIPPED = new Set(['__pycache__', '.next', 'target', '.cache']);
const MAX_FILES = 30000;
const MAX_BYTES = 500 * 1024 * 1024; // (a clone on APFS costs nothing; a real copy does)
const MAX_BASE_BYTES = 50 * 1024 * 1024; // the files to merge, kept in memory
const SHRUNK_MIN_LINES = 20; // a file shorter than this may well be rewritten whole

export interface ProjectCopy {
  dir: string;
  /** The files to merge as they were when the copy was made (outside IGNORED_DIRS). */
  base: Map<string, Buffer>;
}

export interface Held {
  path: string;
  why: 'deleted' | 'shrunk' | 'conflict';
  /** The version for the main agent to look at: the copy's, or both with conflict marks. */
  content: Buffer | null;
}

export interface MergeResult {
  applied: { path: string; how: 'new' | 'changed' | 'merged' }[];
  held: Held[];
}

/** A copy of the project for a sub-agent, or null when it is too large (it then works in the project). */
export async function copyProject(cwd: string): Promise<ProjectCopy | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-agent-'));
  const base = new Map<string, Buffer>();
  let files = 0;
  let bytes = 0;
  let baseBytes = 0;
  const visit = async (from: string, to: string, rel: string, merged: boolean): Promise<boolean> => {
    for (const e of await fs.readdir(from, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || (!rel && e.name === SCRATCH)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const src = path.join(from, e.name);
      const dst = path.join(to, e.name);
      if (e.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(src), dst).catch(() => {});
      } else if (e.isDirectory()) {
        if (SKIPPED.has(e.name)) continue;
        if (LINKED.has(e.name)) { await fs.symlink(src, dst, 'dir').catch(() => {}); continue; }
        await fs.mkdir(dst);
        if (!(await visit(src, dst, r, merged && !IGNORED_DIRS.has(e.name)))) return false;
      } else if (e.isFile()) {
        await fs.copyFile(src, dst, constants.COPYFILE_FICLONE);
        const size = (await fs.stat(src)).size;
        bytes += size;
        if (++files > MAX_FILES || bytes > MAX_BYTES) return false;
        if (merged) {
          baseBytes += size;
          if (baseBytes > MAX_BASE_BYTES) return false;
          base.set(r, await fs.readFile(src));
        }
      }
    }
    return true;
  };
  let ok = false;
  try { ok = await visit(cwd, dir, '', true); } catch {}
  if (!ok) {
    await dropCopy({ dir, base });
    return null;
  }
  return { dir, base };
}

export async function dropCopy(copy: ProjectCopy): Promise<void> {
  // (rm does not follow the links to the project's dependencies: it removes the links)
  await fs.rm(copy.dir, { recursive: true, force: true }).catch(() => {});
}

/** The files to merge of a folder (the same ones as in the base). */
async function filesOf(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, rel: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.DS_Store' || (!rel && e.name === SCRATCH)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name) && !SKIPPED.has(e.name)) await visit(path.join(dir, e.name), r); }
      else if (e.isFile()) out.push(r);
    }
  };
  await visit(root, '');
  return out;
}

const read = (p: string) => fs.readFile(p).catch(() => null);
const same = (a: Buffer | null | undefined, b: Buffer | null | undefined) => (a == null || b == null ? a == b : a.equals(b));
const isText = (b: Buffer) => !b.includes(0);
const lineCount = (b: Buffer) => b.toString('utf8').split('\n').length;

/** Brings the changes of the copy into the project: what can be decided, and the rest held. */
export async function mergeCopy(copy: ProjectCopy, cwd: string): Promise<MergeResult> {
  const result: MergeResult = { applied: [], held: [] };
  const paths = [...new Set([...copy.base.keys(), ...await filesOf(copy.dir)])].sort();
  for (const rel of paths) {
    const base = copy.base.get(rel) ?? null;
    const mine = await read(path.join(copy.dir, rel));
    if (same(mine, base)) continue;
    const target = path.join(cwd, rel);
    const now = await read(target);
    if (same(now, mine)) continue; // (the same change, made elsewhere too)
    if (!mine) { result.held.push({ path: rel, why: 'deleted', content: null }); continue; }
    if (base && isText(base) && isText(mine) && lineCount(base) >= SHRUNK_MIN_LINES && lineCount(mine) < lineCount(base) / 2) {
      result.held.push({ path: rel, why: 'shrunk', content: mine });
      continue;
    }
    let content: Buffer = mine;
    let how: MergeResult['applied'][number]['how'] = base ? 'changed' : 'new';
    if (!same(now, base)) {
      // Changed in the project too (or deleted, or created there as well).
      if (!now || !isText(now) || !isText(mine) || (base && !isText(base))) { result.held.push({ path: rel, why: 'conflict', content: mine }); continue; }
      const m = merge3((base ?? Buffer.alloc(0)).toString('utf8'), now.toString('utf8'), mine.toString('utf8'));
      if (m.conflicts) { result.held.push({ path: rel, why: 'conflict', content: Buffer.from(m.text) }); continue; }
      content = Buffer.from(m.text);
      how = 'merged';
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    result.applied.push({ path: rel, how });
  }
  return result;
}

/** What the main agent is told of a merge (`kept`: where each held version is, in .poney/). */
export function mergeReport(r: MergeResult, kept: Map<string, string>): string {
  if (!r.applied.length && !r.held.length) return '';
  const lines: string[] = [];
  if (r.applied.length) {
    const how = (a: MergeResult['applied'][number]) => (a.how === 'new' ? `${a.path} (new)` : a.how === 'merged' ? `${a.path} (merged with changes made meanwhile)` : a.path);
    lines.push(`Its changes, made in a copy of the project, are now in the project: ${r.applied.map(how).join(', ')}.`);
  }
  if (r.held.length) {
    lines.push(`NOT in the project, for you to decide${r.applied.length ? '' : ' (its changes were made in a copy of the project)'}:`);
    for (const h of r.held) {
      const at = kept.get(h.path);
      if (h.why === 'deleted') lines.push(`- ${h.path}: it deleted this file. If that is right, delete it yourself.`);
      else if (h.why === 'shrunk') lines.push(`- ${h.path}: its version has less than half the lines of the file (rewritten from memory, or cut by mistake?).${at ? ` Its version: ${at}. Compare them, and change ${h.path} only with what is right.` : ''}`);
      else lines.push(`- ${h.path}: changed meanwhile in the same lines, in the project.${at ? ` Both versions, between <<<<<<< project and >>>>>>> sub-agent marks: ${at}. Change ${h.path} with what is right.` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---------- three-way merge of texts ----------

interface Hunk { start: number; end: number; lines: string[] } // base[start, end) replaced by lines

/** The changes from `a` to `b`, as replaced ranges of `a` (LCS of lines). */
function hunks(a: string[], b: string[]): Hunk[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { cur = null; i++; j++; continue; }
    if (!cur) out.push(cur = { start: pre + i, end: pre + i, lines: [] });
    if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { i++; cur.end = pre + i; }
    else { cur.lines.push(B[j]); j++; }
  }
  return out;
}

/**
 * Merges the changes from `base` to `ours` and to `theirs`. Changes that touch
 * the same lines (or are next to each other) and differ are a conflict, written
 * between <<<<<<< / ======= / >>>>>>> marks.
 */
export function merge3(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
  const b = base.split('\n');
  const o = hunks(b, ours.split('\n'));
  const t = hunks(b, theirs.split('\n'));
  if (!o || !t) return { text: `<<<<<<< project\n${ours}\n=======\n${theirs}\n>>>>>>> sub-agent`, conflicts: 1 };
  const all = [...o.map((h) => ({ ...h, side: 0 })), ...t.map((h) => ({ ...h, side: 1 }))].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let conflicts = 0;
  let at = 0;
  for (let k = 0; k < all.length;) {
    // A group: the changes whose ranges overlap or touch.
    const group = [all[k]];
    let end = all[k].end;
    for (k++; k < all.length && all[k].start <= end; k++) {
      group.push(all[k]);
      end = Math.max(end, all[k].end);
    }
    const start = group[0].start;
    out.push(...b.slice(at, start));
    // Each side's text for the range of the group.
    const sideText = (side: number) => {
      const lines: string[] = [];
      let p = start;
      for (const h of group.filter((g) => g.side === side)) {
        lines.push(...b.slice(p, h.start), ...h.lines);
        p = h.end;
      }
      lines.push(...b.slice(p, end));
      return lines;
    };
    const sides = new Set(group.map((g) => g.side));
    const ourLines = sideText(0);
    const theirLines = sideText(1);
    if (sides.size === 1) out.push(...(sides.has(0) ? ourLines : theirLines));
    else if (ourLines.join('\n') === theirLines.join('\n')) out.push(...ourLines);
    else {
      conflicts++;
      out.push('<<<<<<< project', ...ourLines, '=======', ...theirLines, '>>>>>>> sub-agent');
    }
    at = end;
  }
  out.push(...b.slice(at));
  return { text: out.join('\n'), conflicts };
}
