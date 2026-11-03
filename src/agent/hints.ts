// Context hints given by the app with a message or a tool result, only when they
// help: what changed in the project without the agent, the closest paths when one
// does not exist, the lines an error points at. The model cannot find these out by
// itself, or would spend steps (and room) on it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, SCRATCH } from './tools.ts';

const MAX_FILES = 5000;

/** The project's files, with their size and modification time (and the Git branch): to see what changed. */
export interface Snapshot {
  files: Map<string, string>;
  branch: string | null;
  complete: boolean;
}

async function walk(cwd: string, onFile: (rel: string, abs: string) => Promise<void> | void, { dirs = false, max = MAX_FILES } = {}): Promise<boolean> {
  let count = 0;
  const visit = async (dir: string, rel: string): Promise<boolean> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (e.name === '.DS_Store' || (!rel && e.name === SCRATCH)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (dirs) await onFile(`${r}/`, path.join(dir, e.name));
        if (!(await visit(path.join(dir, e.name), r))) return false;
      } else if (e.isFile()) {
        if (++count > max) return false;
        await onFile(r, path.join(dir, e.name));
      }
    }
    return true;
  };
  return visit(cwd, '');
}

export async function projectSnapshot(cwd: string): Promise<Snapshot> {
  const files = new Map<string, string>();
  const complete = await walk(cwd, async (rel, abs) => {
    try { const st = await fs.stat(abs); files.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`); } catch {}
  });
  const head = await fs.readFile(path.join(cwd, '.git', 'HEAD'), 'utf8').catch(() => '');
  const branch = head.match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? (head.trim() ? head.trim().slice(0, 12) : null);
  return { files, branch, complete };
}

/** What changed between two snapshots, for the model (null: nothing). */
export function changesNote(before: Snapshot, after: Snapshot, max = 12): { text: string; files: string[] } | null {
  const changed: string[] = [];
  for (const [f, v] of after.files) {
    const old = before.files.get(f);
    if (old === undefined) changed.push(`${f} (new)`);
    else if (old !== v) changed.push(`${f} (modified)`);
  }
  // (a snapshot cut at MAX_FILES does not know the files it did not reach)
  if (before.complete && after.complete) for (const f of before.files.keys()) if (!after.files.has(f)) changed.push(`${f} (deleted)`);
  const branch = before.branch && after.branch && before.branch !== after.branch ? `The Git branch changed: ${before.branch} → ${after.branch}.` : '';
  if (!changed.length && !branch) return null;
  const list = changed.length ? `Files changed in the project since your last answer, not by you: ${changed.slice(0, max).join(', ')}${changed.length > max ? `, and ${changed.length - max} more` : ''}. Read them again before relying on what you saw.` : '';
  return { text: `(${[list, branch].filter(Boolean).join(' ')})`, files: changed.map((c) => c.replace(/ \((new|modified|deleted)\)$/, '')) };
}

// ---------- the closest paths ----------

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** The existing paths closest to one that does not exist (same name elsewhere, a typo, another extension). */
export async function nearestPaths(cwd: string, rel: string, { dirs = false, n = 3 } = {}): Promise<string[]> {
  const want = rel.replace(/\/+$/, '').toLowerCase();
  const name = want.split('/').pop() ?? '';
  const stem = name.replace(/\.[^.]+$/, '');
  if (!name) return [];
  const scored: { p: string; score: number }[] = [];
  await walk(cwd, (p) => {
    if (dirs !== p.endsWith('/')) return;
    const clean = p.replace(/\/$/, '');
    const base = (clean.split('/').pop() ?? '').toLowerCase();
    const d = distance(name, base);
    const sameStem = base.replace(/\.[^.]+$/, '') === stem && stem.length >= 2;
    if (d > Math.max(2, Math.floor(name.length / 3)) && !sameStem) return;
    scored.push({ p: clean, score: (sameStem ? Math.min(d, 1) : d) * 10 + distance(want, clean.toLowerCase()) / 10 });
  }, { dirs, max: 20000 });
  return scored.sort((a, b) => a.score - b.score).slice(0, n).map((s) => s.p);
}

export const didYouMean = (paths: string[]) => (paths.length ? ` Did you mean ${paths.map((p) => `"${p}"`).join(' or ')}?` : '');

// ---------- the lines an error points at ----------

const REFS = [
  /File "([^"]+)", line (\d+)/g, // Python
  /([\w./@\\-]+\.[A-Za-z]\w{0,5})\((\d+),\d+\)/g, // tsc, C#: file(line,col)
  /([\w./@\\-]+\.[A-Za-z]\w{0,5}):(\d+)(?::\d+)?/g, // file:line(:col), stack traces
];

/**
 * The lines of the project cited by a failed command's output (at most 3, a few
 * lines around each), so the model sees them without reading the files. Empty if
 * none can be found.
 */
export async function citedLines(cwd: string, output: string, { max = 3, around = 2, maxChars = 1500 } = {}): Promise<string> {
  const refs: { rel: string; line: number }[] = [];
  const root = path.resolve(cwd);
  for (const re of REFS) {
    for (const m of output.matchAll(re)) {
      const abs = path.resolve(root, m[1]);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const line = Number(m[2]);
      if (!rel || rel.startsWith('..') || rel.split('/').some((s) => IGNORED_DIRS.has(s)) || !line) continue;
      if (refs.some((r) => r.rel === rel && Math.abs(r.line - line) <= around)) continue;
      refs.push({ rel, line });
    }
  }
  const parts: string[] = [];
  for (const { rel, line } of refs) {
    if (parts.length >= max) break;
    const text = await fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
    if (text === null || text.includes('\u0000')) continue;
    const lines = text.replace(/\n$/, '').split('\n'); // (not the empty line after the last newline)
    if (line > lines.length) continue;
    const from = Math.max(1, line - around);
    const to = Math.min(lines.length, line + around);
    const w = String(to).length;
    const body = lines.slice(from - 1, to).map((l, i) => `${from + i === line ? '>' : ' '}${String(from + i).padStart(w)}| ${l.slice(0, 200)}`).join('\n');
    parts.push(`${rel}:${line}\n${body}`);
  }
  if (!parts.length) return '';
  const text = `Lines cited in the output:\n${parts.join('\n')}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[...]` : text;
}
