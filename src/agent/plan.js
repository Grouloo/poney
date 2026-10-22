// The agent's plan (<plan>): the list of tasks of a request, each one carried out
// by a sub-agent. The model only writes the list; a task is done when its
// sub-agent stops (the model never has to keep its list up to date, which small
// models fail at). Tasks run in order; consecutive tasks marked @parallel run at
// the same time.
//
//   <plan>
//   - Read the parser and list its edge cases
//   - @parallel Write docs/parser.md (files: parser.py)
//   - @parallel Add tests for the edge cases (files: tests/test_parser.py)
//   - Fix the bugs the tests found
//   </plan>

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\[( |x|X|~|!|-)\]\s*(.+?)\s*$/;
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
// "@parallel" ("@agent", the mark of earlier versions, means the same).
const PARALLEL_RE = /^(?:@parallel\b|@agent\b|\((?:parallel|agent)\))\s*:?\s*/i;

/** Tasks written by the model: [{ text, done, parallel }]. */
export function parsePlan(body) {
  const tasks = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(CHECKBOX_RE) || line.match(ITEM_RE);
    if (!m) continue;
    const box = m.length === 3 ? m[1] : ' ';
    let text = (m.length === 3 ? m[2] : m[1]).trim();
    const parallel = PARALLEL_RE.test(text);
    if (parallel) text = text.replace(PARALLEL_RE, '').trim();
    if (text) tasks.push({ text, done: /x/i.test(box), parallel });
  }
  return tasks;
}

const key = (text) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.:;!]+$/, '').trim();

/**
 * The new plan, from the tasks the model just wrote and the previous plan: a task
 * already done keeps its result and is not run again. A task the model shows as
 * done ([x]) is taken as done.
 * plan = { tasks: [{ text, status: 'pending'|'running'|'done'|'failed', parallel, report }], done: { [key]: report } }
 */
export function mergePlan(prev, written) {
  const done = { ...(prev?.done || {}) };
  const tasks = written.map((t) => {
    const k = key(t.text);
    if (done[k] !== undefined) return { text: t.text, parallel: t.parallel, status: 'done', report: done[k] };
    return { text: t.text, parallel: t.parallel, status: t.done ? 'done' : 'pending', report: '' };
  });
  return { tasks, done };
}

/** The next tasks to run: the first pending one, with the @parallel ones right after it if it is one too. */
export function nextGroup(plan) {
  const i = plan.tasks.findIndex((t) => t.status === 'pending');
  if (i < 0) return [];
  const group = [plan.tasks[i]];
  if (plan.tasks[i].parallel) {
    for (let j = i + 1; j < plan.tasks.length && plan.tasks[j].parallel && plan.tasks[j].status === 'pending'; j++) group.push(plan.tasks[j]);
  }
  return group;
}

export function setStatus(plan, task, status, report = '') {
  task.status = status;
  if (report) task.report = report;
  if (status === 'done') plan.done[key(task.text)] = task.report || '';
}

const BOX = { pending: '[ ]', running: '[~]', done: '[x]', failed: '[!]' };

/** The plan as shown to the model ([!]: its sub-agent failed). */
export function formatPlan(plan, mark = null) {
  return plan.tasks.map((t) => `- ${BOX[t.status]} ${t.parallel ? '@parallel ' : ''}${t.text}${t === mark ? '   <- YOUR TASK' : ''}`).join('\n');
}

/**
 * What a sub-agent gets: the request, the whole plan (its task marked), the
 * reports of the tasks already done (it may build on them), its task.
 */
export function subAgentTask(plan, task, request) {
  const req = String(request || '').trim();
  const before = plan.tasks.filter((t) => t.status === 'done' && t.report);
  return [
    'You are one of several agents carrying out a plan, one task each. Do ONLY your task; the others are done by other agents.',
    req ? `\nThe user's request:\n${req.length > 3000 ? `${req.slice(0, 3000)}…` : req}` : '',
    `\nThe plan:\n${formatPlan(plan, task)}`,
    before.length ? `\nReports of the tasks already done:\n${before.map((t) => `- ${t.text}: ${t.report.length > 800 ? `${t.report.slice(0, 800)}…` : t.report}`).join('\n')}` : '',
    `\nYOUR TASK: ${task.text}`,
  ].join('\n');
}
