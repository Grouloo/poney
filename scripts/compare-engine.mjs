// Compares Poney's engine with LM Studio on the same prompts, for each GGUF model
// both can run: loops, invalid tool calls, time to first token, speed. A build of
// the engine becomes the default only after this passes on the usual models.
//   node scripts/compare-engine.mjs [http://localhost:1234/v1] [context]
// LM Studio must be running. The engine is installed in ./.engine-test if needed.
import os from 'node:os';
import path from 'node:path';
import { ModelEngine } from '../src/engine/engine.js';
import { ENGINE_BUILD, installEngine } from '../src/engine/install.js';
import { scanModels, sameModelFile } from '../src/engine/models.js';
import { closeClients, lmStudioModels, setInferenceService, streamChat } from '../src/agent/llm.js';

const baseUrl = process.argv[2] ?? 'http://localhost:1234/v1';
const numCtx = Number(process.argv[3]) || 16384;
const SYSTEM = 'You are a coding agent. To call a tool write <tool_call>{"name": "...", "arguments": {...}}</tool_call>. Tools: read(path), write(path, content), run(command).';
const PROMPTS = [
  'Read package.json, then tell me what the test command is.',
  'Write a function that reverses a linked list in Python, in reverse.py.',
  'Explain in three sentences what a race condition is.',
  'List the files of this folder.',
];
const work = path.resolve('.engine-test');
const engine = new ModelEngine({
  binary: () => installEngine(path.join(work, 'engine')),
  cacheDir: path.join(work, 'cache'),
  build: ENGINE_BUILD,
  idleMs: 0,
});
const models = await scanModels([path.join(os.homedir(), '.lmstudio', 'models')]);
setInferenceService({
  acquire: ({ provider, model, numCtx: n, signal, onStatus }) => (provider === 'poney' ? engine.acquire({ model: models.find((m) => m.id === model), numCtx: n, signal, onStatus }) : engine.acquire({ signal, onStatus })),
});

async function run(opts, prompt) {
  const started = Date.now();
  let first = null;
  let text = '';
  let thinking = '';
  let usage = null;
  let error = null;
  try {
    for await (const c of streamChat({ ...opts, numCtx, maxTokens: 1024, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] })) {
      if (c.type === 'text' || c.type === 'thinking') first ??= Date.now() - started;
      if (c.type === 'text') text += c.text;
      if (c.type === 'thinking') thinking += c.text;
      if (c.type === 'usage') usage = c;
    }
  } catch (e) {
    error = e.message;
  }
  const calls = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => m[1]);
  const broken = calls.filter((c) => { try { JSON.parse(c); return false; } catch { return true; } }).length;
  const lines = text.split('\n').filter((l) => l.trim().length > 20);
  const looped = lines.length - new Set(lines).size >= 3;
  const seconds = (Date.now() - started - (first ?? 0)) / 1000;
  return { first, tps: usage?.outputTokens && seconds > 0 ? Math.round(usage.outputTokens / seconds) : null, calls: calls.length, broken, looped, empty: !text.trim() && !thinking.trim(), error };
}

const listed = await lmStudioModels({ baseUrl });
if (!listed) throw new Error(`LM Studio does not answer on ${baseUrl}`);
const pairs = listed.filter((l) => l.compatibility_type === 'gguf' && l.type !== 'embeddings').map((l) => [l.id, models.find((m) => sameModelFile(l.id, [m]))]).filter(([, m]) => m);
let bad = 0;
for (const [lmsId, model] of pairs) {
  for (const prompt of PROMPTS) {
    const lms = await run({ provider: 'openai', baseUrl, model: lmsId }, prompt);
    const own = await run({ provider: 'poney', model: model.id }, prompt);
    const fails = own.error || own.empty || own.looped > lms.looped || own.broken > lms.broken || (own.calls === 0 && lms.calls > 0);
    if (fails) bad++;
    console.log(`${fails ? 'DIFF' : 'ok  '} ${model.id} | ${prompt.slice(0, 40)}\n  LM Studio ${JSON.stringify(lms)}\n  Poney     ${JSON.stringify(own)}`);
  }
}
await engine.shutdown();
await closeClients();
console.log(bad ? `${bad} difference(s).` : `No difference on ${pairs.length} model(s).`);
process.exit(bad ? 1 : 0);
