import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseActions } from '../src/agent/protocol.js';
import { Agent } from '../src/agent/agent.js';

test('native tool-call formats are understood as our tags', () => {
  const one = (t) => parseActions(t).actions.map((a) => [a.tool, a.args]);
  assert.deepEqual(one('<|tool_call>call:list path="." /<tool_call|>'), [['list', { path: '.' }]]);
  assert.deepEqual(one('<|tool_call>call:read{"path": "src/x.py"}<tool_call|>'), [['read', { path: 'src/x.py' }]]);
  assert.deepEqual(one('<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "print(1)"}}</tool_call>'), [['write', { path: 'a.py', content: 'print(1)' }]]);
  assert.deepEqual(one('<tool_call>{"name": "edit", "arguments": {"path": "a.py", "old": "x = 1", "new": "x = 2"}}</tool_call>')[0][0], 'edit');
  assert.deepEqual(one('<tool_call>{"name":"run","arguments":"{\\"command\\": \\"ls -la\\"}"}</tool_call>'), [['run', { command: 'ls -la' }]]);
  assert.deepEqual(one('<tool_call>{"name": "unknown_tool", "arguments": {}}</tool_call>'), []);
});

function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}` })));
}

test('OpenAI-style streamed tool_calls are executed', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
    const chunks = ++n === 1
      ? [
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '{"path": "out.txt", ' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content": "hello"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }];
    res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-native-'));
  const agent = new Agent({ cwd, config: { provider: 'openai', baseUrl: `${url}/v1`, model: 'm', shellEnabled: false } });
  await agent.send('write hello in out.txt');
  server.close();
  assert.equal(await fs.readFile(path.join(cwd, 'out.txt'), 'utf8'), 'hello\n');
});

test('Ollama tool_calls are executed', async () => {
  let n = 0;
  const { server, url } = await serve((req, res) => {
    const msg = ++n === 1
      ? { content: '', tool_calls: [{ function: { name: 'write', arguments: { path: 'o.txt', content: 'hi' } } }] }
      : { content: 'Done.' };
    res.end(`${JSON.stringify({ message: msg, done: true, done_reason: 'stop' })}\n`);
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-native-'));
  const agent = new Agent({ cwd, config: { baseUrl: url, model: 'm', shellEnabled: false } });
  await agent.send('write hi in o.txt');
  server.close();
  assert.equal(await fs.readFile(path.join(cwd, 'o.txt'), 'utf8'), 'hi\n');
});

test('a streamed native call stops the generation at the right place', async () => {
  const { server, url } = await serve((req, res) => {
    const parts = ['<|tool_call>call:', 'list path="." /', '<tool_call|>', ' and then some invented text'];
    res.end(parts.map((p) => JSON.stringify({ message: { content: p }, done: false })).join('\n') + `\n${JSON.stringify({ message: { content: '' }, done: true })}\n`);
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-native-'));
  const agent = new Agent({ cwd, config: { baseUrl: url, model: 'm' } });
  const ends = [];
  agent.on('event', (e) => e.type === 'action_start' && ends.push(e));
  agent.config.maxSteps = 1;
  await agent.send('list files');
  server.close();
  assert.equal(ends[0]?.tool, 'list');
  assert.match(agent.messages[1].content, /^<list path="\." \/>$/);
});

test("Gemma's raw native arguments (unquoted keys, <|\"|> delimiters) are understood", () => {
  const one = (t) => parseActions(t).actions.map((a) => [a.tool, a.args]);
  assert.deepEqual(one('<|tool_call>call:run{command:"ls -la src"}<tool_call|>'), [['run', { command: 'ls -la src' }]]);
  assert.deepEqual(one('<|tool_call>call:write{path:<|"|>a.py<|"|>,content:<|"|>x = "1"\nprint(x)<|"|>}<tool_call|>'), [['write', { path: 'a.py', content: 'x = "1"\nprint(x)' }]]);
});

test('tool schemas follow the toggles', async () => {
  const { toolSchemas } = await import('../src/agent/protocol.js');
  const names = (c) => toolSchemas(c).map((t) => t.function.name);
  assert.deepEqual(names({}), ['list', 'read', 'search', 'write', 'edit', 'run', 'web_search', 'fetch']);
  assert.deepEqual(names({ shellEnabled: false, webEnabled: false }), ['list', 'read', 'search', 'write', 'edit']);
});

test('tools are declared only to LM Studio models with tool_use, and native calls show progress', async () => {
  for (const [model, expectTools] of [['gemma', true], ['qwen', false]]) {
    const bodies = [];
    const { server, url } = await serve((req, res, body) => {
      if (req.url === '/api/v0/models') return res.end(JSON.stringify({ data: [{ id: 'gemma', state: 'loaded', capabilities: ['tool_use'] }, { id: 'qwen', state: 'loaded' }] }));
      if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
      bodies.push(JSON.parse(body));
      const chunks = bodies.length === 1
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'list', arguments: '{"path"' } }] } }] },
           { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "."}' } }] } }] },
           { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]
        : [{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }];
      res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-native-'));
    const agent = new Agent({ cwd, config: { provider: 'openai', baseUrl: `${url}/v1`, model, shellEnabled: false } });
    const deltas = [];
    const actions = [];
    agent.on('event', (e) => { if (e.type === 'delta') deltas.push(e.kind); if (e.type === 'action_start') actions.push(e.tool); });
    await agent.send('list');
    server.close();
    assert.equal(Boolean(bodies[0].tools), expectTools, model);
    if (expectTools) {
      assert.deepEqual(bodies[0].tools.map((t) => t.function.name), ['list', 'read', 'search', 'write', 'edit', 'web_search', 'fetch']);
      assert.ok(deltas.includes('tool'), 'progress shown while the native call streams');
    }
    assert.deepEqual(actions, ['list']);
  }
});

// Regression: Gemma opening native calls with our attribute syntax and never closing them.
test('unclosed native calls (attribute or brace form) are understood, incomplete ones are not', () => {
  const acts = (t, final = true) => parseActions(t, { final }).actions.map((a) => [a.tool, a.args]);
  assert.deepEqual(
    acts('<|tool_call>call:read path="deploy/core_logic/da_layer/storage_manager.py" /><|tool_call>call:read path="deploy/core_logic/audit_agent/audit_agent.py" />'),
    [['read', { path: 'deploy/core_logic/da_layer/storage_manager.py' }], ['read', { path: 'deploy/core_logic/audit_agent/audit_agent.py' }]],
  );
  assert.deepEqual(acts('<|tool_call>call:run{command:<|"|>ls -la<|"|>}'), [['run', { command: 'ls -la' }]]);
  assert.deepEqual(acts('<|tool_call>call:write{path:<|"|>a.py<|"|>,content:<|"|>d = {1: 2}<|"|>}'), [['write', { path: 'a.py', content: 'd = {1: 2}' }]]);
  assert.deepEqual(acts('<|tool_call>call:read path="a.py" /><tool_call|>'), [['read', { path: 'a.py' }]]);
  assert.deepEqual(acts('<|tool_call>call:run{command:<|"|>ls', false), [], 'still streaming');
});
