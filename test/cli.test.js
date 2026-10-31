// The command line, as another program drives it: a real process, fake model servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { ENGINE_BUILD } from '../src/engine/install.js';
import { savedConfig } from '../src/providers.js';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'poney-cli-'));
const TRIAGE = '{"claims": []}';

/** Runs the CLI to its end. stdin stays open, unless told otherwise: nothing may wait for it. */
function cli(args, { onStart } = {}) {
  const proc = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PONEY_DATA: '/nonexistent/poney-cli-test' } });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; onStart?.(proc, stdout); });
  proc.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => proc.on('close', (code) => {
    proc.stdin.destroy();
    resolve({ code, stdout, stderr, events: () => stdout.trim().split('\n').map((l) => JSON.parse(l)) });
  }));
}

/** Fake Ollama: the next reply for each generation, the assessment apart. A reply may be a function (req, res) taking over. */
function fakeOllama(replies, { sub = () => 'Report: done.' } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      const reply = data.format ? TRIAGE : data.messages[0].content.startsWith('You are a sub-agent') ? sub(data) : replies[Math.min(n++, replies.length - 1)];
      if (typeof reply === 'function') return reply(req, res);
      const message = typeof reply === 'string' ? { content: reply } : reply;
      res.end(`${JSON.stringify({ message, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

const ollamaArgs = (m, cwd) => ['--cwd', cwd, '--base-url', m.url, '--model', 'm', '--no-web'];

function gguf(arch, contextLength = 8192) {
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const head = Buffer.concat([Buffer.from('GGUF'), u32(3), Buffer.alloc(8), Buffer.alloc(8)]);
  head.writeBigUInt64LE(2n, 16);
  return Buffer.concat([head, str('general.architecture'), u32(8), str(arch), str(`${arch}.context_length`), u32(4), u32(contextLength)]);
}

/** Fake engine service: what llama-server answers to the app's calls. */
function fakeEngine(modelFile, key, reply, { nCtx = 8192 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; return res.end(); }
      if (req.url === '/props') return res.end(JSON.stringify({ model_path: modelFile, default_generation_settings: { n_ctx: nCtx } }));
      if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: 'PROMPT' }));
      const data = JSON.parse(body);
      if (req.url === '/v1/completions') {
        const text = data.prompt.endsWith('<|channel>thought<channel|>') ? TRIAGE : reply();
        res.end(`data: ${JSON.stringify({ choices: [{ text, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else if (req.url === '/v1/chat/completions') {
        const content = data.response_format ? TRIAGE : reply();
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else { res.statusCode = 404; res.end(); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

async function engineSetup(arch, key = 'secret-engine-key') {
  const dir = await tmp();
  const modelFile = path.join(dir, 'Test-Model.gguf');
  await fs.writeFile(modelFile, gguf(arch));
  const keyFile = path.join(dir, 'key');
  await fs.writeFile(keyFile, `${key}\n`);
  return { dir, modelFile, keyFile, key };
}

// ---------- 1. engine-serve ----------
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), key: process.env.LLAMA_API_KEY }));
http.createServer((req, res) => {
  if (req.url === '/props') return res.end('{}');
  res.end('{"status":"ok"}');
}).listen(port, '127.0.0.1');
`;

async function installFake(engineDir) {
  await fs.mkdir(path.join(engineDir, ENGINE_BUILD), { recursive: true });
  await fs.writeFile(path.join(engineDir, ENGINE_BUILD, 'llama-server'), FAKE_SERVER, { mode: 0o755 });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('engine-serve loads the model, tells where it is, and stops with its server on SIGTERM', async () => {
  const dir = await tmp();
  const modelsDir = path.join(dir, 'models');
  await fs.mkdir(modelsDir);
  await fs.writeFile(path.join(modelsDir, 'Small.gguf'), gguf('qwen3', 4096));
  const engineDir = path.join(dir, 'engine');
  await installFake(engineDir);
  const record = path.join(dir, 'record.json');
  const before = await fs.readdir(engineDir, { recursive: true });
  const proc = spawn(process.execPath, [CLI, 'engine-serve', '--model', 'small', '--num-ctx', '2048', '--models-dir', modelsDir, '--cache-dir', path.join(dir, 'cache'), '--engine-dir', engineDir], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_RECORD: record },
  });
  process.once('exit', () => proc.kill('SIGKILL'));
  const line = await new Promise((resolve, reject) => {
    proc.stdout.once('data', (d) => resolve(String(d)));
    proc.once('exit', (code) => reject(new Error(`exit ${code}`)));
  });
  const info = JSON.parse(line);
  assert.deepEqual(Object.keys(info).sort(), ['apiKey', 'baseUrl', 'build', 'memory', 'numCtx', 'pid']);
  assert.equal(info.numCtx, 2048);
  assert.equal(info.build, ENGINE_BUILD);
  assert.ok(info.memory > 0);
  assert.notEqual(info.pid, proc.pid);
  assert.ok(alive(info.pid));
  assert.equal((await fetch(`${info.baseUrl}/health`)).ok, true);
  const seen = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.equal(seen.key, info.apiKey);
  assert.equal(seen.args[seen.args.indexOf('-c') + 1], '2048');
  assert.deepEqual(await fs.readdir(engineDir, { recursive: true }), before); // (read only)
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(alive(info.pid), false);
});


test('engine-serve downloads nothing: no engine is an explicit error', async () => {
  const dir = await tmp();
  const r = await cli(['engine-serve', '--model', 'small', '--cache-dir', path.join(dir, 'c'), '--engine-dir', path.join(dir, 'none'), '--models-dir', dir]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no engine .* nothing is downloaded/);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(r.stdout, '');
});

// ---------- 2. a turn on the service ----------
test('a Gemma model on the service takes the path of the app: its template, then raw completion, with the key', async (t) => {
  const e = await engineSetup('gemma4');
  let n = 0;
  const f = await fakeEngine(e.modelFile, e.key, () => (++n === 1 ? '<run>env</run>' : 'Fini.'));
  t.after(() => f.server.close());
  const cwd = await tmp();
  const r = await cli(['--cwd', cwd, '--provider', 'poney', '--engine-url', f.url, '--engine-key-file', e.keyFile, '--yes', '--no-web', '--json', 'go']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(f.calls.some((c) => c.url === '/apply-template'));
  assert.ok(f.calls.some((c) => c.url === '/v1/completions' && c.body.cache_prompt === true && c.body.model === 'test-model'));
  assert.ok(!f.calls.some((c) => c.url === '/v1/chat/completions'));
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${e.key}`));
  const out = r.events().find((ev) => ev.type === 'action_end').output;
  assert.match(out, /PONEY_DATA/); // (it is the environment)
  assert.ok(!r.stdout.includes(e.key)); // the commands never see the key
});

test('another model on the service takes the chat endpoint, and the window the engine loaded', async (t) => {
  const e = await engineSetup('qwen3');
  const f = await fakeEngine(e.modelFile, e.key, () => 'Fini.', { nCtx: 6000 });
  t.after(() => f.server.close());
  const cwd = await tmp();
  const base = ['--cwd', cwd, '--provider', 'poney', '--engine-url', f.url, '--engine-key-file', e.keyFile, '--no-web', '--json'];
  const r = await cli([...base, 'go']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(f.calls.some((c) => c.url === '/v1/chat/completions' && c.body.cache_prompt === true));
  assert.ok(!f.calls.some((c) => c.url === '/apply-template'));
  assert.equal(r.events().find((ev) => ev.type === 'context').numCtx, 6000);
  const asked = await cli([...base, '--num-ctx', '3000', 'go']);
  assert.equal(asked.events().find((ev) => ev.type === 'context').numCtx, 3000);
  const tooMuch = await cli([...base, '--num-ctx', '9000', 'go']);
  assert.equal(tooMuch.events().find((ev) => ev.type === 'context').numCtx, 6000);
  const wrong = await cli([...base, '--model', 'another', 'go']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /serves test-model/);
});

test('without its service, a poney run says so', async () => {
  const e = await engineSetup('qwen3');
  assert.equal((await cli(['--provider', 'poney', 'go'])).code, 1);
  assert.equal((await cli(['--provider', 'poney', '--engine-url', 'http://127.0.0.1:9', '--engine-key-file', e.keyFile, 'go'])).code, 3);
});

// ---------- 3. settings ----------
test('the settings apply as in the app, are never written, and options win', async (t) => {
  const m = await fakeOllama(['Fini.']);
  t.after(() => m.server.close());
  const dir = await tmp();
  const cwd = await tmp();
  const file = path.join(dir, 'settings.json');
  const text = JSON.stringify({
    config: { provider: 'ollama', baseUrl: m.url, model: 'm', numCtx: 5000, maxInferences: 1, subagentsEnabled: false, autoSkills: false, temperature: 0.7, webEnabled: false },
    modelContexts: { m: 7000 },
  });
  await fs.writeFile(file, text);
  const r = await cli(['--cwd', cwd, '--settings', file, '--json', 'go']);
  assert.equal(r.code, 0, r.stderr);
  const main = m.requests.find((q) => !q.format);
  assert.equal(main.options.num_ctx, 7000);
  assert.equal(main.options.temperature, 0.7);
  assert.ok(!main.messages[0].content.includes('<agent'));
  assert.equal(await fs.readFile(file, 'utf8'), text);
  m.requests.length = 0;
  await cli(['--cwd', cwd, '--settings', file, '--num-ctx', '9000', '--temperature', '0.3', '--json', 'go']);
  const over = m.requests.find((q) => !q.format);
  assert.equal(over.options.num_ctx, 9000);
  assert.equal(over.options.temperature, 0.3);
});

test('old settings are read as the app reads them', () => {
  assert.equal(savedConfig({ config: { parallelAgents: false } }).maxInferences, 1);
  assert.equal(savedConfig({ config: { maxParallelAgents: 4 } }).maxInferences, 4);
  assert.equal(savedConfig({ config: { temperature: 0.2 } }).temperature, null);
  assert.equal(savedConfig({ config: { temperature: 0.2 }, temperatureFromModel: true }).temperature, 0.2);
});

// ---------- 4 and 11. the machine output ----------
test('--json gives every event, those of the sub-agents included', async (t) => {
  const m = await fakeOllama([
    '<agent title="A">\nDo it\n</agent>',
    'Fini.',
  ], { sub: () => 'Report: done.' });
  t.after(() => m.server.close());
  const cwd = await tmp();
  const r = await cli([...ollamaArgs(m, cwd), '--no-shell', '--json', 'go']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('\x1b'));
  const events = r.events();
  const types = new Set(events.map((e) => e.type));
  for (const type of ['triage_start', 'triage', 'context', 'turn_start', 'assistant_start', 'delta', 'assistant_end', 'action_start', 'action_end', 'final', 'turn_end']) assert.ok(types.has(type), type);
  const end = events.findLast((e) => e.type === 'turn_end');
  assert.equal(end.reason, 'done');
  assert.ok(end.stats.steps >= 2);
  const id = events.find((e) => e.type === 'action_start').id;
  const sub = events.filter((e) => e.agentId === id);
  for (const type of ['delta', 'assistant_end', 'turn_start', 'turn_end']) assert.ok(sub.some((e) => e.type === type), `sub ${type}`);
});

test('--json tells what the model really wrote, and each call as it was written', async (t) => {
  const m = await fakeOllama([
    '<read_file path="a.txt" />',
    '<tool_call>{"name": "list_files", "arguments": {"path": "."}}</tool_call>',
    '<|tool_call>call:read{"path": "a.txt"}<tool_call|>',
    { content: '', tool_calls: [{ function: { name: 'read', arguments: { path: 'a.txt' } } }] },
    '<|tool_call>call:list path="." />',
    '<list path="." />',
    '<think>hm</think>Fini.',
  ]);
  t.after(() => m.server.close());
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n');
  const r = await cli([...ollamaArgs(m, cwd), '--no-shell', '--json', 'go']);
  assert.equal(r.code, 0, r.stderr);
  const events = r.events();
  assert.deepEqual(events.filter((e) => e.type === 'action_start').map((e) => [e.tool, e.calledAs]), [
    ['read', 'read_file'],
    ['list', 'hermes:list_files'],
    ['read', 'gemma:read'],
    ['read', 'tool_calls:read'],
    ['list', 'gemma:list'],
    ['list', 'list'],
  ]);
  const ends = events.filter((e) => e.type === 'assistant_end');
  assert.equal(ends[0].rawText, '<read_file path="a.txt" />');
  assert.match(ends[1].rawText, /^<tool_call>\{"name": "list_files"/);
  assert.equal(ends[6].text, 'Fini.');
  assert.equal(ends[6].rawText, '<think>hm</think>Fini.');
});

test('a raw completion is traced with its markers', async (t) => {
  const e = await engineSetup('gemma4');
  const f = await fakeEngine(e.modelFile, e.key, () => '<|channel>thought\nje vois<channel|>Fini.');
  t.after(() => f.server.close());
  const r = await cli(['--cwd', await tmp(), '--provider', 'poney', '--engine-url', f.url, '--engine-key-file', e.keyFile, '--no-web', '--json', 'go']);
  const end = r.events().find((ev) => ev.type === 'assistant_end');
  assert.equal(end.text, 'Fini.');
  assert.equal(end.thinking, 'je vois');
  assert.equal(end.rawText, '<|channel>thought\nje vois<channel|>Fini.');
});

test('the app gets none of it: its transcripts stay as they are', async (t) => {
  const m = await fakeOllama(['<read_file path="a.txt" />', 'Fini.']);
  t.after(() => m.server.close());
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n');
  const agent = new Agent({ cwd, config: { baseUrl: m.url, model: 'm', shellEnabled: false, webEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go');
  for (const e of events) {
    assert.equal(e.rawText, undefined);
    assert.equal(e.calledAs, undefined);
  }
});

// ---------- 5. exit codes ----------
test('exit codes: finished, step limit, model error, stopped', async (t) => {
  const cwd = await tmp();
  const done = await fakeOllama(['Fini.']);
  const steps = await fakeOllama(['<list path="." />']);
  const broken = await fakeOllama([(req, res) => { res.statusCode = 500; res.end('no'); }]);
  const hanging = await fakeOllama([(req, res) => { res.write(`${JSON.stringify({ message: { content: 'Je ' } })}\n`); }]);
  t.after(() => {
    for (const m of [done, steps, broken]) m.server.close();
    hanging.server.closeAllConnections();
    hanging.server.close();
  });
  assert.equal((await cli([...ollamaArgs(done, cwd), 'go'])).code, 0);
  assert.equal((await cli([...ollamaArgs(steps, cwd), '--max-steps', '2', 'go'])).code, 2);
  assert.equal((await cli([...ollamaArgs(broken, cwd), 'go'])).code, 3);
  let sent = false;
  const r = await cli([...ollamaArgs(hanging, cwd), '--json', 'go'], {
    onStart: (proc, out) => {
      if (sent || !out.includes('"kind":"text"')) return;
      sent = true;
      proc.kill('SIGINT');
    },
  });
  assert.equal(r.code, 130);
  assert.equal(r.events().findLast((e) => e.type === 'turn_end').reason, 'stopped');
});

// ---------- 6. scripts ----------
test('--script sends its messages in one conversation, each after the previous turn', async (t) => {
  const m = await fakeOllama(['Un.', 'Deux.']);
  t.after(() => m.server.close());
  const cwd = await tmp();
  const script = path.join(cwd, 'script.json');
  await fs.writeFile(script, JSON.stringify(['premier', 'second']));
  const r = await cli([...ollamaArgs(m, cwd), '--script', script, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const types = r.events().map((e) => e.type).filter((x) => x === 'turn_start' || x === 'turn_end');
  assert.deepEqual(types, ['turn_start', 'turn_end', 'turn_start', 'turn_end']);
  const last = m.requests.filter((q) => !q.format).at(-1).messages.map((x) => x.content).join('\n');
  for (const s of ['premier', 'Un.', 'second']) assert.ok(last.includes(s), s);
});

test('a script stops at the first turn that does not finish, and a bad one starts nothing', async (t) => {
  const m = await fakeOllama(['<list path="." />']);
  t.after(() => m.server.close());
  const cwd = await tmp();
  const script = path.join(cwd, 'script.json');
  await fs.writeFile(script, JSON.stringify(['premier', 'second']));
  const r = await cli([...ollamaArgs(m, cwd), '--max-steps', '1', '--script', script, '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.events().filter((e) => e.type === 'turn_end').length, 1);
  const before = m.requests.length;
  await fs.writeFile(script, '{"not": "a list"}');
  const bad = await cli([...ollamaArgs(m, cwd), '--script', script]);
  assert.equal(bad.code, 1);
  assert.equal(m.requests.length, before);
});

// ---------- 7. without a terminal ----------
test('without a terminal nothing waits on stdin: a command that needs an answer is refused', async (t) => {
  const m = await fakeOllama(['<run>touch made.txt</run>', 'Fini.']);
  t.after(() => m.server.close());
  const cwd = await tmp();
  const r = await cli([...ollamaArgs(m, cwd), '--json', 'go']);
  assert.equal(r.code, 0, r.stderr);
  const end = r.events().find((e) => e.type === 'action_end');
  assert.equal(end.ok, false);
  await assert.rejects(fs.access(path.join(cwd, 'made.txt')));
  const yes = await fakeOllama(['<run>touch made.txt</run>', 'Fini.']);
  t.after(() => yes.server.close());
  assert.equal((await cli([...ollamaArgs(yes, cwd), '--yes', '--json', 'go'])).code, 0);
  await fs.access(path.join(cwd, 'made.txt'));
});

// ---------- 8. models ----------
test('models --json lists the folders given, loading nothing', async () => {
  const a = await tmp();
  const b = await tmp();
  await fs.writeFile(path.join(a, 'One.gguf'), gguf('qwen3', 1000));
  await fs.writeFile(path.join(b, 'Two.gguf'), gguf('gemma4', 2000));
  const r = await cli(['models', '--json', '--models-dir', a, '--models-dir', b]);
  assert.equal(r.code, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.map((m) => [m.id, m.file, m.contextLength]), [['one', path.join(a, 'One.gguf'), 1000], ['two', path.join(b, 'Two.gguf'), 2000]]);
  assert.equal(list[0].size, (await fs.stat(path.join(a, 'One.gguf'))).size);
  assert.deepEqual(Object.keys(list[0]), ['id', 'file', 'size', 'contextLength']);
});

// ---------- 9. version ----------
test('version --json identifies this harness, whatever the machine', async () => {
  const one = JSON.parse((await cli(['version', '--json'])).stdout);
  assert.match(one.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof one.dirty, 'boolean');
  assert.equal(one.engineBuild, ENGINE_BUILD);
  assert.match(one.systemPromptHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse((await cli(['version', '--json'])).stdout), one);
});

// ---------- 10. help ----------
test('--help documents the options', async () => {
  const { stdout, code } = await cli(['--help']);
  assert.equal(code, 0);
  for (const o of ['--searxng-url', '--max-steps', '--max-tokens', '--command-timeout', '--temperature', '--engine-url', '--engine-key-file', '--settings', '--script', '--json', 'engine-serve', '--models-dir']) assert.ok(stdout.includes(o), o);
});

test('a task that is one word of a command stays a task when others follow', async (t) => {
  const m = await fakeOllama(['Fini.']);
  t.after(() => m.server.close());
  assert.equal((await cli([...ollamaArgs(m, await tmp()), 'version', 'of', 'node'])).code, 0);
  assert.ok(m.requests.at(-1).messages.at(-1).content.includes('version of node'));
});
