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

/** The request for the assessment: the cached conversation, the instruction appended to its last message. */
export function triageRequest(prompt) {
  const msgs = prompt.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  if (last?.role === 'user') last.content = `${last.content}\n\n${triageInstruction()}`;
  else msgs.push({ role: 'user', content: triageInstruction() });
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
  direct: 'Nothing you lack: act or answer directly, no lookup is needed.',
  check: 'Check your doubts with at least ONE lookup (read the file, search the project, or the web) before relying on them.',
  investigate: `Read at least ${ROUTE_SOURCES.investigate} sources (files, project search, web pages) to fill what you do not know BEFORE concluding. A final answer given before that will be refused.`,
};

/** The assessment as added to the user's message, with the route the app chose. */
export function triageBlock(t) {
  const line = (x) => `- ${x.point}${x.why ? ` (${x.why})` : ''}`;
  return [
    '(Your assessment before acting, made at the app\'s request:',
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
