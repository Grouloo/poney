// Read-only file access for the file browser and viewer.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IGNORED_DIRS, SCRATCH, resolveInside } from './agent/tools.ts';
import { isRecord, isString, list, parseJson, rec } from './unknown.ts';

const IMAGE_TYPES: Record<string, string | undefined> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

/**
 * A folder's entries. At the root, the conversation's private folder (.poney/, see
 * tools.ts) comes first once the model has put something there.
 */
export async function listDir(cwd: string | null | undefined, rel = '.', scratch: string | null = null) {
  if (!cwd) return [];
  const { abs, rel: clean } = resolveInside(cwd, rel || '.', scratch);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const list = entries
    .filter((e) => e.name !== '.DS_Store' && !(clean === '.' && scratch && e.name === SCRATCH))
    .map((e) => ({
      name: e.name,
      path: clean === '.' ? e.name : `${clean}/${e.name}`,
      dir: e.isDirectory(),
      ignored: e.isDirectory() && IGNORED_DIRS.has(e.name),
      scratch: false,
    }))
    .sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (clean !== '.' || !scratch) return list;
  const used = await fs.readdir(scratch).then((names) => names.some((n) => n !== '.DS_Store'), () => false);
  return used ? [{ name: SCRATCH, path: SCRATCH, dir: true, ignored: false, scratch: true }, ...list] : list;
}

export type ViewedFile = {
  path: string;
  size: number;
  mtime: number;
} & ({ kind: 'large' | 'binary' } | { kind: 'image'; src: string } | { kind: 'text'; content: string; truncated: boolean });

export async function readFileForViewer(cwd: string, rel: string, scratch: string | null = null): Promise<ViewedFile> {
  const { abs, rel: clean } = resolveInside(cwd, rel, scratch);
  const st = await fs.stat(abs);
  const ext = path.extname(abs).toLowerCase();
  const base = { path: clean, size: st.size, mtime: st.mtimeMs };
  const image = IMAGE_TYPES[ext];
  if (image) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'large' };
    const data = await fs.readFile(abs);
    return { ...base, kind: 'image', src: `data:${image};base64,${data.toString('base64')}` };
  }
  const handle = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
    await handle.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', content: buf.toString('utf8'), truncated: st.size > MAX_TEXT };
  } finally {
    await handle.close();
  }
}

/**
 * The file of an image the agent shows in its answer (![…](path)): an absolute path, a file://
 * URL, or a path in the project. Null: not a local image.
 */
export function imagePath(cwd: string | null, src: string): string | null {
  let file = src.trim();
  if (/^file:\/\//i.test(file)) {
    try { file = fileURLToPath(file); } catch { return null; }
  } else if (/^[a-z][\w+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return null; // (web addresses, data URLs: not this)
  try { file = decodeURI(file); } catch {}
  if (!path.isAbsolute(file)) {
    if (!cwd) return null;
    file = path.resolve(cwd, file);
  }
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ? file : null;
}

/** Such an image, as a data URL (null: none there, or too large). */
export async function readImage(cwd: string | null, src: string): Promise<string | null> {
  const file = imagePath(cwd, src);
  if (!file) return null;
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_IMAGE) return null;
    return `data:${IMAGE_TYPES[path.extname(file).toLowerCase()]};base64,${(await fs.readFile(file)).toString('base64')}`;
  } catch {
    return null;
  }
}

/** A name not taken in a folder: "name.ext", else "name 2.ext", "name 3.ext"… */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} ${n}${ext}`;
    try { await fs.lstat(path.join(dir, candidate)); } catch { return candidate; }
  }
}

/**
 * Files brought into a folder (of the project): copied, or moved (from another disk too, by a
 * copy then removal). A name taken gets a number. Returns the new names.
 */
export async function bringInto(sources: string[], dir: string, { move = false } = {}): Promise<string[]> {
  const names: string[] = [];
  for (const source of sources) {
    const from = path.resolve(source);
    if (dir === from || dir.startsWith(`${from}${path.sep}`)) throw new Error(`« ${path.basename(from)} » ne peut pas aller dans lui-même.`);
    if (move && path.dirname(from) === dir) continue; // (already there)
    const name = await freeName(dir, path.basename(from));
    const to = path.join(dir, name);
    if (!move) await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    else {
      try {
        await fs.rename(from, to);
      } catch (e) {
        if (rec(e).code !== 'EXDEV') throw e;
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await fs.rm(from, { recursive: true, force: true });
      }
    }
    names.push(name);
  }
  return names;
}

// The applications that open a file (macOS asks Launch Services; elsewhere, none is known).
const APPS_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  const ws = $.NSWorkspace.sharedWorkspace, fm = $.NSFileManager.defaultManager;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const app = (u) => ({ path: u.path.js, name: fm.displayNameAtPath(u.path).js.replace(/\\.app$/, '') });
  const first = ws.URLForApplicationToOpenURL(url), all = ws.URLsForApplicationsToOpenURL(url), apps = [];
  for (let i = 0; i < all.count; i++) apps.push(app(all.objectAtIndex(i)));
  return JSON.stringify({ default: first.isNil() ? null : app(first), apps });
}`;
export type OpeningApp = { path: string; name: string };
const isApp = (v: unknown): v is OpeningApp => isRecord(v) && isString(v.path) && isString(v.name);

/** The default application of a file, then the others that can open it. */
export async function appsToOpen(abs: string): Promise<{ default: OpeningApp | null; others: OpeningApp[] }> {
  if (process.platform !== 'darwin') return { default: null, others: [] };
  const { stdout } = await promisify(execFile)('osascript', ['-l', 'JavaScript', '-e', APPS_SCRIPT, abs], { timeout: 5000 });
  const r = parseJson(stdout);
  const first = isRecord(r) && isApp(r.default) ? r.default : null;
  const apps = list(isRecord(r) ? r.apps : null).filter(isApp);
  return { default: first, others: apps.filter((a) => a.path !== first?.path && !a.path.includes('.app/')).sort((a, b) => a.name.localeCompare(b.name)) }; // (not the helpers inside an app)
}

/** Opens a file with an application (macOS). */
export async function openWith(abs: string, appPath: string) {
  if (process.platform !== 'darwin') throw new Error('Indisponible sur ce système.');
  if (!appPath.endsWith('.app')) throw new Error('Application inconnue.');
  await fs.stat(appPath);
  await promisify(execFile)('open', ['-a', appPath, '--', abs]);
}
