// Streaming chat client for local model servers.
// - "ollama": native /api/chat (lets us set num_ctx, which the OpenAI shim ignores)
// - "openai": any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, ...).
//   With LM Studio, the prompt is first read through its SDK, which reports the
//   reading progress (minutes on long prompts with local hardware), and stopped
//   at the first token; the answer is then generated over HTTP, which reuses
//   that cache. Generating through the SDK is avoided: LM Studio cuts SDK
//   predictions after about 5 minutes ("TypeError: terminated").
import { LMStudioClient, Chat } from '@lmstudio/sdk';
import { errorMessage, isRecord, list, num, parseJson, rec, str } from '../unknown.ts';
import type { ChatOptions, Lease, ModelChunk, Usage } from '../types.ts';

/** A model in LM Studio's own list. */
export interface LmsModel {
  id: string;
  arch?: string;
  type?: string;
  state?: string;
  capabilities?: string[];
  compatibility_type?: string;
  loaded_context_length?: number;
  max_context_length?: number;
}

interface InferenceService {
  acquire: (opts: ChatOptions & { onStatus: (text: string) => void }) => Promise<Lease>;
}

const isLmsModel = (m: unknown): m is LmsModel => isRecord(m) && typeof m.id === 'string';

/** The models of a /api/v0/models answer, if it is LM Studio's (it has model states). */
function lmsList(data: unknown): LmsModel[] | null {
  const models = rec(data).data;
  return Array.isArray(models) && models.some((m) => isRecord(m) && 'state' in m) ? models.filter(isLmsModel) : null;
}

function trimSlash(url = '') {
  return url.replace(/\/+$/, '');
}

function openaiBase(baseUrl: string | undefined) {
  const b = trimSlash(baseUrl);
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

async function* readLines(body: AsyncIterable<Uint8Array> | null) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body ?? []) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function checkResponse(res: Response) {
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
 * Text from a native tool call has native: true; {type: 'raw', text} is what a raw
 * completion wrote before it was split into text and thinking.
 * opts.jsonSchema: the answer must be JSON following this schema (structured output).
 * opts.noThinking: the model answers at once, without reasoning first, where the
 * server allows it (Gemma in LM Studio's raw mode, Ollama's think: false).
 */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<ModelChunk, void> {
  if (!service) return yield* dispatch(opts);
  // The lease is awaited here, what it waits for coming through as chunks.
  const statuses: string[] = [];
  let wake: (() => void) | null = null;
  const acquiring = service.acquire({ ...opts, onStatus: (text) => { statuses.push(text); wake?.(); } });
  const state: { lease: Lease | null; failure: unknown } = { lease: null, failure: null };
  acquiring.then((l) => { state.lease = l; }, (e: unknown) => { state.failure = e; }).finally(() => wake?.());
  while (!state.lease && !state.failure) {
    while (statuses.length) yield { type: 'status', text: statuses.shift() ?? '' };
    if (!state.lease && !state.failure) await new Promise<void>((resolve) => { wake = resolve; });
  }
  const { lease } = state;
  if (!lease) throw state.failure;
  try {
    yield { type: 'status', text: '' };
    yield* dispatch({ ...opts, lease });
  } finally {
    lease.release();
  }
}

// The queue and the models Poney runs itself (see src/engine/). Without it (the
// command line, the tests) calls go straight to the server.
let service: InferenceService | null = null;
export const setInferenceService = (s: InferenceService | null) => { service = s; };

async function* dispatch(opts: ChatOptions): AsyncGenerator<ModelChunk, void> {
  if (opts.provider === 'poney') {
    const { lease } = opts;
    if (!lease) throw new Error("No lease from Poney's engine.");
    yield* streamEngine({ ...opts, lease, baseUrl: lease.baseUrl, apiKey: lease.apiKey });
    return;
  }
  if (opts.provider === 'openai' && await isLMStudio(opts)) {
    // Declare our tools to models with native tool calls (see toolSchemas), for the
    // chat endpoint only. Not in raw mode, which holds nothing back: declared there
    // (in the system turn, in Gemma's own format, while the history calls them with
    // our tags), they made Gemma skip its reasoning and loop on a few words. Seen on
    // a sub-agent's report: 25 loops in 47 tries with them, 1 in 25 without.
    // (raw completions cannot constrain the output to a JSON schema: the chat endpoint
    // does; but only raw mode can keep the model from reasoning first, which wins)
    const raw = (!opts.jsonSchema || opts.noThinking) && lmsRawMode(opts) && !lmsBroken.has(lmsRoot(opts.baseUrl));
    const tools = lmsToolUse(opts) && opts.toolSchemas?.length ? opts.toolSchemas : undefined;
    opts = { ...opts, tools: raw ? undefined : tools };
    try {
      yield* readPromptLMStudio(opts);
      yield { type: 'prompt_read' }; // the prompt is in the server cache
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // No progress this time: the HTTP request reads the prompt itself.
      // Stop trying the SDK if it could not even connect.
      if (/ECONNREFUSED|websocket|connect/i.test(errorMessage(e))) lmsBroken.add(lmsRoot(opts.baseUrl));
    }
    if (raw && !lmsBroken.has(lmsRoot(opts.baseUrl))) {
      let yielded = false;
      try {
        for await (const chunk of streamLMStudioRaw(opts)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (e) {
        if (yielded || opts.signal?.aborted) throw e;
        // Raw mode unusable this time: the chat endpoint below, with the tools.
        opts = { ...opts, tools };
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

/** The temperature, when one is set; otherwise the server applies the model's own. */
const sampling = (temperature: number | null | undefined) => (typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {});

/** Models whose output format the raw mode knows (Gemma: <|channel>thought … <channel|>). */
function lmsRawMode({ baseUrl, model }: Pick<ChatOptions, 'baseUrl' | 'model'>) {
  const m = lmsModels.get(lmsRoot(baseUrl))?.find((x) => x.id === model);
  return /^gemma/i.test(m?.arch || '');
}

const CHANNEL_OPEN = '<|channel>';
const CHANNEL_CLOSE = '<channel|>';
const END_MARKERS = ['<turn|>', '<eos>', '<end_of_turn>'];

/** Length of the longest end of `s` that could be the start of `marker`. */
function partialTail(s: string, marker: string) {
  for (let k = Math.min(marker.length - 1, s.length); k > 0; k--) if (s.endsWith(marker.slice(0, k))) return k;
  return 0;
}

/**
 * Splits a raw Gemma stream into text and thinking, markers possibly cut across
 * pieces. Gemma sometimes reopens a reasoning channel while already reasoning
 * ("…sentence.<|channel>thought\n…", often to start the same passage again: a
 * loop): the marker is removed and reported as { type: 'reopen' }. A stray
 * closing marker in the answer is removed too. Both used to show as raw text.
 */
export function makeChannelSplitter() {
  let buf = '';
  let mode: 'text' | 'header' | 'thinking' = 'text'; // (header: the channel name line)
  let headerThen: 'text' | 'thinking' = 'thinking';
  return function* split(piece: string, final = false): Generator<ModelChunk> {
    buf += piece;
    for (const end of END_MARKERS) buf = buf.split(end).join('');
    while (true) {
      if (mode === 'header') {
        // The channel name ("thought"), then a newline. An empty reasoning comes without
        // the newline ("<|channel>thought<channel|>" then the answer): the name ends at
        // the first character that cannot be part of it. (Waiting for a newline there
        // swallowed the whole answer.)
        if (buf.startsWith(CHANNEL_OPEN)) { buf = buf.slice(CHANNEL_OPEN.length); continue; } // (opened twice)
        if (!final && CHANNEL_OPEN.startsWith(buf) && buf) return; // (maybe opened twice, cut)
        const name = buf.match(/^[A-Za-z_]*/)?.[0] ?? '';
        if (name.length === buf.length && !final) return; // (the name may go on in the next piece)
        buf = buf.slice(name.length);
        if (buf.startsWith('\n')) buf = buf.slice(1);
        mode = headerThen;
        continue;
      }
      const thinking = mode === 'thinking';
      const open = buf.indexOf(CHANNEL_OPEN);
      const close = buf.indexOf(CHANNEL_CLOSE);
      const at = [open, close].filter((i) => i >= 0).sort((x, y) => x - y)[0] ?? -1;
      if (at >= 0) {
        if (at) yield { type: thinking ? 'thinking' : 'text', text: buf.slice(0, at) };
        if (at === open) {
          buf = buf.slice(at + CHANNEL_OPEN.length);
          if (thinking) yield { type: 'reopen' };
          mode = 'header';
          headerThen = 'thinking';
        } else {
          buf = buf.slice(at + CHANNEL_CLOSE.length);
          mode = 'text'; // (in the answer: a stray closing marker, dropped)
        }
        continue;
      }
      const keep = final ? 0 : Math.max(partialTail(buf, CHANNEL_OPEN), partialTail(buf, CHANNEL_CLOSE), ...(thinking ? [] : END_MARKERS.map((m) => partialTail(buf, m))));
      const out = buf.slice(0, buf.length - keep);
      if (out) yield { type: thinking ? 'thinking' : 'text', text: out };
      buf = buf.slice(buf.length - keep);
      return;
    }
  };
}

// Gemma's own way of not reasoning: an empty reasoning channel, closed at once.
export const GEMMA_NO_THINKING = '<|channel>thought<channel|>';

async function* streamLMStudioRaw(opts: ChatOptions): AsyncGenerator<ModelChunk> {
  const { baseUrl, model, messages = [], tools } = opts;
  const handle = await lmsModelHandle(baseUrl, model);
  const prompt = await handle.applyPromptTemplate(Chat.from(messages), tools ? { toolDefinitions: tools } : undefined);
  yield* streamRaw({ ...opts, prompt });
}

async function* streamRaw({ baseUrl, apiKey, model, prompt = '', temperature, maxTokens, signal, noThinking, extra = {} }: ChatOptions): AsyncGenerator<ModelChunk> {
  // The answer starts after an empty reasoning (the prompt before it is unchanged: still cached).
  if (noThinking) prompt += GEMMA_NO_THINKING;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${openaiBase(baseUrl)}/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, prompt, stream: true, stream_options: { include_usage: true }, ...sampling(temperature), max_tokens: maxTokens, stop: ['<turn|>'], ...extra }),
  });
  await checkResponse(res);
  const split = makeChannelSplitter();
  let finish: string | null = null;
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    let data: Record<string, unknown>;
    try { data = rec(parseJson(payload)); } catch { continue; }
    if (data.prompt_progress) yield progressChunk(data.prompt_progress);
    const usage = rec(data.usage);
    if (usage.completion_tokens) {
      yield { type: 'usage', promptTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens), ...timingsOf(data) };
    }
    const choice = rec(list(data.choices)[0]);
    const text = str(choice.text);
    if (text) {
      yield { type: 'raw', text }; // (the markers included, for those who trace the output)
      yield* split(text);
    }
    if (choice.finish_reason) finish = str(choice.finish_reason);
  }
  yield* split('', true);
  yield { type: 'done', reason: finish === 'length' ? 'length' : 'stop' };
}

// ---------- Poney's engine (llama-server) ----------
const orNull = (v: unknown) => (typeof v === 'number' ? v : null);
const progressChunk = (reported: unknown): ModelChunk => {
  const { processed, total } = rec(reported);
  return { type: 'progress', progress: total ? num(processed) / num(total) : 1 };
};
const timingsOf = ({ timings }: Record<string, unknown>) => (timings ? { promptMs: orNull(rec(timings).prompt_ms), evalMs: orNull(rec(timings).predicted_ms) } : {});

/** As with LM Studio: Gemma in raw mode (it can hold nothing back), the others on the chat endpoint. */
async function* streamEngine(opts: ChatOptions & { lease: Lease }): AsyncGenerator<ModelChunk> {
  const { lease, baseUrl, apiKey, messages, jsonSchema, noThinking, toolSchemas } = opts;
  const extra = { return_progress: true, cache_prompt: true };
  if (/^gemma/i.test(lease.model?.info?.arch ?? '') && (!jsonSchema || noThinking)) {
    const res = await fetch(`${baseUrl}/apply-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ messages }),
      signal: opts.signal,
    });
    await checkResponse(res);
    // (llama-server constrains raw completions too: the JSON schema stands, without the reasoning)
    yield* streamRaw({ ...opts, prompt: str(rec(await res.json()).prompt), extra: { ...extra, ...(jsonSchema ? { json_schema: jsonSchema } : {}) } });
    return;
  }
  yield* streamHTTP({ ...opts, provider: 'openai', tools: toolSchemas?.length ? toolSchemas : undefined, extra });
}

// ---------- LM Studio (SDK) ----------

const lmsDetected = new Map<string, boolean>(); // root url -> boolean
const lmsModels = new Map<string, LmsModel[]>(); // root url -> [{ id, capabilities }]
const lmsBroken = new Set<string>();
const lmsClients = new Map<string, LMStudioClient>();

const lmsRoot = (baseUrl: string | undefined) => openaiBase(baseUrl).replace(/\/v1$/, '');

/** True when the OpenAI-compatible server is LM Studio (it has /api/v0/models with model states). */
async function isLMStudio({ baseUrl }: Pick<ChatOptions, 'baseUrl'>): Promise<boolean> {
  const root = lmsRoot(baseUrl);
  if (lmsBroken.has(root)) return false;
  if (!lmsDetected.has(root)) {
    let ok = false;
    try {
      const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
      const models = lmsList(res.ok ? await res.json() : null);
      ok = Boolean(models);
      if (models) lmsModels.set(root, models);
    } catch {}
    lmsDetected.set(root, ok);
  }
  return lmsDetected.get(root) ?? false;
}

/** LM Studio's list of models (with their formats), or null if this server is not LM Studio. */
export async function lmStudioModels({ baseUrl }: Pick<ChatOptions, 'baseUrl'>): Promise<LmsModel[] | null> {
  try {
    const res = await fetch(`${lmsRoot(baseUrl)}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    return lmsList(res.ok ? await res.json() : null);
  } catch {
    return null;
  }
}

/** Whether LM Studio says this model supports native tool calls. */
function lmsToolUse({ baseUrl, model }: Pick<ChatOptions, 'baseUrl' | 'model'>) {
  return Boolean(lmsModels.get(lmsRoot(baseUrl))?.find((m) => m.id === model)?.capabilities?.includes('tool_use'));
}

function lmsClient(baseUrl: string | undefined) {
  const ws = lmsRoot(baseUrl).replace(/^http/, 'ws');
  const known = lmsClients.get(ws);
  if (known) return known;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const client = new LMStudioClient({ baseUrl: ws, logger: quiet });
  lmsClients.set(ws, client);
  return client;
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
async function lmsModelHandle(baseUrl: string | undefined, model: string | undefined) {
  if (!model) throw new Error('No model selected.');
  const ws = lmsRoot(baseUrl).replace(/^http/, 'ws');
  try {
    // The SDK retries forever when the WebSocket does not answer: give up after a few seconds.
    return await Promise.race([
      lmsClient(baseUrl).llm.model(model),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LM Studio websocket connect timeout')), 4000).unref?.()),
    ]);
  } catch (e) {
    const client = lmsClients.get(ws);
    lmsClients.delete(ws);
    client?.[Symbol.asyncDispose]?.().catch(() => {});
    throw e;
  }
}

async function* readPromptLMStudio({ baseUrl, model, messages = [], temperature, signal, tools }: ChatOptions): AsyncGenerator<ModelChunk> {
  const handle = await lmsModelHandle(baseUrl, model);
  // The SDK reports progress through a callback: queue it for the generator.
  const queue: ModelChunk[] = [];
  const state: { finished: boolean; failure: unknown; wake: (() => void) | null } = { finished: false, failure: null, wake: null };
  const push = (item: ModelChunk) => {
    queue.push(item);
    state.wake?.();
    state.wake = null;
  };
  const prediction = handle.respond(Chat.from(messages), {
    maxTokens: 1,
    ...sampling(temperature),
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
      state.failure = e;
    } finally {
      state.finished = true;
      state.wake?.();
      state.wake = null;
    }
  })();
  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (state.finished) break;
      await new Promise<void>((resolve) => (state.wake = resolve));
    }
    if (state.failure && !signal?.aborted) throw state.failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!state.finished) prediction.cancel();
  }
}

// ---------- HTTP (Ollama native, OpenAI-compatible) ----------

async function* streamHTTP({ provider, baseUrl, apiKey, model, messages, numCtx, temperature, maxTokens, signal, tools, jsonSchema, noThinking, extra = {} }: ChatOptions): AsyncGenerator<ModelChunk> {
  if (!model) throw new Error('No model selected.');
  if (provider === 'ollama') {
    const post = (think?: boolean) => fetch(`${trimSlash(baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(jsonSchema ? { format: jsonSchema } : {}),
        ...(think === false ? { think: false } : {}),
        options: { num_ctx: numCtx, ...sampling(temperature), num_predict: maxTokens },
      }),
    });
    let res = await post(noThinking ? false : undefined);
    // (a server too old for "think": the same request without it)
    if (noThinking && res.status === 400 && /think/i.test(await res.clone().text().catch(() => ''))) res = await post(undefined);
    await checkResponse(res);
    for await (const line of readLines(res.body)) {
      let data: Record<string, unknown>;
      try { data = rec(parseJson(line)); } catch { continue; }
      if (data.error) throw new Error(String(data.error));
      const m = rec(data.message);
      if (m.thinking) yield { type: 'thinking', text: str(m.thinking) };
      if (m.content) yield { type: 'text', text: str(m.content) };
      for (const call of list(m.tool_calls)) {
        // Native function call (the model ignored our tags): pass it on as text.
        const fn = rec(rec(call).function);
        yield { type: 'text', native: true, text: `\n<tool_call>${JSON.stringify({ name: fn.name, arguments: fn.arguments ?? {} })}</tool_call>` };
      }
      if (data.done) {
        if (data.prompt_eval_count || data.eval_count) {
          yield {
            type: 'usage',
            promptTokens: num(data.prompt_eval_count),
            outputTokens: num(data.eval_count),
            // Server-side timings (nanoseconds -> ms): more exact than ours.
            promptMs: data.prompt_eval_duration ? num(data.prompt_eval_duration) / 1e6 : null,
            evalMs: data.eval_duration ? num(data.eval_duration) / 1e6 : null,
          };
        }
        yield { type: 'done', reason: str(data.done_reason) || 'stop' };
        return;
      }
    }
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${openaiBase(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, ...sampling(temperature), max_tokens: maxTokens, ...(tools ? { tools } : {}),
      ...(jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: jsonSchema } } } : {}), ...extra }),
  });
  await checkResponse(res);
  const toolCalls: { name: string; arguments: string }[] = []; // native function calls, streamed in pieces
  const flushToolCalls = function* (): Generator<ModelChunk> {
    for (const c of toolCalls.splice(0)) {
      if (c.name) yield { type: 'text', native: true, text: `\n<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>` };
    }
  };
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { yield* flushToolCalls(); return; }
    let data: Record<string, unknown>;
    try { data = rec(parseJson(payload)); } catch { continue; }
    if (data.prompt_progress) yield progressChunk(data.prompt_progress);
    const usage = rec(data.usage);
    if (usage.prompt_tokens) {
      yield { type: 'usage', promptTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens), ...timingsOf(data) };
    }
    const choice = rec(list(data.choices)[0]);
    const delta = rec(choice.delta);
    for (const tc of list(delta.tool_calls)) {
      const call = rec(tc);
      const fn = rec(call.function);
      const c = (toolCalls[num(call.index)] ??= { name: '', arguments: '' });
      if (fn.name) c.name += str(fn.name);
      if (fn.arguments) c.arguments += str(fn.arguments);
      // Visible progress while a native call is generated (it is parsed at the end).
      yield { type: 'tool_progress', name: c.name, text: str(fn.arguments) };
    }
    const finish = str(choice.finish_reason);
    if (finish) {
      yield* flushToolCalls();
      yield { type: 'done', reason: finish };
    }
    const thinking = str(delta.reasoning_content) || str(delta.reasoning);
    if (thinking) yield { type: 'thinking', text: thinking };
    if (delta.content) yield { type: 'text', text: str(delta.content) };
  }
}

/** Non-streaming convenience: returns the text, the thinking, usage and why it ended. */
export async function complete(opts: ChatOptions) {
  let text = '';
  let thinking = '';
  let usage: Usage | null = null;
  let doneReason: string | null = null;
  for await (const chunk of streamChat(opts)) {
    if (chunk.type === 'progress') opts.onProgress?.(chunk.progress);
    else if (chunk.type === 'status') opts.onStatus?.(chunk.text);
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
export async function serverContextLength({ provider, baseUrl, apiKey, model }: Pick<ChatOptions, 'provider' | 'baseUrl' | 'apiKey' | 'model'>): Promise<number | null> {
  if (provider === 'ollama' || provider === 'poney' || !model) return null; // (their context is ours to set)
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const get = async (url: string): Promise<unknown> => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const v1 = openaiBase(baseUrl);
  const root = v1.replace(/\/v1$/, '');
  const named = (data: unknown) => rec(list(rec(data).data).find((m) => rec(m).id === model));
  const lm = list(rec(await get(`${root}/api/v0/models`)).data).find((m) => rec(m).id === model);
  if (lm) return num(rec(lm).loaded_context_length) || null;
  const props = rec(await get(`${root}/props`));
  const n = rec(props.default_generation_settings).n_ctx ?? props.n_ctx;
  if (n) return num(n);
  return num(named(await get(`${v1}/models`)).max_model_len) || null;
}

export async function listModels({ provider, baseUrl, apiKey, timeoutMs = 3000 }: Pick<ChatOptions, 'provider' | 'baseUrl' | 'apiKey'> & { timeoutMs?: number }): Promise<string[]> {
  const signal = AbortSignal.timeout(timeoutMs); // (a server can take the connection and never answer)
  if (provider === 'ollama') {
    const res = await fetch(`${trimSlash(baseUrl)}/api/tags`, { signal });
    await checkResponse(res);
    const data = rec(await res.json());
    return list(data.models).map((m) => str(rec(m).name));
  }
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(`${openaiBase(baseUrl)}/models`, { headers, signal });
  await checkResponse(res);
  const data = rec(await res.json());
  return list(data.data).map((m) => str(rec(m).id));
}
