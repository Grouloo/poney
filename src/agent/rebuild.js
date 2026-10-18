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
    case 'search': return `<search${attr('pattern', a.pattern)}${attr('path', a.path)} />`;
    case 'read': return `<read${attr('path', a.path)}${attr('start', a.start)}${attr('end', a.end)} />`;
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
