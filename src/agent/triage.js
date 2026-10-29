// The assessment made before acting ("bilan"): before the model may use its tools
// on a message, a dedicated call asks it ONLY for what it knows, what it doubts and
// what it does not know (with why), as constrained JSON. The app, not the model,
// then decides the route: nothing doubtful, act directly; a doubt, check it (one
// lookup); something unknown, read several sources before concluding, and a final
// answer given before that is refused. A small model told this in its system
// prompt alone does it for a few turns, then skips it, mostly when it is wrongly
// sure of itself.

// The model lists the facts its answer will rely on, then grades each one. Asked
// directly "what do you know", a small model restates the request ("the user wants
// an explanation of X") and is done: its knowledge of X was never weighed. The
// reason comes before the grade, so that the grade follows from it.
const claim = {
  type: 'object',
  properties: {
    point: { type: 'string' },
    why: { type: 'string' },
    status: { type: 'string', enum: ['known', 'doubt', 'unknown'] },
  },
  required: ['point', 'why', 'status'],
};

/** The JSON the assessment call must produce (sent as structured output when the server supports it). */
export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: { claims: { type: 'array', items: claim, maxItems: 6 } },
  required: ['claims'],
};

const CLAIM_FORMAT = '{"claims": [{"point": "a fact your answer or work relies on", "why": "where your knowledge of it comes from, or why it may be wrong", "status": "known" or "doubt" or "unknown"}]}';
const GRADES = [
  '"known": you are sure of it: well-established knowledge you could state precisely, or read in this conversation.',
  '"doubt": you may be wrong: details, numbers, names, formulas, versions, edge cases you remember only roughly.',
  '"unknown": you would have to guess.',
].join(' ');

/** Sources a turn must read: none, one check, several. */
export const ROUTE_SOURCES = { direct: 0, check: 1, investigate: 2 };

/**
 * Tools that read a source (files, project, commands, web pages, earlier conversation,
 * sub-agents). Not <web_search>: it finds pages, its snippets are not pages read.
 */
export const SOURCE_TOOLS = new Set(['read', 'search', 'list', 'run', 'fetch', 'recall', 'agent', 'plan']);

/**
 * The assessment calls: low temperature (the model's own, often 1.0, makes small
 * models wander out of the JSON), then, if nothing could be read, again with a
 * reminder, more room and a little more temperature (at the same one, the same
 * mistake comes back). The model is asked not to reason first (see noThinking in
 * llm.js: a first impression is what is wanted, and the "why" of each item is its
 * reasoning); where a server cannot prevent it, the room includes the reasoning
 * (seen with Gemma on updates: 600 tokens of reasoning, then cut before the JSON).
 */
export const TRIAGE_ATTEMPTS = [
  { temperature: 0.1, maxTokens: 1200 },
  { temperature: 0.3, maxTokens: 1800, retry: true },
  { temperature: 0.6, maxTokens: 1800, retry: true },
];
export const TRIAGE_RETRY = '(Your previous reply could not be used: it was not this JSON, or it only restated the request. Reply with the JSON object ONLY, nothing before or after it: the facts your answer relies on, each graded; short items.)';
export const TRIAGE_RETRY_CUT = '(Your previous reply ran out of room while you were still reasoning, before the JSON. Reason briefly this time, then write the JSON object.)';

/**
 * When no assessment could be read at all: a careful route instead of none, so
 * that failing it is never a way around it (one source to read before answering).
 */
export function fallbackTriage() {
  return { known: [], doubts: [{ point: 'what your answer relies on', why: 'your assessment could not be read' }], unknowns: [], route: 'check' };
}

export function triageInstruction() {
  return [
    '(Before you act on this message, the app asks you for an honest assessment. Do NOT answer the message and do NOT use any tool now.',
    'This is about YOUR KNOWLEDGE, not about the request: do not restate what the user asks ("the user wants…"). List the facts your answer or your work will rely on, and grade each one honestly.',
    'Reply with ONLY this JSON object:',
    CLAIM_FORMAT,
    GRADES,
    'A fact about this project (its files, its code, its state) that you have not read in this conversation is a doubt at best. A recent fact (versions, news, prices, APIs that change) is a doubt or unknown. An empty list only when the message needs no knowledge at all (a greeting, a thanks). Short items, at most 6.)',
  ].join('\n');
}

// ---------- updates during the answer ----------
// Results from outside (web pages, searches, commands, the user's CLIs) can settle a
// doubt or raise a new one. After such results the assessment is asked again, about
// the CURRENT TASK only: what the model does not need for it is left out, so that it
// does not turn away from its work to look up everything it does not know. The app
// also caps it: a few updates per answer, a few items each, and a few refusals in all.

/** Tools whose results bring outside information worth reassessing after. */
export const UPDATE_TOOLS = new Set(['web_search', 'fetch', 'run']);
export const MAX_UPDATES = 3; // per answer
export const MAX_REFUSALS = 3; // per answer, all assessments together
const UPDATE_MIN_CHARS = 300; // a short result (an echo, "ok") brings nothing to reassess

/** Whether results just received call for an update of the assessment. */
export function needsUpdate(results, updatesSoFar) {
  if (updatesSoFar >= MAX_UPDATES) return false;
  return results.some((r) => r.ok && UPDATE_TOOLS.has(r.tool) && String(r.output ?? '').length >= UPDATE_MIN_CHARS);
}

export function triageUpdateInstruction(task) {
  // (a sub-agent of a plan: its own task, not the context it was given with it)
  const own = String(task ?? '').match(/\nYOUR TASK: ([\s\S]+)$/);
  const t = (own ? own[1] : String(task ?? '')).replace(/\s+/g, ' ').trim();
  return [
    '(Before you go on, the app asks you to update your assessment from the results above. Do NOT go on with the task and do NOT use any tool now.',
    t ? `Your current task: ${t.length > 400 ? `${t.slice(0, 400)}…` : t}` : '',
    'Reply with ONLY this JSON object:',
    CLAIM_FORMAT,
    GRADES,
    'The facts your task relies on, as the results leave them: a point the results settled is "known".',
    'Search results are snippets, not pages read: a detail (a number, a date, a name, a quote) that only a snippet gives is a "doubt" until a page you fetched confirms it; only the broad picture several snippets agree on can be "known".',
    'Only what matters for YOUR CURRENT TASK: a doubt or unknown only if the task cannot be done well without it. Something the results mention that is interesting but not needed: leave it out, do not chase it. At most 6 items.)',
  ].filter(Boolean).join('\n');
}

/** The request for the assessment: the cached conversation, the instruction appended to its last message. */
export function triageRequest(prompt, instruction = triageInstruction()) {
  const msgs = prompt.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  if (last?.role === 'user') last.content = `${last.content}\n\n${instruction}`;
  else msgs.push({ role: 'user', content: instruction });
  return msgs;
}

const clean = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// An item about the request, not about knowledge ("The user wants an explanation of X").
const RESTATES = /^(the )?user('s)? (wants|asks|is asking|would like|requests|needs|question|request)\b|^(the )?(request|question|task) (is|asks)\b/i;

function items(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? { point: clean(x), why: '' } : { point: clean(x?.point ?? x?.what ?? x?.item ?? x?.fact), why: clean(x?.why ?? x?.reason) }))
    .filter((x) => x.point)
    .slice(0, 5);
}

/**
 * The assessment from the model's reply (JSON, possibly wrapped in prose or a code
 * fence, or cut), with the route set by the app. Null when nothing can be read.
 */
export function parseTriage(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let data = null;
  for (let end = s.lastIndexOf('}'); end > start && !data; end = s.lastIndexOf('}', end - 1)) {
    try { data = JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  if (!data || typeof data !== 'object') return null;
  let known;
  let doubts;
  let unknowns;
  if (Array.isArray(data.claims)) {
    const all = data.claims.map((c) => ({ ...items([c])[0], status: String(c?.status ?? '').trim().toLowerCase() })).filter((x) => x.point);
    const kept = all.filter((x) => !RESTATES.test(x.point));
    // Only the request restated: no knowledge was weighed, the assessment is asked again.
    if (all.length && !kept.length) return null;
    const of = (status) => kept.filter((x) => x.status === status).map(({ point, why }) => ({ point, why })).slice(0, 5);
    known = of('known');
    doubts = kept.filter((x) => x.status !== 'known' && x.status !== 'unknown').map(({ point, why }) => ({ point, why })).slice(0, 5); // (no grade: a doubt)
    unknowns = of('unknown');
  } else {
    // (the earlier form: three lists)
    known = items(data.known).filter((x) => !RESTATES.test(x.point));
    doubts = items(data.doubts ?? data.doubt);
    unknowns = items(data.unknowns ?? data.unknown ?? data.ignored);
  }
  return { known, doubts, unknowns, route: unknowns.length ? 'investigate' : doubts.length ? 'check' : 'direct' };
}

const ROUTE_TEXT = {
  direct: 'Nothing you lack: act or answer directly, no lookup is needed. Do not look up more.',
  check: 'Check your doubts with at least ONE lookup (read the file, search the project, or the web) before relying on them.',
  investigate: `Read at least ${ROUTE_SOURCES.investigate} sources (files, project search, web pages) to fill what you do not know BEFORE concluding. A final answer given before that will be refused.`,
};

/** The assessment as added to the user's message (or, updated, to the results), with the route the app chose. */
export function triageBlock(t, { update = false, web = false } = {}) {
  const line = (x) => `- ${x.point}${x.why ? ` (${x.why})` : ''}`;
  return [
    update ? '(Your assessment, updated from these results at the app\'s request (it replaces the earlier one):' : '(Your assessment before acting, made at the app\'s request:',
    t.known.length ? `You know:\n${t.known.map(line).join('\n')}` : '',
    t.doubts.length ? `You doubt:\n${t.doubts.map(line).join('\n')}` : '',
    t.unknowns.length ? `You do not know:\n${t.unknowns.map(line).join('\n')}` : '',
    web ? `Route set by the app: ${ROUTE_TEXT[t.route]}\nWhen you answer from the web: end with "Sources" (only pages you opened with <fetch>) and "Seen in search results (not opened)", and say which details you could not check.)` : `Route set by the app: ${ROUTE_TEXT[t.route]})`,
  ].filter(Boolean).join('\n');
}

/** What is still missing, recalled with each result until the route is satisfied. */
export function triageReminder(t, read) {
  const need = ROUTE_SOURCES[t.route];
  if (read >= need) return '';
  const what = [...t.unknowns, ...t.doubts].map((x) => x.point).slice(0, 3).join('; ');
  return `(Assessment: still to check: ${what}. Sources read this turn: ${read}/${need}.)`;
}

/** The message refusing a final answer given before the route is satisfied. */
export function triageRefusal(t, read) {
  const need = ROUTE_SOURCES[t.route];
  const what = [...t.unknowns, ...t.doubts].map((x) => `- ${x.point}`).join('\n');
  return `Not yet: in your assessment you said you ${t.unknowns.length ? 'do not know' : 'are not sure of'}:\n${what}\n` +
    `You have read ${read} source(s) this turn; read at least ${need} (<read>, <search>, <fetch> a page found with <web_search>: its snippets do not count) before giving your final answer. ` +
    'If it really cannot be found, say so plainly in your answer instead of guessing.';
}
