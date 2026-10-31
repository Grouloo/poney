import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAgent, toolView, claudeModels, claudeLoggedIn, claudeError } from '../src/agent/claude.js';

const stream = (event, parent = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });
const start = stream({ type: 'message_start' });
const stop = stream({ type: 'message_stop' });
const text = (t) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const tool = (index, id, name, input, parent = null) => [
  stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } }, parent),
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, parent),
  stream({ type: 'content_block_stop', index }, parent),
];
const result = (id, content, is_error = false, parent = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const done = { type: 'result', subtype: 'success', result: 'Fini.', duration_ms: 2000, duration_api_ms: 1000, num_turns: 2, usage: { output_tokens: 50 } };
const init = { type: 'system', subtype: 'init', session_id: 'abc' };

function agent(messages, { approve = async () => true, options } = {}) {
  const calls = [];
  const a = new ClaudeAgent({
    cwd: '/project',
    executable: '/bin/claude',
    approve,
    query: (params) => {
      calls.push(params);
      return (async function* () { for (const m of typeof messages === 'function' ? await messages(params) : messages) yield m; })();
    },
  });
  a.choice = { engine: 'claude', model: 'opus', effort: 'high', mode: 'manual', ...options };
  const events = [];
  a.on('event', (e) => events.push(e));
  return { a, events, calls };
}

test('the harness of Claude becomes the events of the interface', async () => {
  const { a, events, calls } = agent([init, start, text('Je lis.'), ...tool(1, 't1', 'Read', { file_path: '/project/src/a.js' }), stop, result('t1', [{ type: 'text', text: 'contenu' }]), start, text('Fini.'), stop, done]);
  await a.send('lis a.js', { turnId: 'x' });
  assert.deepEqual(events.map((e) => e.type), ['turn_start', 'assistant_start', 'delta', 'assistant_end', 'action_start', 'action_end', 'assistant_start', 'delta', 'assistant_end', 'final', 'turn_end']);
  const started = events.find((e) => e.type === 'action_start');
  assert.deepEqual([started.tool, started.args], ['read', { path: 'src/a.js' }]);
  assert.equal(events.find((e) => e.type === 'action_end').output, 'contenu');
  assert.equal(events.at(-1).reason, 'done');
  assert.equal(events.at(-1).stats.tokens, 50);
  assert.equal(a.sessionId, 'abc');
  const o = calls[0].options;
  assert.deepEqual([o.model, o.effort, o.permissionMode, o.resume], ['opus', 'high', 'default', undefined]);
  await a.send('encore');
  assert.equal(calls[1].options.resume, 'abc');
});

test('the modes of the interface are the permission modes of Claude', async () => {
  for (const [mode, expected] of [['auto', 'auto'], ['manual', 'default'], ['plan', 'plan']]) {
    const { a, calls } = agent([done], { options: { mode } });
    await a.send('go');
    assert.equal(calls[0].options.permissionMode, expected);
  }
});

test('a permission is the question of the interface, on the card of the tool', async () => {
  let asked = null;
  const approve = async (req) => { asked = req; return { ok: false, reason: 'pas ça' }; };
  let answer;
  const { a, events } = agent(async (params) => {
    answer = await params.options.canUseTool('Bash', { command: 'rm x' }, { toolUseID: 't1' });
    return [result('t1', 'refusé', true), done];
  }, { approve });
  await a.send('go');
  const card = events.find((e) => e.type === 'action_start');
  assert.equal(asked.id, card.id);
  assert.equal(card.tool, 'run');
  assert.ok(asked.claude);
  assert.deepEqual(answer, { behavior: 'deny', message: 'pas ça' });
  assert.equal(events.find((e) => e.type === 'action_end').ok, false);
});

test('the work of a sub-agent goes inside its card', async () => {
  const { a, events } = agent([start, ...tool(0, 'sub', 'Agent', { description: 'Explorer', prompt: 'cherche' }), stop, stream({ type: 'message_start' }, 'sub'), ...tool(0, 't2', 'Grep', { pattern: 'x' }, 'sub'), stream({ type: 'message_stop' }, 'sub'), result('t2', 'trouvé', false, 'sub'), result('sub', 'Rapport'), done]);
  await a.send('go');
  const card = events.find((e) => e.type === 'action_start' && e.tool === 'agent');
  assert.deepEqual(card.args, { title: 'Explorer', task: 'cherche' });
  const inner = events.find((e) => e.type === 'action_start' && e.tool === 'search');
  assert.equal(inner.agentId, card.id);
  assert.equal(events.find((e) => e.type === 'action_end' && e.id === card.id).output, 'Rapport');
});

test('stopped: no card goes on, and the turn ends as stopped', async () => {
  const { a, events } = agent(async (params) => {
    a.stop();
    params.options.abortController.signal.throwIfAborted();
    return [];
  });
  await a.send('go');
  assert.equal(events.at(-1).reason, 'stopped');
  assert.ok(events.some((e) => e.type === 'notice' && e.text === 'Arrêté.'));
  assert.equal(a.running, false);
});

test('an edit shows its diff, the other tools a card named after them', async () => {
  const { a, events } = agent([start, ...tool(0, 'e', 'Edit', { file_path: '/project/a.js', old_string: 'a', new_string: 'b' }), stop, result('e', 'ok'), done]);
  await a.send('go');
  assert.match(events.find((e) => e.type === 'action_end').diff, /^\+b$/m);
  assert.deepEqual(toolView('CronCreate', { schedule: '0 8 * * *' }, '/p'), { tool: 'CronCreate', args: { path: '0 8 * * *' } });
});

test('a Poney skill reaches Claude, and /name is not read as one of its commands', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-claude-'));
  const { a, calls, events } = agent([done]);
  a.cwd = cwd;
  await a.send('/grilling mon plan');
  assert.match(calls[0].prompt, /^grilling mon plan/);
  assert.match(calls[0].prompt, /\(Skill "grilling"/);
  assert.equal(events.find((e) => e.type === 'skill').skills[0].name, 'grilling');
});

test('the models come from the Claude harness', async () => {
  let closed = false;
  const q = { supportedModels: async () => [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'high'], supportsAutoMode: true }], close: () => { closed = true; } };
  assert.deepEqual(await claudeModels('/bin/claude', { query: () => q }), [{ value: 'opus', name: 'Opus', efforts: ['low', 'high'], auto: true }]);
  assert.ok(closed);
});

test('not logged in: seen before the first message, and said in the words of the interface', async () => {
  const says = (stdout, error = null) => (exe, args, opts, done) => done(error, stdout);
  assert.equal(await claudeLoggedIn('/bin/claude', says('{"loggedIn": false}')), false);
  assert.equal(await claudeLoggedIn('/bin/claude', says('{"loggedIn": true}')), true);
  assert.equal(await claudeLoggedIn('/bin/claude', says('', new Error('no such command'))), false);
  assert.match(claudeError('Claude Code returned an error result: Not logged in · Please run /login'), /claude auth login/);
  assert.doesNotMatch(claudeError('Claude Code returned an error result: boom in Claude Code'), /Claude Code/);
});

test('a failed result is said once, and ends the turn as an error', async () => {
  const { a, events } = agent(async () => [{ type: 'result', subtype: 'error_during_execution', errors: ['Not logged in'] }]);
  await a.send('go');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.equal(events.at(-1).reason, 'error');
});

test('the reasoning is asked for as a summary, and an empty one shows nothing', async () => {
  const think = (t) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
  const { a, events, calls } = agent([init, start, think(''), think('Je compare.'), think(''), text('Fini.'), stop, done]);
  await a.send('compare');
  assert.deepEqual(calls[0].options.thinking, { type: 'adaptive', display: 'summarized' });
  const thoughts = events.filter((e) => e.kind === 'thinking');
  assert.deepEqual(thoughts.map((e) => [e.text, e.summary]), [['Je compare.', true]]);
  assert.equal(events.find((e) => e.type === 'assistant_end').thinking, 'Je compare.');
});
