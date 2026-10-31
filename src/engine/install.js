// The inference engine: llama-server, a pinned build of llama.cpp. It is fetched
// from the project's releases the first time a Poney model is used, checked
// against the digest below, and kept in the app's data. A new build is pinned
// here only after scripts/compare-engine.mjs has passed on it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const ENGINE_BUILD = 'b12020';
const ASSETS = {
  'darwin-arm64': { file: `llama-${ENGINE_BUILD}-bin-macos-arm64.tar.gz`, sha256: 'b630ebd5da34b02e86f7294dd5743aba842a0a02cb023130debd64599721c541' },
};
const URL_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_BUILD}`;

export const engineSupported = (platform = process.platform, arch = process.arch) => Boolean(ASSETS[`${platform}-${arch}`]);

async function findFile(dir, name) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const found = await findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/** The server's path once installed, else null. */
export async function installedEngine(dir, build = ENGINE_BUILD) {
  try {
    return await findFile(path.join(dir, build), 'llama-server');
  } catch {
    return null;
  }
}

/** Fetches and unpacks the engine, unless it is there. A file that does not match the digest is thrown away. */
export async function installEngine(dir, { fetchFn = fetch, asset = ASSETS[`${process.platform}-${process.arch}`], url = `${URL_BASE}/${asset?.file}`, build = ENGINE_BUILD, onProgress } = {}) {
  const found = await installedEngine(dir, build);
  if (found) return found;
  if (!asset) throw new Error('Le moteur de Poney n’est pas disponible sur cette machine pour l’instant.');
  await fs.mkdir(dir, { recursive: true });
  const work = await fs.mkdtemp(path.join(dir, 'install-'));
  try {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers?.get?.('content-length')) || 0;
    const archive = path.join(work, 'engine.tar.gz');
    const hash = createHash('sha256');
    const out = createWriteStream(archive);
    let got = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      if (total) onProgress?.(got / total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (hash.digest('hex') !== asset.sha256) throw new Error('le fichier téléchargé ne correspond pas à la version attendue');
    const unpacked = path.join(work, 'unpacked');
    await fs.mkdir(unpacked);
    await promisify(execFile)('tar', ['-xzf', archive, '-C', unpacked]);
    const server = await findFile(unpacked, 'llama-server');
    if (!server) throw new Error('llama-server est absent de l’archive');
    await fs.chmod(server, 0o755);
    await fs.rename(unpacked, path.join(dir, build));
    return installedEngine(dir, build);
  } catch (e) {
    throw new Error(`Installation du moteur impossible : ${e.message}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
