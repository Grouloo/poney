#!/usr/bin/env node
// Headless runner: node src/cli.js --cwd ./project --model qwen2.5:14b "task"
import path from 'node:path';
import readline from 'node:readline/promises';
import { Agent } from './agent/agent.js';
import { closeClients } from './agent/llm.js';

const argv = process.argv.slice(2);
const opts = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (['yes', 'verbose', 'help', 'noWeb', 'noShell', 'tor'].includes(key) || next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  } else words.push(a);
}

if (!words.length || opts.help) {
  console.log(`Usage: node src/cli.js [options] "task"
  --cwd DIR            project folder (default: current dir)
  --provider P         ollama | openai (default: ollama)
  --base-url URL       server URL (default: http://localhost:11434)
  --model NAME         model name
  --num-ctx N          context size (default: 16384)
  --test-command CMD   command that must pass before the agent may finish
  --yes                run commands without asking
  --no-web             disable web search and page fetching
  --no-shell           disable terminal commands
  --tor                web search and page reading through Tor (refused if Tor is down)
  --tor-proxy ADDR     Tor SOCKS proxy (default: auto, 127.0.0.1:9050 then 9150)
  --verbose            print full tool outputs`);
  process.exit(words.length ? 0 : 1);
}

const config = {};
for (const k of ['provider', 'baseUrl', 'model', 'apiKey', 'testCommand', 'searxngUrl']) if (opts[k]) config[k] = opts[k];
for (const k of ['numCtx', 'maxTokens', 'maxSteps', 'commandTimeout']) if (opts[k]) config[k] = Number(opts[k]);
if (opts.temperature) config.temperature = Number(opts.temperature);
if (opts.provider === 'openai' && !opts.baseUrl) config.baseUrl = 'http://localhost:1234/v1';
config.approval = opts.yes ? 'auto' : 'ask';
if (opts.noWeb) config.webEnabled = false;
if (opts.noShell) config.shellEnabled = false;
if (opts.tor) config.torEnabled = true;
if (opts.torProxy) config.torProxy = opts.torProxy;

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const agent = new Agent({
  cwd: path.resolve(opts.cwd || '.'),
  config,
  triage: true,
  approve: async ({ command }) => /^(y|o|yes|oui)?$/i.test((await rl.question(`${c.yellow}Run \`${command}\`? [Y/n] ${c.reset}`)).trim()),
});

const summarize = (tool, args) => {
  if (tool === 'run') return args.command;
  if (tool === 'web_search') return args.query;
  if (tool === 'fetch') return args.url;
  if (tool === 'agent') return args.title;
  if (tool === 'search') return `${args.pattern} in ${args.path || '.'}`;
  return args.path || '.';
};

const subTitles = new Map(); // sub-agent card id -> title
agent.on('event', (ev) => {
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
});

process.on('SIGINT', () => agent.stop());
await agent.send(words.join(' '));
rl.close();
await closeClients();
