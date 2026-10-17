// Streaming chat client for local model servers.
// - "ollama": native /api/chat (lets us set num_ctx, which the OpenAI shim ignores)
// - "openai": any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, ...)

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
 * Yields {type: 'text' | 'thinking', text} chunks, and at the end (if the
 * server reports them) {type: 'usage', promptTokens, outputTokens} and
 * {type: 'done', reason} where reason 'length' means the answer was cut.
 */
export async function* streamChat({ provider, baseUrl, apiKey, model, messages, numCtx, temperature, maxTokens, signal }) {
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
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, temperature, max_tokens: maxTokens }),
  });
  await checkResponse(res);
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    if (data.usage?.prompt_tokens) {
      yield { type: 'usage', promptTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens || 0 };
    }
    const finish = data.choices?.[0]?.finish_reason;
    if (finish) yield { type: 'done', reason: finish };
    const delta = data.choices?.[0]?.delta || {};
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
    if (chunk.type === 'text') text += chunk.text;
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
