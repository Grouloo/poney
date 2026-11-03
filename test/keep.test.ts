import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { addProjectNote, insertNote, keepProposed, noteHeadings, parseKeep, projectPath } from '../src/agent/keep.ts';
import { port } from './helpers.ts';
import type { ModelRequest } from './helpers.ts';
import type { AgentEvent, EventOf } from '../src/types.ts';

const json = (keep: unknown[]) => JSON.stringify({ keep });

test('what to keep is cleaned: no restatement, nothing banal, a project fact only in a project', () => {
  const memory = ['The user wants answers in English.'];
  const notes = '# Commands\n- `npm test` runs all the tests';
  const items = parseKeep(json([
    { fact: 'The parser must accept tabs as separators.', where: 'memory' },
    { fact: 'Answers in English, the user wants them.', where: 'memory' }, // (already in memory)
    { fact: 'npm test runs all the tests', where: 'project' }, // (already in the notes)
    { fact: 'The user asked for help with the parser.', where: 'memory' }, // (about the conversation)
    { fact: 'short', where: 'memory' },
    { fact: 'Nothing worth keeping here at all.', where: 'none' },
    { fact: 'The build needs Node 24 or later.', where: 'project', section: '## Commands' },
  ]), { memory, notes });
  assert.deepEqual(items, [
    { fact: 'The parser must accept tabs as separators.', where: 'memory', section: '' },
    { fact: 'The build needs Node 24 or later.', where: 'project', section: 'Commands' },
  ]);
  // Outside a project: kept in the memory instead.
  assert.deepEqual(parseKeep(json([{ fact: 'The build needs Node 24 or later.', where: 'project' }]), { project: false }), [{ fact: 'The build needs Node 24 or later.', where: 'memory', section: '' }]);
  // At most 3, and twice the same only once.
  const many = ['The database is SQLite, in data/app.db.', 'Dates are stored in UTC everywhere.', 'The logo must stay blue on every page.', 'Exports are limited to CSV files.', 'Login uses magic links sent by email.']
    .map((fact) => ({ fact, where: 'memory' }));
  assert.equal(parseKeep(json([many[0], many[0], ...many.slice(1)]))!.length, 3);
  assert.equal(parseKeep('no json'), null);

  // Another file: one, inside the project, with a task; only when sub-agents may run.
  const doc = { fact: 'The export format changed', where: 'file', path: './docs/export.md', task: 'Say that exports are CSV only, since v2 (the user asked).' };
  assert.deepEqual(parseKeep(json([doc, { ...doc, path: 'docs/other.md' }]), { files: true }), [{ ...doc, path: 'docs/export.md', section: '' }]);
  assert.deepEqual(parseKeep(json([doc])), []); // (sub-agents off, or outside a project)
  assert.deepEqual(parseKeep(json([{ ...doc, path: '../elsewhere.md' }, { ...doc, path: '/etc/hosts' }, { ...doc, task: 'short' }]), { files: true }), []);
  assert.deepEqual(parseKeep(json([{ ...doc, fact: 'Exports are CSV only since v2.', path: 'AGENTS.md' }]), { files: true }), [{ fact: 'Exports are CSV only since v2.', where: 'project', section: '' }]); // (the app's own)
  assert.equal(projectPath('.poney/notes.md'), null);
  assert.equal(projectPath('docs\\a.md'), 'docs/a.md');
  assert.deepEqual(parseKeep('{"keep": []}'), []);
  // A preference of the user is not banal.
  assert.deepEqual(parseKeep(json([{ fact: 'The user wants the notes in paragraphs, no bullet points.', where: 'memory' }]))!.map((i) => i.fact), ['The user wants the notes in paragraphs, no bullet points.']);
  assert.equal(keepProposed(json([{ fact: 'a', where: 'memory' }, { fact: 'b', where: 'none' }])), 1);
  assert.equal(keepProposed('no json'), 0);
});

test('a project line goes at the end of the section the model names, or under a new heading', async () => {
  const notes = '# Poney\n\nIntro.\n\n## Commands\n\n- `npm test`: all the tests.\n- `npm start`: run.\n\n## Rules\n\n- No `any`.\n\n```md\n## Not a heading\n```\n';
  assert.deepEqual(noteHeadings(notes), ['Commands', 'Rules']);
  const a = insertNote(notes, 'Run  one file with node --test', 'commands');
  assert.equal(a.section, 'Commands');
  assert.match(a.text, /- `npm start`: run\.\n- Run one file with node --test\n\n## Rules/);
  const b = insertNote(notes, 'Keep skills short', 'Rules');
  assert.match(b.text, /- No `any`\.\n\n```md\n## Not a heading\n```\n- Keep skills short\n$/); // (the end of the section, after its code block)
  const c = insertNote(notes, 'Ports in use: 9335', 'Ports');
  assert.equal(c.section, 'Ports');
  assert.match(c.text, /```\n\n## Ports\n\n- Ports in use: 9335\n$/);
  assert.equal(insertNote('# Title\n', 'A fact', '').text, '# Title\n\n## Notes\n\n- A fact\n');
  assert.equal(insertNote('', 'A fact', 'Tests').text, '## Tests\n\n- A fact\n');

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-keep-'));
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), notes);
  assert.equal(await addProjectNote(cwd, '../AGENTS.md', 'Node 24', 'Commands'), 'Commands'); // (only at the root of the project)
  assert.match(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), /- `npm start`: run\.\n- Node 24\n/);
});

async function compactWith(keepReply: string | ((n: number) => string), config: Record<string, unknown> = {}, other = (_: ModelRequest) => 'Goal: g\nNext step: s') {
  const requests: ModelRequest[] = [];
  let asked = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body) as ModelRequest;
      requests.push(data);
      const keep = data.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.');
      res.end(`${JSON.stringify({ message: { content: keep ? (typeof keepReply === 'string' ? keepReply : keepReply(++asked)) : other(data) }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-keep-'));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${port(server)}`, model: 'fake', numCtx: 8192, maxTokens: 512, ...config } });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  agent.messages.push({ role: 'user', content: 'task' });
  for (let i = 0; i < 12; i++) {
    agent.messages.push({ role: 'assistant', content: `<read path="p${i}.py" />` });
    agent.messages.push({ role: 'user', content: `<result tool="read" path="p${i}.py" lines="1-9">\n${'data '.repeat(400)}\n</result>` });
  }
  const r = await agent.maybeCompact('system', new AbortController().signal);
  server.close();
  return { agent, events, requests, r, cwd };
}

test('before a compaction, the model says what to keep: written to the memory and to the project notes', async () => {
  const { agent, events, requests, r, cwd } = await compactWith(json([
    { fact: 'Files p0 to p11 hold the parser, p3 is the entry point.', where: 'memory' },
    { fact: 'The fixtures of the project are in p11.py.', where: 'project', section: 'Tests' },
  ]));
  assert.equal(r.compacted, true);
  // One call on the cached conversation, before the summary: it says what leaves the view.
  const keep = requests.findIndex((d) => d.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.'));
  assert.equal(keep, 0);
  assert.ok(requests[keep].format, 'constrained JSON');
  assert.match(requests[keep].messages.at(-1)!.content, /Everything above the message that starts with « <\w+ / );
  assert.match(requests[keep].messages.at(-1)!.content, /added to AGENTS\.md/);
  assert.match(requests[keep].messages.at(-1)!.content, /"section", for "project": a short heading for it in AGENTS\.md/);
  assert.deepEqual(agent.memory, ['Files p0 to p11 hold the parser, p3 is the entry point.']);
  const kept = events.find((e): e is EventOf<'kept'> => e.type === 'kept')!;
  assert.deepEqual(kept.memory, ['Files p0 to p11 hold the parser, p3 is the entry point.']);
  assert.deepEqual(kept.project, [{ fact: 'The fixtures of the project are in p11.py.', section: 'Tests' }]);
  assert.equal(kept.file, 'AGENTS.md');
  assert.equal(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), '## Tests\n\n- The fixtures of the project are in p11.py.\n');
  // The note is in the summary that replaces the old messages.
  const c = events.find((e): e is EventOf<'compaction'> => e.type === 'compaction')!;
  assert.match(c.summary, /MEMORY[^\n]*\n1\. Files p0 to p11 hold the parser/);
  assert.ok(events.findIndex((e) => e.type === 'kept') < events.findIndex((e) => e.type === 'compaction_start'));
});

test('an unreadable review is asked again, and JSON in prose or a code fence is read', async () => {
  const fact = json([{ fact: 'The export runs every night at 2.', where: 'memory' }]);
  const r = await compactWith((n) => (n === 1 ? 'Here is what I would keep: the export.' : `Sure:\n\`\`\`json\n${fact}\n\`\`\`\nThat is all {}.`));
  const asks = r.requests.filter((d) => d.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.'));
  assert.equal(asks.length, 2);
  assert.match(asks[1].messages.at(-1)!.content, /could not be used/);
  assert.ok(r.events.some((e) => e.type === 'notice' && /nouvel essai \(2\/3\)/.test(e.text)));
  assert.deepEqual(r.agent.memory.map((m) => m.replace(/^\[[^\]]*\]\s*/, '')).filter((m) => m.includes('export')).length, 1);
});

test('no keep step without memory, and an unreadable answer only skips it', async () => {
  const off = await compactWith(json([{ fact: 'Something to keep for sure.', where: 'memory' }]), { memoryEnabled: false });
  assert.equal(off.requests.filter((d) => d.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.')).length, 0);
  assert.equal(off.r.compacted, true);
  const bad = await compactWith('not json at all');
  assert.equal(bad.r.compacted, true);
  assert.deepEqual(bad.agent.memory, []);
  const kept = bad.events.find((e): e is EventOf<'kept'> => e.type === 'kept')!;
  assert.deepEqual([kept.memory, kept.project], [[], []]);
  assert.equal(kept.failed, 'réponse du modèle illisible'); // (told apart from nothing to keep)
  assert.equal(bad.requests.filter((d) => d.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.')).length, 3); // (asked again first)
  const known = await compactWith(json([{ fact: 'Something to keep for sure.', where: 'memory' }, { fact: 'The user asked for help with it.', where: 'memory' }]));
  const k2 = known.events.find((e): e is EventOf<'kept'> => e.type === 'kept')!;
  assert.equal(k2.failed, undefined);
  assert.equal(k2.dropped, 1); // (the banal one)
});

test('a doc to update is left to a sub-agent, before the summary, with what it needs', async () => {
  const task = 'Add that exports are CSV only since v2, at the end of the Export section.';
  const { events, requests, r, cwd } = await compactWith(json([{ fact: 'Exports are CSV only', where: 'file', path: 'docs/export.md', task }]), {}, (d) => {
    const last = d.messages.at(-1)!.content;
    if (/Update the file docs\/export\.md/.test(last)) return '<write path="docs/export.md">\n# Export\n\nCSV only since v2.\n</write>';
    if (/tool="write"/.test(last)) return 'Added the CSV line to docs/export.md.';
    return 'Goal: g\nNext step: s';
  });
  assert.equal(r.compacted, true);
  assert.equal(await fs.readFile(path.join(cwd, 'docs/export.md'), 'utf8'), '# Export\n\nCSV only since v2.\n');
  // Its own window: the task, not the conversation.
  const sub = requests.find((d) => /Update the file docs\/export\.md/.test(d.messages.at(-1)!.content))!;
  assert.ok(sub.messages.at(-1)!.content.includes(task));
  assert.ok(!sub.messages.some((m) => m.content.includes('p11.py')));
  const kept = events.find((e): e is EventOf<'kept'> => e.type === 'kept')!;
  assert.equal(kept.update, 'docs/export.md');
  const start = events.find((e): e is EventOf<'action_start'> => e.type === 'action_start' && e.tool === 'agent' && !e.agentId)!;
  assert.equal(start.auto, true); // (the app's, not a tag of the model: no "resume from here")
  // Before the summary, which says it is done.
  assert.ok(events.indexOf(start) < events.findIndex((e) => e.type === 'compaction_start'));
  const c = events.find((e): e is EventOf<'compaction'> => e.type === 'compaction')!;
  assert.match(c.summary, /FILE UPDATED: docs\/export\.md \(updated before this summary by a helper\): Added the CSV line/);
});
