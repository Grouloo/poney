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
