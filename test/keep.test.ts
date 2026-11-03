import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { addProjectNote, insertNote, noteHeadings, parseKeep } from '../src/agent/keep.ts';
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
  assert.deepEqual(parseKeep('{"keep": []}'), []);
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

async function compactWith(keepReply: string, config: Record<string, unknown> = {}) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const data = JSON.parse(body) as ModelRequest;
      requests.push(data);
      const keep = data.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.');
      res.end(`${JSON.stringify({ message: { content: keep ? keepReply : 'Goal: g\nNext step: s' }, done: true, done_reason: 'stop' })}\n`);
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

test('no keep step without memory, and an unreadable answer only skips it', async () => {
  const off = await compactWith(json([{ fact: 'Something to keep for sure.', where: 'memory' }]), { memoryEnabled: false });
  assert.equal(off.requests.filter((d) => d.messages.at(-1)!.content.includes('BEFORE THE SUMMARY.')).length, 0);
  assert.equal(off.r.compacted, true);
  const bad = await compactWith('not json at all');
  assert.equal(bad.r.compacted, true);
  assert.deepEqual(bad.agent.memory, []);
  const kept = bad.events.find((e): e is EventOf<'kept'> => e.type === 'kept')!;
  assert.deepEqual([kept.memory, kept.project], [[], []]);
});
