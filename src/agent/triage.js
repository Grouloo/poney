// The assessment made before acting ("bilan"): before the model may use its tools
// on a message, a dedicated call asks it ONLY for what it knows, what it doubts and
// what it does not know (with why), as constrained JSON. The app, not the model,
// then decides the route: nothing doubtful, act directly; a doubt, check it (one
// lookup); something unknown, read several sources before concluding, and a final
// answer given before that is refused. A small model told this in its system
// prompt alone does it for a few turns, then skips it, mostly when it is wrongly
// sure of itself.

const item = { type: 'object', properties: { point: { type: 'string' }, why: { type: 'string' } }, required: ['point', 'why'] };

/** The JSON the assessment call must produce (sent as structured output when the server supports it). */
export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    known: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    doubts: { type: 'array', items: item, maxItems: 5 },
    unknowns: { type: 'array', items: item, maxItems: 5 },
  },
  required: ['known', 'doubts', 'unknowns'],
};

/** Sources a turn must read: none, one check, several. */
export const ROUTE_SOURCES = { direct: 0, check: 1, investigate: 2 };

/** Tools that read a source (files, project, commands, web, earlier conversation, sub-agents). */
export const SOURCE_TOOLS = new Set(['read', 'search', 'list', 'run', 'web_search', 'fetch', 'recall', 'agent', 'plan']);

export const TRIAGE_MAX_TOKENS = 600;

export function triageInstruction() {
  return [
    '(Before you act on this message, the app asks you for an honest assessment. Do NOT answer the message and do NOT use any tool now.',
    'Reply with ONLY this JSON object:',
    '{"known": ["what you know for sure that this message needs"], "doubts": [{"point": "what you are not sure of", "why": "why"}], "unknowns": [{"point": "what you do not know", "why": "why"}]}',
    'A fact about this project (its files, its code, its state) that you have not read in this conversation is a doubt at best. A recent fact (versions, news, prices, APIs that change) is a doubt or unknown. Empty lists are fine when the message needs nothing you lack (a greeting, a thanks). Short items, at most 5 per list.)',
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
  const t = String(task ?? '').replace(/\s+/g, ' ').trim();
  return [
    '(Before you go on, the app asks you to update your assessment from the results above. Do NOT go on with the task and do NOT use any tool now.',
    t ? `Your current task: ${t.length > 400 ? `${t.slice(0, 400)}…` : t}` : '',
    'Reply with ONLY this JSON object:',
    '{"known": ["what the results established that your task needs"], "doubts": [{"point": "what is still uncertain", "why": "why"}], "unknowns": [{"point": "what you still do not know", "why": "why"}]}',
    'Only what matters for YOUR CURRENT TASK: list a doubt or unknown only if the task cannot be done well without it. Something the results mention that is interesting but not needed: leave it out, do not chase it. A point the results settled goes in "known", not in doubts. At most 3 items per list.)',
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

function items(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? { point: clean(x), why: '' } : { point: clean(x?.point ?? x?.what ?? x?.item), why: clean(x?.why ?? x?.reason) }))
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
  const known = (Array.isArray(data.known) ? data.known : []).map((k) => clean(typeof k === 'string' ? k : k?.point)).filter(Boolean).slice(0, 5);
  const doubts = items(data.doubts ?? data.doubt);
  const unknowns = items(data.unknowns ?? data.unknown ?? data.ignored);
  return { known, doubts, unknowns, route: unknowns.length ? 'investigate' : doubts.length ? 'check' : 'direct' };
}

const ROUTE_TEXT = {
  direct: 'Nothing you lack: act or answer directly, no lookup is needed. Do not look up more.',
  check: 'Check your doubts with at least ONE lookup (read the file, search the project, or the web) before relying on them.',
  investigate: `Read at least ${ROUTE_SOURCES.investigate} sources (files, project search, web pages) to fill what you do not know BEFORE concluding. A final answer given before that will be refused.`,
};

/** The assessment as added to the user's message (or, updated, to the results), with the route the app chose. */
export function triageBlock(t, { update = false } = {}) {
  const line = (x) => `- ${x.point}${x.why ? ` (${x.why})` : ''}`;
  return [
    update ? '(Your assessment, updated from these results at the app\'s request (it replaces the earlier one):' : '(Your assessment before acting, made at the app\'s request:',
    t.known.length ? `You know:\n${t.known.map((k) => `- ${k}`).join('\n')}` : '',
    t.doubts.length ? `You doubt:\n${t.doubts.map(line).join('\n')}` : '',
    t.unknowns.length ? `You do not know:\n${t.unknowns.map(line).join('\n')}` : '',
    `Route set by the app: ${ROUTE_TEXT[t.route]})`,
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
    `You have read ${read} source(s) this turn; read at least ${need} (<read>, <search>, <web_search>, <fetch>) before giving your final answer. ` +
    'If it really cannot be found, say so plainly in your answer instead of guessing.';
}
