import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { buildSystemPrompt } from '../src/agent/protocol.js';

test('the prompt asks to note lasting methodology in the project notes file it was given', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-notes-'));
  await fs.writeFile(path.join(cwd, 'CLAUDE.md'), '# Notes\n- run the tests with make check\n');
  const agent = new Agent({ cwd, config: { model: 'm' } });
  const p = await agent.defaultSystemPrompt();
  assert.match(p, /CLAUDE\.md at the root of the project is given to you at the start of EVERY conversation/);
  assert.match(p, /add it there with <edit>: one short line/);
  assert.match(p, /PROJECT NOTES \(from CLAUDE\.md\):\n# Notes\n- run the tests with make check/);
});

test('without a notes file: AGENTS.md, to create; none for sub-agents or outside a project', () => {
  assert.match(buildSystemPrompt({ cwd: '/p', platform: 'x' }), /AGENTS\.md at the root[\s\S]*\(create it with <write> if missing\)/);
  assert.doesNotMatch(buildSystemPrompt({ cwd: '/p', platform: 'x', subagentRole: true }), /AGENTS\.md/);
  assert.doesNotMatch(buildSystemPrompt({ cwd: '/p', platform: 'x', offProject: true }), /AGENTS\.md/);
});
