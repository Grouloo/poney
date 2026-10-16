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
 * server reports it) {type: 'usage', promptTokens, outputTokens}.
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
        if (data.prompt_eval_count) yield { type: 'usage', promptTokens: data.prompt_eval_count, outputTokens: data.eval_count || 0 };
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
    const delta = data.choices?.[0]?.delta || {};
    const thinking = delta.reasoning_content || delta.reasoning;
    if (thinking) yield { type: 'thinking', text: thinking };
    if (delta.content) yield { type: 'text', text: delta.content };
  }
}

/** Non-streaming convenience: returns the full text (thinking excluded) and usage. */
export async function complete(opts) {
  let text = '';
  let usage = null;
  for await (const chunk of streamChat(opts)) {
    if (chunk.type === 'text') text += chunk.text;
    else if (chunk.type === 'usage') usage = chunk;
  }
  return { text, usage };
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
