// The agent's task list (<plan>): what is left to do, so that it does not
// restate its whole plan in its reasoning at every step. Tasks starting with
// "@agent" are independent: they are handed to sub-agents automatically.
//
//   <plan>
//   - [x] Read the parser and its tests
//   - [ ] @agent Write docs/parser.md (files: parser.py)
//   - [ ] Fix the bug found by the tests
//   </plan>

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\[( |x|X|~|!|-)\]\s*(.+?)\s*$/;
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const AGENT_RE = /^(?:@agent\b|\(agent\))\s*:?\s*/i;

/** Tasks written by the model: [{ text, done, agent }]. */
export function parsePlan(body) {
  const tasks = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(CHECKBOX_RE) || line.match(ITEM_RE);
    if (!m) continue;
    const box = m.length === 3 ? m[1] : ' ';
    let text = (m.length === 3 ? m[2] : m[1]).trim();
    const agent = AGENT_RE.test(text);
    if (agent) text = text.replace(AGENT_RE, '').trim();
    if (text) tasks.push({ text, done: /x/i.test(box), agent });
  }
  return tasks;
}

const key = (text) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.:;!]+$/, '').trim();

/**
 * The new plan, from the tasks the model just wrote and the previous plan: a task
 * already handed to a sub-agent keeps the sub-agent's status (it is never started
 * twice, even if the model still shows it unchecked).
 * plan = { tasks: [{ text, status: 'pending'|'running'|'done'|'failed', agent }], delegated: { [key]: status } }
 */
export function mergePlan(prev, written) {
  const delegated = { ...(prev?.delegated || {}) };
  const tasks = written.map((t) => {
    const d = delegated[key(t.text)];
    // Checked by the model: done (e.g. a failed delegated task it did itself).
    return { text: t.text, agent: t.agent, status: t.done ? 'done' : d && d !== 'pending' ? d : 'pending' };
  });
  return { tasks, delegated };
}

/** Tasks to start in sub-agents now. */
export const tasksToDelegate = (plan) => plan.tasks.filter((t) => t.agent && t.status === 'pending' && [undefined, 'pending'].includes(plan.delegated[key(t.text)]));

export function setStatus(plan, task, status) {
  task.status = status;
  if (task.agent) plan.delegated[key(task.text)] = status;
}

const BOX = { pending: '[ ]', running: '[~]', done: '[x]', failed: '[!]' };

/** The plan as the model writes it ([!]: a sub-agent failed). */
export function formatPlan(plan, mark = null) {
  return plan.tasks.map((t) => `- ${BOX[t.status]} ${t.agent ? '@agent ' : ''}${t.text}${t === mark ? '   <- YOUR TASK' : ''}`).join('\n');
}

/** One line after each result: where the plan stands, so it need not be restated. */
export function planReminder(plan) {
  if (!plan?.tasks.length) return '';
  const done = plan.tasks.filter((t) => t.status === 'done').length;
  const next = plan.tasks.find((t) => t.status === 'pending' || t.status === 'failed');
  if (!next) return `(Plan: all ${plan.tasks.length} tasks done.)`;
  return `(Plan: ${done}/${plan.tasks.length} done. Next: ${next.text}${next.status === 'failed' ? ' [failed, see its report]' : ''})`;
}

/** What a sub-agent gets: the request, the whole plan (who does what), its task. */
export function subAgentTask(plan, task, request) {
  const req = String(request || '').trim();
  return [
    'You are one of several agents working on the same request. Do ONLY your task; the other tasks of the plan are done by other agents.',
    req ? `\nThe user's request:\n${req.length > 3000 ? `${req.slice(0, 3000)}…` : req}` : '',
    `\nThe plan:\n${formatPlan(plan, task)}`,
    `\nYOUR TASK: ${task.text}`,
  ].join('\n');
}
