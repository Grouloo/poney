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
  return { tasks, done, work: [...(prev?.work || [])] };
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

/** The name under which a sub-agent reads step n of the main agent's turn in full (see turnDigest). */
export const turnStepPath = (n) => `@turn/${n}`;

/**
 * What the main agent did in this turn before its plan (its messages and the
 * results it got), for a sub-agent: it would otherwise read again what the main
 * agent has already read, or miss what it found.
 *
 * The steps that concern the sub-agent's task (they name its files, or several of
 * its words) are kept much longer than the others; when everything does not fit,
 * the oldest steps unrelated to the task go first. A step cut short is cut in the
 * middle (a command's error is at its end), and says where to read it in full:
 * each step is put in `outputs` under turnStepPath(n), which the sub-agent reads
 * with <read> like a file. Without that, a sub-agent whose task needs a cut part
 * goes round in circles looking for it.
 */
export function turnDigest(messages, { maxChars = 6000, task = '', outputs = null } = {}) {
  if (typeof arguments[1] === 'number') maxChars = arguments[1]; // (older form: the size alone)
  const terms = digestTerms(task);
  const steps = messages
    .map((m, i) => ({ m, n: i + 1 }))
    .filter(({ m }) => m.content?.trim())
    .map(({ m, n }) => {
      const full = m.content.trim();
      outputs?.set(turnStepPath(n), full);
      const relevant = isRelevant(full, terms);
      const limit = m.role === 'assistant' ? (relevant ? 3000 : 1000) : relevant ? Math.max(1500, Math.floor(maxChars / 2)) : 1500;
      const body = cutStep(full, limit, outputs ? turnStepPath(n) : null);
      return { n, relevant, text: m.role === 'assistant' ? `MAIN AGENT:\n${body}` : body };
    });
  // Over budget: the oldest unrelated steps first, then the oldest related ones.
  let size = steps.reduce((k, s) => k + s.text.length + 2, 0);
  const dropped = new Set();
  for (const pass of [false, true]) {
    for (const s of steps) {
      if (size <= maxChars) break;
      if (s.relevant !== pass || s === steps[steps.length - 1]) continue;
      dropped.add(s);
      size -= s.text.length + 2;
    }
  }
  const out = [];
  let gap = [];
  const flushGap = () => {
    if (!gap.length) return;
    out.push(`[… ${gap.length} step(s) left out${outputs ? `: <read path="${turnStepPath(gap[0])}" />${gap.length > 1 ? ` to <read path="${turnStepPath(gap[gap.length - 1])}" />` : ''} if you need them` : ''}]`);
    gap = [];
  };
  for (const s of steps) {
    if (dropped.has(s)) { gap.push(s.n); continue; }
    flushGap();
    out.push(s.text);
  }
  flushGap();
  return out.join('\n\n');
}

/** A step cut to `limit` characters in the middle, saying what was cut and where to read it. */
function cutStep(text, limit, readPath) {
  if (text.length <= limit) return text;
  // Cut at line ends when there are some near the limits (so the line numbers are exact).
  let head = Math.floor(limit * 0.4);
  const nl = text.lastIndexOf('\n', head);
  if (nl > head * 0.5) head = nl;
  let to = text.length - (limit - head);
  const nl2 = text.indexOf('\n', to);
  if (nl2 >= 0 && nl2 - to < limit * 0.2) to = nl2 + 1;
  const from = text.slice(0, head).split('\n').length + (text[head] === '\n' ? 1 : 0); // first line cut
  const lineTo = text.slice(0, to).split('\n').length - (text[to - 1] === '\n' ? 1 : 0); // last line cut
  const where = readPath ? ` (lines ${from}-${lineTo}): <read path="${readPath}" start="${from}" end="${lineTo}" /> shows them` : '';
  return `${text.slice(0, head)}\n[… ${to - head} characters cut${where}]\n${text.slice(to)}`;
}

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'task', 'les', 'des', 'une', 'pour', 'avec', 'dans', 'que', 'qui', 'est', 'sur', 'pas', 'par', 'fichier', 'file', 'files']);

/** What makes a step concern a task: the files it names, and its words (by their root). */
function digestTerms(task) {
  const t = String(task || '');
  const files = [...new Set((t.match(/[\w.-]*[\w-]\.[a-z0-9]{1,6}\b|[\w.-]+\/[\w./-]+/gi) || []).map((f) => fold(f.split('/').pop())).filter((f) => f.length >= 3))];
  const words = [...new Set(fold(t).split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => (w.length >= 6 ? w.slice(0, Math.max(5, w.length - 2)) : w)))];
  return { files, words };
}

function isRelevant(text, { files, words }) {
  if (!files.length && !words.length) return false;
  const low = fold(text);
  if (files.some((f) => low.includes(f))) return true;
  let hits = 0;
  for (const w of words) if (low.includes(w) && ++hits >= 2) return true;
  return false;
}

/**
 * What a sub-agent gets: the request, what the main agent did in this turn
 * before the plan, the whole plan (its task marked), the reports of the tasks
 * already done (it may build on them), its task.
 */
export function subAgentTask(plan, task, request, digest = '') {
  const req = String(request || '').trim();
  const before = plan.tasks.filter((t) => t.status === 'done' && t.report);
  const work = (plan.work || []).slice(-12).map((w) => `- ${w.task}: ${w.items.slice(-15).join('; ')}`);
  return [
    'You are one of several agents carrying out a plan, one task each. Do ONLY your task; the others are done by other agents.',
    req ? `\nThe user's request:\n${req.length > 3000 ? `${req.slice(0, 3000)}…` : req}` : '',
    digest ? `\nWhat the main agent did in this turn before the plan (what it read and found: do not redo it):\n${digest}\n[end of the main agent's steps]` : '',
    // (numbered, without "- [ ]" or @parallel: not a <plan> to write again)
    `\nThe plan, already written (do not write it again):\n${plan.tasks.map((t, i) => `${i + 1}. ${t.text}${t === task ? '   <- YOUR TASK' : t.status === 'done' ? '   (done)' : ''}`).join('\n')}`,
    before.length ? `\nReports of the tasks already done:\n${before.map((t) => `- ${t.text}: ${t.report.length > 1500 ? `${t.report.slice(0, 1500)}…` : t.report}`).join('\n')}` : '',
    work.length ? `\nWhat the earlier agents changed (files, commands):\n${work.join('\n')}` : '',
    before.length || work.length
      ? '\nThe earlier agents may have done more than their own task, even part or all of yours. Before working, check what they changed. Do only what is still missing; if your task is already done, check that it works and report that, without redoing it.'
      : '',
    `\nYOUR TASK: ${task.text}`,
  ].join('\n');
}
