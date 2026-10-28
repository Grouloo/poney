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
  assert.match(t, /The plan, already written \(do not write it again\):\n1\. Read {3}\(done\)\n2\. Docs {3}<- YOUR TASK\n3\. Fix$/m);
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
      if (r.messages.length === 2) runs[task] = (runs[task] || 0) + 1;
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

test('a sub-agent has no <plan>; one written anyway is not taken, and it is sent back to its task', async () => {
  const { buildSystemPrompt, toolSchemas } = await import('../src/agent/protocol.js');
  assert.doesNotMatch(buildSystemPrompt({ cwd: '/p', platform: 'x', subagentRole: true }), /<plan>/);
  assert.ok(!toolSchemas({}, { subagentRole: true }).some((t) => t.function.name === 'plan'));

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  let main = 0;
  let subPlans = 0;
  const f = await fake((r) => {
    if (isSub(r)) {
      const last = r.messages.at(-1).content;
      // The loop seen with Gemma: the sub-agent copies the plan of its task message.
      if (!/<result/.test(last)) { subPlans++; return '<plan>\n- Write a\n- Write b\n</plan>'; }
      const mine = last.match(/No <plan> here[\s\S]*ONE task: (Write [ab])/);
      if (mine) return `Did ${mine[1]}.`;
      subPlans++;
      return '<plan>\n- Write a\n- Write b\n</plan>';
    }
    return ++main === 1 ? '<plan>\n- Write a\n- Write b\n</plan>' : 'Done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', parallelAgents: false, shellEnabled: false } });
  try {
    await agent.send('write a and b');
  } finally {
    f.server.close();
  }
  assert.equal(subPlans, 2); // once per sub-agent, then back to work
  assert.deepEqual(agent.taskPlan.tasks.map((t) => t.status), ['done', 'done']);
});

test('sub-agents see what the main agent did in this turn before its plan', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'The parser lives in src/parse.js\n');
  let main = 0;
  const f = await fake((r) => {
    if (isSub(r)) return `Did ${taskOf(r)}.`;
    main++;
    if (main === 1) return '<read path="notes.txt" />';
    if (main === 2) return 'The parser is in src/parse.js.\n<plan>\n- Fix the parser\n</plan>';
    return 'Done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  try {
    await agent.send('fix the parser');
  } finally {
    f.server.close();
  }
  const task = f.requests.find(isSub).messages.at(-1).content;
  assert.match(task, /What the main agent did in this turn before the plan[^\n]*\nMAIN AGENT:\n<read path="notes.txt" \/>\n\n<result tool="read"[\s\S]*The parser lives in src\/parse\.js[\s\S]*\[end of the main agent's steps\]/);
  assert.doesNotMatch(task.split('[end of the main agent')[0], /<plan>/); // not the message with the plan itself
});

test('the digest of the turn keeps its latest steps when too long', async () => {
  const { turnDigest } = await import('../src/agent/plan.js');
  const d = turnDigest([1, 2, 3, 4].map((i) => ({ role: i % 2 ? 'assistant' : 'user', content: `step ${i} ${'x'.repeat(400)}` })), 900);
  assert.match(d, /^\[… 2 step\(s\) left out\]\n\nMAIN AGENT:\nstep 3[\s\S]*step 4/);
  assert.doesNotMatch(d, /step [12]/);
});

test('the digest keeps the steps of the sub-agent\'s task longer, drops unrelated ones first, and says where to read a cut', async () => {
  const { turnDigest } = await import('../src/agent/plan.js');
  const lines = (tag) => Array.from({ length: 120 }, (_, i) => `${tag} line ${i + 1} ${"·".repeat(14)}`).join('\n');
  const messages = [
    { role: 'assistant', content: '<read path="other.txt" />' },
    { role: 'user', content: `<result tool="read" path="other.txt">\n${lines('other')}\n</result>` },
    { role: 'assistant', content: '<read path="more.txt" />' },
    { role: 'user', content: `<result tool="read" path="more.txt">\n${lines('more')}\n</result>` },
    { role: 'assistant', content: '<read path="parser.js" />' },
    { role: 'user', content: `<result tool="read" path="parser.js">\n${lines('parser')}\n</result>` },
    { role: 'assistant', content: 'Now the plan.' },
  ];
  const outputs = new Map();
  const d = turnDigest(messages, { maxChars: 4000, task: 'Fix the bug in parser.js', outputs });
  // The step about parser.js is kept (cut in the middle, end included); the unrelated one goes first.
  assert.match(d, /^\[… 2 step\(s\) left out: <read path="@turn\/1" \/> to <read path="@turn\/2" \/> if you need them\]/);
  assert.match(d, /parser line 1 ·+\n[\s\S]*\[… \d+ characters cut \(lines (\d+)-(\d+)\): <read path="@turn\/6" start="\1" end="\2" \/> shows them\]\nparser line \d+[\s\S]*parser line 120 ·+\n<\/result>/);
  // The line numbers given are those of the full text.
  const [, before, from, to, after] = d.match(/\n([^\n]*)\n\[… \d+ characters cut \(lines (\d+)-(\d+)\): <read path="@turn\/6"[^\]]*\]\n([^\n]*)/);
  const full = outputs.get('@turn/6').split('\n');
  assert.match(d, /more line 1 /); // the later unrelated step is still there
  assert.equal(full[from - 2], before);
  assert.equal(full[to], after);
  assert.equal(outputs.get('@turn/2').length > 2000, true);
});

test('a sub-agent reads a cut part of the main agent\'s steps in full', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  await fs.writeFile(path.join(cwd, 'big.txt'), Array.from({ length: 150 }, (_, i) => (i === 74 ? 'SECRET-VALUE-42' : `filler line number ${i + 1} with some words`)).join('\n'));
  let main = 0;
  let subSaw = '';
  const f = await fake((r) => {
    if (isSub(r)) {
      const last = r.messages.at(-1).content;
      if (/<result tool="read" path="@turn\/2"/.test(last)) { subSaw = last; return 'Found it.'; }
      const cut = last.match(/<read path="@turn\/2" start="\d+" end="\d+" \/>/);
      return cut ? cut[0] : 'No cut seen.';
    }
    main++;
    if (main === 1) return '<read path="big.txt" />';
    if (main === 2) return '<plan>\n- Do the job\n</plan>';
    return 'Done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  try {
    await agent.send('do the job'); // (no word in common with the file: its step is cut short)
  } finally {
    f.server.close();
  }
  const task = f.requests.find(isSub).messages.at(-1).content;
  assert.doesNotMatch(task, /SECRET-VALUE-42/); // cut from the digest…
  assert.match(subSaw, /75\| SECRET-VALUE-42/); // …and read back in full by the sub-agent
});

test('a sub-agent sees what the earlier ones changed, even beyond their task, and is told not to redo it', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-plan-'));
  let main = 0;
  const f = await fake((r) => {
    if (isSub(r)) {
      const last = r.messages.at(-1).content;
      if (taskOf(r) === 'Write a' && !/<result/.test(last)) return '<write path="a.md">\nA\n</write>\n<write path="b.md">\nB\n</write>';
      return `Did ${taskOf(r)}.`;
    }
    return ++main === 1 ? '<plan>\n- Write a\n- Write b\n</plan>' : 'Done.';
  });
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false } });
  try {
    await agent.send('write a and b');
  } finally {
    f.server.close();
  }
  const second = f.requests.find((r) => isSub(r) && taskOf(r) === 'Write b').messages.at(-1).content;
  assert.match(second, /What the earlier agents changed \(files, commands\):\n- Write a: wrote a\.md; wrote b\.md/);
  assert.match(second, /if your task is already done, check that it works and report that, without redoing it/);
  const first = f.requests.find((r) => isSub(r) && taskOf(r) === 'Write a').messages.at(-1).content;
  assert.doesNotMatch(first, /earlier agents/);
});
