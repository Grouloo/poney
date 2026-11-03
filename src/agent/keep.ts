// What to keep before a compaction: the oldest messages are about to be summarized
// and leave the model's view, so it is asked once (a dedicated call on the cached
// conversation, like the assessment) what in the whole conversation must not be
// lost. The app writes each item where the model says: the conversation's memory,
// or, for a lasting fact about the project, its notes file (AGENTS.md).

import fs from 'node:fs/promises';
import path from 'node:path';
import { list, rec } from '../unknown.ts';

export const MAX_KEPT = 3;
const MIN_CHARS = 15;

export type KeepWhere = 'memory' | 'project';
export interface KeepItem {
  fact: string;
  where: KeepWhere;
}

export const KEEP_SCHEMA = {
  type: 'object',
  properties: {
    keep: {
      type: 'array',
      maxItems: MAX_KEPT,
      items: {
        type: 'object',
        properties: {
          fact: { type: 'string', maxLength: 200 },
          where: { type: 'string', enum: ['memory', 'project', 'none'] },
        },
        required: ['fact', 'where'],
      },
    },
  },
  required: ['keep'],
};

/** The instruction: which messages leave the view, and what may be kept where. */
export function keepInstruction({ until, project, file }: { until: string; project: boolean; file: string }): string {
  const part = until
    ? `Everything above the message that starts with « ${until} » is about to be summarized: its details will leave your view.`
    : 'The conversation above is about to be summarized: its details will leave your view.';
  return [
    `BEFORE THE SUMMARY. ${part}`,
    `Before that: what in the WHOLE conversation must not be lost? At most ${MAX_KEPT} items, one short sentence each, that are NOT already in your MEMORY${project ? ` or in ${file}` : ''}: a decision, a preference or constraint of the user, a result found, a name or value needed later.`,
    `"where": "memory" to keep it for this conversation${project ? `; "project" for a lasting fact about working on this project, needed in the next conversations too (how to run or test it, a convention, a pitfall): it will be added to ${file}` : ''}; "none" if it is not worth it.`,
    'Nothing new or important: an empty list. Answer with the JSON only.',
  ].join('\n');
}

const words = (s: string) => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));

/** Whether a fact is already said by one of these texts (most of its words in common). */
function restates(fact: string, known: string[]): boolean {
  const mine = words(fact);
  if (!mine.size) return true;
  return known.some((k) => {
    const theirs = words(k);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return shared >= 0.7 * mine.size;
  });
}

// Items about the conversation itself, not facts ("The user asked for help").
const BANAL = /^(the )?(user|conversation|discussion|task|assistant|i|we)\b[^.]{0,30}\b(asked|wants|is about|discussed|talked|helped|started|working on)\b/i;

/**
 * The items of the answer, cleaned: known destinations only, not too short, not
 * banal, not already in memory or in the project notes, not twice. Null when the
 * answer cannot be read.
 */
export function parseKeep(text: string, { memory = [], notes = '', project = true }: { memory?: string[]; notes?: string; project?: boolean } = {}): KeepItem[] | null {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return null; }
  const items = list(rec(raw).keep);
  const noteLines = notes.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: KeepItem[] = [];
  for (const x of items) {
    const r = rec(x);
    const fact = String(r.fact ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const where = r.where === 'project' && project ? 'project' : r.where === 'memory' || r.where === 'project' ? 'memory' : null;
    if (!where || fact.length < MIN_CHARS || BANAL.test(fact)) continue;
    if (restates(fact, [...memory, ...noteLines, ...out.map((o) => o.fact)])) continue;
    out.push({ fact, where });
    if (out.length >= MAX_KEPT) break;
  }
  return out;
}

/** The start of a message, to point at it in the instruction (without its date stamp). */
export const messageStart = (content: string) => content.replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Adds a line to the project's notes file (created if missing), at its end. */
export async function addProjectNote(cwd: string, file: string, line: string): Promise<void> {
  const name = path.basename(file); // (only at the root of the project)
  const at = path.join(cwd, name);
  const text = await fs.readFile(at, 'utf8').catch(() => '');
  const note = `- ${line.replace(/\s+/g, ' ').trim()}\n`;
  await fs.writeFile(at, !text ? note : `${text}${text.endsWith('\n') ? '' : '\n'}${note}`);
}
