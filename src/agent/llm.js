// Streaming chat client for local model servers.
// - "ollama": native /api/chat (lets us set num_ctx, which the OpenAI shim ignores)
// - "openai": any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, ...).
//   With LM Studio, the prompt is first read through its SDK, which reports the
//   reading progress (minutes on long prompts with local hardware), and stopped
//   at the first token; the answer is then generated over HTTP, which reuses
//   that cache. Generating through the SDK is avoided: LM Studio cuts SDK
//   predictions after about 5 minutes ("TypeError: terminated").
import { LMStudioClient, Chat } from '@lmstudio/sdk';

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

function openaiBase(baseUrl) {
  const b = trimSlash(baseUrl);
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

async function* readLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function checkResponse(res) {
  if (res.ok) return;
  let detail = '';
  try { detail = (await res.text()).slice(0, 500); } catch {}
  throw new Error(`Model server returned HTTP ${res.status}: ${detail}`);
}

/**
 * Yields {type: 'text' | 'thinking', text} chunks, {type: 'progress', progress}
 * (0..1) while the prompt is being read when the server reports it, and at the
 * end (if the server reports them) {type: 'usage', promptTokens, outputTokens,
 * promptMs?, evalMs?} and {type: 'done', reason} ('length' = the answer was cut).
 */
export async function* streamChat(opts) {
  if (opts.provider === 'openai' && await isLMStudio(opts)) {
    // Declare our tools to models with native tool calls (see toolSchemas).
    opts = { ...opts, tools: lmsToolUse(opts) && opts.toolSchemas?.length ? opts.toolSchemas : undefined };
    try {
      yield* readPromptLMStudio(opts);
      yield { type: 'prompt_read' }; // the prompt is in the server cache
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // No progress this time: the HTTP request reads the prompt itself.
      // Stop trying the SDK if it could not even connect.
      if (/ECONNREFUSED|websocket|connect/i.test(String(e?.message))) lmsBroken.add(lmsRoot(opts.baseUrl));
    }
    if (lmsRawMode(opts) && !lmsBroken.has(lmsRoot(opts.baseUrl))) {
      let yielded = false;
      try {
        for await (const chunk of streamLMStudioRaw(opts)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (e) {
        if (yielded || opts.signal?.aborted) throw e;
        // Raw mode unusable this time: the chat endpoint below.
      }
    }
  }
  yield* streamHTTP(opts);
}

// ---------- LM Studio raw mode (Gemma) ----------
// The chat endpoint parses the output: from a "<|tool_call>" on, it holds
// everything back until the call is closed, and drops it if it never is (Gemma
// sometimes opens a call inside its reasoning): generation goes on, nothing comes
// out. In raw mode we render the prompt with the model's own template (SDK) and
// use /v1/completions, which returns every token; reasoning is split here.

/** Models whose output format the raw mode knows (Gemma: <|channel>thought … <channel|>). */
function lmsRawMode({ baseUrl, model }) {
  const m = lmsModels.get(lmsRoot(baseUrl))?.find((x) => x.id === model);
  return /^gemma/i.test(m?.arch || '');
}

const CHANNEL_OPEN = '<|channel>';
const CHANNEL_CLOSE = '<channel|>';
const END_MARKERS = ['<turn|>', '<eos>', '<end_of_turn>'];

/** Length of the longest end of `s` that could be the start of `marker`. */
function partialTail(s, marker) {
  for (let k = Math.min(marker.length - 1, s.length); k > 0; k--) if (s.endsWith(marker.slice(0, k))) return k;
  return 0;
}

/** Splits a raw Gemma stream into text and thinking, markers possibly cut across pieces. */
export function makeChannelSplitter() {
  let buf = '';
  let mode = 'text'; // 'text' | 'header' (channel name line) | 'thinking'
  return function* split(piece, final = false) {
    buf += piece;
    for (const end of END_MARKERS) buf = buf.split(end).join('');
    while (true) {
      if (mode === 'text') {
        const i = buf.indexOf(CHANNEL_OPEN);
        if (i >= 0) {
          if (i) yield { type: 'text', text: buf.slice(0, i) };
          buf = buf.slice(i + CHANNEL_OPEN.length);
          mode = 'header';
          continue;
        }
        const keep = final ? 0 : Math.max(partialTail(buf, CHANNEL_OPEN), ...END_MARKERS.map((m) => partialTail(buf, m)));
        const out = buf.slice(0, buf.length - keep);
        if (out) yield { type: 'text', text: out };
        buf = buf.slice(buf.length - keep);
        return;
      }
      if (mode === 'header') {
        const nl = buf.indexOf('\n');
        if (nl < 0) {
          if (final) buf = '';
          return;
        }
        buf = buf.slice(nl + 1);
        mode = 'thinking';
        continue;
      }
      const j = buf.indexOf(CHANNEL_CLOSE);
      if (j >= 0) {
        if (j) yield { type: 'thinking', text: buf.slice(0, j) };
        buf = buf.slice(j + CHANNEL_CLOSE.length);
        mode = 'text';
        continue;
      }
      const keep = final ? 0 : partialTail(buf, CHANNEL_CLOSE);
      const out = buf.slice(0, buf.length - keep);
      if (out) yield { type: 'thinking', text: out };
      buf = buf.slice(buf.length - keep);
      return;
    }
  };
}

async function* streamLMStudioRaw({ baseUrl, apiKey, model, messages, temperature, maxTokens, signal, tools }) {
  const handle = await lmsModelHandle(baseUrl, model);
  const prompt = await handle.applyPromptTemplate(Chat.from(messages), tools ? { toolDefinitions: tools } : undefined);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${openaiBase(baseUrl)}/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, prompt, stream: true, stream_options: { include_usage: true }, temperature, max_tokens: maxTokens, stop: ['<turn|>'] }),
  });
  await checkResponse(res);
  const split = makeChannelSplitter();
  let finish = null;
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    if (data.usage?.completion_tokens) {
      yield { type: 'usage', promptTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens };
    }
    const choice = data.choices?.[0];
    if (choice?.text) yield* split(choice.text);
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  yield* split('', true);
  yield { type: 'done', reason: finish === 'length' ? 'length' : 'stop' };
}

// ---------- LM Studio (SDK) ----------

const lmsDetected = new Map(); // root url -> boolean
const lmsModels = new Map(); // root url -> [{ id, capabilities }]
const lmsBroken = new Set();
const lmsClients = new Map();

const lmsRoot = (baseUrl) => openaiBase(baseUrl).replace(/\/v1$/, '');

/** True when the OpenAI-compatible server is LM Studio (it has /api/v0/models with model states). */
async function isLMStudio({ baseUrl }) {
  const root = lmsRoot(baseUrl);
  if (lmsBroken.has(root)) return false;
  if (!lmsDetected.has(root)) {
    let ok = false;
    try {
      const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
      const data = res.ok ? await res.json() : null;
      ok = Array.isArray(data?.data) && data.data.some((m) => 'state' in m);
      if (ok) lmsModels.set(root, data.data);
    } catch {}
    lmsDetected.set(root, ok);
  }
  return lmsDetected.get(root);
}

/** Whether LM Studio says this model supports native tool calls. */
function lmsToolUse({ baseUrl, model }) {
  return Boolean(lmsModels.get(lmsRoot(baseUrl))?.find((m) => m.id === model)?.capabilities?.includes('tool_use'));
}

function lmsClient(baseUrl) {
  const ws = lmsRoot(baseUrl).replace(/^http/, 'ws');
  if (!lmsClients.has(ws)) {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    lmsClients.set(ws, new LMStudioClient({ baseUrl: ws, logger: quiet }));
  }
  return lmsClients.get(ws);
}

/** Closes the SDK connections (they keep a Node process alive, e.g. the CLI). */
export async function closeClients() {
  const clients = [...lmsClients.values()];
  lmsClients.clear();
  await Promise.all(clients.map((c) => c[Symbol.asyncDispose]?.().catch(() => {})));
}

/**
 * Reads the prompt through the SDK, yielding {type: 'progress'} events, and
 * stops at the first token: the server cache then holds the prompt, so the HTTP
 * request that follows starts generating almost at once.
 */
async function lmsModelHandle(baseUrl, model) {
  if (!model) throw new Error('No model selected.');
  const ws = lmsRoot(baseUrl).replace(/^http/, 'ws');
  try {
    // The SDK retries forever when the WebSocket does not answer: give up after a few seconds.
    return await Promise.race([
      lmsClient(baseUrl).llm.model(model),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LM Studio websocket connect timeout')), 4000).unref?.()),
    ]);
  } catch (e) {
    const client = lmsClients.get(ws);
    lmsClients.delete(ws);
    client?.[Symbol.asyncDispose]?.().catch(() => {});
    throw e;
  }
}

async function* readPromptLMStudio({ baseUrl, model, messages, temperature, signal, tools }) {
  const handle = await lmsModelHandle(baseUrl, model);
  // The SDK reports progress through a callback: queue it for the generator.
  const queue = [];
  let wake = null;
  let finished = false;
  let failure = null;
  const push = (item) => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  const prediction = handle.respond(Chat.from(messages), {
    maxTokens: 1,
    temperature,
    // Same tools as the HTTP request, so that the cached prompt is identical.
    ...(tools ? { rawTools: { type: 'toolArray', tools } } : {}),
    contextOverflowPolicy: 'stopAtLimit', // we size the prompt ourselves: never truncate silently
    onPromptProcessingProgress: (progress) => push({ type: 'progress', progress }),
  });
  const onAbort = () => prediction.cancel();
  signal?.addEventListener('abort', onAbort);
  (async () => {
    try {
      for await (const _ of prediction) {
        prediction.cancel(); // the first token means the prompt is read
        break;
      }
      await prediction.result().catch(() => {});
    } catch (e) {
      failure = e;
    } finally {
      finished = true;
      wake?.();
      wake = null;
    }
  })();
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (finished) break;
      await new Promise((resolve) => (wake = resolve));
    }
    if (failure && !signal?.aborted) throw failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) prediction.cancel();
  }
}

// ---------- HTTP (Ollama native, OpenAI-compatible) ----------

async function* streamHTTP({ provider, baseUrl, apiKey, model, messages, numCtx, temperature, maxTokens, signal, tools }) {
  if (!model) throw new Error('No model selected.');
  if (provider === 'ollama') {
    const res = await fetch(`${trimSlash(baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_ctx: numCtx, temperature, num_predict: maxTokens },
      }),
    });
    await checkResponse(res);
    for await (const line of readLines(res.body)) {
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (data.error) throw new Error(data.error);
      const m = data.message || {};
      if (m.thinking) yield { type: 'thinking', text: m.thinking };
      if (m.content) yield { type: 'text', text: m.content };
      for (const call of m.tool_calls || []) {
        // Native function call (the model ignored our tags): pass it on as text.
        yield { type: 'text', text: `\n<tool_call>${JSON.stringify({ name: call.function?.name, arguments: call.function?.arguments ?? {} })}</tool_call>` };
      }
      if (data.done) {
        if (data.prompt_eval_count || data.eval_count) {
          yield {
            type: 'usage',
            promptTokens: data.prompt_eval_count || 0,
            outputTokens: data.eval_count || 0,
            // Server-side timings (nanoseconds -> ms): more exact than ours.
            promptMs: data.prompt_eval_duration ? data.prompt_eval_duration / 1e6 : null,
            evalMs: data.eval_duration ? data.eval_duration / 1e6 : null,
          };
        }
        yield { type: 'done', reason: data.done_reason || 'stop' };
        return;
      }
    }
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${openaiBase(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, temperature, max_tokens: maxTokens, ...(tools ? { tools } : {}) }),
  });
  await checkResponse(res);
  const toolCalls = []; // native function calls, streamed in pieces
  const flushToolCalls = function* () {
    for (const c of toolCalls.splice(0)) {
      if (c.name) yield { type: 'text', text: `\n<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>` };
    }
  };
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { yield* flushToolCalls(); return; }
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    if (data.usage?.prompt_tokens) {
      yield { type: 'usage', promptTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens || 0 };
    }
    const delta = data.choices?.[0]?.delta || {};
    for (const tc of delta.tool_calls || []) {
      const c = (toolCalls[tc.index ?? 0] ??= { name: '', arguments: '' });
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
      // Visible progress while a native call is generated (it is parsed at the end).
      yield { type: 'tool_progress', name: c.name, text: tc.function?.arguments || '' };
    }
    const finish = data.choices?.[0]?.finish_reason;
    if (finish) {
      yield* flushToolCalls();
      yield { type: 'done', reason: finish };
    }
    const thinking = delta.reasoning_content || delta.reasoning;
    if (thinking) yield { type: 'thinking', text: thinking };
    if (delta.content) yield { type: 'text', text: delta.content };
  }
}

/** Non-streaming convenience: returns the text, the thinking, usage and why it ended. */
export async function complete(opts) {
  let text = '';
  let thinking = '';
  let usage = null;
  let doneReason = null;
  for await (const chunk of streamChat(opts)) {
    if (chunk.type === 'progress') opts.onProgress?.(chunk.progress);
    else if (chunk.type === 'text') text += chunk.text;
    else if (chunk.type === 'thinking') thinking += chunk.text;
    else if (chunk.type === 'usage') usage = chunk;
    else if (chunk.type === 'done') doneReason = chunk.reason;
  }
  return { text, thinking, usage, doneReason };
}

/**
 * Context length actually loaded on an OpenAI-compatible server, when it tells:
 * LM Studio (loaded_context_length), llama.cpp server (/props n_ctx), vLLM
 * (max_model_len). Null if unknown. Ollama is not queried: we set num_ctx ourselves.
 */
export async function serverContextLength({ provider, baseUrl, apiKey, model }) {
  if (provider === 'ollama' || !model) return null;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const get = async (url) => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const v1 = openaiBase(baseUrl);
  const root = v1.replace(/\/v1$/, '');
  const lms = await get(`${root}/api/v0/models`);
  const lm = lms?.data?.find((m) => m.id === model);
  if (lm) return lm.loaded_context_length || null;
  const props = await get(`${root}/props`);
  const n = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
  if (n) return n;
  const models = await get(`${v1}/models`);
  return models?.data?.find((m) => m.id === model)?.max_model_len || null;
}

export async function listModels({ provider, baseUrl, apiKey }) {
  if (provider === 'ollama') {
    const res = await fetch(`${trimSlash(baseUrl)}/api/tags`);
    await checkResponse(res);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  }
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(`${openaiBase(baseUrl)}/models`, { headers });
  await checkResponse(res);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}
