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
