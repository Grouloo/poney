import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { InferenceGate, MAX_PASSES } from '../src/engine/gate.js';
import { ModelEngine, estimateMemory } from '../src/engine/engine.js';
import { installEngine, installedEngine } from '../src/engine/install.js';
import { readGguf } from '../src/engine/gguf.js';
import { scanModels, sameModelFile } from '../src/engine/models.js';
import { streamChat, setInferenceService } from '../src/agent/llm.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'poney-engine-'));
const GB = 1024 ** 3;
const model = (id, size = GB, extra = {}) => ({ id, name: id, file: `/models/${id}.gguf`, size, mtimeMs: 1, folder: id, info: { arch: 'qwen3', ...extra } });

// ---------- the gate ----------
function host({ loaded = new Set(), can = () => true } = {}) {
  return { loaded, started: [], canStart: can, isLoaded: (r) => loaded.has(r.model), start(r) { this.started.push(r.name ?? r.model); } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the limit holds, and a call waits for the one before it', async () => {
  const h = host();
  const gate = new InferenceGate(h, 1);
  const first = await gate.acquire({ model: 'a' });
  let second = null;
  gate.acquire({ model: 'a' }).then((r) => { second = r; });
  await flush();
  assert.equal(second, null);
  first();
  await flush();
  assert.equal(typeof second, 'function');
  first(); // (released twice: counted once)
  assert.equal(gate.running, 1);
});

test('without a limit, everything starts', async () => {
  const gate = new InferenceGate(host(), 0);
  await Promise.all([gate.acquire({ model: 'a' }), gate.acquire({ model: 'b' }), gate.acquire({ model: 'c' })]);
  assert.equal(gate.running, 3);
});

test('a call for the model loaded goes first, but passes an older one only so many times', async () => {
  const h = host({ loaded: new Set(['a']) });
  const gate = new InferenceGate(h, 1);
  const hold = await gate.acquire({ model: 'a' });
  h.started.length = 0;
  const releases = [];
  const ask = (name, m) => gate.acquire({ model: m, name }).then((r) => releases.push(r));
  ask('b1', 'b');
  for (let i = 1; i <= MAX_PASSES + 1; i++) ask(`a${i}`, 'a');
  await flush();
  hold();
  for (let i = 0; i < MAX_PASSES + 2; i++) {
    await flush();
    releases.shift()();
  }
  await flush();
  assert.deepEqual(h.started, ['a1', 'a2', 'a3', 'b1', 'a4']);
});

test('a call stopped while it waits leaves the queue', async () => {
  const gate = new InferenceGate(host(), 1);
  const hold = await gate.acquire({ model: 'a' });
  const ctrl = new AbortController();
  const waiting = gate.acquire({ model: 'b' }, ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting);
  assert.equal(gate.waiting.length, 0);
  hold();
});

// ---------- the engine, with a fake llama-server ----------
function fakeEngine({ limit = 1, totalMemory = 40 * GB, idleMs = 0, cacheDir = '/nonexistent', cacheBytes } = {}) {
  const spawned = [];
  const calls = [];
  const spawn = (binary, args) => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.args = args;
    p.kill = () => { if (!p.dead) { p.dead = true; setImmediate(() => p.emit('exit', 0)); } };
    spawned.push(p);
    return p;
  };
  const fetchFn = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const engine = new ModelEngine({ binary: async () => '/bin/llama-server', cacheDir, build: 'test', limit, idleMs, totalMemory, spawn, fetchFn, ...(cacheBytes ? { cacheBytes } : {}) });
  return { engine, spawned, calls };
}
const arg = (p, name) => p.args[p.args.indexOf(name) + 1];

test('a model is loaded by the first call, on 127.0.0.1, and stays for the next', async () => {
  const dir = await tmp();
  const { engine, spawned } = fakeEngine({ cacheDir: dir });
  const m = model('a');
  const statuses = [];
  const lease = await engine.acquire({ model: m, numCtx: 8000, onStatus: (t) => statuses.push(t) });
  assert.ok(statuses.includes('Chargement du modèle…'));
  assert.equal(arg(spawned[0], '--host'), '127.0.0.1');
  assert.equal(arg(spawned[0], '-c'), '8000');
  assert.match(lease.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(lease.apiKey.length > 20);
  lease.release();
  (await engine.acquire({ model: m, numCtx: 8000 })).release();
  assert.equal(spawned.length, 1);
  await engine.shutdown();
});

test('another model takes the place of an idle one when both do not fit', async () => {
  const dir = await tmp();
  const { engine, spawned } = fakeEngine({ totalMemory: 12 * GB, cacheDir: dir });
  (await engine.acquire({ model: model('a', 6 * GB), numCtx: 4000 })).release();
  const b = await engine.acquire({ model: model('b', 6 * GB), numCtx: 4000 });
  assert.equal(spawned[0].dead, true);
  assert.deepEqual(engine.status().map((s) => s.id), ['b']);
  b.release();
  await engine.shutdown();
});

test('memory comes before the limit: with no limit, a second model waits for the first', async () => {
  const dir = await tmp();
  const { engine } = fakeEngine({ limit: 0, totalMemory: 12 * GB, cacheDir: dir });
  const a = await engine.acquire({ model: model('a', 6 * GB), numCtx: 4000 });
  const statuses = [];
  let b = null;
  engine.acquire({ model: model('b', 6 * GB), numCtx: 4000, onStatus: (t) => statuses.push(t) }).then((l) => { b = l; });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(b, null);
  assert.ok(statuses.includes('En attente du modèle…'));
  a.release();
  while (!b) await flush();
  b.release();
  await engine.shutdown();
});

test('a model that can never fit says so at once', async () => {
  const { engine, spawned } = fakeEngine({ totalMemory: 8 * GB });
  await assert.rejects(engine.acquire({ model: model('a', 16 * GB), numCtx: 4000 }), /pèse 16,0 Go/);
  assert.equal(spawned.length, 0);
});

test('an estimate above the budget refuses nothing: the model gets the machine and tries', async () => {
  const { engine, spawned } = fakeEngine({ totalMemory: 10 * GB, cacheDir: await tmp() });
  const big = model('big', 8 * GB, { blockCount: 40, embeddingLength: 4096, headCount: 16 });
  assert.ok(estimateMemory(big, 32000) > engine.budget);
  (await engine.acquire({ model: model('small', GB), numCtx: 4000 })).release();
  const lease = await engine.acquire({ model: big, numCtx: 32000 });
  assert.deepEqual(engine.status().map((s) => s.id), ['big']);
  assert.equal(spawned[0].dead, true);
  lease.release();
  await engine.shutdown();
});

test('the memory estimate follows the layers: sliding-window layers do not grow with the context', () => {
  const swa = { blockCount: 4, embeddingLength: 2816, headCount: 16, headCountKv: [4, 4, 4, 4], keyLength: 512, valueLength: 512, slidingWindow: 1024, slidingPattern: [true, true, true, false], keyLengthSwa: 256, valueLengthSwa: 256 };
  const base = estimateMemory(model('a', GB, swa), 4000);
  const grown = estimateMemory(model('a', GB, swa), 5000);
  assert.equal(grown - base, 1000 * 4 * 1024 * 2); // (the one full layer: the windows are past their reach)
  const flat = { blockCount: 40, embeddingLength: 2048, headCount: 16, headCountKv: 2, keyLength: 256, valueLength: 256 };
  const kv = estimateMemory(model('b', 0, flat), 32000) - estimateMemory(model('b', 0, flat), 0);
  assert.equal(kv, 32000 * 40 * 2 * 512 * 2);
});

test('the context never exceeds what the model was trained for', async () => {
  const dir = await tmp();
  const { engine, spawned } = fakeEngine({ cacheDir: dir });
  (await engine.acquire({ model: model('a', GB, { contextLength: 2048 }), numCtx: 8000 })).release();
  assert.equal(arg(spawned[0], '-c'), '2048');
  await engine.shutdown();
});

test('a new context reloads the model, with no action but the call', async () => {
  const dir = await tmp();
  const { engine, spawned } = fakeEngine({ cacheDir: dir });
  const m = model('a');
  (await engine.acquire({ model: m, numCtx: 4000 })).release();
  (await engine.acquire({ model: m, numCtx: 8000 })).release();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].dead, true);
  assert.equal(arg(spawned[1], '-c'), '8000');
  await engine.shutdown();
});

test('an idle model is unloaded, and the next call loads it back', async () => {
  const dir = await tmp();
  const { engine, spawned } = fakeEngine({ idleMs: 20, cacheDir: dir });
  const m = model('a');
  (await engine.acquire({ model: m, numCtx: 4000 })).release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(engine.status(), []);
  (await engine.acquire({ model: m, numCtx: 4000 })).release();
  assert.equal(spawned.length, 2);
  await engine.shutdown();
});

test('calls in parallel get slots, each with the whole context, as far as memory goes', async () => {
  const dir = await tmp();
  const m = model('a', GB, { blockCount: 30, embeddingLength: 4096, headCount: 16 });
  const wide = fakeEngine({ limit: 2, cacheDir: dir });
  (await wide.engine.acquire({ model: m, numCtx: 8000 })).release();
  assert.equal(arg(wide.spawned[0], '-np'), '2');
  assert.equal(arg(wide.spawned[0], '-c'), '16000');
  await wide.engine.shutdown();
  const tight = fakeEngine({ limit: 2, totalMemory: (estimateMemory(m, 8000, 1) + 1000) / 0.85, cacheDir: dir });
  (await tight.engine.acquire({ model: m, numCtx: 8000 })).release();
  assert.equal(arg(tight.spawned[0], '-np'), '1');
  await tight.engine.shutdown();
});

test('the prompt cache is saved at unload and restored at load; a change of context starts afresh', async () => {
  const dir = await tmp();
  const { engine, calls } = fakeEngine({ cacheDir: dir });
  const m = model('a');
  (await engine.acquire({ model: m, numCtx: 4000 })).release();
  await engine.shutdown();
  const saved = calls.find((c) => c.url.includes('action=save'));
  const { filename } = JSON.parse(saved.body);
  await fs.writeFile(path.join(dir, filename), 'cache');
  calls.length = 0;
  (await engine.acquire({ model: m, numCtx: 4000 })).release();
  assert.ok(calls.some((c) => c.url.includes('action=restore')));
  await engine.shutdown();
  calls.length = 0;
  (await engine.acquire({ model: m, numCtx: 8000 })).release();
  assert.ok(!calls.some((c) => c.url.includes('action=restore')));
  await engine.shutdown();
});

test('over its limit, the disk cache loses what was unused longest', async () => {
  const dir = await tmp();
  const { engine } = fakeEngine({ cacheDir: dir, cacheBytes: 15 });
  for (const [name, age] of [['old', 200], ['mid', 100], ['new', 0]]) {
    await fs.writeFile(path.join(dir, name), '0123456789');
    const t = new Date(Date.now() - age * 1000);
    await fs.utimes(path.join(dir, name), t, t);
  }
  await engine.purgeCache();
  assert.deepEqual(await fs.readdir(dir), ['new']);
});

test('a model that fails to load gives the reason, and frees its place', async () => {
  const { engine, spawned } = fakeEngine({ cacheDir: await tmp() });
  engine.fetchFn = async () => { throw new Error('refused'); };
  const failing = engine.acquire({ model: model('a'), numCtx: 4000 });
  await flush();
  while (!spawned.length) await flush();
  spawned[0].stderr.emit('data', 'error: unknown model architecture');
  spawned[0].emit('exit', 1);
  await assert.rejects(failing, /unknown model architecture/);
  assert.equal(engine.gate.running, 0);
  assert.deepEqual(engine.status(), []);
});

test('an engine that cannot be installed fails the call, and the next one tries again', async () => {
  const { engine, spawned } = fakeEngine({ cacheDir: await tmp() });
  const binary = engine.binary;
  engine.binary = async () => { throw new Error('Installation du moteur impossible : HTTP 404'); };
  await assert.rejects(engine.acquire({ model: model('a'), numCtx: 4000 }), /HTTP 404/);
  assert.deepEqual(engine.status(), []);
  engine.binary = binary;
  (await engine.acquire({ model: model('a'), numCtx: 4000 })).release();
  assert.equal(spawned.length, 1);
  await engine.shutdown();
});

test('stopped before its process starts, a model never starts it', async () => {
  const { engine, spawned } = fakeEngine({ cacheDir: await tmp() });
  let found;
  engine.binary = () => new Promise((resolve) => { found = resolve; });
  const lease = engine.acquire({ model: model('a'), numCtx: 8000 });
  while (!found) await flush();
  await engine.shutdown();
  found('/bin/llama-server');
  await assert.rejects(lease);
  assert.equal(spawned.length, 0);
});

// ---------- installing ----------
test('the engine is installed once, and only if it matches its digest', async () => {
  const work = await tmp();
  await fs.mkdir(path.join(work, 'pack'));
  await fs.writeFile(path.join(work, 'pack', 'llama-server'), '#!/bin/sh\n');
  execFileSync('tar', ['-czf', path.join(work, 'a.tgz'), '-C', path.join(work, 'pack'), '.']);
  const bytes = await fs.readFile(path.join(work, 'a.tgz'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let fetched = 0;
  const fetchFn = async () => { fetched++; return { ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), body: [bytes] }; };
  const dir = path.join(work, 'engine');
  await assert.rejects(installEngine(dir, { fetchFn, asset: { sha256: '00' }, url: 'x', build: 'bad' }), /ne correspond pas/);
  assert.equal(await installedEngine(dir, 'bad'), null);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.startsWith('install-')), []);
  const installed = await installEngine(dir, { fetchFn, asset: { sha256 }, url: 'x', build: 'good' });
  assert.match(installed, /good.*llama-server$/);
  await installEngine(dir, { fetchFn, asset: { sha256 }, url: 'x', build: 'good' });
  assert.equal(fetched, 2);
});

// ---------- finding models ----------
function gguf(entries) {
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]); };
  const parts = [Buffer.from('GGUF'), Buffer.from([3, 0, 0, 0]), Buffer.alloc(8), Buffer.alloc(8)];
  parts[3].writeBigUInt64LE(BigInt(entries.length));
  for (const [k, type, v] of entries) {
    parts.push(str(k));
    const t = Buffer.alloc(4); t.writeUInt32LE(type === 'ints' ? 9 : type); parts.push(t);
    if (type === 'ints') {
      const h = Buffer.alloc(12 + v.length * 4); h.writeUInt32LE(4); h.writeBigUInt64LE(BigInt(v.length), 4);
      v.forEach((n, i) => h.writeUInt32LE(n, 12 + i * 4));
      parts.push(h);
    }
    if (type === 8) parts.push(str(v));
    else if (type === 4) { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); } else if (type === 9) {
      const h = Buffer.alloc(12); h.writeUInt32LE(8); h.writeBigUInt64LE(BigInt(v.length), 4); parts.push(h, ...v.map(str));
    }
  }
  return Buffer.concat(parts);
}

test('the header of a GGUF file gives what memory needs', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'm.gguf');
  await fs.writeFile(file, gguf([['general.architecture', 8, 'gemma4'], ['general.tags', 9, ['a', 'b']], ['gemma4.context_length', 4, 262144], ['gemma4.block_count', 4, 30], ['gemma4.embedding_length', 4, 2048], ['gemma4.attention.head_count', 4, 8], ['gemma4.attention.head_count_kv', 'ints', [4, 2]], ['tokenizer.ggml.model', 8, 'x']]));
  const info = await readGguf(file);
  assert.deepEqual([info.arch, info.contextLength, info.blockCount, info.embeddingLength, info.headCount], ['gemma4', 262144, 30, 2048, 8]);
  assert.deepEqual(info.headCountKv, [4, 2]);
  await fs.writeFile(file, 'not a model at all');
  assert.equal(await readGguf(file), null);
});

test('models are found once, without their companions, and LM Studio\'s copy is recognised', async () => {
  const dir = await tmp();
  const own = path.join(dir, 'own');
  const lms = path.join(dir, 'lms', 'SC117', 'gemma-4-12B-it-heretic-QAT-GGUF');
  await fs.mkdir(own, { recursive: true });
  await fs.mkdir(lms, { recursive: true });
  const data = gguf([['general.architecture', 8, 'gemma4']]);
  await fs.writeFile(path.join(lms, 'gemma-4-12B-Q4.gguf'), data);
  await fs.writeFile(path.join(lms, 'mmproj-gemma.gguf'), data);
  await fs.writeFile(path.join(lms, 'nomic-embed-text.gguf'), data);
  await fs.writeFile(path.join(own, 'gemma-4-12B-Q4.gguf'), data);
  await fs.writeFile(path.join(own, 'big-00001-of-00002.gguf'), data);
  await fs.writeFile(path.join(own, 'big-00002-of-00002.gguf'), data);
  const models = await scanModels([own, path.join(dir, 'lms'), path.join(dir, 'absent')]);
  assert.deepEqual(models.map((m) => m.id), ['big', 'gemma-4-12b-q4']);
  assert.equal(models[0].size, data.length * 2);
  assert.ok(models[1].file.startsWith(own));
  const fromLms = await scanModels([path.join(dir, 'lms')]);
  assert.ok(sameModelFile('gemma-4-12b-it-heretic-qat', fromLms));
  assert.ok(!sameModelFile('qwen/qwen2.5-coder-14b', fromLms));
});

// ---------- calls through the service ----------
function fakeLlama() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: '<start>' }));
      res.setHeader('Content-Type', 'text/event-stream');
      const raw = req.url.endsWith('/completions') && !req.url.includes('chat');
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [], prompt_progress: { total: 10, cache: 0, processed: 5, time_ms: 1 } });
      if (raw) {
        send({ choices: [{ text: '<|channel>thought\nJe pense<channel|>Bonjour' }] });
        send({ choices: [{ text: '', finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 }, timings: { prompt_ms: 12, predicted_ms: 34 } });
      } else {
        send({ choices: [{ delta: { reasoning_content: 'Je pense' } }] });
        send({ choices: [{ delta: { content: 'Bonjour' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 }, timings: { prompt_ms: 12, predicted_ms: 34 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

async function collect(opts) {
  const out = [];
  for await (const c of streamChat(opts)) out.push(c);
  return out;
}

test('Gemma goes through the raw mode, the others through the chat, with the reasoning apart', async (t) => {
  const f = await fakeLlama();
  let released = 0;
  setInferenceService({ acquire: async ({ onStatus }) => {
    onStatus('En attente du modèle…');
    return { baseUrl: f.url, apiKey: 'secret', model: { info: { arch: 'gemma4' } }, release: () => released++ };
  } });
  t.after(() => { setInferenceService(null); f.close(); });
  const chunks = await collect({ provider: 'poney', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  assert.equal(chunks.find((c) => c.type === 'status').text, 'En attente du modèle…');
  assert.equal(chunks.filter((c) => c.type === 'thinking').map((c) => c.text).join(''), 'Je pense');
  assert.equal(chunks.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'Bonjour');
  assert.deepEqual(chunks.find((c) => c.type === 'progress').progress, 0.5);
  const usage = chunks.find((c) => c.type === 'usage');
  assert.deepEqual([usage.promptMs, usage.evalMs], [12, 34]);
  assert.equal(released, 1);
  assert.equal(f.seen[1].auth, 'Bearer secret');
  assert.equal(f.seen[1].body.prompt, '<start>');
  assert.equal(f.seen[1].body.cache_prompt, true);

  setInferenceService({ acquire: async () => ({ baseUrl: f.url, apiKey: 'k', model: { info: { arch: 'qwen3' } }, release: () => released++ }) });
  const chat = await collect({ provider: 'poney', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, toolSchemas: [{ type: 'function' }] });
  assert.equal(chat.filter((c) => c.type === 'thinking').map((c) => c.text).join(''), 'Je pense');
  assert.equal(chat.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'Bonjour');
  assert.equal(f.seen.at(-1).url, '/v1/chat/completions');
  assert.equal(f.seen.at(-1).body.tools.length, 1);
});

test('a call that stops early gives its place back', async (t) => {
  const f = await fakeLlama();
  let released = 0;
  setInferenceService({ acquire: async () => ({ baseUrl: f.url, apiKey: 'k', model: { info: { arch: 'qwen3' } }, release: () => released++ }) });
  t.after(() => { setInferenceService(null); f.close(); });
  for await (const c of streamChat({ provider: 'poney', model: 'm', messages: [], maxTokens: 10 })) if (c.type === 'thinking') break;
  assert.equal(released, 1);
});
