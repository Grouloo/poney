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

// A server that streams the given pieces, then either ends or stays silent (connection kept open).
async function streamer(firstReply, { silentAfter = false } = {}) {
  const http = await import('node:http');
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      if (++n === 1) {
        for (const p of firstReply) res.write(`${JSON.stringify({ message: p, done: false })}\n`);
        if (!silentAfter) res.end(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`);
      } else {
        res.end(`${JSON.stringify({ message: { content: 'Done.' }, done: true, done_reason: 'stop' })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, requests, url: `http://localhost:${server.address().port}` };
}

async function runAgent(reply, opts) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-stall-'));
  await fs.writeFile(path.join(cwd, 'main.py'), 'REAL = 1\n');
  const s = await streamer(reply, opts);
  const agent = new Agent({ cwd, config: { baseUrl: s.url, model: 'm', approval: 'auto' } });
  agent.stallMs = 300;
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go');
  s.server.closeAllConnections?.();
  s.server.close();
  return { events, cwd, actions: events.filter((e) => e.type === 'action_start').map((e) => e.tool), notices: events.filter((e) => e.type === 'notice').map((e) => e.text) };
}

// Regression: Gemma "calls" a tool at the end of its reasoning, then nothing comes out any more.
test('a call ending the reasoning followed by silence is run', async () => {
  const r = await runAgent([{ thinking: 'I need the file. ' }, { thinking: '<read path="main.py" />' }], { silentAfter: true });
  assert.deepEqual(r.actions, ['read']);
  assert.ok(r.notices.some((n) => /n’a plus rien produit/.test(n)));
});

test('a plan listing a command and going on is not cut', async () => {
  const r = await runAgent([{ thinking: 'Plan:\n1. <run>ls -la</run>' }, { thinking: ' to see the files\n2. then read the config.' }, { content: 'Here is my plan.' }]);
  assert.deepEqual(r.actions, []);
  assert.equal(r.events.find((e) => e.type === 'final')?.text, 'Here is my plan.');
});

test('an answer ending with a write followed by silence is run', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const r = await runAgent([{ content: '<write path="new.py">\nx = 2\n</write>' }], { silentAfter: true });
  assert.deepEqual(r.actions, ['write']);
  assert.equal(await fs.readFile(path.join(r.cwd, 'new.py'), 'utf8'), 'x = 2\n');
});

test('a call left at the end of the reasoning is not run when the model wrote a real answer', async () => {
  const r = await runAgent([{ thinking: 'Maybe later <run>ls</run>' }, { content: 'Voici une réponse complète. '.repeat(10) }]);
  assert.deepEqual(r.actions, []);
});

// Regression: Gemma reopening its reasoning channel while reasoning, over and over (a loop),
// and stray closing markers in the answer: both showed as raw text and fed the loop.
test('a reasoning channel reopened while reasoning is removed and reported; a stray close in the answer is dropped', () => {
  const split = makeChannelSplitter();
  const out = [];
  for (const p of ['<|channel>thought\nPlan A.<|channel>thought\nPlan A again.<|channel><|chan', 'nel>thought\nAgain.<channel|>Answer.<channel|> End.']) out.push(...split(p));
  out.push(...split('', true));
  assert.deepEqual(out.filter((c) => c.type === 'reopen').length, 2);
  assert.equal(out.filter((c) => c.type === 'thinking').map((c) => c.text).join(''), 'Plan A.Plan A again.Again.');
  assert.equal(out.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'Answer. End.');
});

test('a model restarting its reasoning three times is stopped; the reasoning is kept up to the first restart', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Agent } = await import('../src/agent/agent.js');
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-reopen-')), config: { model: 'm' } });
  let calls = 0;
  let restartsSent = 0;
  agent.streamChat = async function* () {
    if (++calls > 1) { yield { type: 'text', text: 'Done.' }; return; }
    yield { type: 'thinking', text: 'I will create the file. ' };
    for (let i = 0; i < 50; i++) { restartsSent++; yield { type: 'reopen' }; yield { type: 'thinking', text: 'I will create the file. ' }; }
  };
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('go');
  assert.equal(restartsSent, 3); // stopped at the third restart
  assert.equal(events.find((e) => e.type === 'assistant_end').thinking, 'I will create the file. ');
  assert.ok(events.some((e) => e.type === 'notice' && /en boucle/.test(e.text)));
});

test('leaked channel markers are removed from the history', async () => {
  const { stripChannelMarkers } = await import('../src/agent/protocol.js');
  assert.equal(stripChannelMarkers('Done.<channel|>\n\nNext.<|channel><|channel>thought\nAgain.'), 'Done.\n\nNext.Again.');
});
