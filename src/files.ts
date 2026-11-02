// Read-only file access for the file browser and viewer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, SCRATCH, resolveInside } from './agent/tools.ts';

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
