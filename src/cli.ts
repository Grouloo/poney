#!/usr/bin/env node
// Headless runner: node src/cli.ts --cwd ./project --model qwen2.5:14b "task"
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
import { Agent, DEFAULT_CONFIG } from './agent/agent.ts';
import { closeClients, setInferenceService } from './agent/llm.ts';
import { buildSystemPrompt } from './agent/protocol.ts';
import { ModelEngine } from './engine/engine.ts';
import { InferenceGate } from './engine/gate.ts';
import { readGguf } from './engine/gguf.ts';
import { ENGINE_BUILD, installedEngine } from './engine/install.ts';
import { modelId, scanModels } from './engine/models.ts';
import { modelConfig, savedConfig } from './providers.ts';
import { errorMessage, isNumber, isString, list, parseJson, rec, str } from './unknown.ts';
import type { AgentEvent, Config, Lease, ToolArgs } from './types.ts';

const argv = process.argv.slice(2);
const opts: Record<string, string | true | undefined> = {};
let modelsDir: string[] | undefined;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (['yes', 'verbose', 'help', 'noWeb', 'noShell', 'tor', 'json'].includes(key) || next === undefined || next.startsWith('--')) opts[key] = true;
    else if (key === 'modelsDir') { (modelsDir ??= []).push(next); i++; } else { opts[key] = next; i++; }
  } else words.push(a);
}

const fail: (message: string, code?: number) => never = (message, code = 1) => {
  console.error(`Error: ${message}`);
  process.exit(code);
};
const EXIT_MODEL = 3; // (see EXIT_CODES)

const command = words.length === 1 && ['engine-serve', 'models', 'version'].includes(words[0]) ? words[0] : null;
if ((!words.length && !opts.script) || opts.help) {
  console.log(`Usage: node src/cli.ts [options] "task"
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
function buildConfig(model?: string) {
  const saved = rec(opts.settings ? readSettings(String(opts.settings)) : {});
  let config: Partial<Config> = {};
  if (opts.settings || opts.provider === 'poney' || opts.maxInferences !== undefined) {
    const base = { ...DEFAULT_CONFIG, ...savedConfig(saved) };
    if (opts.maxInferences !== undefined) base.maxInferences = Number(opts.maxInferences);
    const contexts = Object.fromEntries(Object.entries(rec(saved.modelContexts)).filter((e): e is [string, number] => isNumber(e[1])));
    config = modelConfig(base, opts.provider === 'poney' ? { type: 'poney' } : null, model, contexts);
  }
  for (const k of ['provider', 'baseUrl', 'model', 'apiKey', 'testCommand', 'searxngUrl'] as const) if (opts[k]) config[k] = String(opts[k]);
  for (const k of ['numCtx', 'maxTokens', 'maxSteps', 'commandTimeout', 'temperature'] as const) if (opts[k]) config[k] = Number(opts[k]);
  if (opts.provider === 'openai' && !opts.baseUrl && !opts.settings) config.baseUrl = 'http://localhost:1234/v1';
  config.approval = opts.yes ? 'auto' : config.approval ?? 'ask';
  if (opts.noWeb) config.webEnabled = false;
  if (opts.noShell) config.shellEnabled = false;
  if (opts.tor) config.torEnabled = true;
  if (opts.torProxy) config.torProxy = String(opts.torProxy);
  return config;
}

function readSettings(file: string): unknown {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read the settings: ${errorMessage(e)}`);
  }
}

const appData = () => {
  const own = process.env.PONEY_DATA || process.env.LOCAL_CODEX_DATA;
  if (own) return own;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'poney');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'poney');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'poney');
};
const modelDirs = () => modelsDir ?? [path.join(appData(), 'models'), path.join(os.homedir(), '.lmstudio', 'models')];

// ---------- models ----------
async function listLocalModels() {
  const models = (await scanModels(modelDirs())).map((m) => ({ id: m.id, file: m.file, size: m.size, contextLength: m.info?.contextLength ?? null }));
  if (opts.json) console.log(JSON.stringify(models));
  else for (const m of models) console.log(`${m.id}\t${(m.size / 1024 ** 3).toFixed(1)} GB\t${m.contextLength ?? '?'}\t${m.file}`);
}

// ---------- version ----------
function showVersion() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git('rev-parse', 'HEAD');
  // (fixed inputs: the hash follows the harness, not the machine or the project)
  const prompt = (subagentRole: boolean) => buildSystemPrompt({ cwd: '/project', platform: 'any', shell: true, web: true, subagents: true, parallel: true, memory: true, subagentRole });
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
  const needed = (k: string, flag: string) => {
    const value = opts[k];
    return typeof value === 'string' ? value : fail(`engine-serve needs ${flag}`);
  };
  const modelName = needed('model', '--model');
  const cacheDir = needed('cacheDir', '--cache-dir');
  const engineDir = needed('engineDir', '--engine-dir');
  const binary = await installedEngine(engineDir);
  if (!binary) fail(`no engine ${ENGINE_BUILD} in ${engineDir}: nothing is downloaded here, install it with the app first`, EXIT_MODEL);
  const model = (await scanModels(modelDirs())).find((m) => m.id === modelName);
  if (!model) fail(`model ${modelName} not found in ${modelDirs().join(', ')}`, EXIT_MODEL);
  const config = buildConfig(model.id);
  const engine = new ModelEngine({
    binary: async () => binary,
    cacheDir,
    build: ENGINE_BUILD,
    limit: config.maxInferences ?? 1,
    idleMs: 0, // (no unloading: it serves until it is stopped)
    log: (what, detail) => console.error(`${what}: ${errorMessage(detail)}`),
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
    engine.servers.get(model.id)?.exited?.then(() => {
      if (!stopping) fail('the engine stopped', EXIT_MODEL);
    });
  } catch (e) {
    if (!stopping) fail(errorMessage(e), EXIT_MODEL);
  }
}

// ---------- a run ----------
/** The service of engine-serve, as a fixed lease. Its model comes from the server: its architecture decides the path of the calls. */
async function connectEngine(): Promise<Omit<Lease, 'release'> & { model: { id: string } }> {
  const { engineUrl, engineKeyFile } = opts;
  if (typeof engineUrl !== 'string' || typeof engineKeyFile !== 'string') return fail('--provider poney needs --engine-url and --engine-key-file');
  let apiKey: string;
  try {
    apiKey = fs.readFileSync(engineKeyFile, 'utf8').trim();
  } catch (e) {
    return fail(`cannot read the key: ${errorMessage(e)}`);
  }
  const baseUrl = engineUrl.replace(/\/+$/, '');
  let props: Record<string, unknown>;
  try {
    const res = await fetch(`${baseUrl}/props`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    props = rec(await res.json());
  } catch (e) {
    return fail(`no engine at ${baseUrl}: ${errorMessage(e)}`, EXIT_MODEL);
  }
  const modelPath = str(props.model_path);
  const info = modelPath ? await readGguf(modelPath).catch(() => null) : null;
  if (!info) return fail(`cannot read the model of the engine (${modelPath || 'not given'})`, EXIT_MODEL);
  const id = modelId(modelPath);
  if (opts.model && opts.model !== id) fail(`the engine serves ${id}, not ${String(opts.model)}`);
  const numCtx = rec(props.default_generation_settings).n_ctx;
  return { baseUrl, apiKey, model: { id, info }, numCtx: isNumber(numCtx) ? numCtx : undefined };
}

/** The list of messages to send, checked before anything starts. */
function readMessages() {
  if (!opts.script) return [words.join(' ')];
  if (words.length) fail('give either --script or a task');
  let script: unknown;
  try {
    script = parseJson(fs.readFileSync(String(opts.script), 'utf8'));
  } catch (e) {
    fail(`cannot read the script: ${errorMessage(e)}`);
  }
  const messages = list(script).filter(isString);
  if (!messages.length || messages.length !== list(script).length || !messages.every((m) => m.trim())) fail('the script must be a JSON list of messages');
  return messages;
}

const EXIT_CODES: Record<string, number | undefined> = { done: 0, max_steps: 2, stopped: 130 }; // (any other end of a turn: EXIT_MODEL)
const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };

const summarize = (tool: string, args: ToolArgs = {}) => {
  if (tool === 'run') return args.command;
  if (tool === 'web_search') return args.query;
  if (tool === 'fetch') return args.url;
  if (tool === 'agent') return args.title;
  if (tool === 'search') return `${args.pattern} in ${args.path || '.'}`;
  return args.path || '.';
};

const subTitles = new Map<number, string | undefined>(); // sub-agent card id -> title
function show(ev: AgentEvent) {
  if (ev.type === 'action_start' && ev.tool === 'agent') subTitles.set(ev.id, ev.args?.title);
  if (ev.agentId) {
    // Sub-agents run at the same time: one prefixed line per action, no streamed text.
    const who = `${c.dim}[${subTitles.get(ev.agentId) || 'sous-agent'}]${c.reset} `;
    if (ev.type === 'action_start') console.log(`${who}${c.cyan}▶ ${ev.tool}: ${summarize(ev.tool, ev.args)}${c.reset}`);
    else if (ev.type === 'action_end') console.log(`${who}${ev.ok ? c.green + '✓' : c.red + '✗'}${c.reset} ${c.dim}${ev.output.split('\n')[0].slice(0, 120)}${c.reset}`);
    else if (ev.type === 'notice' || ev.type === 'error') console.log(`${who}${c.yellow}• ${ev.type === 'notice' ? ev.text : ev.message}${c.reset}`);
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
  const config = buildConfig(lease?.model.id ?? (typeof opts.model === 'string' ? opts.model : undefined));
  if (lease) {
    // The window is the one the engine loaded: all the sizes follow from it.
    const wanted = (opts.numCtx || opts.settings ? config.numCtx : lease.numCtx) ?? DEFAULT_CONFIG.numCtx;
    config.numCtx = Math.min(wanted, lease.numCtx || wanted);
    const gate = new InferenceGate<object>({ canStart: () => true, isLoaded: () => true, start() {} }, config.maxInferences ?? 1);
    setInferenceService({ acquire: async ({ signal }) => ({ ...lease, release: await gate.acquire({}, signal) }) });
  }

  // Nobody to ask: a command that needs an answer is refused.
  const interactive = process.stdin.isTTY && config.approval !== 'auto';
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: opts.json ? process.stderr : process.stdout }) : null;
  const asking = new AbortController();
  const agent = new Agent({
    cwd: path.resolve(String(opts.cwd || '.')),
    config,
    triage: true,
    approve: async ({ command }) => {
      if (!rl) return false;
      const answer = await rl.question(`${c.yellow}Run \`${command}\`? [Y/n] ${c.reset}`, { signal: asking.signal }).catch(() => 'n');
      return /^(y|o|yes|oui)?$/i.test(answer.trim());
    },
  });
  agent.trace = Boolean(opts.json);

  const turn: { reason: string | null } = { reason: null };
  const emitLine = (ev: AgentEvent) => process.stdout.write(`${JSON.stringify(ev)}\n`);
  agent.on('event', (ev) => {
    if (ev.type === 'turn_end') turn.reason = ev.reason; // (those of sub-agents come as sub_turn)
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
    if (turn.reason !== 'done') break;
  }
  rl?.close();
  await closeClients();
  process.exitCode = stopped ? EXIT_CODES.stopped : EXIT_CODES[turn.reason ?? ''] ?? EXIT_MODEL;
}

try {
  if (command === 'engine-serve') await engineServe();
  else if (command === 'models') await listLocalModels();
  else if (command === 'version') showVersion();
  else await run();
} catch (e) {
  fail(errorMessage(e), EXIT_MODEL);
}
