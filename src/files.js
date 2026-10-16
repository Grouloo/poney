// Read-only file access for the file browser and viewer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, resolveInside } from './agent/tools.js';

const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

export async function listDir(cwd, rel = '.') {
  if (!cwd) return [];
  const { abs } = resolveInside(cwd, rel || '.');
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== '.DS_Store')
    .map((e) => ({
      name: e.name,
      path: path.relative(cwd, path.join(abs, e.name)),
      dir: e.isDirectory(),
      ignored: e.isDirectory() && IGNORED_DIRS.has(e.name),
    }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function readFileForViewer(cwd, rel) {
  const { abs, rel: clean } = resolveInside(cwd, rel);
  const st = await fs.stat(abs);
  const ext = path.extname(abs).toLowerCase();
  const base = { path: clean, size: st.size, mtime: st.mtimeMs };
  if (IMAGE_TYPES[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'large' };
    const data = await fs.readFile(abs);
    return { ...base, kind: 'image', src: `data:${IMAGE_TYPES[ext]};base64,${data.toString('base64')}` };
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
