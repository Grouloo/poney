import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tokens, codeTerms, rankedSearch } from '../src/agent/codesearch.js';
import { executeAction } from '../src/agent/tools.js';
import { parseActions, normalizeToolCalls } from '../src/agent/protocol.js';

test('code words: identifiers split the code way, accents folded', () => {
  assert.deepEqual(tokens('loadConfig load_config HTTPServer'), ['load', 'config', 'load', 'config', 'http', 'server']);
  assert.deepEqual(codeTerms('Où est chargée la config ? "read file"'), ['read file', 'chargee', 'config']);
});

async function project() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-search-'));
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.mkdir(path.join(cwd, 'tests'));
  await fs.mkdir(path.join(cwd, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'src', 'config.py'), 'import json\n\ndef load_config(path):\n    """Read the settings."""\n    return json.load(open(path))\n');
  await fs.writeFile(path.join(cwd, 'src', 'server.py'), 'from config import load_config\n\ncfg = load_config("a.json")\nprint("started")\n');
  await fs.writeFile(path.join(cwd, 'src', 'store.py'), 'class Store:\n    history = []\n'); // "tor" must not match "store"/"history"
  await fs.writeFile(path.join(cwd, 'tests', 'test_config.py'), 'from config import load_config\n\ndef test_load_config():\n    assert load_config("t.json")\n');
  await fs.writeFile(path.join(cwd, 'node_modules', 'x', 'index.js'), 'loadConfig()');
  return cwd;
}

test('ranked search: the defining file first, its best lines with numbers; whole words only; ignored folders skipped', async () => {
  const cwd = await project();
  const { output } = await rankedSearch(cwd, '.', 'load config', { ignoredDirs: new Set(['node_modules']) });
  const files = output.split('\n').filter((l) => /^\S+\.py \(/.test(l)).map((l) => l.split(' ')[0]);
  assert.equal(files[0], 'src/config.py');
  assert.ok(files.includes('tests/test_config.py') && files.includes('src/server.py'));
  assert.ok(!output.includes('node_modules'));
  assert.match(output, /src\/config\.py \(\d+ match(es)?\)\n {2}3: def load_config\(path\):/);
  assert.match(output, /<read path="\.\.\." start="\.\.\." end="\.\.\." \/>/);
  assert.match((await rankedSearch(cwd, '.', 'tor', { ignoredDirs: new Set(['node_modules']) })).output, /^No file of the \d+ searched contains: tor/);
});

test('<search>keywords</search> is the ranked search; pattern="regex" still lists every matching line', async () => {
  const cwd = await project();
  const [kw, re] = parseActions('<search>load config</search><search pattern="^def \\w+" />').actions;
  const a = await executeAction(kw, { cwd, config: {} });
  assert.match(a.output, /match "load" "config"; the most relevant:\nsrc\/config\.py/);
  const b = await executeAction(re, { cwd, config: {} });
  assert.match(b.output, /src\/config\.py:3: def load_config\(path\):/);
  assert.equal(normalizeToolCalls('<|tool_call>call:search{query:<|"|>load config<|"|>}<tool_call|>'), '<search>load config</search>');
});
