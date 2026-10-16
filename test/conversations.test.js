import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/conversations.js';

test('rename keeps the conversation in place and cleans the title', async () => {
  const store = new ConversationStore(await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-conv-')));
  const a = store.create('/w', 'first');
  store.save(a);
  await new Promise((r) => setTimeout(r, 5));
  const b = store.create('/w', 'second');
  store.save(b);
  assert.deepEqual(store.list('/w').map((c) => c.title), ['second', 'first']);

  assert.equal(store.rename(a.id, '  Mon   refactor\n du parser  '), 'Mon refactor du parser');
  assert.deepEqual(store.list('/w').map((c) => c.title), ['second', 'Mon refactor du parser'], 'order unchanged');
  assert.equal(store.rename(a.id, '   '), 'Mon refactor du parser', 'empty title ignored');
  assert.equal(store.rename(a.id, 'x'.repeat(200)).length, 80);
});
