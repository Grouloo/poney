import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { parseTriage, triageBlock, triageReminder } from '../src/agent/triage.js';

function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      const out = reply(r, requests.length);
      if (out?.status) { res.writeHead(out.status); res.end(out.body); return; }
      res.end(`${JSON.stringify({ message: { content: out }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}` })));
}

const isTriage = (r) => /honest assessment/.test(r.messages.at(-1).content);
const lastUser = (r) => r.messages.at(-1).content;

test('the assessment is read from JSON (in a fence, in prose, cut) and gives the route', () => {
  assert.deepEqual(parseTriage('```json\n{"known": ["Node 24"], "doubts": [], "unknowns": []}\n```'), { known: ['Node 24'], doubts: [], unknowns: [], route: 'direct' });
  const t = parseTriage('Here: {"known": [], "doubts": [{"point": "the test command", "why": "not read"}], "unknowns": []} done');
  assert.equal(t.route, 'check');
  assert.deepEqual(t.doubts, [{ point: 'the test command', why: 'not read' }]);
  assert.equal(parseTriage('{"known": [], "doubts": [], "unknowns": ["the latest version"]}').route, 'investigate');
  assert.equal(parseTriage('no json at all'), null);
  assert.equal(parseTriage('{"known": ["a"], "doubts": [{"point": "b"'), null); // cut: unreadable
  assert.match(triageBlock(t), /You doubt:\n- the test command \(not read\)\nRoute set by the app: Check your doubts/);
  assert.equal(triageReminder(t, 1), '');
  assert.match(triageReminder(t, 0), /still to check: the test command\. Sources read this turn: 0\/1/);
});

test('something unknown: the final answer is refused until several sources are read', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'beta');
  let reads = 0;
  const f = await fake((r) => {
    if (isTriage(r)) return JSON.stringify({ known: [], doubts: [], unknowns: [{ point: 'what a.txt and b.txt hold', why: 'never read' }] });
    if (/Not yet: in your assessment/.test(lastUser(r))) return '<read path="a.txt" />';
    if (/<result/.test(lastUser(r)) && reads++ === 0) return '<read path="b.txt" />';
    return 'They hold alpha and beta.';
  });
  const agent = new Agent({ cwd, triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('What do a.txt and b.txt hold?');
  } finally {
    f.server.close();
  }
  const triageReq = f.requests[0];
  assert.ok(isTriage(triageReq));
  assert.equal(triageReq.format?.type, 'object'); // structured output asked for
  // The turn's message carries the assessment and the route.
  assert.match(f.requests[1].messages.at(-1).content, /You do not know:\n- what a\.txt and b\.txt hold \(never read\)\nRoute set by the app: Read at least 2 sources/);
  const triage = events.find((e) => e.type === 'triage');
  assert.equal(triage.route, 'investigate');
  assert.ok(events.some((e) => e.type === 'notice' && /Réponse finale refusée/.test(e.text)));
  // The reminder goes with the results until two sources were read.
  assert.ok(f.requests.some((r) => /Sources read this turn: 1\/2/.test(lastUser(r))));
  assert.ok(!f.requests.some((r) => /Sources read this turn: 2\/2/.test(lastUser(r))));
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['They hold alpha and beta.']);
});

test('nothing lacking: no lookup asked, the answer goes through; turned off, no assessment call', async () => {
  const f = await fake((r) => (isTriage(r) ? '{"known": ["a greeting"], "doubts": [], "unknowns": []}' : 'Hello!'));
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const finals = [];
  agent.on('event', (e) => e.type === 'final' && finals.push(e.text));
  try {
    await agent.send('hi');
    assert.equal(f.requests.length, 2);
    assert.match(lastUser(f.requests[1]), /Route set by the app: Nothing you lack/);
    agent.steps = { before: '', after: '', afterOnlyIfChanged: false, triage: false };
    await agent.send('hi again');
    assert.equal(f.requests.length, 3);
    assert.ok(!isTriage(f.requests[2]));
  } finally {
    f.server.close();
  }
  assert.deepEqual(finals, ['Hello!', 'Hello!']);
});

test('a server without structured output: the assessment is asked again without it', async () => {
  const f = await fake((r) => {
    if (isTriage(r)) return r.format ? { status: 400, body: 'format not supported' } : 'Sure: {"known": [], "doubts": [{"point": "the API", "why": "it changes"}], "unknowns": []}';
    return /Not yet/.test(lastUser(r)) ? 'I could not check it: no source available. Here is my best answer.' : 'Answer from memory.';
  });
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('How does the API work?');
  } finally {
    f.server.close();
  }
  assert.ok(f.requests[0].format && !f.requests[1].format);
  assert.equal(events.find((e) => e.type === 'triage').route, 'check');
  // A doubt: refused once, then let through.
  assert.equal(events.filter((e) => e.type === 'notice' && /refusée/.test(e.text)).length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['I could not check it: no source available. Here is my best answer.']);
});

const isUpdate = (r) => /update your assessment/.test(r.messages.at(-1).content);
const LONG = `node -e "console.log('data '.repeat(100))"`; // an output long enough to reassess

test('outside results update the assessment, about the current task, and the new route applies', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'beta');
  let step = 0;
  const f = await fake((r) => {
    if (isTriage(r)) return '{"known": ["how to run the tool"], "doubts": [], "unknowns": []}';
    if (isUpdate(r)) return '{"known": ["the tool prints data"], "doubts": [], "unknowns": [{"point": "the format of a.txt and b.txt", "why": "the output refers to them"}]}';
    step++;
    if (step === 1) return `<run>${LONG}</run>`;
    if (step === 2) return 'Done, here it is.'; // refused: the update found something unknown
    if (step === 3) return '<read path="a.txt" />';
    if (step === 4) return '<read path="b.txt" />';
    return 'Done: alpha and beta.';
  });
  const agent = new Agent({ cwd, triage: true, config: { baseUrl: f.url, model: 'm', approval: 'auto' } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('Run the tool and tell me about its files');
  } finally {
    f.server.close();
  }
  const upd = f.requests.find(isUpdate);
  assert.match(lastUser(upd), /<result tool="run"[\s\S]*data data[\s\S]*Your current task: [^\n]*Run the tool and tell me about its files[\s\S]*Only what matters for YOUR CURRENT TASK/);
  // The update goes with the results, and replaces the first assessment.
  const after = f.requests[f.requests.indexOf(upd) + 1];
  assert.match(lastUser(after), /<result tool="run"[\s\S]*updated from these results[\s\S]*You do not know:\n- the format of a\.txt and b\.txt[\s\S]*Read at least 2 sources/);
  assert.deepEqual(events.filter((e) => e.type === 'triage').map((e) => [Boolean(e.update), e.route]), [[false, 'direct'], [true, 'investigate']]);
  // The run that triggered the update does not count for it: two reads after it are needed.
  assert.equal(events.filter((e) => e.type === 'notice' && /refusée/.test(e.text)).length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['Done: alpha and beta.']);
});

test('updates are capped per answer, and short outputs do not call for one', async () => {
  let step = 0;
  const f = await fake((r) => {
    if (isTriage(r) || isUpdate(r)) return '{"known": [], "doubts": [], "unknowns": []}';
    step++;
    if (step === 1) return '<run>echo ok</run>';
    if (step <= 6) return `<run>${LONG}</run>`;
    return 'Done.';
  });
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: f.url, model: 'm', approval: 'auto' } });
  try {
    await agent.send('run things');
  } finally {
    f.server.close();
  }
  assert.equal(f.requests.filter(isUpdate).length, 3); // 5 long outputs, 3 updates at most
  assert.ok(!f.requests.some((r) => isUpdate(r) && /command="echo ok"/.test(lastUser(r)))); // "ok": nothing to reassess
});

test('sub-agents make their own assessment, with the same route and refusals', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'beta');
  const isSubReq = (r) => r.messages.some((m) => m.role === 'user' && /Find what a\.txt and b\.txt hold/.test(m.content) && !/<agent/.test(m.content));
  let main = 0;
  let sub = 0;
  const f = await fake((r) => {
    if (isSubReq(r)) {
      if (isTriage(r)) return '{"known": [], "doubts": [], "unknowns": [{"point": "the content of a.txt and b.txt", "why": "never read"}]}';
      sub++;
      if (sub === 1) return 'They hold text.';
      if (sub === 2) return '<read path="a.txt" />';
      if (sub === 3) return '<read path="b.txt" />';
      return 'alpha and beta';
    }
    if (isTriage(r)) return '{"known": ["a sub-agent can look"], "doubts": [], "unknowns": []}';
    return ++main === 1 ? '<agent title="look">\nFind what a.txt and b.txt hold\n</agent>' : 'They hold alpha and beta.';
  });
  const agent = new Agent({ cwd, triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('what is in a.txt and b.txt? use a sub-agent');
  } finally {
    f.server.close();
  }
  const subTriage = events.find((e) => e.type === 'triage' && e.agentId);
  assert.equal(subTriage?.route, 'investigate');
  assert.ok(events.some((e) => e.type === 'notice' && e.agentId && /refusée/.test(e.text)));
  assert.match(events.find((e) => e.type === 'action_end' && e.meta?.title === 'look').output, /alpha and beta/);
});

test('in a plan, the update names the sub-agent\'s own task, not the context it was given', async () => {
  const { triageUpdateInstruction } = await import('../src/agent/triage.js');
  const text = triageUpdateInstruction('You are one of several agents…\n\nThe plan:\n1. A\n2. B\n\nYOUR TASK: Write the docs');
  assert.match(text, /Your current task: Write the docs\n/);
});

test('an unreadable assessment is asked again (low temperature, then a little higher); given up after 3', async () => {
  let tries = 0;
  const f = await fake((r) => {
    if (isTriage(r)) return ++tries === 1 ? 'Sure! I know things about this.' : '{"known": [], "doubts": [{"point": "the API", "why": "it changes"}], "unknowns": []}';
    return 'Answer.';
  });
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('How does the API work?');
  } finally {
    f.server.close();
  }
  const asks = f.requests.filter(isTriage);
  assert.deepEqual(asks.map((r) => r.options.temperature), [0.1, 0.3]);
  assert.match(lastUser(asks[1]), /could not be read as this JSON/);
  assert.ok(events.some((e) => e.type === 'notice' && /Bilan illisible : nouvel essai \(2\/3\)/.test(e.text)));
  assert.equal(events.find((e) => e.type === 'triage').route, 'check');

  const g = await fake((r) => (isTriage(r) ? 'no json' : 'Answer.'));
  agent.config = { ...agent.config, baseUrl: g.url };
  events.length = 0;
  try {
    await agent.send('again');
  } finally {
    g.server.close();
  }
  assert.equal(g.requests.filter(isTriage).length, 3);
  assert.ok(events.find((e) => e.type === 'triage').failed);
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['Answer.']);
});
