// Conversations saved as one JSON file each: the agent's message history (to
// resume the work) and the UI events (to redraw the transcript).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isRecord, parseJson } from './unknown.ts';
import type { AgentEvent, ConversationFile, ConversationSummary } from './types.ts';

const MAX_STORED_OUTPUT = 20000;
// Streaming events are redundant with assistant_end / action_end.
const SKIPPED_EVENTS = new Set<AgentEvent['type']>(['delta', 'action_output', 'turn_start', 'context', 'compaction_start', 'prompt_progress', 'fetching']);

/** A saved conversation: written by this app, so only its top level is checked. */
const isConversation = (v: unknown): v is ConversationFile => isRecord(v);

function readConversation(file: string): ConversationFile {
  const conv = parseJson(fs.readFileSync(file, 'utf8'));
  if (!isConversation(conv)) throw new Error(`Invalid conversation file: ${file}`);
  return conv;
}

export class ConversationStore {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  static newId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  create(workspace: string, title: string, { id = ConversationStore.newId(), offProject = false } = {}): ConversationFile {
    const now = Date.now();
    return {
      id,
      ...(offProject ? { offProject: true } : {}),
      workspace,
      title: ConversationStore.cleanTitle(title) || 'Sans titre',
      createdAt: now,
      updatedAt: now,
      messages: [],
      events: [],
      untested: false,
    };
  }

  /** Records a UI event for replay. */
  record(conv: ConversationFile, ev: AgentEvent): void {
    if (SKIPPED_EVENTS.has(ev.type)) return;
    if (ev.type === 'action_end' && ev.output && ev.output.length > MAX_STORED_OUTPUT) {
      ev = { ...ev, output: `${ev.output.slice(0, MAX_STORED_OUTPUT)}\n[... sortie tronquée dans l’historique ...]` };
    }
    conv.events.push(ev);
  }

  save(conv: ConversationFile, { touch = true } = {}): void {
    if (touch) conv.updatedAt = Date.now();
    const target = this.file(conv.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(conv));
    fs.renameSync(tmp, target);
  }

  load(id: string): ConversationFile {
    return readConversation(this.file(id));
  }

  static cleanTitle(title: unknown): string {
    return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** Renames a conversation on disk without changing its place in the list. */
  rename(id: string, title: unknown): string {
    const conv = this.load(id);
    conv.title = ConversationStore.cleanTitle(title) || conv.title;
    delete conv.titleFromDraft;
    this.save(conv, { touch: false });
    return conv.title;
  }

  delete(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }

  /** All the conversations, most recent first (metadata only, with their project). */
  listAll(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = readConversation(path.join(this.dir, name));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, workspace: c.workspace, offProject: Boolean(c.offProject), draft: Boolean(c.draft), engine: c.choice?.engine ?? 'local', provider: c.choice?.provider, failed: Boolean(c.failed), unread: c.unread || 0 });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Conversations of a workspace, most recent first (metadata only). */
  list(workspace: string | null) {
    const out: Pick<ConversationSummary, 'id' | 'title' | 'updatedAt'>[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = readConversation(path.join(this.dir, name));
        // workspace null: the conversations outside any project (each has its own folder)
        if (workspace === null ? c.offProject : c.workspace === workspace && !c.offProject) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Moves the app's own data (settings, conversations, logs) from an old data folder, once. */
export function moveAppData(from: string, to: string): void {
  for (const name of ['settings.json', 'conversations', 'logs']) {
    try {
      if (fs.existsSync(path.join(from, name)) && !fs.existsSync(path.join(to, name))) {
        fs.mkdirSync(to, { recursive: true });
        fs.renameSync(path.join(from, name), path.join(to, name));
      }
    } catch {}
  }
}
