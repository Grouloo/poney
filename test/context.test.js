import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  contextPlan, answerTokens, makeEstimator, splitForCompaction, extractFacts, renderTranscript, calibrate, buildSummaryMessage, SUMMARY_MARKER,
} from '../src/agent/context.js';
import { Agent } from '../src/agent/agent.js';

const est = makeEstimator(3.2);
// A summary request: separate transcript, or continuation of the conversation.
const isSummaryReq = (d) => d.messages[0].content.startsWith('You summarize') || d.messages.at(-1).content.includes('PAUSE THE TASK');
const msg = (role, content) => ({ role, content });

test('splitForCompaction keeps recent messages that fit, at least 2', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'x'.repeat(320))); // ~100 tokens each
  const { old, recent } = splitForCompaction(msgs, 350, est);
  assert.equal(recent.length, 3);
  assert.equal(old.length, 7);
  const tiny = splitForCompaction(msgs, 1, est);
  assert.equal(tiny.recent.length, 2);
});

test('extractFacts lists changed files and commands, and carries previous facts forward', () => {
  const msgs = [
    msg('user', buildSummaryMessage({ summary: 'Goal: x', facts: 'Files changed: old.py (written)' })),
    msg('assistant', '<write path="a.py">\nprint(1)\n</write>\n<edit path="b.py"><old>x</old><new>y</new></edit>\n<run>python3 a.py</run>'),
    msg('user', '<result tool="write" path="a.py">\nok\n</result>\n<result tool="run" exit="1" command="python3 a.py">\nboom\n</result>'),
  ];
  const facts = extractFacts(msgs);
  assert.match(facts, /a\.py \(written\)/);
  assert.match(facts, /b\.py \(edited\)/);
  assert.match(facts, /old\.py \(written\)/);
  assert.match(facts, /`python3 a\.py` -> exit 1/);
});

test('renderTranscript shrinks file bodies and long outputs, and caps size', () => {
  const t = renderTranscript([
    msg('assistant', `<write path="a.py">\n${'line\n'.repeat(50)}</write>`),
    msg('user', `<result tool="run" exit="0">\n${'o'.repeat(5000)}\n</result>`),
  ], 100000);
  assert.match(t, /\[5\d lines\]/);
  assert.ok(t.length < 1200);
  const capped = renderTranscript([msg('user', 'a'.repeat(50000))], 2000);
  assert.ok(capped.length <= 2100);
  assert.match(capped, /omitted/);
});

test('calibrate ignores cache-reduced counts and absurd ratios', () => {
  assert.equal(calibrate(3.2, 32000, 10000), 3.2); // exact match
  assert.ok(calibrate(3.2, 32000, 12000) < 3.2); // more tokens than estimated -> ratio goes down
  assert.equal(calibrate(3.2, 32000, 500), 3.2); // looks cache-reduced
  assert.equal(calibrate(3.2, 1000, 400), 3.2); // too small a sample
});

// ---------- agent + fake Ollama server ----------

function fakeOllama(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      requests.push(data);
      const { content, promptTokens, doneReason = 'stop' } = handler(data, requests.length);
      res.end(`${JSON.stringify({ message: { content }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, done_reason: doneReason, prompt_eval_count: promptTokens, eval_count: 10 })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}

test('agent compacts a long history with a summary, then keeps a stable prefix', async () => {
  const isSummary = (data) => isSummaryReq(data);
  let step = 0;
  const fake = await fakeOllama((data) => {
    const chars = data.messages.reduce((n, m) => n + m.content.length, 0);
    if (isSummary(data)) return { content: 'Goal: build the parser.\nNext step: write tests.', promptTokens: Math.round(chars / 3) };
    step++;
    return { content: step === 1 ? '<write path="n.txt">\nhello\n</write>\n<read path="n.txt" />' : 'Done.', promptTokens: Math.round(chars / 3) };
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 4096, maxTokens: 512, approval: 'auto' } });
  // ~6000 tokens of old history: well above the ~2800 token budget.
  for (let i = 0; i < 12; i++) {
    agent.messages.push(msg('user', `<result tool="read" path="f${i}.py">\n${'data '.repeat(320)}\n</result>`));
    agent.messages.push(msg('assistant', `<write path="f${i}.py">\n${'code '.repeat(80)}\n</write>`));
  }
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('continue');
  fake.server.close();

  const compactions = events.filter((e) => e.type === 'compaction');
  assert.equal(compactions.length, 1, 'compacted exactly once (hysteresis)');
  assert.ok(compactions[0].after < compactions[0].before / 2);
  assert.equal(fake.requests.filter(isSummary).length, 1);

  const main = fake.requests.filter((d) => !isSummary(d));
  assert.equal(main.length, 2);
  assert.ok(main[0].messages[1].content.startsWith(SUMMARY_MARKER), 'summary is the first history message');
  assert.match(main[0].messages[1].content, /Goal: build the parser/);
  assert.match(main[0].messages[1].content, /f11\.py \(written\)|f0\.py \(written\)/);
  // The request is recent, so it stays verbatim (not copied into the summary).
  assert.doesNotMatch(main[0].messages[1].content, /\[CURRENT TASK\]/);
  assert.ok(main[0].messages.some((m) => m.content.endsWith('continue')));
  // Second step: same prefix as the first one (server cache reusable).
  const prefix = (d) => JSON.stringify(d.messages.slice(0, 3));
  assert.equal(prefix(main[1]), prefix(main[0]));
  // Calibrated to the fake server's ratio (3 chars/token) and gauge emitted.
  assert.ok(agent.charsPerToken < 3.2 && agent.charsPerToken > 2.9, `ratio ${agent.charsPerToken}`);
  const ctx = events.filter((e) => e.type === 'context').pop();
  assert.ok(ctx.used < ctx.compactAt);
  assert.equal(agent.messages[0].content.startsWith(SUMMARY_MARKER), true);
});

test('manual compaction refuses when there is too little history', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { model: 'fake', numCtx: 4096, maxTokens: 512 } });
  agent.messages.push(msg('user', 'hi'), msg('assistant', 'hello'));
  const r = await agent.compact();
  assert.equal(r.compacted, false);
  assert.equal(agent.messages.length, 2);
});

test('the current request is copied into the summary when it gets compacted', async () => {
  const fake = await fakeOllama(() => ({ content: 'Goal: g\nNext step: s', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 4096, maxTokens: 512 } });
  agent.messages.push(msg('user', 'Refactor the parser please'));
  for (let i = 0; i < 10; i++) {
    agent.messages.push(msg('assistant', `<read path="p${i}.py" />`));
    agent.messages.push(msg('user', `<result tool="read" path="p${i}.py">\n${'data '.repeat(400)}\n</result>`));
  }
  agent.turnStartIndex = 0;
  const r = await agent.maybeCompact('system', new AbortController().signal);
  fake.server.close();
  assert.equal(r.compacted, true);
  assert.match(agent.messages[0].content, /\[CURRENT TASK\]\nRefactor the parser please/);
  assert.equal(agent.turnStartIndex, 0);
});

test('successive compactions do not nest summaries', async () => {
  let n = 0;
  const fake = await fakeOllama(() => ({ content: `Goal: g${++n}\nNext step: s`, promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 4096, maxTokens: 512 } });
  const fill = (k) => {
    for (let i = 0; i < k; i++) {
      agent.messages.push(msg('assistant', `<read path="p${i}.py" />`));
      agent.messages.push(msg('user', `<result tool="read" path="p${i}.py">\n${'data '.repeat(400)}\n</result>`));
    }
  };
  agent.messages.push(msg('user', 'Refactor the parser please'));
  agent.turnStartIndex = 0;
  fill(10);
  await agent.maybeCompact('system', new AbortController().signal);
  fill(10);
  await agent.maybeCompact('system', new AbortController().signal);
  fake.server.close();
  const first = agent.messages[0].content;
  assert.equal(first.split(SUMMARY_MARKER).length - 1, 1, first);
  assert.match(first, /Goal: g2/);
  assert.match(first, /\[CURRENT TASK\]\nRefactor the parser please\n/);
});

test('cleanSummary: copied transcripts rejected, English or French summaries accepted', async () => {
  const { cleanSummary } = await import('../src/agent/context.js');
  assert.match(cleanSummary('<read path="a.py" />\n### USER\n<result tool="read">x</result>').reason, /recopié/);
  assert.match(cleanSummary('Some text without the headings').reason, /format/);
  assert.equal(cleanSummary('').reason, 'réponse vide');
  assert.equal(cleanSummary('<think>hmm</think>\nGoal: x\nDone so far: y\nCurrent state: ok\nNext step: z').summary, 'Goal: x\nDone so far: y\nCurrent state: ok\nNext step: z');
  assert.ok(cleanSummary('**Objectif :** refactor\n**Déjà fait :** lu parser.py\n**État actuel :** ok\n**Prochaine étape :** tests').summary);
  assert.ok(cleanSummary('Goal: fix\nDone so far: changed a.py with <edit>\nNext step: run tests').summary, 'one tool mention is fine');
});

test('a bad summary is retried, then replaced by a backup summary with the reason', async () => {
  const fake = await fakeOllama(() => ({ content: '### USER\n<read path="x" />', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 4096, maxTokens: 512 } });
  agent.messages.push(msg('user', 'Refactor the parser'));
  for (let i = 0; i < 10; i++) {
    agent.messages.push(msg('assistant', `I will now update module number ${i} carefully.\n<write path="w${i}.py">\n${'x = 1\n'.repeat(200)}</write>`));
    agent.messages.push(msg('user', `<result tool="write" path="w${i}.py">\nok\n</result>`));
  }
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.maybeCompact('system', new AbortController().signal);
  fake.server.close();
  assert.equal(fake.requests.length, 2, 'one retry');
  assert.match(fake.requests[1].messages[1].content, /without long reasoning/);
  const first = agent.messages[0].content;
  assert.match(first, /The automatic summary failed/);
  assert.match(first, /User requests:\n- Refactor the parser/);
  assert.match(first, /Last notes from the assistant:\n- I will now update module number/);
  assert.match(first, /w0\.py \(written\)/);
  const c = events.find((e) => e.type === 'compaction');
  assert.equal(c.fallback, true);
  assert.match(c.failure, /recopié/);
});

test('a model that only reasons gets a clear failure reason', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(`${JSON.stringify({ message: { thinking: 'Let me think about it at length...' }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length' })}\n`));
  });
  await new Promise((r) => server.listen(0, r));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'fake', numCtx: 4096, maxTokens: 512 } });
  agent.messages.push(msg('user', 'task'));
  for (let i = 0; i < 10; i++) {
    agent.messages.push(msg('assistant', `<read path="p${i}.py" />`));
    agent.messages.push(msg('user', `<result tool="read" path="p${i}.py" lines="1-9">\n${'data '.repeat(400)}\n</result>`));
  }
  const r = await agent.maybeCompact('system', new AbortController().signal);
  server.close();
  assert.equal(r.fallback, true);
  assert.match(r.failure, /budget à réfléchir/);
});

test('summary rejected by the server is retried with a shorter transcript', async () => {
  const sizes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body);
      sizes.push(data.messages[1].content.length);
      if (sizes.length === 1) { res.statusCode = 400; return res.end('{"error":"context length exceeded"}'); }
      res.end(`${JSON.stringify({ message: { content: 'Goal: g\nNext step: s' }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'fake', numCtx: 4096, maxTokens: 512 } });
  agent.messages.push(msg('user', 'task'));
  for (let i = 0; i < 10; i++) {
    agent.messages.push(msg('assistant', `<read path="p${i}.py" />`));
    agent.messages.push(msg('user', `<result tool="read" path="p${i}.py" lines="1-9">\n${'data '.repeat(400)}\n</result>`));
  }
  const r = await agent.maybeCompact('system', new AbortController().signal);
  server.close();
  assert.equal(r.fallback, false);
  assert.ok(sizes[1] < sizes[0], `${sizes}`);
});

test('the real context length loaded in LM Studio caps the setting (HTTP fallback without websocket)', async () => {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/api/v0/models') return res.end(JSON.stringify({ data: [{ id: 'gemma', state: 'loaded', loaded_context_length: 16128 }] }));
      if (req.method !== 'POST') { res.statusCode = 404; return res.end(); } // e.g. the SDK's websocket attempt
      chats.push(JSON.parse(body));
      res.end('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { provider: 'openai', baseUrl: `http://localhost:${server.address().port}/v1`, model: 'gemma', numCtx: 24000, maxTokens: 4096 } });
  const ctx = [];
  agent.on('event', (e) => e.type === 'context' && ctx.push(e));
  await agent.send('hi');
  server.close();
  assert.equal(agent.serverCtx, 16128);
  assert.equal(ctx.at(-1).numCtx, 16128);
  assert.equal(ctx.at(-1).settingCtx, 24000);
  assert.ok(chats[0].max_tokens <= 16128);
});

// ---------- just-in-time compaction ----------

test('contextPlan compacts late: ~80% of a 16k window, more once calibrated', () => {
  const cfg = { numCtx: 16384, maxTokens: 4096 };
  const raw = contextPlan(cfg, 500, false);
  const cal = contextPlan(cfg, 500, true);
  assert.ok((500 + raw.budget) / 16384 > 0.78, `uncalibrated ${(500 + raw.budget) / 16384}`);
  assert.ok((500 + cal.budget) / 16384 > 0.82, `calibrated ${(500 + cal.budget) / 16384}`);
  assert.equal(raw.minOutput, 2048);
  // Small window: answer room capped at a quarter of it.
  assert.equal(contextPlan({ numCtx: 4096, maxTokens: 4096 }, 400).minOutput, 1024);
  // Answer size: as much as fits, between minOutput and maxTokens.
  assert.equal(answerTokens(cfg, raw, 1000), 4096);
  assert.equal(answerTokens(cfg, raw, 13500), Math.max(2048, 16384 - 13500 - raw.margin));
});

function bigHistory(agent, pairs, words) {
  for (let i = 0; i < pairs; i++) {
    agent.messages.push(msg('user', `<result tool="read" path="f${i}.py" lines="1-9">\n${'data '.repeat(words)}\n</result>`));
    agent.messages.push(msg('assistant', `<read path="f${i + 1}.py" />`));
  }
}

test('no compaction at 70% of the window; the answer size fits the window', async () => {
  const fake = await fakeOllama(() => ({ content: 'Done.', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 16384, maxTokens: 4096 } });
  bigHistory(agent, 20, 340); // ~11k tokens: the old trigger (60%) would have compacted
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('next');
  fake.server.close();
  assert.equal(events.filter((e) => e.type === 'compaction').length, 0);
  assert.equal(fake.requests.length, 1);
  const req = fake.requests[0];
  const promptTokens = req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 3.2) + 4, 0);
  assert.ok(promptTokens + req.options.num_predict <= 16384, `${promptTokens} + ${req.options.num_predict}`);
  assert.ok(req.options.num_predict >= 2048);
});

test('an unfinished <write> cut by the length limit is not executed', async () => {
  let n = 0;
  const fake = await fakeOllama(() => (++n === 1
    ? { content: 'Writing it.\n<write path="a.py">\nprint(1', promptTokens: 0, doneReason: 'length' }
    : { content: 'Done.', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', shellEnabled: false } });
  await agent.send('create a.py');
  fake.server.close();
  await assert.rejects(fs.access(path.join(cwd, 'a.py')));
  assert.match(fake.requests[1].messages.at(-1).content, /unfinished and was NOT executed/);
});

test('an answer cut because the window is full triggers compaction and a retry', async () => {
  const isSummary = (d) => isSummaryReq(d);
  let main = 0;
  const fake = await fakeOllama((d) => {
    if (isSummary(d)) return { content: 'Goal: g\nNext step: s', promptTokens: 0 };
    return ++main === 1 ? { content: 'A very long answer that', promptTokens: 0, doneReason: 'length' } : { content: 'Done.', promptTokens: 0 };
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 8192, maxTokens: 4096 } });
  bigHistory(agent, 10, 235); // just under the budget: no compaction up front, but a short answer room
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go');
  fake.server.close();
  assert.ok(fake.requests[0].options.num_predict < 4096, 'answer limited by the window');
  assert.deepEqual(fake.requests.map((d) => (isSummary(d) ? 'summary' : 'main')), ['main', 'summary', 'main']);
  assert.equal(events.filter((e) => e.type === 'compaction').length, 1);
  assert.equal(events.filter((e) => e.type === 'final').pop().text, 'Done.');
  assert.ok(fake.requests[2].options.num_predict > fake.requests[0].options.num_predict);
});

test('manual compaction works on a history that would fit in the window', async () => {
  const fake = await fakeOllama(() => ({ content: 'Goal: g\nNext step: s', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 32768, maxTokens: 4096 } });
  agent.messages.push(msg('user', 'task'));
  for (let i = 0; i < 6; i++) {
    agent.messages.push(msg('assistant', `<read path="p${i}.py" />`));
    agent.messages.push(msg('user', `<result tool="read" path="p${i}.py" lines="1-9">\n${'data '.repeat(100)}\n</result>`));
  }
  const r = await agent.compact();
  fake.server.close();
  assert.equal(r.compacted, true);
  assert.ok(r.after < r.before);
});

test('the summary request continues the cached conversation (same prefix, no re-read)', async () => {
  const fake = await fakeOllama((d) => (isSummaryReq(d)
    ? { content: 'Goal: g\nNext step: s', promptTokens: 0 }
    : { content: fake.requests.filter((r) => !isSummaryReq(r)).length === 1 ? '<read path="big.txt" />' : 'Done.', promptTokens: 0 }));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctx-'));
  await fs.writeFile(path.join(cwd, 'big.txt'), `${'data '.repeat(1000)}\n`);
  const agent = new Agent({ cwd, config: { baseUrl: fake.url, model: 'fake', numCtx: 8192, maxTokens: 4096, subagentsEnabled: false } });
  bigHistory(agent, 10, 235); // just under the budget; reading big.txt pushes it over
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go');
  fake.server.close();

  assert.deepEqual(fake.requests.map((d) => (isSummaryReq(d) ? 'summary' : 'main')), ['main', 'summary', 'main']);
  const [main, summary] = fake.requests;
  assert.match(summary.messages.at(-1).content, /PAUSE THE TASK/);
  assert.equal(summary.messages[0].content, main.messages[0].content, 'same system prompt');
  assert.deepEqual(summary.messages.slice(0, main.messages.length), main.messages, 'previous request is an exact prefix');
  assert.equal(events.find((e) => e.type === 'compaction').fallback, false);
});
