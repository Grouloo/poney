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
 * Yields {type: 'text' | 'thinking', text} chunks.
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
      if (data.done) return;
    }
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${openaiBase(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: maxTokens }),
  });
  await checkResponse(res);
  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    const delta = data.choices?.[0]?.delta || {};
    const thinking = delta.reasoning_content || delta.reasoning;
    if (thinking) yield { type: 'thinking', text: thinking };
    if (delta.content) yield { type: 'text', text: delta.content };
  }
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
