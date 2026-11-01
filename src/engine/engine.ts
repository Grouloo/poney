// The models Poney runs itself: one llama-server per model loaded, each on
// 127.0.0.1 behind its own key, loaded when a message needs it and unloaded after
// a while without one. Memory comes before the limit of calls: the idle models go
// first, then a call waits. The prompt cache of a model is kept on disk when it
// is unloaded and read back with it.
// The service is what serves calls, whoever asks: nothing here knows of a conversation.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { InferenceGate } from './gate.ts';
import { num, rec } from '../unknown.ts';
import type { GgufInfo, Lease, LocalModel } from '../types.ts';

export type EngineModel = Pick<LocalModel, 'id' | 'name' | 'file' | 'size' | 'mtimeMs'> & { info?: GgufInfo | null };

/** What the engine needs of a llama-server process. */
export interface ServerProcess {
  pid?: number;
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit' | 'error', listener: () => void): unknown;
}

type Spawn = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'pipe'] }) => ServerProcess;
type FetchFn = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
type Status = (text: string) => void;

interface EngineRequest {
  model: EngineModel | null;
  numCtx: number;
}

interface Server {
  model: EngineModel;
  numCtx: number;
  slots: number;
  memory: number;
  state: 'loading' | 'ready';
  active: number;
  usedAt: number;
  key: string;
  ready?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  onStatus?: Status;
  port?: number;
  proc?: ServerProcess;
  exited?: Promise<void>;
  props?: unknown;
}

const GB = 1024 ** 3;
const MEMORY_SHARE = 0.85; // of the RAM, for the models: the system and the apps keep the rest
const CACHE_RAM_MIB = 1024; // llama-server's prompt cache in memory
const MAX_SLOTS = 8;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const gb = (n: number) => (n / GB).toFixed(1).replace('.', ',');

const BASE_OVERHEAD = 0.5 * GB; // (graphs and buffers, whatever the context)

/** Bytes of the KV cache: for each layer, its cells (a sliding-window layer keeps only its window) by its heads. */
function kvBytes(info: GgufInfo | null | undefined, numCtx: number, slots: number) {
  const { blockCount, embeddingLength, headCount, headCountKv, keyLength, valueLength, slidingWindow, slidingPattern, keyLengthSwa, valueLengthSwa }: Partial<GgufInfo> = info ?? {};
  if (!blockCount) return null;
  const heads = (i: number) => (Array.isArray(headCountKv) ? headCountKv[i] ?? 0 : headCountKv ?? headCount ?? 1);
  const headSize = embeddingLength && headCount ? Math.floor(embeddingLength / headCount) : 0;
  let cellBytes = 0; // over all the layers, for one cell of the full context
  let windowBytes = 0; // the same for the sliding-window layers, whose cells do not grow with the context
  for (let i = 0; i < blockCount; i++) {
    const sliding = Boolean(slidingWindow && slidingPattern?.[i]);
    const key = (sliding && keyLengthSwa) || keyLength || headSize;
    const value = (sliding && valueLengthSwa) || valueLength || headSize;
    const bytes = heads(i) * (key + value) * 2; // (16 bits each)
    if (sliding) windowBytes += bytes; else cellBytes += bytes;
  }
  return slots * (numCtx * cellBytes + Math.min(numCtx, (slidingWindow ?? 0) * 2) * windowBytes);
}

/** Bytes a model needs with this context on each slot: its weights, its KV cache, the prompt cache. An estimate. */
export function estimateMemory(model: Pick<EngineModel, 'size' | 'info'>, numCtx: number, slots = 1): number {
  const kv = kvBytes(model.info, numCtx, slots) ?? model.size * 0.2;
  return Math.round(model.size * 1.02 + kv + BASE_OVERHEAD + CACHE_RAM_MIB * 1024 * 1024);
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const port = num(rec(s.address()).port);
    s.close(() => resolve(port));
  });
});

export class ModelEngine {
  binary: (onStatus: Status) => Promise<string>;
  cacheDir: string;
  build?: string;
  idleMs: number;
  cacheBytes: number;
  spawn: Spawn;
  fetchFn: FetchFn;
  log: (what: string, e: unknown) => void;
  budget: number;
  servers: Map<string, Server>;
  stopping: Set<Promise<void>>;
  gate: InferenceGate<EngineRequest>;

  /**
   * binary(onStatus): the path of llama-server, installed if need be.
   * cacheDir: the prompt caches kept on disk. build: the engine's, part of their keys.
   */
  constructor({ binary, cacheDir, build, limit = 1, idleMs = 15 * 60 * 1000, cacheBytes = 10 * GB, totalMemory = os.totalmem(), spawn = (binary, args, options) => nodeSpawn(binary, args, options), fetchFn = fetch, log = () => {} }: {
    binary: (onStatus: Status) => Promise<string>;
    cacheDir: string;
    build?: string;
    limit?: number;
    idleMs?: number;
    cacheBytes?: number;
    totalMemory?: number;
    spawn?: Spawn;
    fetchFn?: FetchFn;
    log?: (what: string, e: unknown) => void;
  }) {
    this.binary = binary;
    this.cacheDir = cacheDir;
    this.build = build;
    this.idleMs = idleMs;
    this.cacheBytes = cacheBytes;
    this.spawn = spawn;
    this.fetchFn = fetchFn;
    this.log = log;
    this.budget = totalMemory * MEMORY_SHARE;
    this.servers = new Map(); // model id -> server
    this.stopping = new Set();
    this.gate = new InferenceGate(this, limit);
  }

  setOptions({ limit, idleMs, cacheBytes }: { limit?: number; idleMs?: number; cacheBytes?: number }): void {
    if (idleMs !== undefined) this.idleMs = idleMs;
    if (cacheBytes !== undefined) this.cacheBytes = cacheBytes;
    if (limit !== undefined) this.gate.setLimit(limit);
    for (const s of this.servers.values()) this.scheduleUnload(s);
  }

  // ---------- memory ----------
  /** What to reserve. The estimate is one: beyond the budget, the model just gets the whole machine and tries. */
  need(model: EngineModel, numCtx: number, slots = 1): number {
    return Math.min(estimateMemory(model, numCtx, slots), this.budget);
  }

  used() {
    let n = 0;
    for (const s of this.servers.values()) n += s.memory;
    return n;
  }

  /** The slots to load: as many as the limit asks and the memory allows beside what stays. */
  slotsFor(model: EngineModel, numCtx: number, room: number): number {
    const wanted = Math.min(this.gate.limit || MAX_SLOTS, MAX_SLOTS);
    for (let n = wanted; n > 1; n--) if (estimateMemory(model, numCtx, n) <= room) return n; // (an extra slot only if it surely fits)
    return 1;
  }

  roomWithoutIdle(exceptId: string): number {
    let keep = 0;
    for (const s of this.servers.values()) if (s.active || s.state === 'loading') if (s.model.id !== exceptId) keep += s.memory;
    return this.budget - keep;
  }

  // ---------- the gate's host ----------
  isLoaded({ model, numCtx }: EngineRequest): boolean {
    if (!model) return true;
    const s = this.servers.get(model.id);
    return Boolean(s && s.numCtx === numCtx);
  }

  canStart({ model, numCtx }: EngineRequest): boolean {
    if (!model) return true; // (another server: only the limit counts)
    const s = this.servers.get(model.id);
    if (s && s.numCtx === numCtx) return s.active < s.slots;
    if (s?.active) return false; // (its context changes: once its calls are done)
    return this.need(model, numCtx) <= this.roomWithoutIdle(model.id);
  }

  start({ model, numCtx }: EngineRequest): void {
    if (!model) return;
    let s = this.servers.get(model.id);
    if (!s || s.numCtx !== numCtx) {
      if (s) this.unload(s);
      const room = this.roomWithoutIdle(model.id);
      const slots = this.slotsFor(model, numCtx, room);
      const memory = this.need(model, numCtx, slots);
      // The idle models that must go, the longest unused first.
      const idle = [...this.servers.values()].filter((x) => !x.active && x.state === 'ready').sort((a, b) => a.usedAt - b.usedAt);
      for (const old of idle) {
        if (this.used() + memory <= this.budget) break;
        this.unload(old);
      }
      const server: Server = { model, numCtx, slots, memory, state: 'loading', active: 0, usedAt: Date.now(), key: randomBytes(24).toString('hex') };
      s = server;
      this.servers.set(model.id, server);
      server.ready = this.load(server).catch((e: unknown) => {
        if (this.servers.get(model.id) === server) this.servers.delete(model.id);
        throw e;
      });
    }
    s.active++;
    clearTimeout(s.idleTimer);
  }

  // ---------- calls ----------
  /**
   * Waits for its turn and for the model. Returns { baseUrl, apiKey, model, slots, release }
   * (for a model of another server, only release). onStatus(text) tells what it waits for.
   */
  async acquire({ model = null, numCtx = 0, signal, onStatus }: { model?: EngineModel | null; numCtx?: number; signal?: AbortSignal; onStatus?: Status }): Promise<Lease> {
    if (model) {
      numCtx = Math.min(numCtx, model.info?.contextLength || numCtx);
      if (model.size > this.budget) { // (only the weights count here: they are known, and no context helps)
        throw new Error(`Ce modèle pèse ${gb(model.size)} Go, alors que ${gb(this.budget)} Go sont disponibles ici pour les modèles.`);
      }
    }
    const req = { model, numCtx };
    const waitTimer = setTimeout(() => onStatus?.('En attente du modèle…'), 150);
    let release: () => void;
    try {
      release = await this.gate.acquire(req, signal);
    } finally {
      clearTimeout(waitTimer);
    }
    if (!model) return { release };
    const s = this.servers.get(model.id);
    if (!s) {
      release();
      throw new Error('Le modèle n’est plus chargé.');
    }
    const done = () => {
      s.active--;
      s.usedAt = Date.now();
      this.scheduleUnload(s);
      release();
    };
    try {
      s.onStatus = onStatus;
      if (s.state === 'loading') onStatus?.('Chargement du modèle…');
      await s.ready;
    } catch (e) {
      done();
      throw e;
    }
    return { baseUrl: `http://127.0.0.1:${s.port}`, apiKey: s.key, model, slots: s.slots, numCtx: s.numCtx, release: done };
  }

  scheduleUnload(s: Server): void {
    clearTimeout(s.idleTimer);
    if (s.active || s.state !== 'ready' || !this.idleMs) return;
    s.idleTimer = setTimeout(() => {
      if (!s.active && this.servers.get(s.model.id) === s) {
        this.unload(s);
        this.gate.pump();
      }
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  // ---------- processes ----------
  cacheFile(s: Server, slot: number): string {
    const key = createHash('sha1').update(JSON.stringify([s.model.file, s.model.size, s.model.mtimeMs, s.numCtx, this.build])).digest('hex').slice(0, 20);
    return `${key}-${slot}.bin`;
  }

  async load(s: Server): Promise<void> {
    await Promise.all(this.stopping); // (what is being unloaded still holds its memory)
    const binary = await this.binary((text) => s.onStatus?.(text));
    await fs.mkdir(this.cacheDir, { recursive: true });
    s.port = await freePort();
    if (this.servers.get(s.model.id) !== s) throw new Error('Chargement annulé.'); // (stopped meanwhile: nothing would stop this process)
    const args = [
      '-m', s.model.file, '--host', '127.0.0.1', '--port', String(s.port),
      '-c', String(s.numCtx * s.slots), '-np', String(s.slots), '--no-kv-unified', '-ngl', 'all',
      '--cache-ram', String(CACHE_RAM_MIB), '--slot-save-path', this.cacheDir, '--no-webui', '--reasoning-format', 'deepseek',
      ...(/^gemma/i.test(s.model.info?.arch ?? '') ? ['--special'] : []), // (the raw mode reads its channel markers)
    ];
    const proc = this.spawn(binary, args, { env: { ...process.env, LLAMA_API_KEY: s.key }, stdio: ['ignore', 'ignore', 'pipe'] });
    s.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + String(d)).slice(-2000); });
    const end: { exited: boolean } = { exited: false };
    s.exited = new Promise<void>((resolve) => proc.once('exit', () => { end.exited = true; resolve(); }));
    proc.once('error', () => { end.exited = true; });
    s.exited.then(() => {
      if (this.servers.get(s.model.id) === s) {
        this.servers.delete(s.model.id);
        this.gate.pump();
      }
    });
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    for (;;) {
      if (end.exited || Date.now() > deadline) {
        proc.kill();
        throw new Error(`Le moteur n’a pas pu charger ${s.model.name}${stderr ? ` : ${stderr.trim().split('\n').slice(-2).join(' ')}` : '.'}`);
      }
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) break;
      } catch {}
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    s.props = await this.call(s, 'GET', '/props').catch(() => null);
    await this.restoreCache(s);
    s.state = 'ready';
    this.gate.pump();
  }

  async call(s: Server, method: string, route: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`http://127.0.0.1:${s.port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.key}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async restoreCache(s: Server): Promise<void> {
    for (let slot = 0; slot < s.slots; slot++) {
      const filename = this.cacheFile(s, slot);
      const file = path.join(this.cacheDir, filename);
      try {
        await fs.access(file);
      } catch {
        continue;
      }
      try {
        await this.call(s, 'POST', `/slots/${slot}?action=restore`, { filename });
        const now = new Date();
        await fs.utimes(file, now, now); // (the purge goes by last use)
      } catch (e) {
        this.log('prompt cache', e);
        await fs.rm(file, { force: true });
      }
    }
  }

  async saveCache(s: Server): Promise<void> {
    for (let slot = 0; slot < s.slots; slot++) {
      try {
        await this.call(s, 'POST', `/slots/${slot}?action=save`, { filename: this.cacheFile(s, slot) });
      } catch (e) {
        this.log('prompt cache', e);
      }
    }
    await this.purgeCache();
  }

  /** Over the limit: the caches unused for the longest time go. */
  async purgeCache(): Promise<void> {
    let files: { file: string; size: number; mtimeMs: number }[];
    try {
      files = await Promise.all((await fs.readdir(this.cacheDir)).map(async (name) => {
        const file = path.join(this.cacheDir, name);
        const st = await fs.stat(file);
        return { file, size: st.size, mtimeMs: st.mtimeMs };
      }));
    } catch {
      return;
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.cacheBytes) break;
      await fs.rm(f.file, { force: true });
      total -= f.size;
    }
  }

  unload(s: Server): Promise<void> {
    clearTimeout(s.idleTimer);
    if (this.servers.get(s.model.id) === s) this.servers.delete(s.model.id);
    const stopped: Promise<void> = (async () => {
      if (s.state === 'ready') await this.saveCache(s);
      const { proc } = s;
      if (!proc) return;
      proc.kill();
      const force = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await s.exited;
      clearTimeout(force);
    })().catch((e: unknown) => this.log('unload', e)).finally(() => {
      this.stopping.delete(stopped);
      this.gate.pump();
    });
    this.stopping.add(stopped);
    return stopped;
  }

  /** At quit: everything is stopped, the caches saved. */
  async shutdown(): Promise<void> {
    for (const s of [...this.servers.values()]) this.unload(s);
    await Promise.all(this.stopping);
  }

  /** The servers still running, for a kill at the last moment (a signal: nothing async is possible). */
  kill(): void {
    for (const s of this.servers.values()) s.proc?.kill('SIGKILL');
  }

  status() {
    return [...this.servers.values()].map((s) => ({ id: s.model.id, state: s.state, active: s.active, slots: s.slots, numCtx: s.numCtx, memory: s.memory, pid: s.proc?.pid ?? null }));
  }
}
