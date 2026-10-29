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
  assert.deepEqual(parseTriage('```json\n{"known": ["Node 24"], "doubts": [], "unknowns": []}\n```'), { known: [{ point: 'Node 24', why: '' }], doubts: [], unknowns: [], route: 'direct' });
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

test('the assessment grades the facts the answer relies on; restating the request is not one', () => {
  const t = parseTriage(JSON.stringify({ claims: [
    { point: 'The user wants an explanation of the exclusion principle', why: 'from the message', status: 'known' },
    { point: 'No two identical fermions share a quantum state', why: 'textbook physics', status: 'known' },
    { point: 'Its derivation from the spin-statistics theorem', why: 'remembered only roughly', status: 'doubt' },
    { point: 'Who first measured it', why: 'never learned', status: 'Unknown' },
    { point: 'A fact without a grade', why: '' },
  ] }));
  assert.deepEqual(t.known, [{ point: 'No two identical fermions share a quantum state', why: 'textbook physics' }]);
  assert.deepEqual(t.doubts.map((x) => x.point), ['Its derivation from the spin-statistics theorem', 'A fact without a grade']);
  assert.deepEqual(t.unknowns.map((x) => x.point), ['Who first measured it']);
  assert.equal(t.route, 'investigate');
  assert.match(triageBlock(t), /You know:\n- No two identical fermions share a quantum state \(textbook physics\)/);
  // Only the request restated: nothing was weighed, so nothing can be read (asked again).
  assert.equal(parseTriage('{"claims": [{"point": "The user wants an explanation of X", "why": "asked", "status": "known"}]}'), null);
  assert.equal(parseTriage('{"claims": []}').route, 'direct'); // a greeting
});

test('the request restated: the assessment is asked again', async () => {
  let tries = 0;
  const f = await fake((r) => {
    if (!isTriage(r)) return 'Answer.';
    return ++tries === 1
      ? '{"claims": [{"point": "The user wants an explanation of Pauli\'s exclusion principle", "why": "the message", "status": "known"}]}'
      : '{"claims": [{"point": "No two electrons share all four quantum numbers", "why": "textbook physics", "status": "known"}]}';
  });
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send("Explain me Pauli's exclusion principle");
  } finally {
    f.server.close();
  }
  assert.equal(f.requests.filter(isTriage).length, 2);
  assert.deepEqual(f.requests[0].format.properties.claims.items.required, ['point', 'why', 'status']);
  const t = events.find((e) => e.type === 'triage');
  assert.deepEqual([t.route, t.known.map((x) => x.point)], ['direct', ['No two electrons share all four quantum numbers']]);
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
  assert.match(lastUser(asks[1]), /could not be used: it was not this JSON, or it only restated the request/);
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

test('search snippets are not pages read: a doubt needs a fetched page; from the web, pages are cited', async () => {
  const { triageUpdateInstruction } = await import('../src/agent/triage.js');
  assert.match(triageUpdateInstruction('task'), /only a snippet gives is a "doubt" until a page you fetched confirms it/);
  const t = { known: [], doubts: [{ point: 'the date', why: 'a snippet' }], unknowns: [], route: 'check' };
  assert.match(triageBlock(t, { update: true, web: true }), /end with the pages you rely on \(their URL\)/);
  assert.doesNotMatch(triageBlock(t, { update: true }), /their URL/);

  let step = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/search')) { res.end(JSON.stringify({ results: [{ title: 'News', url: `${base}/page`, content: 'Protests on Oct 17' }] })); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'text/html'); res.end('<html><body><p>Protests began on October 17.</p></body></html>'); return; }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      let out;
      if (isTriage(r)) out = '{"claims": [{"point": "the date of the protests", "why": "recent news", "status": "doubt"}]}';
      else {
        step++;
        out = step === 1 ? '<web_search>France protests</web_search>' : step === 2 ? 'They began on October 17.' : step === 3 ? `<fetch>${base}/page</fetch>` : `They began on October 17.\nSource: ${base}/page`;
      }
      res.end(`${JSON.stringify({ message: { content: out }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  const base = `http://localhost:${server.address().port}`;
  const agent = new Agent({ cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-triage-')), triage: true, config: { baseUrl: base, model: 'm', shellEnabled: false, webEnabled: true, searxngUrl: base } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('When did the protests in France begin?');
  } finally {
    server.close();
  }
  assert.ok(requests.some((r) => /<result tool="web_search"[\s\S]*Sources read this turn: 0\/1/.test(lastUser(r))), 'the search does not count');
  const refusal = requests.find((r) => /^Not yet/.test(lastUser(r)));
  assert.match(lastUser(refusal), /<fetch> a page found with <web_search>: its snippets do not count/);
  assert.equal(events.filter((e) => e.type === 'notice' && /refusée/.test(e.text)).length, 1);
  assert.ok(requests.some((r) => /<result tool="fetch"[\s\S]*October 17[\s\S]*/.test(lastUser(r)) && !/Sources read this turn/.test(lastUser(r))), 'the page counts');
  assert.match(events.filter((e) => e.type === 'final').at(-1).text, /Source: http/);
});
