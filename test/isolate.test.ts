import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { merge3, copyProject, mergeCopy, dropCopy } from '../src/agent/isolate.ts';
import { cfg, port } from './helpers.ts';
import type { Fake, ModelRequest, Reply } from './helpers.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-iso-'));
const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join('\n');

test('a three-way merge takes the changes of both sides, and marks those in the same lines', () => {
  const base = 'a\nb\nc\nd\ne';
  assert.deepEqual(merge3(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE'), { text: 'A\nb\nc\nd\nE', conflicts: 0 });
  assert.deepEqual(merge3(base, 'a\nb\nX\nd\ne', 'a\nb\nX\nd\ne'), { text: 'a\nb\nX\nd\ne', conflicts: 0 }); // (the same change)
  assert.deepEqual(merge3(base, 'a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne'), { text: 'a\nb\nc\nd\ne\nf', conflicts: 0 });
  const m = merge3(base, 'a\nb\nP\nd\ne', 'a\nb\nS\nd\ne');
  assert.equal(m.conflicts, 1);
  assert.equal(m.text, 'a\nb\n<<<<<<< project\nP\n=======\nS\n>>>>>>> sub-agent\nd\ne');
});

test('a copy merged back: changes on one side taken, both sides merged, deletions, shrunk files and conflicts held', async () => {
  const cwd = await tmp();
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.mkdir(path.join(cwd, 'node_modules/dep'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'node_modules/dep/index.js'), 'dep');
  for (const f of ['src/one.ts', 'src/both.ts', 'src/same.ts', 'src/gone.ts', 'src/cut.ts', 'src/untouched.ts']) await fs.writeFile(path.join(cwd, f), lines(30));
  const copy = await copyProject(cwd);
  assert.ok(copy);
  assert.ok((await fs.lstat(path.join(copy.dir, 'node_modules'))).isSymbolicLink()); // (dependencies linked, not copied)
  const inCopy = (f: string, t: string) => fs.writeFile(path.join(copy.dir, f), t);
  await inCopy('src/one.ts', lines(30).replace('line 3\n', 'line 3 (sub)\n'));
  await inCopy('src/both.ts', lines(30).replace('line 3\n', 'line 3 (sub)\n'));
  await inCopy('src/same.ts', lines(30).replace('line 3\n', 'line 3 (sub)\n'));
  await inCopy('src/cut.ts', lines(5));
  await inCopy('src/new.ts', 'new');
  await fs.rm(path.join(copy.dir, 'src/gone.ts'));
  // Meanwhile, in the project:
  await fs.writeFile(path.join(cwd, 'src/both.ts'), lines(30).replace('line 20\n', 'line 20 (main)\n'));
  await fs.writeFile(path.join(cwd, 'src/same.ts'), lines(30).replace('line 3\n', 'line 3 (main)\n'));
  const r = await mergeCopy(copy, cwd);
  await dropCopy(copy);
  await assert.rejects(fs.stat(copy.dir));
  assert.equal(await fs.readFile(path.join(cwd, 'node_modules/dep/index.js'), 'utf8'), 'dep'); // (the link removed, not what it points to)
  assert.deepEqual(r.applied, [{ path: 'src/both.ts', how: 'merged' }, { path: 'src/new.ts', how: 'new' }, { path: 'src/one.ts', how: 'changed' }]);
  assert.deepEqual(r.held.map((h) => [h.path, h.why]), [['src/cut.ts', 'shrunk'], ['src/gone.ts', 'deleted'], ['src/same.ts', 'conflict']]);
  const at = (f: string) => fs.readFile(path.join(cwd, f), 'utf8');
  assert.match(await at('src/both.ts'), /line 3 \(sub\)[\s\S]*line 20 \(main\)/);
  assert.equal(await at('src/cut.ts'), lines(30)); // (held: the project keeps its version)
  assert.equal(await at('src/gone.ts'), lines(30));
  assert.match(await at('src/same.ts'), /line 3 \(main\)/);
  assert.match(String(r.held[2].content), /<<<<<<< project\nline 3 \(main\)\n=======\nline 3 \(sub\)\n>>>>>>> sub-agent/);
});

// Fake Ollama: the reply chosen from the request (a sub-agent sees "YOUR TASK: …" or its <agent> task).
function fake(reply: Reply) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const r = JSON.parse(body) as ModelRequest;
      requests.push(r);
      const content = r.format ? '{}' : reply(r, requests.length);
      res.end(`${JSON.stringify({ message: { content }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  return new Promise<Fake>((ok) => server.listen(0, () => ok({ server, requests, url: `http://localhost:${port(server)}` })));
}
const isSub = (r: ModelRequest) => /You are a sub-agent/.test(r.messages[0].content);
const firstTask = (r: ModelRequest) => r.messages.find((m) => m.role === 'user')!.content;
const lastIsResult = (r: ModelRequest) => /<result/.test(r.messages.at(-1)!.content);

test('sub-agents at the same time work in their own copy, and their changes are merged when they stop', async () => {
  const cwd = await tmp();
  await fs.writeFile(path.join(cwd, 'notes.md'), lines(30));
  const seen: boolean[] = [];
  const f = await fake((r) => {
    if (isSub(r)) {
      const a = firstTask(r).includes('top');
      if (lastIsResult(r)) {
        seen.push((a ? /\(top\)/ : /\(bottom\)/).test(readFileSync(path.join(cwd, 'notes.md'), 'utf8'))); // its change: not in the project yet
        return `Changed the ${a ? 'top' : 'bottom'}.`;
      }
      const [from, to] = a ? ['line 1\nline 2\nline 3', 'line 1\nline 2 (top)\nline 3'] : ['line 28\nline 29\nline 30', 'line 28\nline 29 (bottom)\nline 30'];
      return `<edit path="notes.md">\n<old>${from}</old>\n<new>${to}</new>\n</edit>`;
    }
    return lastIsResult(r) ? 'Both done.' : '<agent title="Top">\nChange the top of notes.md\n</agent>\n<agent title="Bottom">\nChange the bottom of notes.md\n</agent>';
  });
  const agent = new Agent({ cwd, config: cfg({ baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false }) });
  try {
    await agent.send('change notes.md');
  } finally {
    f.server.close();
  }
  assert.deepEqual(seen, [false, false]);
  const text = await fs.readFile(path.join(cwd, 'notes.md'), 'utf8');
  assert.match(text, /line 2 \(top\)[\s\S]*line 29 \(bottom\)/);
  const results = f.requests.filter((r) => !isSub(r)).at(-1)!.messages.at(-1)!.content;
  assert.match(results, /now in the project: notes\.md/);
  assert.match(results, /notes\.md \(merged with changes made meanwhile\)/); // (the second one)
});

test('a file a sub-agent cut to a few lines is held: the main agent is told, and finds its version in .poney/', async () => {
  const cwd = await tmp();
  const scratch = await tmp();
  await fs.writeFile(path.join(cwd, 'app.js'), lines(40));
  const f = await fake((r) => {
    if (isSub(r)) {
      const last = r.messages.at(-1)!.content;
      return /<result tool="write"/.test(last) ? 'Rewrote app.js.' : /<result tool="read"/.test(last) ? '<write path="app.js">\nconsole.log(1);\n</write>' : '<read path="app.js" />';
    }
    return lastIsResult(r) ? 'Ok.' : '<agent title="Fix">\nFix app.js\n</agent>';
  });
  const agent = new Agent({ cwd, scratch, config: cfg({ baseUrl: f.url, model: 'm', approval: 'auto', shellEnabled: false }) });
  const notices: string[] = [];
  agent.on('event', (ev) => { if (ev.type === 'notice') notices.push(ev.text); });
  try {
    await agent.send('fix app.js');
  } finally {
    f.server.close();
  }
  assert.equal(await fs.readFile(path.join(cwd, 'app.js'), 'utf8'), lines(40));
  const result = f.requests.filter((r) => !isSub(r)).at(-1)!.messages.at(-1)!.content;
  assert.match(result, /NOT in the project, for you to decide[^\n]*:\n- app\.js: its version has less than half the lines[^\n]*Its version: \.poney\/agents\/\d+\/app\.js\./);
  const id = result.match(/\.poney\/agents\/(\d+)\//)![1];
  assert.equal(await fs.readFile(path.join(scratch, 'agents', id, 'app.js'), 'utf8'), 'console.log(1);\n');
  assert.ok(notices.some((n) => /non intégré\(s\), l’agent principal décide : app\.js \(raccourci de plus de moitié\)/.test(n)));
});
