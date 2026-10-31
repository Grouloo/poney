#!/usr/bin/env node
// Headless runner: node src/cli.js --cwd ./project --model qwen2.5:14b "task"
// Also lets another program drive the engine and the harness (see "Driving Poney
// from a program" in the README). It never writes the app's data: all that it
// keeps is in the folders it is given.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Agent, DEFAULT_CONFIG } from './agent/agent.js';
import { closeClients, setInferenceService } from './agent/llm.js';
import { buildSystemPrompt } from './agent/protocol.js';
import { ModelEngine } from './engine/engine.js';
import { InferenceGate } from './engine/gate.js';
import { readGguf } from './engine/gguf.js';
import { ENGINE_BUILD, installedEngine } from './engine/install.js';
import { modelId, scanModels } from './engine/models.js';
import { modelConfig, savedConfig } from './providers.js';

const argv = process.argv.slice(2);
const opts = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (['yes', 'verbose', 'help', 'noWeb', 'noShell', 'tor', 'json'].includes(key) || next === undefined || next.startsWith('--')) opts[key] = true;
    else if (key === 'modelsDir') { (opts.modelsDir ??= []).push(next); i++; } else { opts[key] = next; i++; }
  } else words.push(a);
}

const fail = (message, code = 1) => {
  console.error(`Error: ${message}`);
  process.exit(code);
};
const EXIT_MODEL = 3; // (see EXIT_CODES)

const command = words.length === 1 && ['engine-serve', 'models', 'version'].includes(words[0]) ? words[0] : null;
if ((!words.length && !opts.script) || opts.help) {
  console.log(`Usage: node src/cli.js [options] "task"
  --cwd DIR             project folder (default: current dir)
  --provider P          ollama | openai | poney (default: ollama)
  --base-url URL        server URL (default: http://localhost:11434)
  --model NAME          model name
  --num-ctx N           context size (default: 16384)
  --temperature T       sampling temperature (default: the model's own)
  --max-tokens N        longest answer of one generation (default: 4096)
  --max-steps N         steps of a turn before it stops (default: 40)
  --command-timeout S   seconds a command may run (default: 120)
  --max-inferences N    calls to the model at the same time, 0 for no limit (default: 1 with poney)
  --test-command CMD    command that must pass before the agent may finish
  --searxng-url URL     SearXNG instance for web search
  --yes                 run commands without asking
  --no-web              disable web search and page fetching
  --no-shell            disable terminal commands
  --tor                 web search and page reading through Tor (refused if Tor is down)
  --tor-proxy ADDR      Tor SOCKS proxy (default: auto, 127.0.0.1:9050 then 9150)
  --verbose             print full tool outputs
  --engine-url URL      with --provider poney: the service started by engine-serve
  --engine-key-file F   with --provider poney: the file holding its key
  --settings FILE       the app's settings (config, modelContexts), read only; options above win
  --script FILE.json    a list of user messages, sent in one conversation, instead of "task"
  --json                every event as one JSON line on stdout

Without a terminal on stdin and without --yes, commands are refused.
Exit codes: 0 turn finished, 2 --max-steps reached, 3 model or server error, 130 stopped.
A script stops at the first turn that does not finish.

Other commands:
  engine-serve --model ID --cache-dir DIR --engine-dir DIR [--num-ctx N] [--models-dir DIR] [--max-inferences N] [--settings FILE]
                        loads a model and serves it until SIGTERM. Prints one JSON line:
                        {baseUrl, apiKey, pid, numCtx, memory, build}. Installs nothing.
  models [--json] [--models-dir DIR]...
                        the GGUF models found, loading nothing: {id, file, size, contextLength}.
                        Default folders: the app's models, then LM Studio's.
  version [--json]      {commit, dirty, engineBuild, systemPromptHash}`);
  process.exit(opts.help ? 0 : 1);
}

for (const k of ['numCtx', 'maxTokens', 'maxSteps', 'commandTimeout', 'temperature', 'maxInferences']) {
  if (opts[k] !== undefined && !Number.isFinite(Number(opts[k] === true ? NaN : opts[k]))) fail(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a number`);
}

/** The options of a run: the settings if given (as the app applies them), and what was asked here above them. */
function buildConfig(model) {
  const saved = opts.settings ? readSettings(opts.settings) : {};
  let config = {};
  if (opts.settings || opts.provider === 'poney' || opts.maxInferences !== undefined) {
    const base = { ...DEFAULT_CONFIG, ...savedConfig(saved) };
    if (opts.maxInferences !== undefined) base.maxInferences = Number(opts.maxInferences);
    config = modelConfig(base, opts.provider === 'poney' ? { type: 'poney' } : null, model, saved.modelContexts);
  }
  for (const k of ['provider', 'baseUrl', 'model', 'apiKey', 'testCommand', 'searxngUrl']) if (opts[k]) config[k] = opts[k];
  for (const k of ['numCtx', 'maxTokens', 'maxSteps', 'commandTimeout', 'temperature']) if (opts[k]) config[k] = Number(opts[k]);
  if (opts.provider === 'openai' && !opts.baseUrl && !opts.settings) config.baseUrl = 'http://localhost:1234/v1';
  config.approval = opts.yes ? 'auto' : config.approval ?? 'ask';
  if (opts.noWeb) config.webEnabled = false;
  if (opts.noShell) config.shellEnabled = false;
  if (opts.tor) config.torEnabled = true;
  if (opts.torProxy) config.torProxy = opts.torProxy;
  return config;
}

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read the settings: ${e.message}`);
  }
}

const appData = () => {
  const own = process.env.PONEY_DATA || process.env.LOCAL_CODEX_DATA;
  if (own) return own;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'poney');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'poney');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'poney');
};
const modelDirs = () => opts.modelsDir ?? [path.join(appData(), 'models'), path.join(os.homedir(), '.lmstudio', 'models')];

// ---------- models ----------
async function listLocalModels() {
  const models = (await scanModels(modelDirs())).map((m) => ({ id: m.id, file: m.file, size: m.size, contextLength: m.info?.contextLength ?? null }));
  if (opts.json) console.log(JSON.stringify(models));
  else for (const m of models) console.log(`${m.id}\t${(m.size / 1024 ** 3).toFixed(1)} GB\t${m.contextLength ?? '?'}\t${m.file}`);
}

// ---------- version ----------
function showVersion() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git('rev-parse', 'HEAD');
  // (fixed inputs: the hash follows the harness, not the machine or the project)
  const prompt = (subagentRole) => buildSystemPrompt({ cwd: '/project', platform: 'any', shell: true, web: true, subagents: true, parallel: true, memory: true, subagentRole });
  const version = {
    commit,
    dirty: commit ? git('status', '--porcelain') !== '' : null,
    engineBuild: ENGINE_BUILD,
    systemPromptHash: createHash('sha256').update(prompt(false)).update(prompt(true)).digest('hex'),
  };
  if (opts.json) console.log(JSON.stringify(version));
  else console.log(`${commit ?? 'no commit'}${version.dirty ? ' (dirty)' : ''}  engine ${ENGINE_BUILD}  prompt ${version.systemPromptHash.slice(0, 12)}`);
}

// ---------- engine-serve ----------
async function engineServe() {
  for (const [k, flag] of [['model', '--model'], ['cacheDir', '--cache-dir'], ['engineDir', '--engine-dir']]) {
    if (typeof opts[k] !== 'string') fail(`engine-serve needs ${flag}`);
  }
  const binary = await installedEngine(opts.engineDir);
  if (!binary) fail(`no engine ${ENGINE_BUILD} in ${opts.engineDir}: nothing is downloaded here, install it with the app first`, EXIT_MODEL);
  const model = (await scanModels(modelDirs())).find((m) => m.id === opts.model);
  if (!model) fail(`model ${opts.model} not found in ${modelDirs().join(', ')}`, EXIT_MODEL);
  const config = buildConfig(model.id);
  const engine = new ModelEngine({
    binary: async () => binary,
    cacheDir: opts.cacheDir,
    build: ENGINE_BUILD,
    limit: config.maxInferences ?? 1,
    idleMs: 0, // (no unloading: it serves until it is stopped)
    log: (what, detail) => console.error(`${what}: ${detail?.message ?? detail}`),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await engine.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const lease = await engine.acquire({ model, numCtx: config.numCtx });
    lease.release();
    const [{ pid, numCtx, memory }] = engine.status();
    console.log(JSON.stringify({ baseUrl: lease.baseUrl, apiKey: lease.apiKey, pid, numCtx, memory, build: ENGINE_BUILD }));
    engine.servers.get(model.id).exited.then(() => {
      if (!stopping) fail('the engine stopped', EXIT_MODEL);
    });
  } catch (e) {
    if (!stopping) fail(e.message, EXIT_MODEL);
  }
}

// ---------- a run ----------
/** The service of engine-serve, as a fixed lease. Its model comes from the server: its architecture decides the path of the calls. */
async function connectEngine() {
  if (typeof opts.engineUrl !== 'string' || typeof opts.engineKeyFile !== 'string') fail('--provider poney needs --engine-url and --engine-key-file');
  let apiKey;
  try {
    apiKey = fs.readFileSync(opts.engineKeyFile, 'utf8').trim();
  } catch (e) {
    fail(`cannot read the key: ${e.message}`);
  }
  const baseUrl = opts.engineUrl.replace(/\/+$/, '');
  let props;
  try {
    const res = await fetch(`${baseUrl}/props`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    props = await res.json();
  } catch (e) {
    fail(`no engine at ${baseUrl}: ${e.message}`, EXIT_MODEL);
  }
  const info = props.model_path ? await readGguf(props.model_path).catch(() => null) : null;
  if (!info) fail(`cannot read the model of the engine (${props.model_path ?? 'not given'})`, EXIT_MODEL);
  const id = modelId(props.model_path);
  if (opts.model && opts.model !== id) fail(`the engine serves ${id}, not ${opts.model}`);
  return { baseUrl, apiKey, model: { id, info }, numCtx: props.default_generation_settings?.n_ctx };
}

/** The list of messages to send, checked before anything starts. */
function readMessages() {
  if (!opts.script) return [words.join(' ')];
  if (words.length) fail('give either --script or a task');
  let list;
  try {
    list = JSON.parse(fs.readFileSync(opts.script, 'utf8'));
  } catch (e) {
    fail(`cannot read the script: ${e.message}`);
  }
  if (!Array.isArray(list) || !list.length || !list.every((m) => typeof m === 'string' && m.trim())) fail('the script must be a JSON list of messages');
  return list;
}

const EXIT_CODES = { done: 0, max_steps: 2, stopped: 130 }; // (any other end of a turn: EXIT_MODEL)
const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };

const summarize = (tool, args) => {
  if (tool === 'run') return args.command;
  if (tool === 'web_search') return args.query;
  if (tool === 'fetch') return args.url;
  if (tool === 'agent') return args.title;
  if (tool === 'search') return `${args.pattern} in ${args.path || '.'}`;
  return args.path || '.';
};

const subTitles = new Map(); // sub-agent card id -> title
function show(ev) {
  if (ev.type === 'action_start' && ev.tool === 'agent') subTitles.set(ev.id, ev.args.title);
  if (ev.agentId) {
    // Sub-agents run at the same time: one prefixed line per action, no streamed text.
    const who = `${c.dim}[${subTitles.get(ev.agentId) || 'sous-agent'}]${c.reset} `;
    if (ev.type === 'action_start') console.log(`${who}${c.cyan}▶ ${ev.tool}: ${summarize(ev.tool, ev.args)}${c.reset}`);
    else if (ev.type === 'action_end') console.log(`${who}${ev.ok ? c.green + '✓' : c.red + '✗'}${c.reset} ${c.dim}${ev.output.split('\n')[0].slice(0, 120)}${c.reset}`);
    else if (ev.type === 'notice' || ev.type === 'error') console.log(`${who}${c.yellow}• ${ev.text || ev.message}${c.reset}`);
    return;
  }
  switch (ev.type) {
    case 'delta':
      if (opts.verbose || ev.kind === 'text') process.stdout.write(ev.kind === 'thinking' ? c.dim + ev.text + c.reset : ev.text);
      break;
    case 'assistant_end':
      process.stdout.write('\n');
      break;
    case 'action_start':
      console.log(`${c.cyan}▶ ${ev.tool}${ev.auto ? ' (auto)' : ''}: ${summarize(ev.tool, ev.args)}${c.reset}`);
      break;
    case 'action_end': {
      const color = ev.ok ? c.green : c.red;
      const out = opts.verbose ? ev.output : ev.output.split('\n').slice(0, 12).join('\n');
      console.log(`${color}${ev.ok ? '✓' : '✗'}${c.reset} ${c.dim}${out}${c.reset}`);
      break;
    }
    case 'notice':
      console.log(`${c.yellow}• ${ev.text}${c.reset}`);
      break;
    case 'error':
      console.log(`${c.red}Error: ${ev.message}${c.reset}`);
      break;
  }
}

async function run() {
  const messages = readMessages();
  if (opts.provider === 'poney' && opts.engineUrl === undefined) fail('--provider poney needs --engine-url and --engine-key-file');
  if (opts.provider !== 'poney' && opts.engineUrl !== undefined) fail('--engine-url goes with --provider poney');
  const lease = opts.provider === 'poney' ? await connectEngine() : null;
  const config = buildConfig(lease?.model.id ?? opts.model);
  if (lease) {
    // The window is the one the engine loaded: all the sizes follow from it.
    const wanted = opts.numCtx || opts.settings ? config.numCtx : lease.numCtx;
    config.numCtx = Math.min(wanted, lease.numCtx || wanted);
    const gate = new InferenceGate({ canStart: () => true, isLoaded: () => true, start() {} }, config.maxInferences ?? 1);
    setInferenceService({ acquire: async ({ signal }) => ({ ...lease, release: await gate.acquire({}, signal) }) });
  }

  // Nobody to ask: a command that needs an answer is refused.
  const interactive = process.stdin.isTTY && config.approval !== 'auto';
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: opts.json ? process.stderr : process.stdout }) : null;
  const asking = new AbortController();
  const agent = new Agent({
    cwd: path.resolve(opts.cwd || '.'),
    config,
    triage: true,
    approve: async ({ command }) => {
      if (!rl) return false;
      const answer = await rl.question(`${c.yellow}Run \`${command}\`? [Y/n] ${c.reset}`, { signal: asking.signal }).catch(() => 'n');
      return /^(y|o|yes|oui)?$/i.test(answer.trim());
    },
  });
  agent.trace = Boolean(opts.json);

  let reason = null;
  const emitLine = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
  agent.on('event', (ev) => {
    if (ev.type === 'turn_end') reason = ev.reason; // (those of sub-agents come as sub_turn)
    if (opts.json) emitLine(ev);
    else show(ev);
  });
  if (opts.json) agent.on('sub_turn', emitLine);

  let stopped = false;
  const stop = () => {
    stopped = true;
    asking.abort();
    agent.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  rl?.on('SIGINT', stop);

  for (const message of messages) {
    if (stopped) break;
    await agent.send(message);
    if (reason !== 'done') break;
  }
  rl?.close();
  await closeClients();
  process.exitCode = stopped ? EXIT_CODES.stopped : EXIT_CODES[reason] ?? EXIT_MODEL;
}

try {
  if (command === 'engine-serve') await engineServe();
  else if (command === 'models') await listLocalModels();
  else if (command === 'version') showVersion();
  else await run();
} catch (e) {
  fail(e.message, EXIT_MODEL);
}
