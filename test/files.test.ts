import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bringInto, freeName, imagePath } from '../src/files.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'poney-files-'));

test('the file of an image an answer shows: local images only', () => {
  assert.equal(imagePath(null, '/a/b/cat.jpg'), '/a/b/cat.jpg');
  assert.equal(imagePath(null, 'file:///a/b/c%20d.png'), '/a/b/c d.png');
  assert.equal(imagePath('/project', 'img/x.webp'), '/project/img/x.webp');
  assert.equal(imagePath(null, 'img/x.webp'), null);
  assert.equal(imagePath(null, '/a/notes.txt'), null);
  assert.equal(imagePath(null, 'https://example.com/a.png'), null);
});

test('files dropped on the files panel: an image copied, Finder files moved, never over another', async () => {
  const outside = await tmp();
  const project = await tmp();
  await fs.mkdir(path.join(project, 'assets'));
  await fs.writeFile(path.join(outside, 'pony.jpg'), 'image');
  await fs.writeFile(path.join(project, 'assets', 'pony.jpg'), 'already there');
  assert.equal(await freeName(path.join(project, 'assets'), 'pony.jpg'), 'pony 2.jpg');

  // Copied: the image stays where it was.
  assert.deepEqual(await bringInto([path.join(outside, 'pony.jpg')], path.join(project, 'assets')), ['pony 2.jpg']);
  assert.equal(await fs.readFile(path.join(outside, 'pony.jpg'), 'utf8'), 'image');
  assert.equal(await fs.readFile(path.join(project, 'assets', 'pony.jpg'), 'utf8'), 'already there');

  // Moved: a file and a folder, gone from where they were.
  await fs.mkdir(path.join(outside, 'docs'));
  await fs.writeFile(path.join(outside, 'docs', 'a.md'), '# A');
  assert.deepEqual(await bringInto([path.join(outside, 'pony.jpg'), path.join(outside, 'docs')], project, { move: true }), ['pony.jpg', 'docs']);
  assert.equal(await fs.readFile(path.join(project, 'docs', 'a.md'), 'utf8'), '# A');
  await assert.rejects(fs.access(path.join(outside, 'pony.jpg')));

  // A folder into itself: refused.
  await assert.rejects(bringInto([project], path.join(project, 'assets'), { move: true }), /ne peut pas aller dans lui-même/);
  // Already in that folder: left as it is.
  assert.deepEqual(await bringInto([path.join(project, 'pony.jpg')], project, { move: true }), []);
});
