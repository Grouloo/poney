import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { parseQuestions, cleanAnswers } from '../src/agent/ask.ts';
import { parseActions } from '../src/agent/protocol.ts';
import { parseTriage, triageBlock } from '../src/agent/triage.ts';
import { cfg, port } from './helpers.ts';
import type { Fake, ModelRequest, Reply } from './helpers.ts';
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, EventOf } from '../src/types.ts';

function fake(reply: Reply<string>) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body) as ModelRequest;
      requests.push(r);
      res.end(`${JSON.stringify({ message: { content: reply(r, requests.length) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise<Fake>((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${port(server)}` })));
}

const ASK = '<ask>\n? Which database should I use?\n- PostgreSQL\n- SQLite\n? Which features do you want? @multiple\n- login\n- export\n? Anything else?\n</ask>';

test('the questionnaire is read from its tag, loosely written ones too', () => {
  assert.deepEqual(parseQuestions(ASK.replace(/<\/?ask>/g, '')), [
    { question: 'Which database should I use?', options: ['PostgreSQL', 'SQLite'], multiple: false },
    { question: 'Which features do you want?', options: ['login', 'export'], multiple: true },
    { question: 'Anything else?', options: [], multiple: false },
  ]);
  // Numbered questions, lettered answers, a marker in parentheses.
  assert.deepEqual(parseQuestions('1. Which port? (multiple choice)\na) 3000\nb) 8080\n2. Which host?\n* localhost'), [
    { question: 'Which port?', options: ['3000', '8080'], multiple: true },
    { question: 'Which host?', options: ['localhost'], multiple: false },
  ]);
  assert.deepEqual(parseQuestions('just some text'), []);
  // Native calls become the same tag.
  const [a] = parseActions('<tool_call>{"name": "ask_user", "arguments": {"questions": [{"question": "Which OS?", "options": ["macOS", "Linux"], "multiple": true}]}}</tool_call>').actions;
  assert.equal(a.tool, 'ask');
  assert.deepEqual(parseQuestions(a.args.body), [{ question: 'Which OS?', options: ['macOS', 'Linux'], multiple: true }]);
});

test('answers are kept only among the proposed ones, one for a single choice', () => {
  const qs = parseQuestions(ASK);
  assert.deepEqual(cleanAnswers(qs, [{ choices: ['SQLite', 'PostgreSQL'] }, { choices: ['login', 'export', 'hack'], other: ' and admin ' }, 'bad']), [
    { choices: ['SQLite'], other: '' },
    { choices: ['login', 'export'], other: 'and admin' },
    { choices: [], other: '' },
  ]);
});

async function run(answer: ApprovalAnswer, replies: string[] = [ASK, 'Done.']) {
  const f = await fake((_, n) => replies[n - 1] ?? 'Done.');
  const asked: ApprovalRequest[] = [];
  const agent = new Agent({
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ask-')),
    config: cfg({ baseUrl: f.url, model: 'm', approval: 'auto' }),
    approve: async (req) => { asked.push(req); return answer; },
  });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('set up the app');
  } finally {
    f.server.close();
  }
  return { f, asked, events };
}

test('the questionnaire waits for the user like an approval (even in auto), and gives their answers', async () => {
  const { f, asked, events } = await run({ ok: true, answers: [{ choices: ['SQLite'], other: '' }, { choices: ['export'], other: 'CSV only' }, { choices: [], other: '' }] });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, 'ask');
  assert.equal(asked[0].questions?.length, 3);
  const result = f.requests[1].messages.at(-1)!.content;
  assert.match(result, /The user answered[^\n]*:\n1\. Which database should I use\?\n→ SQLite\n2\. Which features do you want\?\n→ export; "CSV only"\n3\. Anything else\?\n→ \(no answer\)/);
  const end = events.find((e): e is EventOf<'action_end'> => e.type === 'action_end')!;
  assert.equal(end.ok, true);
  assert.match(end.output, /→ export; "CSV only"/);
  // (kept on the card: resuming from it starts from these answers)
  assert.deepEqual(end.meta?.answers, [{ choices: ['SQLite'], other: '' }, { choices: ['export'], other: 'CSV only' }, { choices: [], other: '' }]);
});

test('a questionnaire closed unanswered tells the model so', async () => {
  const { f, events } = await run(false);
  assert.match(f.requests[1].messages.at(-1)!.content, /closed the questionnaire without answering/);
  assert.equal(events.find((e): e is EventOf<'action_end'> => e.type === 'action_end')!.output, 'Questionnaire fermé sans réponse.');
  assert.equal(events.find((e): e is EventOf<'action_end'> => e.type === 'action_end')!.meta?.answers, undefined);
});

test('an empty questionnaire is not shown: the model is told the format', async () => {
  const { f, asked } = await run(true, ['<ask>tell me more</ask>', 'Done.']);
  assert.equal(asked.length, 0);
  assert.match(f.requests[1].messages.at(-1)!.content, /No question found\. Write each question on a line starting with "\?"/);
});

test('the assessment lists what to ask the user, and the app recalls the questionnaire', async () => {
  const t = parseTriage(JSON.stringify({ claims: [{ point: 'Node 24 runs .ts files', why: 'read here', status: 'known' }], questions: ['Which database to use', 'none'] }))!;
  assert.deepEqual(t.questions, ['Which database to use']);
  assert.equal(t.route, 'direct');
  assert.match(triageBlock(t), /To ask the user:\n- Which database to use\nAsk them with <ask>/);
  assert.doesNotMatch(triageBlock(t, { ask: false }), /To ask the user/); // (a sub-agent cannot)
  assert.deepEqual(parseTriage('{"claims": []}')!.questions, []);

  // Asked in prose although the assessment said so: once, the questionnaire instead.
  const f = await fake((r, n) => {
    const last = r.messages.at(-1)!.content;
    if (/honest assessment/.test(last)) return JSON.stringify({ claims: [], questions: ['Which database to use'] });
    if (/Your answer asks them in prose/.test(last)) return ASK;
    return n === 2 ? 'Which database do you want, PostgreSQL or SQLite?' : 'Done.';
  });
  const asked: ApprovalRequest[] = [];
  const agent = new Agent({
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ask-')),
    triage: true,
    config: cfg({ baseUrl: f.url, model: 'm', shellEnabled: false }),
    approve: async (req) => { asked.push(req); return { ok: true, answers: [{ choices: ['SQLite'], other: '' }] }; },
  });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  try {
    await agent.send('set up a database');
  } finally {
    f.server.close();
  }
  assert.match(f.requests[1].messages.at(-1)!.content, /To ask the user:\n- Which database to use\nAsk them with <ask>/);
  assert.equal(events.filter((e) => e.type === 'notice' && /questionnaire/.test(e.text)).length, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'final').map((e) => e.text), ['Done.']);
});
