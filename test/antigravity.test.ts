import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AntigravityAgent, agyError, agyModels, parseModels, toolView } from '../src/agent/antigravity.ts';
import { readImage } from '../src/files.ts';
import { parseJson, isStringArray } from '../src/unknown.ts';
import type { AgentEvent, EventOf } from '../src/types.ts';

// A fake agy: prints the lines of its script (stream-json), then exits; its arguments are kept.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.AGY_ARGS, JSON.stringify(process.argv.slice(2)));
const script = JSON.parse(fs.readFileSync(process.env.AGY_SCRIPT, 'utf8'));
for (const [rel, text] of Object.entries(script.files || {})) {
  const file = require('path').join(process.env.AGY_BRAIN, rel);
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
if (script.stderr) process.stderr.write(script.stderr);
for (const line of script.stdout) process.stdout.write(JSON.stringify(line) + '\\n');
setTimeout(() => process.exit(script.code || 0), script.sleep || 0);
`;

interface Script { stdout: unknown[]; stderr?: string; code?: number; sleep?: number; files?: Record<string, string> }

async function fakeAgy() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-agy-'));
  const executable = path.join(dir, 'agy');
  await fs.writeFile(executable, FAKE, { mode: 0o755 });
  process.env.AGY_ARGS = path.join(dir, 'args.json');
  process.env.AGY_SCRIPT = path.join(dir, 'script.json');
  process.env.AGY_BRAIN = path.join(dir, 'brain');
  const agent = new AntigravityAgent({ cwd: dir, executable, brain: path.join(dir, 'brain') });
  const events: AgentEvent[] = [];
  agent.on('event', (e) => events.push(e));
  return {
    dir,
    agent,
    events,
    script: (s: Script) => fs.writeFile(path.join(dir, 'script.json'), JSON.stringify(s)),
    args: async () => {
      const a = parseJson(await fs.readFile(path.join(dir, 'args.json'), 'utf8'));
      return isStringArray(a) ? a : [];
    },
  };
}

// (as agy 1.4 prints them: the fields under the event's name)
const step = (conversation: string, index: number, fields: Record<string, unknown>) => ({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, ...fields } });
const result = (fields: Record<string, unknown>) => ({ event: 'result', result: fields });
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((e): e is EventOf<T> => e.type === type);

test('a message runs agy headless, and its steps become the cards and answers of Poney', async () => {
  const { dir, agent, events, script, args } = await fakeAgy();
  const image = '/tmp/brain/c1/siamese_cat_1.jpg';
  await script({
    stdout: [
      { event: 'init', conversation_id: 'c1', init: { cwd: dir, tools: ['generate_image'], permission_mode: 'request-review' } },
      step('c1', 0, { state: 'DONE', step_type: 'user_input' }),
      step('c1', 1, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Je génère ' }),
      step('c1', 1, { state: 'DONE', step_type: 'agent_response', text_delta: 'l’image.' }),
      step('c1', 2, { state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', parameters: { Role: '"Image Generator"', Prompt: '"A cat"' } }, subagent_info: { subagents: [{ type_name: 'image-generator', role: 'Image Generator', conversation_id: 'c2' }] } }),
      step('c2', 1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'generate_image', tool_info: { name: 'generate_image', parameters: { ImageName: '"siamese_cat"', Prompt: '"A Siamese cat"' } } }),
      step('c2', 1, { state: 'DONE', step_type: 'tool', tool_name: 'generate_image', tool_info: { name: 'generate_image', parameters: {}, output: `Saved ${image}` } }),
      step('c9', 1, { state: 'DONE', step_type: 'agent_response', text_delta: 'unknown' }),
      step('c1', 2, { state: 'DONE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', output: 'Created the subagent' } }),
      step('c1', 3, { state: 'DONE', step_type: 'agent_response', text_delta: `Voici :\n\n![Chat](${image})` }),
      result({ conversation_id: 'c1', status: 'SUCCESS', response: `Voici :\n\n![Chat](${image})`, duration_seconds: 12, num_turns: 4, usage: { output_tokens: 300, thinking_tokens: 100 } }),
    ],
  });
  agent.choice = { engine: 'antigravity', model: 'gemini-3-pro', effort: 'high', mode: 'auto' };
  await agent.send('génère un chat');
  assert.deepEqual(await args(), ['-p', 'génère un chat', '--output-format', 'stream-json', '--print-timeout', '0s', '--model', 'gemini-3-pro', '--dangerously-skip-permissions']);

  const ends = of(events, 'assistant_end');
  assert.deepEqual(ends.map((e) => e.text), ['Je génère l’image.', `Voici :\n\n![Chat](${image})`]);
  const starts = of(events, 'action_start');
  assert.deepEqual(starts.map((e) => [e.tool, e.args]), [['agent', { title: 'Image Generator', task: 'A cat' }], ['image', { path: 'siamese_cat' }]]);
  assert.equal(starts[1].agentId, starts[0].id); // (the sub-agent's step, in its card)
  assert.equal(of(events, 'action_end').find((e) => e.id === starts[1].id)?.output, `Saved ${image}`);
  assert.ok(!events.some((e) => e.type === 'delta' && e.text === 'unknown')); // (a conversation of which nothing is known)
  assert.deepEqual(of(events, 'final').map((e) => e.text), [`Voici :\n\n![Chat](${image})`]);
  const end = of(events, 'turn_end')[0];
  assert.equal(end.reason, 'done');
  assert.equal(end.stats?.tokens, 400);
  assert.equal(end.stats?.totalMs, 12000);
  assert.equal(agent.sessionId, 'c1');

  // The next message goes on with the same conversation; Plan and Manual.
  await script({ stdout: [result({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' })] });
  agent.choice = { engine: 'antigravity', mode: 'plan' };
  await agent.send('et ensuite');
  assert.deepEqual(await args(), ['-p', 'et ensuite', '--output-format', 'stream-json', '--print-timeout', '0s', '--conversation', 'c1', '--mode', 'plan']);
  agent.choice = { engine: 'antigravity', mode: 'manual' };
  await agent.send('encore');
  assert.deepEqual((await args()).slice(6), ['--conversation', 'c1']);
});

test('a turn as agy 1.4.12 prints it', async () => {
  const { agent, events, script } = await fakeAgy();
  // (an actual run of "Réponds juste OK", tools cut short)
  await script({ stdout: [
    { event: 'init', conversation_id: 'ad26b583', init: { model: 'gemini-3.8-flash-low', cwd: '/tmp/x', tools: ['generate_image', 'view_file'], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: 'ad26b583', step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'step_update', step_update: { conversation_id: 'ad26b583', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'OK' } },
    { event: 'step_update', step_update: { conversation_id: 'ad26b583', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 2.024337, usage: { input_tokens: 6856, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 6857 } } },
    { event: 'result', result: { conversation_id: 'ad26b583', status: 'SUCCESS', response: 'OK\n', duration_seconds: 2.054322, num_turns: 1, usage: { input_tokens: 6856, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 6857 } } },
  ] });
  await agent.send('Réponds juste OK');
  assert.deepEqual(of(events, 'assistant_end').map((e) => e.text), ['OK\n']);
  assert.deepEqual(of(events, 'final').map((e) => e.text), ['OK\n']);
  assert.equal(of(events, 'turn_end')[0].stats?.tokens, 1);
  assert.equal(agent.sessionId, 'ad26b583');
});

test('the reasoning and the sub-agents\' steps come from agy\'s logs', async () => {
  const { agent, events, script } = await fakeAgy();
  const log = (steps: object[]) => steps.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const image = '/brain/main/pony.jpg';
  await script({
    files: {
      'main/.system_generated/logs/transcript_full.jsonl': log([
        { step_index: 0, type: 'USER_INPUT', content: 'un poney' },
        { step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'Je délègue l’image.', tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Pony Generator' } }] },
        { step_index: 2, type: 'GENERIC', content: 'Created the following subagent' },
        { step_index: 3, type: 'PLANNER_RESPONSE', thinking: 'Le fichier est prêt.', content: 'Voici.' },
      ]),
      'main/.system_generated/subagents/sub.json': JSON.stringify({ conversationId: 'sub', subagentDescriptor: { typeName: 'image-generator', role: 'Pony Generator' }, spawnStepIndex: 2 }),
      'sub/.system_generated/logs/transcript_full.jsonl': log([
        { step_index: 0, type: 'SYSTEM_MESSAGE', content: 'Generate a pony' },
        { step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'A white pony, pink mane.', tool_calls: [{ name: 'generate_image', args: { ImageName: 'pony', Prompt: 'A white pony' } }] },
        { step_index: 2, type: 'GENERIC', status: 'DONE', content: `Created At: 2026-11-04T00:13:27+01:00\nCompleted At: 2026-11-04T00:13:36+01:00\nGenerated image is saved at ${image}.` },
        { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Sent back.' },
      ]),
    },
    stdout: [
      { event: 'init', conversation_id: 'main', init: {} },
      step('main', 2, { state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', parameters: { Role: 'Pony Generator' } } }),
      step('main', 2, { state: 'DONE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', output: 'Created' } }),
      step('main', 3, { state: 'DONE', step_type: 'agent_response', text_delta: 'Voici.' }),
      result({ conversation_id: 'main', status: 'SUCCESS', response: 'Voici.' }),
    ],
  });
  await agent.send('un poney');
  const ends = of(events, 'assistant_end');
  // The main conversation: the reasoning before its call, then the answer with its own.
  const main = ends.filter((e) => !e.agentId);
  assert.deepEqual(main.map((e) => [e.text, e.thinking]), [['', 'Je délègue l’image.'], ['Voici.', 'Le fichier est prêt.']]);
  const card = of(events, 'action_start').find((e) => e.tool === 'agent')!;
  assert.ok(events.indexOf(main[0]) < events.indexOf(card)); // (the reasoning before the card)
  // The sub-agent: its steps in its card.
  const sub = events.filter((e) => e.agentId === card.id);
  assert.deepEqual(of(sub, 'assistant_end').map((e) => [e.text, e.thinking]), [['', 'A white pony, pink mane.'], ['Sent back.', '']]);
  const generate = of(sub, 'action_start')[0];
  assert.deepEqual([generate.tool, generate.args], ['image', { path: 'pony' }]);
  assert.deepEqual(of(sub, 'action_end').map((e) => [e.id, e.ok, e.output]), [[generate.id, true, `Generated image is saved at ${image}.`]]);

  // The next message: nothing of before is shown again.
  events.length = 0;
  await script({ stdout: [result({ conversation_id: 'main', status: 'SUCCESS', response: 'ok' })] });
  await agent.send('merci');
  assert.ok(!events.some((e) => e.type === 'assistant_end' || e.agentId !== undefined));
});

test('what goes wrong with agy is said once, in the words of the interface', async () => {
  const { agent, events, script } = await fakeAgy();
  await script({ stdout: [], stderr: 'Error: authentication required\n', code: 1 });
  await agent.send('bonjour');
  assert.deepEqual(of(events, 'error').map((e) => e.message), ['Antigravity n’est pas connecté : lancez « agy » une fois dans un terminal pour vous connecter avec votre compte Google.']);
  assert.equal(of(events, 'turn_end')[0].reason, 'error');

  events.length = 0;
  await script({ stdout: [result({ status: 'ERROR', error: { type: 'model', message: 'Unknown model "x"' } })], code: 1 });
  await agent.send('bonjour');
  assert.deepEqual(of(events, 'error').map((e) => e.message), ['Unknown model "x"']);

  // Tools it could not ask for: said.
  events.length = 0;
  await script({ stdout: [result({ status: 'SUCCESS', response: 'fait' })], stderr: 'Permission denied for run_command(npm test)\n' });
  await agent.send('teste');
  assert.match(of(events, 'notice')[0].text, /Antigravity : Permission denied for run_command\(npm test\)/);

  // Nothing it can read, but a clean exit: not a turn done.
  events.length = 0;
  await script({ stdout: [{ event: 'something_new', something_new: {} }] });
  await agent.send('bonjour');
  assert.deepEqual(of(events, 'error').map((e) => e.message), ['agy n’a rendu aucun résultat.']);
  assert.equal(of(events, 'turn_end')[0].reason, 'error');

  const missing = new AntigravityAgent({ cwd: os.tmpdir(), executable: null });
  const said: AgentEvent[] = [];
  missing.on('event', (e) => said.push(e));
  await missing.send('bonjour');
  assert.match(of(said, 'error')[0].message, /pas installé/);
  assert.equal(agyError(''), 'Antigravity n’a pas pu terminer.');
});

test('a message stopped stops agy, and no card goes on turning', async () => {
  const { agent, events, script } = await fakeAgy();
  await script({ stdout: [step('c1', 1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: '"sleep 10"' } } })], sleep: 10000 });
  const sent = agent.send('attends');
  while (!events.some((e) => e.type === 'action_start')) await new Promise((r) => setTimeout(r, 20));
  assert.ok(agent.running);
  agent.stop();
  await sent;
  assert.equal(of(events, 'turn_end')[0].reason, 'stopped');
  assert.deepEqual(of(events, 'action_end').map((e) => [e.ok, e.output]), [[false, 'Arrêté.']]);
  assert.ok(!agent.running);
});

test('the models of agy, as JSON or as a table', async () => {
  assert.deepEqual(parseModels('["gemini-3-pro", "claude-opus-4"]').map((m) => m.value), ['gemini-3-pro', 'claude-opus-4']);
  assert.deepEqual(parseModels('{"models":[{"slug":"gemini-3-flash","displayName":"Gemini 3 Flash"}]}'), [{ value: 'gemini-3-flash', name: 'Gemini 3 Flash' }]);
  assert.deepEqual(parseModels('Available models:\n\n  SLUG            NAME\n  ------------\n* gemini-3-pro     Gemini 3 Pro (default)\n  gemini-3-flash   Gemini 3 Flash\n  claude-sonnet-4-5\n'), [
    { value: 'gemini-3-pro', name: 'Gemini 3 Pro' },
    { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    { value: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
  ]);
  const listed = await agyModels('/bin/agy', (_, args, __, callback) => callback(null, args[0] === 'models' ? 'gemini-3-pro  Gemini 3 Pro\n' : '', ''));
  assert.deepEqual(listed, { models: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }], error: null });
  const none = await agyModels('/bin/agy', (_, __, ___, callback) => callback(new Error('exit 1'), '', 'authentication required'));
  assert.match(none.error ?? '', /pas connecté/);
});

test('the tools of Antigravity as cards of Poney', () => {
  assert.deepEqual(toolView('view_file', { AbsolutePath: '/p/src/a.ts' }, '/p'), { tool: 'read', args: { path: 'src/a.ts' } });
  assert.deepEqual(toolView('write_to_file', { TargetFile: '"/p/b.ts"' }, '/p'), { tool: 'write', args: { path: 'b.ts' } });
  assert.deepEqual(toolView('replace_file_content', { TargetFile: '/elsewhere/c.ts' }, '/p'), { tool: 'edit', args: { path: '/elsewhere/c.ts' } });
  assert.deepEqual(toolView('run_command', { CommandLine: 'npm test', Cwd: '/p' }, '/p'), { tool: 'run', args: { command: 'npm test' } });
  assert.deepEqual(toolView('grep_search', { Query: 'TODO', SearchPath: '/p/src' }, '/p'), { tool: 'search', args: { pattern: 'TODO', path: 'src' } });
  assert.deepEqual(toolView('search_web', { query: 'antigravity' }, '/p'), { tool: 'web_search', args: { query: 'antigravity' } });
  assert.deepEqual(toolView('read_url_content', { Url: 'https://x.dev' }, '/p'), { tool: 'fetch', args: { url: 'https://x.dev' } });
  assert.deepEqual(toolView('browser_click', { Selector: '#ok' }, '/p'), { tool: 'browser_click', args: { path: '#ok' } });
});

test('an image the agent shows is read by the app: local files only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-img-'));
  await fs.writeFile(path.join(dir, 'cat image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not an image');
  const data = 'data:image/png;base64,iVBORw==';
  assert.equal(await readImage(null, path.join(dir, 'cat image.png')), data);
  assert.equal(await readImage(null, pathToFileURL(path.join(dir, 'cat image.png')).href), data);
  assert.equal(await readImage(null, `${dir}/cat%20image.png`), data);
  assert.equal(await readImage(dir, 'cat image.png'), data); // (in the project)
  assert.equal(await readImage(null, 'cat image.png'), null);
  assert.equal(await readImage(null, path.join(dir, 'notes.txt')), null);
  assert.equal(await readImage(null, path.join(dir, 'gone.png')), null);
  assert.equal(await readImage(null, 'https://example.com/a.png'), null);
});
