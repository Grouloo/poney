// Conversations saved as one JSON file each: the agent's message history (to
// resume the work) and the UI events (to redraw the transcript).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_STORED_OUTPUT = 20000;
// Streaming events are redundant with assistant_end / action_end.
const SKIPPED_EVENTS = new Set(['delta', 'action_output', 'turn_start', 'context', 'compaction_start', 'prompt_progress', 'fetching']);

export class ConversationStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  static newId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  create(workspace, title, { id = ConversationStore.newId(), offProject = false } = {}) {
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
  record(conv, ev) {
    if (SKIPPED_EVENTS.has(ev.type)) return;
    if (ev.type === 'action_end' && ev.output && ev.output.length > MAX_STORED_OUTPUT) {
      ev = { ...ev, output: `${ev.output.slice(0, MAX_STORED_OUTPUT)}\n[... sortie tronquée dans l’historique ...]` };
    }
    conv.events.push(ev);
  }

  save(conv, { touch = true } = {}) {
    if (touch) conv.updatedAt = Date.now();
    const target = this.file(conv.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(conv));
    fs.renameSync(tmp, target);
  }

  load(id) {
    return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
  }

  static cleanTitle(title) {
    return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** Renames a conversation on disk without changing its place in the list. */
  rename(id, title) {
    const conv = this.load(id);
    conv.title = ConversationStore.cleanTitle(title) || conv.title;
    delete conv.titleFromDraft;
    this.save(conv, { touch: false });
    return conv.title;
  }

  delete(id) {
    fs.rmSync(this.file(id), { force: true });
  }

  /** All the conversations, most recent first (metadata only, with their project). */
  listAll() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, workspace: c.workspace, offProject: Boolean(c.offProject), draft: Boolean(c.draft), engine: c.choice?.engine ?? 'local', unread: c.unread || 0 });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Conversations of a workspace, most recent first (metadata only). */
  list(workspace) {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        // workspace null: the conversations outside any project (each has its own folder)
        if (workspace === null ? c.offProject : c.workspace === workspace && !c.offProject) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Moves the app's own data (settings, conversations, logs) from an old data folder, once. */
export function moveAppData(from, to) {
  for (const name of ['settings.json', 'conversations', 'logs']) {
    try {
      if (fs.existsSync(path.join(from, name)) && !fs.existsSync(path.join(to, name))) {
        fs.mkdirSync(to, { recursive: true });
        fs.renameSync(path.join(from, name), path.join(to, name));
      }
    } catch {}
  }
}
