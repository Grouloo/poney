import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';

// Fake Ollama streaming each reply in small pieces, like a real server.
function fake(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const text = replies.shift() ?? 'Done.';
      const pieces = text.match(/[\s\S]{1,12}/g) || [''];
      res.end(pieces.map((p) => JSON.stringify({ message: { content: p }, done: false })).join('\n') + `\n${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${server.address().port}` })));
}
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lcx-narr-'));
const invented = 'Les fonctions ont été testées et tout fonctionne parfaitement. '.repeat(15);

test('long text after an action is cut: the action runs, the invented text is dropped', async () => {
  const cwd = await tmp();
  const f = await fake([`<write path="stats.py">\ndef mean(x):\n    return sum(x) / len(x)\n</write>\n${invented}`, 'Done.']);
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  const notices = [];
  agent.on('event', (e) => e.type === 'notice' && notices.push(e.text));
  await agent.send('create stats.py');
  f.server.close();
  assert.match(await fs.readFile(path.join(cwd, 'stats.py'), 'utf8'), /def mean/);
  assert.match(agent.messages[1].content, /<\/write>$/);
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /testées/);
  assert.ok(notices.some((n) => /continuait à écrire/.test(n)));
});

test('short text between two actions is kept, and both actions run', async () => {
  const cwd = await tmp();
  const f = await fake(['<write path="a.py">\nx = 1\n</write>\nNow the second file:\n<write path="b.py">\ny = 2\n</write>', 'Done.']);
  const agent = new Agent({ cwd, config: { baseUrl: f.url, model: 'm', shellEnabled: false } });
  await agent.send('create two files');
  f.server.close();
  assert.equal(await fs.readFile(path.join(cwd, 'b.py'), 'utf8'), 'y = 2\n');
});

test('a long final answer without action is not cut', async () => {
  const f = await fake([`Voici l'explication. ${invented}`]);
  const agent = new Agent({ cwd: await tmp(), config: { baseUrl: f.url, model: 'm' } });
  let final;
  agent.on('event', (e) => e.type === 'final' && (final = e.text));
  await agent.send('explain');
  f.server.close();
  assert.ok(final.length > 500);
});

test('a stream cut by the server keeps what was written: complete actions still run', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (++n === 1) {
        res.write(`${JSON.stringify({ message: { content: '<write path="kept.py">\nx = 1\n</write>\n<write path="lost.py">\nhalf' }, done: false })}\n`);
        setTimeout(() => res.socket.destroy(), 50); // like LM Studio's "TypeError: terminated"
      } else {
        res.end(`${JSON.stringify({ message: { content: 'Done.' }, done: true })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const cwd = await tmp();
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', shellEnabled: false } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  await agent.send('create files');
  server.close();
  assert.equal(await fs.readFile(path.join(cwd, 'kept.py'), 'utf8'), 'x = 1\n');
  await assert.rejects(fs.access(path.join(cwd, 'lost.py')));
  assert.ok(events.some((e) => e.type === 'notice' && /coupé la génération/.test(e.text)));
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.equal(events.find((e) => e.type === 'final')?.text, 'Done.');
});
