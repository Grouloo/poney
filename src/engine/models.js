// The GGUF models on this machine: Poney's own folder, then the ones others keep
// (read only, so that nothing is stored twice).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readGguf } from './gguf.js';

const SHARD = /-(\d{5})-of-\d{5}\.gguf$/i;

async function ggufFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await ggufFiles(p, out);
    else if (/\.gguf$/i.test(e.name) && !/^mmproj/i.test(e.name) && !/embed/i.test(e.name)) out.push(p);
  }
  return out;
}

/** [{ id, name, file, size, mtimeMs, folder, info }]: a file found twice counts once, the first folder winning. */
export async function scanModels(dirs) {
  const models = new Map();
  for (const dir of dirs) {
    for (const file of await ggufFiles(dir)) {
      const shard = file.match(SHARD);
      if (shard && shard[1] !== '00001') continue;
      const name = path.basename(file).replace(SHARD, '').replace(/\.gguf$/i, '');
      const id = name.toLowerCase();
      if (models.has(id)) continue;
      const info = await readGguf(file);
      if (!info) continue;
      let size = 0;
      let mtimeMs = 0;
      const siblings = shard ? (await fs.readdir(path.dirname(file))).filter((f) => f.replace(SHARD, '') === path.basename(file).replace(SHARD, '')).map((f) => path.join(path.dirname(file), f)) : [file];
      for (const f of siblings) {
        const st = await fs.stat(f);
        size += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
      models.set(id, { id, name, file, size, mtimeMs, folder: path.basename(path.dirname(file)), info });
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Whether a model listed by LM Studio is one of these files: Poney runs it, so it shows once. */
export function sameModelFile(lmStudioId, models) {
  const id = lmStudioId.toLowerCase();
  return models.some((m) => m.folder.toLowerCase().startsWith(id) || m.id.startsWith(id));
}
