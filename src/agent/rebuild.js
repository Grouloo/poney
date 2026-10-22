// Gives old conversations (saved before rewind points existed) the ability to be
// edited and relaunched from any user message.
import { formatResult, withReasoning } from './protocol.js';

const attr = (k, v) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${String(v).replace(/"/g, "'")}"`);

/** Our tag for an action, from the tool name and arguments saved in the transcript events. */
export function actionTag(tool, a = {}) {
  switch (tool) {
    case 'write': return `<write${attr('path', a.path)}>\n${a.content ?? ''}\n</write>`;
    case 'edit': return `<edit${attr('path', a.path)}>${a.body ?? ''}</edit>`;
    case 'run': return `<run>${a.command ?? ''}</run>`;
    case 'web_search': return `<web_search>${a.query ?? ''}</web_search>`;
    case 'fetch': return `<fetch>${a.url ?? ''}</fetch>`;
    case 'search': return a.query ? `<search${attr('path', a.path)}>${a.query}</search>` : `<search${attr('pattern', a.pattern)}${attr('path', a.path)} />`;
    case 'read': return `<read${attr('path', a.path)}${attr('start', a.start)}${attr('end', a.end)} />`;
    case 'agent': return `<agent${attr('title', a.title)}>\n${a.task ?? ''}\n</agent>`;
    case 'plan': return `<plan>\n${a.body ?? ''}\n</plan>`;
    default: return `<${tool}${attr('path', a.path)}${attr('depth', a.depth)} />`;
  }
}

/**
 * Rebuilds the model history from the transcript events: user messages, the
 * assistant's text and reasoning, its actions and their results. Close to the
 * original, not identical: long outputs were truncated when saved, and the
 * app's automatic reminders were not saved.
 */
export function rebuildHistory(events, { maxReasoningChars } = {}) {
  const messages = [];
  let step = null; // { prose, thinking, actions: [{ id, tool, args, end }] }
  let pendingAuto = []; // results of commands run by the app itself (test command)

  const flush = () => {
    if (step) {
      const tags = step.actions.map((a) => actionTag(a.tool, a.args));
      const content = [step.prose, ...tags].filter(Boolean).join('\n');
      if (content) messages.push({ role: 'assistant', content: withReasoning(content, step.thinking, maxReasoningChars) });
      const results = step.actions.filter((a) => a.end).map((a) => resultText(a));
      if (results.length) messages.push({ role: 'user', content: results.join('\n') });
      step = null;
    }
    if (pendingAuto.length) {
      messages.push({ role: 'user', content: pendingAuto.map(resultText).join('\n') });
      pendingAuto = [];
    }
  };

  const byId = new Map();
  for (const ev of events) {
    switch (ev.type) {
      case 'user_message':
        flush();
        messages.push({ role: 'user', content: ev.text });
        break;
      case 'assistant_end':
        flush();
        step = { prose: ev.text || '', thinking: ev.thinking || '', actions: [] };
        break;
      case 'action_start': {
        const a = { id: ev.id, tool: ev.tool, args: ev.args || {}, end: null };
        byId.set(ev.id, a);
        if (ev.auto) pendingAuto.push(a);
        else if (step) step.actions.push(a);
        break;
      }
      case 'action_end': {
        const a = byId.get(ev.id);
        if (a) a.end = ev;
        break;
      }
    }
  }
  flush();
  // Consecutive messages of the same role (e.g. an action-less step) are merged.
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

function resultText(a) {
  const attrs = { ...(a.end?.meta || {}) };
  if (a.tool === 'run') attrs.command = a.args.command;
  return formatResult(a.tool, attrs, a.end?.output ?? '(no result recorded)');
}

/**
 * Upgrades a conversation saved before rewind points existed: gives each user
 * message an id and a checkpoint. Exact checkpoints when the message is still in
 * the agent history verbatim; otherwise (summarized by a compaction) the
 * history will be rebuilt from the events. Returns true if something changed.
 */
export function migrateLegacy(conv) {
  const legacy = conv.events.filter((e) => e.type === 'user_message' && !e.turnId);
  if (!legacy.length) return false;
  const messages = conv.messages || [];
  const existing = conv.checkpoints || [];
  const fresh = [];
  let from = 0;
  conv.events.forEach((e, i) => {
    if (e.type !== 'user_message' || e.turnId) return;
    e.turnId = `legacy-${i}`;
    const idx = messages.findIndex((m, k) => k >= from && m.role === 'user' && m.content === e.text);
    if (idx >= 0) {
      fresh.push({ turnId: e.turnId, archive: null, length: idx, untested: false });
      from = idx + 1;
    } else {
      fresh.push({ turnId: e.turnId, rebuild: true });
    }
  });
  // Legacy messages all come before the ones that already have checkpoints.
  conv.checkpoints = [...fresh, ...existing];
  return true;
}

/**
 * Resume state for an action that has no checkpoint (conversations saved before
 * resume points existed), rebuilt from the transcript: the history up to the
 * message that asked for it (with all its actions), the results of the actions
 * before it in that message, and the actions to run again. A sub-agent restarts
 * with its whole group. Null if the action is not found.
 */
export function rebuildForAction(events, actId) {
  const top = (e) => !e.agentId;
  const at = events.findIndex((e) => e.type === 'action_start' && e.id === actId && top(e));
  if (at < 0) return null;
  let stepAt = -1;
  for (let i = at - 1; i >= 0; i--) {
    if (top(events[i]) && events[i].type === 'assistant_end') { stepAt = i; break; }
    if (top(events[i]) && events[i].type === 'user_message') break;
  }
  if (stepAt < 0) return null;
  let stepEnd = events.length;
  for (let i = stepAt + 1; i < events.length; i++) {
    if (top(events[i]) && (events[i].type === 'assistant_end' || events[i].type === 'user_message')) { stepEnd = i; break; }
  }
  const step = events.slice(stepAt + 1, stepEnd).filter((e) => top(e) && e.type === 'action_start' && !e.auto);
  const ends = new Map(events.filter((e) => top(e) && e.type === 'action_end').map((e) => [e.id, e]));
  let j = step.findIndex((e) => e.id === actId);
  if (j < 0) return null;
  if (step[j].tool === 'agent') while (j > 0 && step[j - 1].tool === 'agent') j--; // the whole group

  const before = rebuildHistory(events.slice(0, stepAt));
  const ask = events[stepAt];
  const content = [ask.text || '', ...step.map((a) => actionTag(a.tool, a.args || {}))].filter(Boolean).join('\n');
  const messages = [...before];
  const last = messages[messages.length - 1];
  const assistant = withReasoning(content, ask.thinking || '');
  if (last?.role === 'assistant') last.content += `\n\n${assistant}`;
  else messages.push({ role: 'assistant', content: assistant });

  const priorResults = step.slice(0, j).map((a) => resultText({ tool: a.tool, args: a.args || {}, end: ends.get(a.id) }));
  const remaining = step.slice(j).map((a) => ({ tool: a.tool, args: { ...(a.args || {}) } }));
  // The request being worked on: the last message the user wrote before this step.
  const request = [...events.slice(0, stepAt)].reverse().find((e) => e.type === 'user_message');
  let turnStartIndex = messages.findLastIndex((m) => m.role === 'user' && request && m.content.includes(request.text));
  if (turnStartIndex < 0) turnStartIndex = 0;
  return {
    messages,
    remaining,
    priorResults,
    turnStartIndex,
    currentTask: request?.text ?? null,
    turnId: request?.turnId ?? null,
    cutAt: events.indexOf(step[j]), // the transcript is cut at the first action run again
  };
}
