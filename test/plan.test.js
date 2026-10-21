import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { parsePlan, mergePlan, tasksToDelegate, setStatus, planReminder, subAgentTask } from '../src/agent/plan.js';
import { normalizeToolCalls } from '../src/agent/protocol.js';

test('a plan is parsed from checklists, plain lists and @agent marks', () => {
  assert.deepEqual(parsePlan('Plan:\n- [x] Read the code\n- [ ] @agent Write docs (files: a.py)\n2. Fix the bug\n* [ ] (agent) Add tests\n'), [
    { text: 'Read the code', done: true, agent: false },
    { text: 'Write docs (files: a.py)', done: false, agent: true },
    { text: 'Fix the bug', done: false, agent: false },
    { text: 'Add tests', done: false, agent: true },
  ]);
});

test('a delegated task is never started twice; checking it off marks it done', () => {
  let plan = mergePlan(null, parsePlan('- [ ] @agent Docs\n- [ ] Fix'));
  const [docs] = tasksToDelegate(plan);
  setStatus(plan, docs, 'failed');
  plan = mergePlan(plan, parsePlan('- [ ] @agent Docs.\n- [ ] Fix')); // rewritten, still unchecked
  assert.deepEqual(tasksToDelegate(plan), []);
  assert.equal(plan.tasks[0].status, 'failed');
  assert.match(planReminder(plan), /0\/2 done\. Next: Docs\. \[failed/);
  plan = mergePlan(plan, parsePlan('- [x] Docs\n- [ ] Fix')); // done by the main agent itself
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(planReminder(plan), '(Plan: 1/2 done. Next: Fix)');
});

test('a sub-agent gets the request, the whole plan (its task marked) and its task', () => {
  const plan = mergePlan(null, parsePlan('- [x] Read\n- [ ] @agent Docs\n- [ ] Fix'));
  const t = subAgentTask(plan, plan.tasks[1], 'Document and fix the parser');
  assert.match(t, /The user's request:\nDocument and fix the parser/);
  assert.match(t, /- \[ \] @agent Docs   <- YOUR TASK/);
  assert.match(t, /- \[ \] Fix\n/);
  assert.match(t, /YOUR TASK: Docs$/);
});

test('Gemma native plan calls become a <plan> tag', () => {
  assert.equal(normalizeToolCalls('<|tool_call>call:plan{tasks:[{task:<|"|>Docs<|"|>,agent:true},{task:<|"|>Read<|"|>,done:true}]}<tool_call|>'),
    '<plan>\n- [ ] @agent Docs\n- [x] Read\n</plan>');
});

// Fake Ollama: replies chosen from the request (the sub-agent sees "YOUR TASK").
function fake(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      res.end(`${JSON.stringify({ message: { content: reply(r, requests.length) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${server.address().port}` })));
}

test('@agent tasks start in sub-agents with their context; the plan follows, and is recalled after each result', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  await fs.writeFile(path.join(cwd, 'a.txt'), 'x\n');
  let mainStep = 0;
  const f = await fake((r) => {
    const sys = r.messages[0].content;
    const last = r.messages.at(-1).content;
    if (/You are a sub-agent/.test(sys)) {
      return /<result/.test(last) ? 'Wrote docs.md.' : '<write path="docs.md">\n# Docs\n</write>';
    }
    mainStep++;
    if (mainStep === 1) return '<plan>\n- [ ] @agent Write docs.md\n- [ ] Read a.txt\n</plan>';
    if (mainStep === 2) return '<read path="a.txt" />';
    return 'All done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false } });
  const plans = [];
  agent.on('event', (e) => e.type === 'plan' && !e.agentId && plans.push(e.tasks.map((t) => t.status).join(',')));
  await agent.send('Document the project and read a.txt');
  f.server.close();
  assert.equal(await fs.readFile(path.join(cwd, 'docs.md'), 'utf8'), '# Docs\n');
  // The sub-agent got the request, the plan and its task.
  const subFirst = f.requests.find((r) => /You are a sub-agent/.test(r.messages[0].content));
  assert.match(subFirst.messages.at(-1).content, /Document the project and read a\.txt[\s\S]*<- YOUR TASK[\s\S]*YOUR TASK: Write docs\.md/);
  assert.deepEqual(plans, ['running,pending', 'done,pending']);
  // The main agent got the reports with the plan, then a one-line reminder after its next action.
  const mainReqs = f.requests.filter((r) => !/You are a sub-agent/.test(r.messages[0].content));
  assert.match(mainReqs[1].messages.at(-1).content, /<result tool="plan">[\s\S]*\[x\] @agent Write docs\.md[\s\S]*Sub-agent reports/);
  assert.match(mainReqs[2].messages.at(-1).content, /\(Plan: 1\/2 done\. Next: Read a\.txt\)$/);
  assert.equal(agent.taskPlan.tasks.length, 2);
});
