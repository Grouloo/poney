import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { parsePlan, mergePlan, nextGroup, setStatus, subAgentTask } from '../src/agent/plan.js';
import { normalizeToolCalls } from '../src/agent/protocol.js';

test('a plan is parsed from lists, checkboxes and @parallel marks (@agent of earlier versions too)', () => {
  assert.deepEqual(parsePlan('Plan:\n- Read the code\n- [x] Done already\n2. @parallel Write docs\n* (agent) Add tests\n'), [
    { text: 'Read the code', done: false, parallel: false },
    { text: 'Done already', done: true, parallel: false },
    { text: 'Write docs', done: false, parallel: true },
    { text: 'Add tests', done: false, parallel: true },
  ]);
});

test('tasks run in order, consecutive @parallel ones together; a done task is never run again', () => {
  let plan = mergePlan(null, parsePlan('- A\n- @parallel B\n- @parallel C\n- D'));
  assert.deepEqual(nextGroup(plan).map((t) => t.text), ['A']);
  setStatus(plan, plan.tasks[0], 'done', 'A done');
  assert.deepEqual(nextGroup(plan).map((t) => t.text), ['B', 'C']);
  plan = mergePlan(plan, parsePlan('- A.\n- New task'));
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(plan.tasks[0].report, 'A done');
  assert.deepEqual(nextGroup(plan).map((t) => t.text), ['New task']);
});

test('a sub-agent gets the request, the plan with its task marked, and the reports of the tasks done', () => {
  const plan = mergePlan(null, parsePlan('- Read\n- Docs\n- Fix'));
  setStatus(plan, plan.tasks[0], 'done', 'The parser is in parser.py');
  const t = subAgentTask(plan, plan.tasks[1], 'Document and fix the parser');
  assert.match(t, /The user's request:\nDocument and fix the parser/);
  assert.match(t, /- \[ \] Docs {3}<- YOUR TASK/);
  assert.match(t, /Reports of the tasks already done:\n- Read: The parser is in parser\.py/);
  assert.match(t, /YOUR TASK: Docs$/);
});

test('Gemma native plan calls become a <plan> tag', () => {
  assert.equal(normalizeToolCalls('<|tool_call>call:plan{tasks:[{task:<|"|>Docs<|"|>,parallel:true},{task:<|"|>Read<|"|>}]}<tool_call|>'),
    '<plan>\n- @parallel Docs\n- Read\n</plan>');
});

// Fake Ollama: the reply chosen from the request (a sub-agent sees "YOUR TASK: …").
function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      res.end(`${JSON.stringify({ message: { content: reply(r) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}` })));
}
const taskOf = (r) => (r.messages.find((m) => m.role === 'user' && /YOUR TASK: /.test(m.content))?.content.match(/YOUR TASK: (.+)$/) || [])[1];
const isSub = (r) => /You are a sub-agent/.test(r.messages[0].content);

test('every task is done by a sub-agent, in order; done when it stops; the model only writes the list', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  let main = 0;
  const f = await fake((r) => {
    if (isSub(r)) {
      const task = taskOf(r);
      if (/<result/.test(r.messages.at(-1).content)) return `Did: ${task}.`;
      return `<write path="${task.split(' ')[1]}.md">\n${task}\n</write>`;
    }
    main++;
    return main === 1 ? '<plan>\n- Write a\n- @parallel Write b\n- @parallel Write c\n</plan>' : 'All three files are written.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false } });
  const plans = [];
  const notices = [];
  agent.on('event', (e) => {
    if (e.type === 'plan' && !e.agentId) plans.push(e.tasks.map((t) => t.status).join(','));
    if (e.type === 'notice') notices.push(e.text);
  });
  try {
    await agent.send('write a, b and c');
  } finally {
    f.server.close();
  }
  for (const x of ['a', 'b', 'c']) assert.equal(await fs.readFile(path.join(cwd, `${x}.md`), 'utf8'), `Write ${x}\n`);
  assert.deepEqual(plans, ['pending,pending,pending', 'running,pending,pending', 'done,pending,pending', 'done,running,running', 'done,done,done']);
  // Later tasks see the report of the first one.
  assert.match(f.requests.find((r) => taskOf(r) === 'Write b').messages.at(-1).content, /Reports of the tasks already done:\n- Write a: Did: Write a\./);
  // The model gets the reports, without having checked anything off, and is never sent back to its list.
  const second = f.requests.filter((r) => !isSub(r))[1];
  assert.match(second.messages.at(-1).content, /<result tool="plan">[\s\S]*Reports:\nWrite a:\nDid: Write a\.[\s\S]*All the tasks are done/);
  assert.equal(notices.filter((n) => /Plan inachevé/.test(n)).length, 0);
});

test('a failed task stops the plan; a new plan runs only what is left', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  let main = 0;
  let broken = true;
  const runs = {};
  const f = await fake((r) => {
    if (isSub(r)) {
      const task = taskOf(r);
      if (!/<result/.test(r.messages.at(-1).content) && r.messages.filter((m) => m.role === 'assistant').length === 0) runs[task] = (runs[task] || 0) + 1;
      if (task === 'Step two' && broken) return ''; // nothing comes out: the sub-agent gives up
      return `Did ${task}.`;
    }
    main++;
    if (main === 1) return '<plan>\n- Step one\n- Step two\n- Step three\n</plan>';
    if (main === 2) { broken = false; return '<plan>\n- Step one\n- Step two\n- Step three\n</plan>'; }
    return 'Done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false } });
  try {
    await agent.send('do the three steps');
  } finally {
    f.server.close();
  }
  const mains = f.requests.filter((r) => !isSub(r));
  assert.match(mains[1].messages.at(-1).content, /\[FAILED\] Step two[\s\S]*A task failed, the plan stopped there \(2 task\(s\) not done\)/);
  assert.deepEqual(runs, { 'Step one': 1, 'Step two': 2, 'Step three': 1 });
  assert.deepEqual(agent.taskPlan.tasks.map((t) => t.status), ['done', 'done', 'done']);
});

test('with parallel sub-agents switched off, @parallel tasks run one at a time, and the prompt does not offer them', async () => {
  const { buildSystemPrompt } = await import('../src/agent/protocol.js');
  assert.match(buildSystemPrompt({ cwd: '/p', platform: 'x', subagents: true }), /@parallel/);
  const seq = buildSystemPrompt({ cwd: '/p', platform: 'x', subagents: true, parallel: false });
  assert.doesNotMatch(seq, /@parallel/);
  assert.match(seq, /one at a time/);

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  let live = 0;
  let most = 0;
  let main = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const r = JSON.parse(body);
      requests.push(r);
      let content;
      if (isSub(r)) {
        live++;
        most = Math.max(most, live);
        await new Promise((ok) => setTimeout(ok, 150));
        live--;
        content = `Did ${taskOf(r)}.`;
      } else content = ++main === 1 ? '<plan>\n- @parallel A\n- @parallel B\n- @parallel C\n</plan>' : 'Done.';
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', parallelAgents: false, shellEnabled: false } });
  const plans = [];
  agent.on('event', (e) => e.type === 'plan' && !e.agentId && plans.push(e.tasks.map((t) => t.status).join(',')));
  try {
    await agent.send('do A, B and C');
  } finally {
    server.close();
  }
  assert.equal(most, 1);
  assert.ok(plans.includes('done,running,pending'));
});
