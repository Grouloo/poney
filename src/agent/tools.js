import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEditBody } from './protocol.js';
import { webSearch, fetchUrl } from './web.js';
import { requireTor, proxyEnv } from './tor.js';
import { unifiedDiff } from './diff.js';

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.cache', '.idea', '.vscode']);
const READ_MAX_LINES = 250;

export class ToolError extends Error {}

export function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${cut} characters cut ...]\n\n${text.slice(-tail)}`;
}

export function resolveInside(cwd, p) {
  if (!p || !String(p).trim()) throw new ToolError('Missing "path".');
  const clean = String(p).trim().replace(/^["'`]|["'`]$/g, '');
  const abs = path.resolve(cwd, clean);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`Path "${clean}" is outside the project folder. Use paths relative to the project.`);
  }
  return { abs, rel: rel || '.' };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ---------- list ----------
async function listTool(cwd, args) {
  const { abs, rel } = resolveInside(cwd, args.path || '.');
  const maxDepth = Math.min(parseInt(args.depth, 10) || 3, 6);
  const lines = [];
  let count = 0;
  async function walk(dir, depth, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { throw new ToolError(`Cannot list "${rel}": ${e.code || e.message}`); }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
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
async function readTool(cwd, args) {
  const { abs, rel } = resolveInside(cwd, args.path);
  let content;
  try { content = await fs.readFile(abs, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError(`File "${rel}" does not exist. Use <list /> to see files.`);
    if (e.code === 'EISDIR') throw new ToolError(`"${rel}" is a folder. Use <list path="${rel}" />.`);
    throw new ToolError(`Cannot read "${rel}": ${e.message}`);
  }
  if (content.includes('\u0000')) throw new ToolError(`"${rel}" is a binary file.`);
  const all = content.split('\n');
  const start = Math.max(1, parseInt(args.start, 10) || 1);
  let end = parseInt(args.end, 10) || start + READ_MAX_LINES - 1;
  end = Math.min(end, all.length, start + READ_MAX_LINES * 2 - 1);
  const width = String(end).length;
  const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join('\n');
  let note = '';
  if (end < all.length) note = `\n[showing lines ${start}-${end} of ${all.length}. Use <read path="${rel}" start="${end + 1}" /> for more]`;
  return { output: (body || '(empty file)') + note, meta: { path: rel, lines: `${start}-${end}` } };
}

// ---------- search ----------
async function searchTool(cwd, args) {
  const pattern = args.pattern || args.query;
  if (!pattern) throw new ToolError('Missing "pattern".');
  const { abs, rel } = resolveInside(cwd, args.path || '.');
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const hits = [];
  async function walk(p) {
    if (hits.length >= 80) return;
    let st;
    try { st = await fs.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(path.basename(p)) && p !== abs) return;
      for (const name of (await fs.readdir(p)).sort()) await walk(path.join(p, name));
      return;
    }
    if (st.size > 1_000_000) return;
    let text;
    try { text = await fs.readFile(p, 'utf8'); } catch { return; }
    if (text.includes('\u0000')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < 80; i++) {
      if (re.test(lines[i])) hits.push(`${path.relative(cwd, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  await walk(abs);
  return { output: hits.length ? hits.join('\n') + (hits.length >= 80 ? '\n[... more matches cut ...]' : '') : 'No matches.', meta: { pattern, path: rel } };
}

// ---------- syntax checks after write/edit ----------
function runCapture(cmd, argv, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, argv, { cwd }); } catch { return resolve(null); }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function syntaxCheck(abs, content, cwd) {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    try { JSON.parse(content); return null; } catch (e) { return `JSON syntax error: ${e.message}`; }
  }
  if (ext === '.py') {
    const r = await runCapture('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', abs], cwd);
    if (r && r.code !== 0) return `Python syntax error:\n${r.out.trim().split('\n').slice(-6).join('\n')}`;
    return null;
  }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = await runCapture(process.env.LOCAL_CODEX_NODE || 'node', ['--check', abs], cwd);
    if (r && r.code !== 0) return `JavaScript syntax error:\n${r.out.trim().split('\n').slice(0, 8).join('\n')}`;
    return null;
  }
  return null;
}

// ---------- write ----------
const countLines = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

const FORMAT_HELP = {
  write: '<write path="dir/file.py">\nfull file content\n</write>',
  edit: '<edit path="dir/file.py">\n<old>exact existing lines</old>\n<new>replacement lines</new>\n</edit>',
};

function requirePath(tool, args) {
  if (args.path && String(args.path).trim()) return;
  throw new ToolError(`Missing path: the opening tag must contain path="...". Exact format:\n${FORMAT_HELP[tool]}`);
}

async function writeTool(cwd, args, ctx = {}) {
  requirePath('write', args);
  const { abs, rel } = resolveInside(cwd, args.path);
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
function indentOf(line) {
  return line.match(/^[ \t]*/)[0];
}

/** Finds `oldText` in `content`, exact first, then ignoring indentation / trailing spaces. */
function locate(content, oldText) {
  const idx = content.indexOf(oldText);
  if (idx >= 0) {
    if (content.indexOf(oldText, idx + 1) >= 0) return { error: 'multiple' };
    return { start: idx, end: idx + oldText.length, exact: true };
  }
  const lines = content.split('\n');
  const oldLines = oldText.replace(/\n+$/, '').split('\n');
  while (oldLines.length && !oldLines[0].trim()) oldLines.shift();
  if (!oldLines.length) return { error: 'empty' };
  const norm = (s) => s.trim().replace(/\s+/g, ' ');
  const target = oldLines.map(norm);
  const matches = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) if (norm(lines[i + j]) !== target[j]) { ok = false; break; }
    if (ok) matches.push(i);
  }
  if (matches.length > 1) return { error: 'multiple' };
  if (matches.length === 1) {
    const i = matches[0];
    const offsets = [];
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

function closestSnippet(content, oldText) {
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

function reindent(text, fromIndent, toIndent) {
  if (fromIndent === toIndent) return text;
  return text.split('\n').map((l) => {
    if (!l.trim()) return l;
    if (l.startsWith(fromIndent)) return toIndent + l.slice(fromIndent.length);
    return toIndent + l.trimStart();
  }).join('\n');
}

async function editTool(cwd, args) {
  requirePath('edit', args);
  const { abs, rel } = resolveInside(cwd, args.path);
  let content;
  try { content = await fs.readFile(abs, 'utf8'); } catch {
    throw new ToolError(`File "${rel}" does not exist. Use <write> to create it.`);
  }
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
  await fs.writeFile(abs, content);
  const err = await syntaxCheck(abs, content, cwd);
  let output = `Edited ${rel} (${pairs.length} change${pairs.length > 1 ? 's' : ''}).`;
  if (err) output += `\nWARNING, the file now has an error:\n${err}`;
  return { output, ok: !err, changed: rel, diff: unifiedDiff(before, content, rel), meta: { path: rel } };
}

// ---------- run ----------
export function runShell(command, { cwd, timeoutSec = 120, signal, onOutput, env: extraEnv = {} }) {
  return new Promise((resolve) => {
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
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort);
    const onData = (d) => {
      const s = d.toString();
      if (out.length < 2_000_000) out += s;
      onOutput?.(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `Failed to start command: ${e.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, out: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), timedOut });
    });
  });
}

async function runTool(cwd, args, ctx) {
  const command = (args.command || '').trim();
  if (!command) throw new ToolError('Empty command. Put the command between <run> and </run>.');
  const timeoutSec = Math.min(parseInt(args.timeout, 10) || ctx.config.commandTimeout, 1800);
  // Tor for commands: proxy variables (honored by curl, git, wget…). Refused if Tor is down.
  const viaTor = ctx.config.torEnabled && ctx.config.torShell;
  const env = viaTor ? proxyEnv(await torProxyOrRefuse(ctx.config)) : {};
  const r = await runShell(command, { cwd, timeoutSec, signal: ctx.signal, onOutput: ctx.onOutput, env });
  let output = r.out.trim() || '(no output)';
  output = truncateMiddle(output, ctx.maxResultChars);
  if (r.timedOut) output += `\n[command killed after ${timeoutSec}s timeout]`;
  return { output, ok: r.code === 0, exitCode: r.code, meta: { exit: r.code, ...(viaTor ? { tor: true } : {}) } };
}

// ---------- web ----------
/** Tor proxy when enabled; refuses (ToolError) rather than going out in the clear. */
async function torProxyOrRefuse(config) {
  if (!config.torEnabled) return null;
  try {
    return await requireTor(config.torProxy);
  } catch (e) {
    throw new ToolError(`${e.message} (Tell the user; do not retry this request.)`);
  }
}

async function webSearchTool(cwd, args, ctx) {
  const q = (args.query || '').trim();
  if (!q) throw new ToolError('Empty query.');
  const proxy = await torProxyOrRefuse(ctx.config);
  const results = await webSearch(q, { searxngUrl: ctx.config.searxngUrl, signal: ctx.signal, proxy });
  const meta = { query: q, ...(proxy ? { tor: true } : {}) };
  if (!results.length) return { output: 'No results.', meta };
  const output = results.slice(0, 6).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
  return { output: output + '\nUse <fetch>url</fetch> to read a page.', meta };
}

async function fetchTool(cwd, args, ctx) {
  const url = (args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new ToolError('Give a full URL starting with http:// or https://');
  const proxy = await torProxyOrRefuse(ctx.config);
  const text = await fetchUrl(url, { signal: ctx.signal, proxy });
  return { output: truncateMiddle(text, ctx.maxResultChars), meta: { url, ...(proxy ? { tor: true } : {}) } };
}

const IMPL = { list: listTool, read: readTool, search: searchTool, write: writeTool, edit: editTool, run: runTool, web_search: webSearchTool, fetch: fetchTool };

/** Executes an action. Never throws: errors become a failed result the model can read. */
export async function executeAction(action, ctx) {
  const impl = IMPL[action.tool];
  try {
    const r = await impl(ctx.cwd, action.args, ctx);
    return { ok: r.ok !== false, ...r };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const msg = e instanceof ToolError ? e.message : `Error: ${e.message}`;
    return { ok: false, output: msg, meta: { path: action.args.path } };
  }
}
