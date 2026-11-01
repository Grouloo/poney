import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { port } from './helpers.ts';
import type { ModelRequest } from './helpers.ts';
import { cfg } from './helpers.ts';
import type { Fake } from './helpers.ts';
import type { ModelReply } from './helpers.ts';
import type { ModelMessage } from './helpers.ts';

// The server can only reuse its cache (and skip re-reading the prompt) if each
// request starts with exactly the previous one.
function fakeOllama(replies: ModelReply[]) {
  const requests: ModelRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body) as ModelRequest);
      const r = replies.shift() ?? { content: 'Done.' };
      const lines: object[] = [];
      if (r.thinking) lines.push({ message: { thinking: r.thinking }, done: false });
      lines.push({ message: { content: r.content }, done: false });
      lines.push({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10 });
      res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  });
  return new Promise<Fake>((resolve) => server.listen(0, () => resolve({ server, requests, url: `http://localhost:${port(server)}` })));
}

const firstDiff = (a: ModelMessage[], b: ModelMessage[]) => a.findIndex((m, i) => JSON.stringify(m) !== JSON.stringify(b[i]));

test('within a turn, each request extends the previous one (cache-friendly)', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-prefix-'));
  await fs.writeFile(path.join(cwd, 'a.py'), 'x = 1\n');
  const fake = await fakeOllama([
    { thinking: 'plan: read', content: '<read path="a.py" />' },
    { thinking: 'now edit', content: '<edit path="a.py">\n<old>x = 1</old>\n<new>x = 2</new>\n</edit>\n<read path="a.py" />' },
    { thinking: 'check', content: '<list />' },
    { content: 'Done.' },
  ]);
  const agent = new Agent({ cwd, config: cfg({ baseUrl: fake.url, model: 'fake', shellEnabled: false }) });
  await agent.send('change x to 2');
  fake.server.close();
  for (let i = 1; i < fake.requests.length; i++) {
    const prev = fake.requests[i - 1].messages;
    const cur = fake.requests[i].messages;
    const d = firstDiff(prev, cur);
    assert.equal(d, -1, `request ${i} differs from request ${i - 1} at message ${d}`);
  }
});
