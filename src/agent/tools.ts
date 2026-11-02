import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { rankedSearch } from './codesearch.ts';
import { parseEditBody } from './protocol.ts';
import { webSearch, fetchUrl } from './web.ts';
import { requireTor, proxyEnv } from './tor.ts';
import { unifiedDiff } from './diff.ts';
import { errorCode, errorMessage, errorName, rec } from '../unknown.ts';
import type { Action, Config, Meta, ToolArgs } from '../types.ts';

export interface SharedFiles {
  versions: Map<string, number>;
  locks: Map<string, Promise<unknown>>;
}

/** What a tool can see of the agent running it. */
export interface ToolContext {
  cwd?: string;
  config?: Config;
  signal?: AbortSignal;
  maxResultChars?: number;
  seenFiles?: Set<string>;
  shared?: SharedFiles;
  readVersions?: Map<string, number>;
  virtualFiles?: Map<string, string> | null;
  /** The conversation's private folder, seen by the model as .poney/ (see resolveInside). */
  scratch?: string | null;
  onOutput?: (text: string) => void;
}

export interface ToolResult {
  ok?: boolean;
  output: string;
  meta: Meta;
  changed?: string;
  diff?: string;
  exitCode?: number;
}

type Tool = (cwd: string, args: ToolArgs, ctx?: ToolContext) => Promise<ToolResult>;

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.cache', '.idea', '.vscode']);
const READ_MAX_LINES = 250;

export class ToolError extends Error {}

/** parseInt of an argument the model may have left out (NaN then, as for any bad number). */
const toInt = (v: string | undefined) => parseInt(v ?? '', 10);

/** The settings: every agent gives them; a tool asked to run without them fails like any error. */
function needConfig(ctx: ToolContext): Config {
  if (!ctx.config) throw new Error('No settings given to the tool.');
  return ctx.config;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${cut} characters cut ...]\n\n${text.slice(-tail)}`;
}

/** How the model names the conversation's private folder: kept by Poney, outside the project. */
export const SCRATCH = '.poney';
const isScratchPath = (clean: string) => clean === SCRATCH || clean.startsWith(`${SCRATCH}/`) || clean === `./${SCRATCH}` || clean.startsWith(`./${SCRATCH}/`);

export function resolveInside(cwd: string, p: unknown, scratch?: string | null): { abs: string; rel: string } {
  if (!p || !String(p).trim()) throw new ToolError('Missing "path".');
  const clean = String(p).trim().replace(/^["'`]|["'`]$/g, '');
  if (scratch && isScratchPath(clean)) {
    const abs = path.resolve(scratch, clean.replace(/^(\.\/)?\.poney\/?/, '') || '.');
    const rel = path.relative(scratch, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`Path "${clean}" is outside ${SCRATCH}/.`);
    return { abs, rel: rel ? `${SCRATCH}/${rel.split(path.sep).join('/')}` : SCRATCH };
  }
  const abs = path.resolve(cwd, clean);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`Path "${clean}" is outside the project folder. Use paths relative to the project.`);
  }
  // Always "/" (Windows gives "\\"): the model, the history and the UI use "/".
  return { abs, rel: rel.split(path.sep).join('/') || '.' };
}

/** A path on disk as the model names it: relative to the project, or under .poney/. */
function shownPath(cwd: string, abs: string, scratch?: string | null): string {
  const inScratch = scratch ? path.relative(scratch, abs) : '..';
  if (!inScratch.startsWith('..') && !path.isAbsolute(inScratch)) return inScratch ? `${SCRATCH}/${inScratch.split(path.sep).join('/')}` : SCRATCH;
  return path.relative(cwd, abs).split(path.sep).join('/');
}

/**
 * The command with each .poney path replaced by the private folder's real path,
 * quoted for where it stands (the folder's path may have spaces).
 */
export function scratchCommand(command: string, scratch: string, win = process.platform === 'win32'): string {
  const BEFORE = /[\s"'=(:<>|;&`]/;
  let out = '';
  let quote: '' | '"' | "'" = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (!win && c === '\\' && quote !== "'") { out += c + (command[i + 1] ?? ''); i++; continue; }
    if (c === '"' || (c === "'" && !win)) {
      if (!quote) quote = c; else if (quote === c) quote = '';
      out += c;
      continue;
    }
    const m = /^(\.\/)?\.poney(?=$|[\/\s"';&|)<>])/.exec(command.slice(i));
    if (m && (i === 0 || BEFORE.test(command[i - 1]))) {
      if (quote === "'") out += scratch.replace(/'/g, `'\\''`);
      else if (quote === '"') out += win ? scratch : scratch.replace(/[\\"$`]/g, '\\$&');
      else out += win ? `"${scratch}"` : `'${scratch.replace(/'/g, `'\\''`)}'`;
      i += m[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ---------- list ----------
async function listTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  const { abs, rel } = resolveInside(cwd, args.path || '.', ctx.scratch);
  if (rel === SCRATCH && !(await exists(abs))) return { output: '(empty folder)', meta: { path: rel } };
  const maxDepth = Math.min(toInt(args.depth) || 3, 6);
  const lines: string[] = [];
  let count = 0;
  async function walk(dir: string, depth: number, prefix: string) {
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { throw new ToolError(`Cannot list "${rel}": ${errorCode(e) || errorMessage(e)}`); }
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= 300) return;
      if (e.name === '.DS_Store') continue;
      if (e.isDirectory()) {
        count++;
        if (IGNORED_DIRS.has(e.name)) { lines.push(`${prefix}${e.name}/ (skipped)`); continue; }
        lines.push(`${prefix}${e.name}/`);
        if (depth < maxDepth) await walk(path.join(dir, e.name), depth + 1, prefix + '  ');
      } else {
        count++;
        lines.push(`${prefix}${e.name}`);
      }
    }
  }
  await walk(abs, 1, '');
  if (count >= 300) lines.push('[... listing truncated, list a subfolder ...]');
  return { output: lines.length ? lines.join('\n') : '(empty folder)', meta: { path: rel } };
}

// ---------- read ----------
async function readTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  // Texts given to a sub-agent to read like files (the main agent's steps, see turnDigest).
  const virtual = ctx.virtualFiles?.get(String(args.path ?? '').trim());
  const { abs, rel } = virtual !== undefined ? { abs: '', rel: String(args.path).trim() } : resolveInside(cwd, args.path, ctx.scratch);
  let content: string;
  if (virtual !== undefined) content = virtual;
  else try { content = await fs.readFile(abs, 'utf8'); } catch (e) {
    if (errorCode(e) === 'ENOENT') throw new ToolError(`File "${rel}" does not exist. Use <list /> to see files.`);
    if (errorCode(e) === 'EISDIR') throw new ToolError(`"${rel}" is a folder. Use <list path="${rel}" />.`);
    throw new ToolError(`Cannot read "${rel}": ${errorMessage(e)}`);
  }
  if (content.includes('\u0000')) throw new ToolError(`"${rel}" is a binary file.`);
  const all = content.split('\n');
  const start = Math.max(1, toInt(args.start) || 1);
  let end = toInt(args.end) || start + READ_MAX_LINES - 1;
  end = Math.min(end, all.length, start + READ_MAX_LINES * 2 - 1);
  const width = String(end).length;
  const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join('\n');
  let note = '';
  if (end < all.length) note = `\n[showing lines ${start}-${end} of ${all.length}. Use <read path="${rel}" start="${end + 1}" /> for more]`;
  if (virtual === undefined) ctx.readVersions?.set(rel, ctx.shared?.versions.get(rel) ?? 0); // the version this agent has seen
  return { output: (body || '(empty file)') + note, meta: { path: rel, lines: `${start}-${end}` } };
}

// ---------- search ----------
// <search>keywords</search>: ranked search over the project (see codesearch.js).
// <search pattern="regex" />: every line matching a regular expression.
const REGEX_CHARS = /[\\^$|()[\]{}*+?]/;
async function searchTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  const words = args.query || (args.pattern && !REGEX_CHARS.test(args.pattern) && /\s/.test(args.pattern.trim()) ? args.pattern : '');
  if (words) {
    const { abs, rel } = resolveInside(cwd, args.path || '.', ctx.scratch);
    const inScratch = ctx.scratch && (rel === SCRATCH || rel.startsWith(`${SCRATCH}/`));
    const options = { ignoredDirs: IGNORED_DIRS, maxChars: Math.min(4000, ctx.maxResultChars || 4000) };
    const r = inScratch && ctx.scratch
      ? await rankedSearch(ctx.scratch, path.relative(ctx.scratch, abs) || '.', words, { ...options, prefix: `${SCRATCH}/` })
      : await rankedSearch(cwd, rel, words, options);
    return { output: r.output, meta: { query: words, path: rel, files: r.count } };
  }
  const pattern = args.pattern;
  if (!pattern) throw new ToolError('Missing keywords: <search>what you look for</search>.');
  const { abs, rel } = resolveInside(cwd, args.path || '.', ctx.scratch);
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const hits: string[] = [];
  async function walk(p: string): Promise<void> {
    if (hits.length >= 80) return;
    let st: Stats;
    try { st = await fs.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(path.basename(p)) && p !== abs) return;
      for (const name of (await fs.readdir(p)).sort()) await walk(path.join(p, name));
      return;
    }
    if (st.size > 1_000_000) return;
    let text: string;
    try { text = await fs.readFile(p, 'utf8'); } catch { return; }
    if (text.includes('\u0000')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < 80; i++) {
      if (re.test(lines[i])) hits.push(`${shownPath(cwd, p, ctx.scratch)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  await walk(abs);
  return { output: hits.length ? hits.join('\n') + (hits.length >= 80 ? '\n[... more matches cut ...]' : '') : 'No matches.', meta: { pattern, path: rel } };
}

// ---------- syntax checks after write/edit ----------
function runCapture(cmd: string, argv: string[], cwd: string, timeoutMs = 15000) {
  return new Promise<{ code: number | null; out: string } | null>((resolve) => {
    let out = '';
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(cmd, argv, { cwd }); } catch { return resolve(null); }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += String(d); });
    child.stderr.on('data', (d: Buffer) => { out += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function syntaxCheck(abs: string, content: string, cwd: string): Promise<string | null> {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    try { JSON.parse(content); return null; } catch (e) { return `JSON syntax error: ${errorMessage(e)}`; }
  }
  if (ext === '.py') {
    const check = ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', abs];
    // Windows: "py" launcher or "python"; "python3" may be the Microsoft Store stub.
    const pythons: [string, ...string[]][] = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
    for (const [cmd, ...pre] of pythons) {
      const r = await runCapture(cmd, [...pre, ...check], cwd);
      if (!r || /was not found|Microsoft Store|not recognized|No installed Python/i.test(r.out)) continue; // not this one
      if (r.code !== 0) return `Python syntax error:\n${r.out.trim().split('\n').slice(-6).join('\n')}`;
      return null;
    }
    return null;
  }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = await runCapture(process.env.PONEY_NODE || process.env.LOCAL_CODEX_NODE || 'node', ['--check', abs], cwd);
    if (r && r.code !== 0) return `JavaScript syntax error:\n${r.out.trim().split('\n').slice(0, 8).join('\n')}`;
    return null;
  }
  return null;
}

// ---------- write ----------
const countLines = (text: string | null) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

const FORMAT_HELP = {
  write: '<write path="dir/file.py">\nfull file content\n</write>',
  edit: '<edit path="dir/file.py">\n<old>exact existing lines</old>\n<new>replacement lines</new>\n</edit>',
};

function requirePath(tool: keyof typeof FORMAT_HELP, args: ToolArgs): void {
  if (args.path && String(args.path).trim()) return;
  throw new ToolError(`Missing path: the opening tag must contain path="...". Exact format:\n${FORMAT_HELP[tool]}`);
}

async function writeTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  requirePath('write', args);
  const { abs, rel } = resolveInside(cwd, args.path, ctx.scratch);
  const content = args.content ?? '';
  const before = (await exists(abs)) ? await fs.readFile(abs, 'utf8').catch(() => '') : null;
  const beforeLines = countLines(before);
  // Small models happily rewrite an existing file from memory and silently drop
  // code. Overwriting is only allowed when the file's content is in the history.
  if (before !== null && ctx.seenFiles && !ctx.seenFiles.has(rel) && beforeLines > 5) {
    throw new ToolError(`Refused: ${rel} already exists (${beforeLines} lines) and you have not read it, so your version would be written from memory and could delete code. ` +
      `Read it first with <read path="${rel}" />, then change it with <edit>. To replace it completely, read it first, then use <write> again.`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const finalContent = content.endsWith('\n') || content === '' ? content : content + '\n';
  await fs.writeFile(abs, finalContent);
  const n = finalContent.split('\n').length - 1;
  const err = await syntaxCheck(abs, finalContent, cwd);
  let output = `${before === null ? 'Created' : 'Overwrote'} ${rel} (${n} lines).`;
  if (before !== null && beforeLines >= 20 && n < beforeLines / 2) {
    output += `\nWARNING: ${rel} went from ${beforeLines} to ${n} lines. If you did not mean to delete code, restore it now.`;
  }
  if (err) output += `\nWARNING, the file has an error:\n${err}`;
  return { output, ok: !err, changed: rel, diff: unifiedDiff(before ?? '', finalContent, rel), meta: { path: rel } };
}

// ---------- edit ----------
function indentOf(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

type Located =
  | { error: 'multiple' | 'empty' | 'notfound' }
  | { error?: undefined; start: number; end: number; exact: true }
  | { error?: undefined; start: number; end: number; exact: false; fileIndent: string; modelIndent: string };

/** Finds `oldText` in `content`, exact first, then ignoring indentation / trailing spaces. */
function locate(content: string, oldText: string): Located {
  const idx = content.indexOf(oldText);
  if (idx >= 0) {
    if (content.indexOf(oldText, idx + 1) >= 0) return { error: 'multiple' };
    return { start: idx, end: idx + oldText.length, exact: true };
  }
  const lines = content.split('\n');
  const oldLines = oldText.replace(/\n+$/, '').split('\n');
  while (oldLines.length && !oldLines[0].trim()) oldLines.shift();
  if (!oldLines.length) return { error: 'empty' };
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const target = oldLines.map(norm);
  const matches: number[] = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) if (norm(lines[i + j]) !== target[j]) { ok = false; break; }
    if (ok) matches.push(i);
  }
  if (matches.length > 1) return { error: 'multiple' };
  if (matches.length === 1) {
    const i = matches[0];
    const offsets: number[] = [];
    let pos = 0;
    for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
    const lastLine = i + target.length - 1;
    return {
      start: offsets[i],
      end: offsets[lastLine] + lines[lastLine].length,
      exact: false,
      fileIndent: indentOf(lines[i]),
      modelIndent: indentOf(oldLines[0]),
    };
  }
  return { error: 'notfound' };
}

/**
 * Checks an <old> block while the model is still writing its edit: found once
 * (exactly, or with another indentation), it gives the lines it covers; otherwise
 * the same error the edit would give, so the generation can stop right there.
 */
export async function checkOldBlock(cwd: string, filePath: string, oldText: string, scratch?: string | null): Promise<{ ok: false; message: string } | { ok: true; rel: string; startLine: number; endLine: number }> {
  let abs: string;
  let rel: string;
  try { ({ abs, rel } = resolveInside(cwd, filePath, scratch)); } catch (e) { return { ok: false, message: errorMessage(e) }; }
  let content: string;
  try { content = await fs.readFile(abs, 'utf8'); } catch {
    return { ok: false, message: `File "${rel}" does not exist. Use <write> to create it.` };
  }
  content = content.replace(/\r\n/g, '\n');
  const pair = parseEditBody(`<old>${oldText}</old><new></new>`)[0];
  if (!pair || !pair.old.trim()) return { ok: false, message: 'Empty <old>. To add code, put the existing neighbouring lines in <old> and repeat them in <new> with your additions.' };
  const loc = locate(content, pair.old);
  if (loc.error === 'multiple') return { ok: false, message: `The <old> text appears several times in ${rel}. Include more surrounding lines so it is unique.` };
  if (loc.error) {
    const snip = closestSnippet(content, pair.old);
    return {
      ok: false,
      message: `The <old> text was not found in ${rel}. It must match the file exactly.` +
        (snip ? `\nClosest lines in the file:\n${snip}` : `\nRead the file first with <read path="${rel}" />.`) +
        '\nTip: for a small file, rewrite it entirely with <write>.',
    };
  }
  const startLine = content.slice(0, loc.start).split('\n').length;
  const endLine = startLine + content.slice(loc.start, loc.end).replace(/\n$/, '').split('\n').length - 1;
  return { ok: true, rel, startLine, endLine };
}

function closestSnippet(content: string, oldText: string): string {
  const lines = content.split('\n');
  const want = new Set(oldText.split('\n').map((l) => l.trim()).filter((l) => l.length > 3));
  if (!want.size) return '';
  let best = -1;
  let bestScore = 0;
  const win = Math.max(oldText.split('\n').length, 3);
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = i; j < Math.min(i + win, lines.length); j++) if (want.has(lines[j].trim())) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return '';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + win + 2);
  return lines.slice(from, to).map((l, k) => `${from + k + 1}| ${l}`).join('\n');
}

function reindent(text: string, fromIndent: string, toIndent: string): string {
  if (fromIndent === toIndent) return text;
  return text.split('\n').map((l) => {
    if (!l.trim()) return l;
    if (l.startsWith(fromIndent)) return toIndent + l.slice(fromIndent.length);
    return toIndent + l.trimStart();
  }).join('\n');
}

async function editTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  requirePath('edit', args);
  const { abs, rel } = resolveInside(cwd, args.path, ctx.scratch);
  let content: string;
  try { content = await fs.readFile(abs, 'utf8'); } catch {
    throw new ToolError(`File "${rel}" does not exist. Use <write> to create it.`);
  }
  // Windows line endings: the model writes <old> with "\n" only. Match on LF, write back CRLF.
  const crlf = content.includes('\r\n');
  if (crlf) content = content.replace(/\r\n/g, '\n');
  const pairs = parseEditBody(args.body || '');
  if (!pairs.length) {
    throw new ToolError('No <old>...</old><new>...</new> pair found. Format:\n<edit path="file">\n<old>exact existing lines</old>\n<new>replacement lines</new>\n</edit>');
  }
  const before = content;
  for (const [k, pair] of pairs.entries()) {
    const label = pairs.length > 1 ? ` (change ${k + 1})` : '';
    if (!pair.old.trim()) {
      throw new ToolError(`Empty <old>${label}. To add code, put the existing neighbouring lines in <old> and repeat them in <new> with your additions.`);
    }
    const loc = locate(content, pair.old);
    if (loc.error === 'multiple') {
      throw new ToolError(`The <old> text${label} appears several times in ${rel}. Include more surrounding lines so it is unique.`);
    }
    if (loc.error) {
      const snip = closestSnippet(content, pair.old);
      throw new ToolError(`The <old> text${label} was not found in ${rel}. It must match the file exactly.` +
        (snip ? `\nClosest lines in the file:\n${snip}` : `\nRead the file first with <read path="${rel}" />.`) +
        '\nTip: for a small file, rewrite it entirely with <write>.');
    }
    let replacement = pair.new;
    if (!loc.exact) {
      replacement = reindent(replacement.replace(/^\n+/, '').replace(/\n+$/, ''), loc.modelIndent, loc.fileIndent);
    }
    content = content.slice(0, loc.start) + replacement + content.slice(loc.end);
  }
  await fs.writeFile(abs, crlf ? content.replace(/\r?\n/g, '\r\n') : content);
  const err = await syntaxCheck(abs, content, cwd);
  let output = `Edited ${rel} (${pairs.length} change${pairs.length > 1 ? 's' : ''}).`;
  if (err) output += `\nWARNING, the file now has an error:\n${err}`;
  return { output, ok: !err, changed: rel, diff: unifiedDiff(before, content, rel), meta: { path: rel } };
}

// ---------- run ----------
export function runShell(command: string, { cwd, timeoutSec = 120, signal, onOutput, env: extraEnv = {} }: { cwd: string; timeoutSec?: number; signal?: AbortSignal; onOutput?: (text: string) => void; env?: Record<string, string> }) {
  return new Promise<{ code: number; out: string; timedOut: boolean }>((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shell, argv, {
      cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', PYTHONUNBUFFERED: '1', NO_COLOR: '1', FORCE_COLOR: '0', PAGER: 'cat', GIT_PAGER: 'cat', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32') {
        // child.kill() would stop cmd.exe only: its children (a server, a test run) keep the output open.
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill(); } catch {} }
        return;
      }
      try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort);
    const onData = (d: Buffer) => {
      const s = d.toString();
      if (out.length < 2_000_000) out += s;
      onOutput?.(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `Failed to start command: ${errorMessage(e)}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, out: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), timedOut });
    });
  });
}

async function runTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  const config = needConfig(ctx);
  const command = (args.command || '').trim();
  if (!command) throw new ToolError('Empty command. Put the command between <run> and </run>.');
  const timeoutSec = Math.min(toInt(args.timeout) || config.commandTimeout, 1800);
  // Tor for commands: proxy variables (honored by curl, git, wget…). Refused if Tor is down.
  const viaTor = config.torEnabled && config.torShell;
  const env: Record<string, string> = viaTor ? proxyEnv(await torProxyOrRefuse(config) ?? '') : {};
  // The private folder: named .poney in the command, PONEY_TMP for scripts, and its
  // real path shown back as .poney.
  const scratch = ctx.scratch;
  if (scratch) {
    env.PONEY_TMP = scratch;
    if (/\.poney|PONEY_TMP/.test(command)) await fs.mkdir(scratch, { recursive: true });
  }
  const shown = (t: string) => (scratch ? t.split(scratch).join(SCRATCH) : t);
  const onOutput = ctx.onOutput;
  const r = await runShell(scratch ? scratchCommand(command, scratch) : command, { cwd, timeoutSec, signal: ctx.signal, onOutput: onOutput && ((t) => onOutput(shown(t))), env });
  let output = shown(r.out.trim()) || '(no output)';
  output = truncateMiddle(output, ctx.maxResultChars ?? Infinity);
  if (r.timedOut) output += `\n[command killed after ${timeoutSec}s timeout]`;
  return { output, ok: r.code === 0, exitCode: r.code, meta: { exit: r.code, ...(viaTor ? { tor: true } : {}) } };
}

// ---------- web ----------
/** Tor proxy when enabled; refuses (ToolError) rather than going out in the clear. */
async function torProxyOrRefuse(config: Config): Promise<string | null> {
  if (!config.torEnabled) return null;
  try {
    return await requireTor(config.torProxy);
  } catch (e) {
    throw new ToolError(`${errorMessage(e)} (Tell the user; do not retry this request.)`);
  }
}

async function webSearchTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  const config = needConfig(ctx);
  const q = (args.query || '').trim();
  if (!q) throw new ToolError('Empty query.');
  const proxy = await torProxyOrRefuse(config);
  const results = await webSearch(q, { searxngUrl: config.searxngUrl, signal: ctx.signal, proxy });
  const meta = { query: q, ...(proxy ? { tor: true } : {}) };
  if (!results.length) return { output: 'No results.', meta };
  const output = results.slice(0, 6).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
  return { output: output + '\nUse <fetch>url</fetch> to read a page.', meta };
}

async function fetchTool(cwd: string, args: ToolArgs, ctx: ToolContext = {}): Promise<ToolResult> {
  const url = (args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new ToolError('Give a full URL starting with http:// or https://');
  const proxy = await torProxyOrRefuse(needConfig(ctx));
  const text = await fetchUrl(url, { signal: ctx.signal, proxy });
  return { output: truncateMiddle(text, ctx.maxResultChars ?? Infinity), meta: { url, ...(proxy ? { tor: true } : {}) } };
}

// ---------- several agents on the same files ----------
// An agent and its sub-agents share a version number per file, bumped by each
// write. Writing over a file another agent changed since this one read it is
// refused (it must read it again); writes to one file run one at a time.

function withFileLock<T>(ctx: ToolContext, rel: string, fn: () => Promise<T>): Promise<T> {
  const locks = ctx.shared?.locks;
  if (!locks) return fn();
  const previous = locks.get(rel) || Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(rel, run.catch(() => {}));
  return run;
}

function checkNotChangedByOther(ctx: ToolContext, rel: string): void {
  if (!ctx.shared || !ctx.readVersions) return;
  const seen = ctx.readVersions.get(rel);
  const current = ctx.shared.versions.get(rel) ?? 0;
  if (seen !== undefined && seen !== current) {
    throw new ToolError(`${rel} was changed by another agent since you read it. Read it again with <read path="${rel}" /> before changing it.`);
  }
}

function recordWrite(ctx: ToolContext, rel: string): void {
  if (!ctx.shared) return;
  const v = (ctx.shared.versions.get(rel) ?? 0) + 1;
  ctx.shared.versions.set(rel, v);
  ctx.readVersions?.set(rel, v); // its own change counts as seen
}

const guarded = (impl: Tool): Tool => (cwd, args, ctx = {}) => {
  let rel: string;
  try { ({ rel } = resolveInside(cwd, args.path, ctx.scratch)); } catch { return impl(cwd, args, ctx); }
  return withFileLock(ctx, rel, async () => {
    checkNotChangedByOther(ctx, rel);
    const r = await impl(cwd, args, ctx);
    if (r.changed) recordWrite(ctx, rel);
    return r;
  });
};

const IMPL: Record<string, Tool> = { list: listTool, read: readTool, search: searchTool, write: guarded(writeTool), edit: guarded(editTool), run: runTool, web_search: webSearchTool, fetch: fetchTool };

/** Executes an action. Never throws: errors become a failed result the model can read. */
export async function executeAction(action: Action, ctx: ToolContext & { cwd: string }): Promise<ToolResult & { ok: boolean }> {
  const impl = IMPL[action.tool];
  try {
    const r = await impl(ctx.cwd, action.args, ctx);
    return { ...r, ok: r.ok !== false };
  } catch (e) {
    if (errorName(e) === 'AbortError') throw e;
    const msg = e instanceof ToolError ? errorMessage(e) : `Error: ${errorMessage(e)}`;
    return { ok: false, output: msg, meta: { path: action.args.path } };
  }
}
