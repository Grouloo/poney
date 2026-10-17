// Conversations saved as one JSON file each: the agent's message history (to
// resume the work) and the UI events (to redraw the transcript).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_STORED_OUTPUT = 20000;
// Streaming events are redundant with assistant_end / action_end.
const SKIPPED_EVENTS = new Set(['delta', 'action_output', 'turn_start', 'context', 'compaction_start', 'prompt_progress']);

export class ConversationStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid conversation id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  create(workspace, title) {
    const now = Date.now();
    return {
      id: `${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
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
    this.save(conv, { touch: false });
    return conv.title;
  }

  delete(id) {
    fs.rmSync(this.file(id), { force: true });
  }

  /** Conversations of a workspace, most recent first (metadata only). */
  list(workspace) {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (c.workspace === workspace) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
