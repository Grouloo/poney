// What to keep before a compaction: the oldest messages are about to be summarized
// and leave the model's view, so it is asked once (a dedicated call on the cached
// conversation, like the assessment) what in the whole conversation must not be
// lost. The app writes each item where the model says: the conversation's memory,
// or, for a lasting fact about the project, its notes file (AGENTS.md). Another
// file of the project (a doc to update) is left to a sub-agent, run before the
// summary: its task is written now, while the model still sees the details, and
// it starts with an empty window, with room to read the file and edit it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { list, rec } from '../unknown.ts';

export const MAX_KEPT = 3;
const MIN_CHARS = 15;

export type KeepWhere = 'memory' | 'project' | 'file';
export interface KeepItem {
  fact: string;
  where: KeepWhere;
  /** For the project: the heading of the notes file to put it under (empty: the model gave none). */
  section: string;
  /** For a file: its path in the project, and the sub-agent's task. */
  path?: string;
  task?: string;
}
const MAX_TASK_CHARS = 2000;

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
          where: { type: 'string', enum: ['memory', 'project', 'file', 'none'] },
          section: { type: 'string', maxLength: 60 },
          path: { type: 'string', maxLength: 200 },
          task: { type: 'string', maxLength: MAX_TASK_CHARS },
        },
        required: ['fact', 'where'],
      },
    },
  },
  required: ['keep'],
};

/** The instruction: which messages leave the view, and what may be kept where. */
export function keepInstruction({ until, project, file, headings = [], files = false }: { until: string; project: boolean; file: string; headings?: string[]; files?: boolean }): string {
  const part = until
    ? `Everything above the message that starts with « ${until} » is about to be summarized: its details will leave your view.`
    : 'The conversation above is about to be summarized: its details will leave your view.';
  return [
    `BEFORE THE SUMMARY. ${part}`,
    `Before that: what in the WHOLE conversation must not be lost? At most ${MAX_KEPT} items, one short sentence each, that are NOT already in your MEMORY${project ? ` or in ${file}` : ''}: a decision, a preference or constraint of the user, a result found, a name or value needed later.`,
    `"where": "memory" to keep it for this conversation${project ? `; "project" for a lasting fact about working on this project, needed in the next conversations too (how to run or test it, a convention, a pitfall): it will be added to ${file}` : ''}; "none" if it is not worth it.`,
    ...(project ? [`"section", for "project": ${headings.length ? `the heading of ${file} it belongs under (${headings.map((h) => `"${h}"`).join(', ')}), or a new short heading if none fits` : `a short heading for it in ${file}`}.`] : []),
    ...(files ? ['"file" when it belongs in another file of the project (a doc to update; at most one): give its "path", and in "task" everything a helper who cannot see this conversation needs to update it: what to add or correct, with the details (names, values, reasons), and where in the file.'] : []),
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
export function parseKeep(text: string, { memory = [], notes = '', project = true, files = false, notesFile = 'AGENTS.md' }: { memory?: string[]; notes?: string; project?: boolean; files?: boolean; notesFile?: string } = {}): KeepItem[] | null {
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
    if (r.where === 'file') {
      // (one, inside the project; the notes file is the app's own)
      const file = projectPath(r.path);
      const task = String(r.task ?? '').trim().slice(0, MAX_TASK_CHARS);
      if (!files || !file || out.some((o) => o.where === 'file') || task.length < MIN_CHARS) continue;
      if (file.toLowerCase() === notesFile.toLowerCase()) { if (fact.length >= MIN_CHARS) out.push({ fact, where: 'project', section: '' }); continue; }
      out.push({ fact: fact || task.slice(0, 200), where: 'file', section: '', path: file, task });
      if (out.length >= MAX_KEPT) break;
      continue;
    }
    const where = r.where === 'project' && project ? 'project' : r.where === 'memory' || r.where === 'project' ? 'memory' : null;
    if (!where || fact.length < MIN_CHARS || BANAL.test(fact)) continue;
    if (restates(fact, [...memory, ...noteLines, ...out.map((o) => o.fact)])) continue;
    out.push({ fact, where, section: where === 'project' ? String(r.section ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '' });
    if (out.length >= MAX_KEPT) break;
  }
  return out;
}

/** A path given by the model, if it stays inside the project: relative, cleaned. */
export function projectPath(raw: unknown): string | null {
  const p = String(raw ?? '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!p || path.isAbsolute(p) || /^[a-z]:/i.test(p)) return null;
  const n = path.posix.normalize(p);
  return n.startsWith('..') || n === '.' || n.startsWith('.git/') || n.startsWith('.poney/') ? null : n;
}

/** The sub-agent's task for a file to update before a compaction. */
export const fileTask = (file: string, task: string) =>
  `Update the file ${file} of the project with what follows. Read it first; put the information where it belongs, in the style of the file, and change nothing else (create the file if it does not exist).\n\n${task}`;

/** The start of a message, to point at it in the instruction (without its date stamp). */
export const messageStart = (content: string) => content.replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60);

// ---------- the project's notes file ----------

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The headings of a Markdown text, outside code blocks: { at (line index), level, title }. */
function headingsOf(lines: string[]) {
  const out: { at: number; level: number; title: string }[] = [];
  let fenced = false;
  lines.forEach((l, at) => {
    if (FENCE.test(l)) fenced = !fenced;
    const m = fenced ? null : l.match(HEADING);
    if (m) out.push({ at, level: m[1].length, title: m[2] });
  });
  return out;
}

/** The headings the model may pick from: the sections (not the title of the file, when it has sections). */
export function noteHeadings(text: string): string[] {
  const all = headingsOf(text.split('\n'));
  const sections = all.some((h) => h.level > 1) ? all.filter((h) => h.level > 1) : all;
  return sections.map((h) => h.title).slice(0, 15);
}

/**
 * The notes file with a line added at the end of the section named (its last
 * line, before the blank lines), or under a new heading when none has that name
 * (at the end of the file). Returns the text and the heading used.
 */
export function insertNote(text: string, line: string, section: string): { text: string; section: string } {
  const note = `- ${line.replace(/\s+/g, ' ').trim()}`;
  const lines = text.replace(/\n+$/, '').split('\n');
  const all = headingsOf(lines);
  const h = section ? all.find((x) => norm(x.title) === norm(section)) : undefined;
  if (h) {
    const next = all.find((x) => x.at > h.at && x.level <= h.level);
    let k = next ? next.at : lines.length;
    while (k - 1 > h.at && !lines[k - 1].trim()) k--;
    lines.splice(k, 0, note);
    return { text: `${lines.join('\n')}\n`, section: h.title };
  }
  const title = section || 'Notes';
  const levels = all.filter((x) => x.level > 1).map((x) => x.level);
  const level = levels.length ? Math.min(...levels) : 2; // (like the other sections)
  const head = text.trim() ? `${lines.join('\n')}\n\n` : '';
  return { text: `${head}${'#'.repeat(level)} ${title}\n\n${note}\n`, section: title };
}

/** Adds a line to the project's notes file (created if missing), in its section. Returns the heading used. */
export async function addProjectNote(cwd: string, file: string, line: string, section = ''): Promise<string> {
  const at = path.join(cwd, path.basename(file)); // (only at the root of the project)
  const r = insertNote(await fs.readFile(at, 'utf8').catch(() => ''), line, section);
  await fs.writeFile(at, r.text);
  return r.section;
}
