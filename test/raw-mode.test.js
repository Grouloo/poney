import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannelSplitter } from '../src/agent/llm.js';

const run = (pieces) => {
  const split = makeChannelSplitter();
  const out = [];
  for (const p of pieces) out.push(...split(p));
  out.push(...split('', true));
  // merge consecutive pieces of the same type
  return out.reduce((acc, c) => {
    const last = acc.at(-1);
    if (last && last.type === c.type) last.text += c.text; else acc.push({ ...c });
    return acc;
  }, []);
};

const raw = '<|channel>thought\nThe user wants hello.py.<channel|><|tool_call>call:write{path:<|"|>hello.py<|"|>,content:<|"|>print(1)<|"|>}<tool_call|><turn|>';

test('raw Gemma output is split into thinking and text', () => {
  assert.deepEqual(run([raw]), [
    { type: 'thinking', text: 'The user wants hello.py.' },
    { type: 'text', text: '<|tool_call>call:write{path:<|"|>hello.py<|"|>,content:<|"|>print(1)<|"|>}<tool_call|>' },
  ]);
});

test('markers cut across stream pieces are still recognized', () => {
  const pieces = raw.match(/[\s\S]{1,3}/g); // 3-character pieces
  assert.deepEqual(run(pieces), run([raw]));
});

test('a tool call opened inside the reasoning stays visible (as thinking)', () => {
  const r = run(['<|channel>thought\nI will <|tool_call>call:run{command:<|"|>ls<|"|>}', ' then think more']);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'thinking');
  assert.match(r[0].text, /tool_call>call:run/);
});

test('a native call made inside the reasoning is executed', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const msg = ++n === 1
        ? { thinking: 'Let me list: <|tool_call>call:list{path:<|"|>.<|"|>}<tool_call|>', content: '' }
        : { content: 'Done.' };
      res.end(`${JSON.stringify({ message: msg, done: true, done_reason: 'stop', eval_count: 30 })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-raw-'));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm' } });
  const actions = [];
  agent.on('event', (e) => e.type === 'action_start' && actions.push(e.tool));
  await agent.send('list files');
  server.close();
  assert.deepEqual(actions, ['list']);
});

test('a tag call in the reasoning stops the generation; the invented result is dropped', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-raw-'));
  await fs.writeFile(path.join(cwd, 'main.py'), 'REAL = 1\n');
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      if (++n === 1) {
        // Reasoning: a call, then an imagined result, streamed in pieces.
        const pieces = ['I need the file. <read path="main.py" />', '\n1| IMAGINED = 2\n', '2| more invented code\n'.repeat(20)];
        res.end(pieces.map((p) => JSON.stringify({ message: { thinking: p }, done: false })).join('\n') + `\n${JSON.stringify({ message: { content: '' }, done: true })}\n`);
      } else {
        res.end(`${JSON.stringify({ message: { content: 'Done.' }, done: true, done_reason: 'stop' })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm' } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('what is in main.py?');
  server.close();
  assert.deepEqual(events.filter((e) => e.type === 'action_start').map((e) => e.tool), ['read']);
  assert.ok(events.some((e) => e.type === 'notice' && /dans sa réflexion/.test(e.text)));
  const second = JSON.stringify(requests[1].messages);
  assert.match(second, /REAL = 1/, 'the real file content is given back');
  assert.doesNotMatch(second, /IMAGINED/, 'the imagined result is not kept');
});

test('stopping keeps the partial output in the transcript', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.write(`${JSON.stringify({ message: { thinking: 'partial reasoning' }, done: false })}\n`); }); // never ends
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-raw-')), config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm' } });
  const ends = [];
  agent.on('event', (e) => { if (e.type === 'assistant_end') ends.push(e); if (e.type === 'delta') agent.stop(); });
  await agent.send('go');
  server.closeAllConnections?.();
  server.close();
  assert.equal(ends.length, 1);
  assert.equal(ends[0].interrupted, true);
  assert.equal(ends[0].thinking, 'partial reasoning');
});

test('reasoning calls: run only when a result is imagined after them, never for a plan', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  for (const [thought, expected] of [
    ['Plan: `<read path="main.py" />`\n1| x = 9\n2| imagined', ['read']], // followed by an imagined result
    ['Maybe `<run>rm -rf build</run>` later.\nOutput: removed', []], // run in backticks: never
    ['Plan:\n1. <run>ls -la</run> to see the files\n2. then read the config and decide.', []], // a plan, nothing imagined
  ]) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-raw-'));
    await fs.writeFile(path.join(cwd, 'main.py'), 'x = 1\n');
    let n = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end(`${JSON.stringify(++n === 1 ? { message: { thinking: thought, content: 'Done.' }, done: true, done_reason: 'stop' } : { message: { content: 'Done.' }, done: true, done_reason: 'stop' })}\n`));
    });
    await new Promise((r) => server.listen(0, r));
    const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', approval: 'auto' } });
    const actions = [];
    agent.on('event', (e) => e.type === 'action_start' && actions.push(e.tool));
    await agent.send('go');
    server.close();
    assert.deepEqual(actions, expected, thought);
  }
});
