// Gives old conversations (saved before rewind points existed) the ability to be
// edited and relaunched from any user message.
import { formatResult, withReasoning } from './protocol.ts';
import { truncateMiddle } from './tools.ts';
import { SOURCE_TOOLS, triageBlock, triageOfEvent } from './triage.ts';
import type { Action, AgentEvent, Checkpoint, ConversationFile, EventOf, Message, RebuiltAction, ToolArgs } from '../types.ts';

const attr = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${String(v).replace(/"/g, "'")}"`);

/** Our tag for an action, from the tool name and arguments saved in the transcript events. */
export function actionTag(tool: string, a: ToolArgs = {}): string {
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
    case 'ask': return `<ask>\n${a.body ?? ''}\n</ask>`;
    case 'remember': return `<remember>${a.note ?? ''}</remember>`;
    case 'forget': return `<forget>${a.id ?? ''}</forget>`;
    case 'recall': return `<recall>${a.query ?? ''}</recall>`;
    default: return `<${tool}${attr('path', a.path)}${attr('depth', a.depth)} />`;
  }
}

/**
 * Changes the arguments of the action at `i` of a batch about to run again: in
 * what is to run, and in the message that asked for it, so the model sees the
 * call as edited (the user's correction, not its own first attempt).
 */
export function editAction(messages: Message[], remaining: Action[], i: number, args: ToolArgs): void {
  const a = remaining[i];
  if (!a) throw new Error('Action introuvable dans ce point de reprise.');
  const tag = actionTag(a.tool, args);
  const m = messages.findLast((x) => x.role === 'assistant');
  if (m) {
    const old = [a.raw, actionTag(a.tool, a.args)].find((t) => t && m.content.includes(t));
    if (old) m.content = m.content.replace(old, () => tag);
  }
  remaining[i] = { tool: a.tool, args, complete: a.complete };
}

/**
 * Rebuilds the model history from the transcript events: user messages, the
 * assistant's text and reasoning, its actions and their results. Close to the
 * original, not identical: long outputs were truncated when saved, and the
 * app's automatic reminders were not saved.
 */
interface Replayed {
  id?: number;
  tool: string;
  args: ToolArgs;
  end?: EventOf<'action_end'> | null;
}

export function rebuildHistory(events: AgentEvent[], { maxReasoningChars }: { maxReasoningChars?: number } = {}): Message[] {
  const messages: Message[] = [];
  let step: { prose: string; thinking: string; actions: Replayed[] } | null = null;
  let pendingAuto: Replayed[] = []; // results of commands run by the app itself (test command)

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

  const byId = new Map<number, Replayed>();
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
      case 'triage': {
        // The assessment, where the agent saw it: under the user message, or (updated) under the results.
        const t = ev.agentId ? null : triageOfEvent(ev);
        if (!t) break;
        flush();
        const last = messages[messages.length - 1];
        if (last?.role === 'user') last.content += `\n\n${triageBlock(t, { update: Boolean(ev.update) })}`;
        break;
      }
    }
  }
  flush();
  // Consecutive messages of the same role (e.g. an action-less step) are merged.
  const merged: Message[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/**
 * The conversation before a message, for a harness whose session cannot be cut there
 * (Antigravity, a Claude session without a point to fork from): told at the start of the
 * first message of a new one. Without the sub-agents' steps, the reasoning, nor long outputs.
 */
export function recapOf(events: AgentEvent[], maxChars = 60_000): string {
  const own: AgentEvent[] = [];
  for (const e of events) {
    if ('agentId' in e && e.agentId !== undefined) continue; // (a sub-agent's step)
    own.push(e.type === 'assistant_end' ? { ...e, thinking: '' } : e);
  }
  const parts = rebuildHistory(own).map((m) => `[${m.role === 'user' ? 'User' : 'You'}]\n${truncateMiddle(m.content, 6000)}`);
  if (!parts.length) return '';
  return `<earlier_conversation>\nThis conversation restarts from an earlier point, in a new session. What was said and done before, as a record (your tool calls as tags, with their results; what they changed in the files is still there):\n\n${truncateMiddle(parts.join('\n\n'), maxChars)}\n</earlier_conversation>\n\n`;
}

function resultText(a: Replayed): string {
  const attrs: Record<string, unknown> = { ...(a.end?.meta || {}) };
  if (a.tool === 'run') attrs.command = a.args.command;
  return formatResult(a.tool, attrs, a.end?.output ?? '(no result recorded)');
}

/**
 * Upgrades a conversation saved before rewind points existed: gives each user
 * message an id and a checkpoint. Exact checkpoints when the message is still in
 * the agent history verbatim; otherwise (summarized by a compaction) the
 * history will be rebuilt from the events. Returns true if something changed.
 */
export function migrateLegacy(conv: ConversationFile): boolean {
  const legacy = conv.events.filter((e) => e.type === 'user_message' && !e.turnId);
  if (!legacy.length) return false;
  const messages = conv.messages || [];
  const existing = conv.checkpoints || [];
  const fresh: Checkpoint[] = [];
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
export function rebuildForAction(events: AgentEvent[], actId: number, edited?: ToolArgs): RebuiltAction | null {
  const top = (e: AgentEvent) => !e.agentId;
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
  const step = events.slice(stepAt + 1, stepEnd).filter((e): e is EventOf<'action_start'> => top(e) && e.type === 'action_start' && !e.auto);
  const ends = new Map(events.filter((e): e is EventOf<'action_end'> => top(e) && e.type === 'action_end').map((e) => [e.id, e]));
  let j = step.findIndex((e) => e.id === actId);
  if (j < 0) return null;
  if (step[j].tool === 'agent') while (j > 0 && step[j - 1].tool === 'agent') j--; // the whole group

  const before = rebuildHistory(events.slice(0, stepAt));
  const ask = events[stepAt];
  const said = ask.type === 'assistant_end' ? ask : { text: '', thinking: '' };
  const content = [said.text || '', ...step.map((a) => actionTag(a.tool, a.args || {}))].filter(Boolean).join('\n');
  const messages = [...before];
  const last = messages[messages.length - 1];
  const assistant = withReasoning(content, said.thinking || '');
  if (last?.role === 'assistant') last.content += `\n\n${assistant}`;
  else messages.push({ role: 'assistant', content: assistant });

  const priorResults = step.slice(0, j).map((a) => resultText({ tool: a.tool, args: a.args || {}, end: ends.get(a.id) }));
  const remaining: Action[] = step.slice(j).map((a) => ({ tool: a.tool, args: { ...(a.args || {}) } }));
  if (edited) editAction(messages, remaining, step.slice(j).findIndex((a) => a.id === actId), edited);
  // The request being worked on: the last message the user wrote before this step.
  const request = [...events.slice(0, stepAt)].reverse().find((e): e is EventOf<'user_message'> => e.type === 'user_message');
  let turnStartIndex = messages.findLastIndex((m) => m.role === 'user' && request && m.content.includes(request.text));
  if (turnStartIndex < 0) turnStartIndex = 0;
  // The turn's latest assessment, and what was read since (its route still applies).
  const turn = events.slice(request ? events.lastIndexOf(request) : 0, at).filter(top);
  const tAt = turn.findLastIndex((e) => triageOfEvent(e));
  const starts = new Map(turn.filter((e): e is EventOf<'action_start'> => e.type === 'action_start').map((e) => [e.id, e.tool]));
  const triage = tAt < 0 ? null : {
    triage: triageOfEvent(turn[tAt])!,
    sourcesSince: turn.slice(tAt).filter((e) => e.type === 'action_end' && e.ok && SOURCE_TOOLS.has(starts.get(e.id) ?? '')).length,
    updates: turn.filter((e) => e.type === 'triage' && e.update).length,
  };
  return {
    messages,
    remaining,
    priorResults,
    turnStartIndex,
    currentTask: request?.text ?? null,
    turnId: request?.turnId ?? null,
    triage,
    cutAt: events.indexOf(step[j]), // the transcript is cut at the first action run again
  };
}
