import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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

test('data of the old app name is moved once, without overwriting', async () => {
  const { moveAppData } = await import('../src/conversations.js');
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'lcx-move-'));
  const from = path.join(root, 'local-codex');
  const to = path.join(root, 'poney');
  fsSync.mkdirSync(path.join(from, 'conversations'), { recursive: true });
  fsSync.writeFileSync(path.join(from, 'conversations', 'a.json'), '{}');
  fsSync.writeFileSync(path.join(from, 'settings.json'), '{"workspace":"/x"}');
  fsSync.writeFileSync(path.join(from, 'Preferences'), 'chromium');
  fsSync.mkdirSync(to); // created by Electron before the app code runs
  fsSync.writeFileSync(path.join(to, 'Preferences'), 'new');
  moveAppData(from, to);
  assert.equal(fsSync.readFileSync(path.join(to, 'conversations', 'a.json'), 'utf8'), '{}');
  assert.equal(fsSync.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"workspace":"/x"}');
  assert.equal(fsSync.readFileSync(path.join(to, 'Preferences'), 'utf8'), 'new');
  assert.ok(!fsSync.existsSync(path.join(from, 'conversations')));
  fsSync.writeFileSync(path.join(to, 'settings.json'), '{"changed":true}');
  fsSync.mkdirSync(path.join(from, 'conversations'));
  moveAppData(from, to); // a second run never overwrites
  assert.equal(fsSync.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"changed":true}');
});
