import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soberPath, withAttachedPaths } from '../src/agent/attached.ts';
import { toolView as claudeTool } from '../src/agent/claude.ts';
import { toolView as agyTool } from '../src/agent/antigravity.ts';

const scratch = '/data/scratch/c1';

test('the private folder is named .poney/ in the interface', () => {
  assert.equal(soberPath('/data/scratch/c1/notes/a.md', scratch), '.poney/notes/a.md');
  assert.equal(soberPath('file:///data/scratch/c1/a.png', scratch), '.poney/a.png');
  assert.equal(soberPath('/data/scratch/c2/a.md', scratch), null);
  assert.equal(soberPath('/data/scratch/c1/a.md', null), null);
  // Cards of Claude and Antigravity reading an attached file.
  assert.deepEqual(claudeTool('Read', { file_path: '/data/scratch/c1/rapport.pdf' }, '/project', scratch).args, { path: '.poney/rapport.pdf' });
  assert.deepEqual(claudeTool('Read', { file_path: '/project/src/a.ts' }, '/project', scratch).args, { path: 'src/a.ts' });
  assert.deepEqual(agyTool('view_file', { AbsolutePath: '/data/scratch/c1/image collée.png' }, '/project', scratch).args, { path: '.poney/image collée.png' });
});

test('the files attached reach Claude and Antigravity by their absolute path', () => {
  const text = 'Résume ça\n\nFichiers joints :\n- `.poney/rapport.md`\n- `src/a.ts`';
  assert.equal(withAttachedPaths(text, scratch), 'Résume ça\n\nFichiers joints :\n- `/data/scratch/c1/rapport.md`\n- `src/a.ts`');
  assert.equal(withAttachedPaths(text, null), text);
  // (a `.poney/` path typed in the message itself stays as it is)
  assert.equal(withAttachedPaths('lis `.poney/x`', scratch), 'lis `.poney/x`');
});

test('a conversation\'s title leaves out the list of files attached', async () => {
  const { ConversationStore } = await import('../src/conversations.ts');
  assert.equal(ConversationStore.cleanTitle('Résume ça\n\nFichiers joints :\n- `.poney/rapport.md`'), 'Résume ça');
  assert.equal(ConversationStore.cleanTitle('Fichiers joints :\n- `.poney/rapport.md`\n- `src/a.ts`'), 'rapport.md, a.ts');
});
