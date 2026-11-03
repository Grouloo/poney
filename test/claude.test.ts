import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAgent, toolView, claudeModels, claudeUsage, claudeLoggedIn, claudeError, claudeEnv, claudeAuth, linkUserSettings, bringSession } from '../src/agent/claude.ts';
import type { ClaudeQuery, ClaudeRun } from '../src/agent/claude.ts';
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, Approve, EventOf } from '../src/types.ts';

type Params = { prompt: string; options: NonNullable<Parameters<ClaudeRun>[0]['options']> };
type Messages = unknown[] | ((params: Params) => Promise<unknown[]>);

/** A run that yields nothing, with the calls given. */
const idle = (calls: Partial<ClaudeQuery>): ClaudeQuery => ({ async* [Symbol.asyncIterator]() {}, ...calls });

const stream = (event: object, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });
const start = stream({ type: 'message_start' });
const stop = stream({ type: 'message_stop' });
const text = (t: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const tool = (index: number, id: string, name: string, input: unknown, parent: string | null = null) => [
  stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } }, parent),
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, parent),
  stream({ type: 'content_block_stop', index }, parent),
];
const result = (id: string, content: unknown, is_error = false, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const done = { type: 'result', subtype: 'success', result: 'Fini.', duration_ms: 2000, duration_api_ms: 1000, num_turns: 2, usage: { output_tokens: 50 } };
const init = { type: 'system', subtype: 'init', session_id: 'abc' };

function agent(messages: Messages, { approve = async (): Promise<ApprovalAnswer> => true, options }: { approve?: Approve; options?: { mode?: string } } = {}) {
  const calls: Params[] = [];
  const a = new ClaudeAgent({
    cwd: '/project',
    executable: '/bin/claude',
    approve,
    query: (run) => {
      const params = run as Params;
      calls.push(params);
      return (async function* () { for (const m of typeof messages === 'function' ? await messages(params) : messages) yield m; })();
    },
  });
  a.choice = { engine: 'claude', model: 'opus', effort: 'high', mode: 'manual', ...options };
  const events: AgentEvent[] = [];
  a.on('event', (e) => events.push(e));
  return { a, events, calls };
}

test('the harness of Claude becomes the events of the interface', async () => {
  const { a, events, calls } = agent([init, start, text('Je lis.'), ...tool(1, 't1', 'Read', { file_path: '/project/src/a.js' }), stop, result('t1', [{ type: 'text', text: 'contenu' }]), start, text('Fini.'), stop, done]);
  await a.send('lis a.js', { turnId: 'x' });
  assert.deepEqual(events.map((e) => e.type), ['turn_start', 'assistant_start', 'delta', 'assistant_end', 'action_start', 'action_end', 'assistant_start', 'delta', 'assistant_end', 'final', 'turn_end']);
  const started = events.find((e) => e.type === 'action_start');
  assert.deepEqual([started!.tool, started!.args], ['read', { path: 'src/a.js' }]);
  assert.equal((events.find((e) => e.type === 'action_end'))!.output, 'contenu');
  assert.equal((events.at(-1) as EventOf<'turn_end'>).reason, 'done');
  assert.equal(((events.at(-1) as EventOf<'turn_end'>).stats)!.tokens, 50);
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
  let asked = null as ApprovalRequest | null;
  const approve = async (req: ApprovalRequest) => { asked = req; return { ok: false, reason: 'pas ça' }; };
  let answer;
  const { a, events } = agent(async (params) => {
    answer = await params.options.canUseTool!('Bash', { command: 'rm x' }, { toolUseID: 't1', requestId: 'r1', signal: new AbortController().signal });
    return [result('t1', 'refusé', true), done];
  }, { approve });
  await a.send('go');
  const card = events.find((e) => e.type === 'action_start');
  assert.equal(asked!.id, card!.id);
  assert.equal(card!.tool, 'run');
  assert.ok(asked!.claude);
  assert.deepEqual(answer, { behavior: 'deny', message: 'pas ça' });
  assert.equal((events.find((e) => e.type === 'action_end'))!.ok, false);
});

test('the work of a sub-agent goes inside its card', async () => {
  const { a, events } = agent([start, ...tool(0, 'sub', 'Agent', { description: 'Explorer', prompt: 'cherche' }), stop, stream({ type: 'message_start' }, 'sub'), ...tool(0, 't2', 'Grep', { pattern: 'x' }, 'sub'), stream({ type: 'message_stop' }, 'sub'), result('t2', 'trouvé', false, 'sub'), result('sub', 'Rapport'), done]);
  await a.send('go');
  const card = events.find((e): e is EventOf<'action_start'> => e.type === 'action_start' && e.tool === 'agent');
  assert.deepEqual(card!.args, { title: 'Explorer', task: 'cherche' });
  const inner = events.find((e): e is EventOf<'action_start'> => e.type === 'action_start' && e.tool === 'search');
  assert.equal(inner!.agentId, card!.id);
  assert.equal((events.find((e): e is EventOf<'action_end'> => e.type === 'action_end' && e.id === card!.id))!.output, 'Rapport');
});

test('stopped: no card goes on, and the turn ends as stopped', async () => {
  const { a, events } = agent(async (params) => {
    a.stop();
    params.options.abortController!.signal.throwIfAborted();
    return [];
  });
  await a.send('go');
  assert.equal((events.at(-1) as EventOf<'turn_end'>).reason, 'stopped');
  assert.ok(events.some((e) => e.type === 'notice' && e.text === 'Arrêté.'));
  assert.equal(a.running, false);
});

test('an edit shows its diff, the other tools a card named after them', async () => {
  const { a, events } = agent([start, ...tool(0, 'e', 'Edit', { file_path: '/project/a.js', old_string: 'a', new_string: 'b' }), stop, result('e', 'ok'), done]);
  await a.send('go');
  assert.match(((events.find((e) => e.type === 'action_end')!).diff)!, /^\+b$/m);
  assert.deepEqual(toolView('CronCreate', { schedule: '0 8 * * *' }, '/p'), { tool: 'CronCreate', args: { path: '0 8 * * *' } });
});

test('a Poney skill reaches Claude, and /name is not read as one of its commands', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-claude-'));
  const { a, calls, events } = agent([done]);
  a.cwd = cwd;
  await a.send('/grilling mon plan');
  assert.match(calls[0].prompt, /^grilling mon plan/);
  assert.match(calls[0].prompt, /\(Skill "grilling"/);
  assert.equal((events.find((e) => e.type === 'skill'))!.skills[0].name, 'grilling');
});

test('the models come from the Claude harness', async () => {
  let closed = false;
  const q = idle({ supportedModels: async () => [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'high'], supportsAutoMode: true }], close: () => { closed = true; } });
  assert.deepEqual(await claudeModels('/bin/claude', { query: () => q }), [{ value: 'opus', name: 'Opus', efforts: ['low', 'high'], auto: true }]);
  assert.ok(closed);
});

test('not logged in: seen before the first message, and said in the words of the interface', async () => {
  const says = (stdout: string, error: Error | null = null) => (_exe: string, _args: string[], _opts: object, done: (error: unknown, stdout: string) => void) => done(error, stdout);
  assert.equal(await claudeLoggedIn('/bin/claude', says('{"loggedIn": false}')), false);
  assert.equal(await claudeLoggedIn('/bin/claude', says('{"loggedIn": true}')), true);
  assert.equal(await claudeLoggedIn('/bin/claude', says('', new Error('no such command'))), false);
  assert.match(claudeError('Claude Code returned an error result: Not logged in · Please run /login'), /Réglages › Fournisseurs/);
  assert.doesNotMatch(claudeError('Claude Code returned an error result: boom in Claude Code'), /Claude Code/);
});

test('a failed result is said once, and ends the turn as an error', async () => {
  const { a, events } = agent(async () => [{ type: 'result', subtype: 'error_during_execution', errors: ['Not logged in'] }]);
  await a.send('go');
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.equal((events.at(-1) as EventOf<'turn_end'>).reason, 'error');
});

test('the reasoning is asked for as a summary, and an empty one shows nothing', async () => {
  const think = (t: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
  const { a, events, calls } = agent([init, start, think(''), think('Je compare.'), think(''), text('Fini.'), stop, done]);
  await a.send('compare');
  assert.deepEqual(calls[0].options.thinking, { type: 'adaptive', display: 'summarized' });
  const thoughts = events.filter((e): e is EventOf<'delta'> => e.type === 'delta' && e.kind === 'thinking');
  assert.deepEqual(thoughts.map((e) => [e.text, e.summary]), [['Je compare.', true]]);
  assert.equal((events.find((e) => e.type === 'assistant_end'))!.thinking, 'Je compare.');
});

test('the context gauge follows the API\'s counts, in the window the harness gives', async () => {
  const usage = { input_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 998, output_tokens: 1 };
  const events: AgentEvent[] = [];
  const messages = [init, stream({ type: 'message_start', message: { usage } }), text('Fini.'), stream({ type: 'message_delta', usage: { ...usage, output_tokens: 500 } }),
    stream({ type: 'message_start', message: { usage: { input_tokens: 999999 } } }, 'sub'), stop, done];
  const a = new ClaudeAgent({
    cwd: '/project', executable: '/bin/claude', approve: async () => true,
    query: () => Object.assign((async function* () { yield* messages; })(), { getContextUsage: async () => ({ totalTokens: 8000, maxTokens: 1000000, autoCompactThreshold: 967000, isAutoCompactEnabled: true }) }),
  });
  a.on('event', (e) => events.push(e));
  assert.equal(a.contextStats(), null);
  await a.send('salut');
  assert.deepEqual(events.filter((e) => e.type === 'context').map((e) => e.used), [8000, 10001, 10500]);
  assert.deepEqual(a.contextStats(), { type: 'context', claude: true, used: 10500, numCtx: 1000000, compactAt: 967000, limit: 967000 });
});

test('without what the harness says of the window, a turn goes on and the gauge stays empty', async () => {
  const { a, events } = agent([init, start, text('Fini.'), stop, done]);
  await a.send('salut');
  assert.equal((events.at(-1) as EventOf<'turn_end'>).reason, 'done');
  assert.equal(a.contextStats(), null);
});

const tasks = (...list: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((description) => ({ task_id: description, task_type: 'local_bash', description })) });
const sleeps = (events: AgentEvent[]) => events.filter((e) => e.type === 'sleeping').map((e) => e.on);

test('asleep from the end of its turn until the background task brings it back', async () => {
  // (the order of a real run: the task, the result, the silence, the end of the task, the next message)
  const { a, events } = agent([init, start, ...tool(1, 't1', 'Bash', { command: 'sleep 15', run_in_background: true }), stop, tasks('sleep'), result('t1', 'en fond'), start, text('J’attends.'), stop, done, tasks(), start, text('Fini.'), stop, done]);
  await a.send('attends');
  assert.deepEqual(sleeps(events), [true, false]);
  const at = (i: number) => events.indexOf(events.filter((e) => e.type === 'sleeping')[i]);
  assert.equal(events[at(0) + 1].type, 'final'); // asleep at the result, not before
  assert.ok(at(1) < events.findLastIndex((e) => e.type === 'assistant_start'));
  assert.equal(events.at(-1)!.type, 'turn_end');
  assert.equal(a.sleeping, false);
});

test('a background task beside a turn that goes on is not sleep', async () => {
  const { a, events } = agent([init, tasks('sleep'), start, text('Je continue.'), stop, tasks(), done]);
  await a.send('x');
  assert.deepEqual(sleeps(events), []);
});

test('a watcher is not a task it waits for', async () => {
  const { a, events } = agent([init, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'monitor', description: 'w', ambient: true }] }, start, stop, done]);
  await a.send('x');
  assert.deepEqual(sleeps(events), []);
});

test('stopped while asleep, it does not stay asleep', async () => {
  const { a, events } = agent([]);
  a.runQuery = () => (async function* () {
    yield init; yield tasks('sleep'); yield done;
    a.stop();
    throw new Error('aborted');
  })();
  await a.send('x');
  assert.deepEqual(sleeps(events), [true, false]);
  assert.equal((events.at(-1) as EventOf<'turn_end'>).reason, 'stopped');
});

test('the plan\'s session usage, or nothing where limits do not apply or the call has changed', async () => {
  const call = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
  let closed = 0;
  const query = (answer: unknown) => (): ClaudeQuery => idle({ [call]: async () => answer, close() { closed++; } });
  const usage = await claudeUsage('/bin/claude', { query: query({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 22, resets_at: 'r5' }, seven_day: { utilization: 56, resets_at: 'r7' } } }) });
  assert.deepEqual(usage, { utilization: 22, resetsAt: 'r5' });
  assert.equal(await claudeUsage('/bin/claude', { query: query({ rate_limits_available: false, rate_limits: null }) }), null);
  assert.equal(await claudeUsage('/bin/claude', { query: () => idle({ close() { closed++; } }) }), null);
  assert.equal(closed, 3);
});

test('started from a Claude session, Poney does not hand its variables on to its own Claude', async () => {
  const host = {
    PATH: '/usr/bin', HOME: '/Users/a', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_HOST_SESSION_ID: 'h',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_EFFORT: 'medium', CLAUDE_PID: '1',
    CLAUDE_AGENT_SDK_VERSION: '0.3', MCP_CONNECTION_NONBLOCKING: 'true',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SHELL: '/bin/zsh',
  };
  assert.deepEqual(claudeEnv(host), { PATH: '/usr/bin', HOME: '/Users/a', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SHELL: '/bin/zsh', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
  // (compacting at 200k unless the user chose another window)
  assert.equal(claudeEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
  // (each turn gets that environment, not the SDK's default: Poney's own)
  const { a, calls } = agent([init, done]);
  await a.send('salut');
  assert.equal(calls[0].options.env?.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(calls[0].options.env?.PATH, process.env.PATH);
});

test('an account added in Poney runs in its own folder; the machine\'s in its usual one', async () => {
  assert.equal(claudeEnv({ PATH: '/usr/bin' }, '/data/claude-accounts/a').CLAUDE_CONFIG_DIR, '/data/claude-accounts/a');
  assert.equal(claudeEnv({ PATH: '/usr/bin' }).CLAUDE_CONFIG_DIR, undefined);
  const { a, calls } = agent([init, done]);
  a.configDir = '/data/claude-accounts/a';
  await a.send('salut');
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/data/claude-accounts/a');
  // Who it is logged in as, asked in its folder.
  let asked: string | undefined;
  const auth = await claudeAuth('/bin/claude', '/data/claude-accounts/a', (_file, _args, options, callback) => {
    asked = options.env.CLAUDE_CONFIG_DIR;
    callback(null, '{"loggedIn": true, "email": "moi@pro.fr", "subscriptionType": "max"}');
  });
  assert.deepEqual([asked, auth], ['/data/claude-accounts/a', { loggedIn: true, email: 'moi@pro.fr', plan: 'max' }]);
});

test('an added account takes the user\'s settings, skills and instructions, not their login', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-accounts-'));
  const user = path.join(root, 'user');
  await fs.mkdir(path.join(user, 'skills'), { recursive: true });
  await fs.writeFile(path.join(user, 'settings.json'), '{}');
  await fs.writeFile(path.join(user, 'CLAUDE.md'), 'mes règles');
  await fs.writeFile(path.join(user, '.credentials.json'), 'secret');
  const account = path.join(root, 'account');
  linkUserSettings(account, user);
  assert.deepEqual((await fs.readdir(account)).sort(), ['CLAUDE.md', 'settings.json', 'skills']);
  assert.equal(await fs.readFile(path.join(account, 'CLAUDE.md'), 'utf8'), 'mes règles');
  // (its own file wins, and a later call adds only what is new)
  await fs.rm(path.join(account, 'settings.json'));
  await fs.writeFile(path.join(account, 'settings.json'), '{"own": true}');
  await fs.mkdir(path.join(user, 'agents'));
  linkUserSettings(account, user);
  assert.equal(await fs.readFile(path.join(account, 'settings.json'), 'utf8'), '{"own": true}');
  assert.ok((await fs.readdir(account)).includes('agents'));
});

test('a conversation goes on with another account: its session follows, the latest written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-switch-'));
  const [a, b] = [path.join(root, 'a'), path.join(root, 'b')];
  const project = path.join('projects', '-Users-moi-projet');
  await fs.mkdir(path.join(a, project, 's1', 'subagents'), { recursive: true });
  await fs.writeFile(path.join(a, project, 's1.jsonl'), 'tour 1\n');
  await fs.writeFile(path.join(a, project, 's1', 'subagents', 'x.jsonl'), 'sous-agent');
  // The next message, with B: the session is there, with what it keeps beside it.
  const { a: agentB, calls } = agent([init, done]);
  agentB.sessionId = 's1';
  agentB.configDir = b;
  agentB.accountDirs = [a, b];
  await agentB.send('suite');
  assert.equal(calls[0].options.resume, 's1');
  assert.equal(await fs.readFile(path.join(b, project, 's1.jsonl'), 'utf8'), 'tour 1\n');
  assert.equal(await fs.readFile(path.join(b, project, 's1', 'subagents', 'x.jsonl'), 'utf8'), 'sous-agent');
  // B went on; back to A, it takes B's copy, the latest.
  await fs.writeFile(path.join(b, project, 's1.jsonl'), 'tour 1\ntour 2\n');
  const later = new Date(Date.now() + 5000);
  await fs.utimes(path.join(b, project, 's1.jsonl'), later, later);
  bringSession('s1', a, [a, b]);
  assert.equal(await fs.readFile(path.join(a, project, 's1.jsonl'), 'utf8'), 'tour 1\ntour 2\n');
  // (a session found nowhere: nothing to do)
  bringSession('inconnue', a, [a, b]);
});

test('the share of the plan\'s session an answer used goes with its figures', async () => {
  const call = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
  const run = (values: (number | null)[]) => {
    const a = new ClaudeAgent({
      cwd: '/project',
      executable: '/bin/claude',
      approve: async () => true,
      query: () => {
        const left = [...values];
        const q: ClaudeQuery = {
          async* [Symbol.asyncIterator]() { for (const m of [init, start, text('Fini.'), stop, done]) yield m; },
          [call]: async () => { const v = left.shift(); return v === null || v === undefined ? { rate_limits_available: false } : { rate_limits_available: true, rate_limits: { five_hour: { utilization: v, resets_at: 'r' } } }; },
        };
        return q;
      },
    });
    a.choice = { engine: 'claude', model: 'opus' };
    const events: AgentEvent[] = [];
    a.on('event', (e) => events.push(e));
    return { a, events };
  };
  const paid = run([22, 25.5]);
  await paid.a.send('bonjour');
  assert.equal((paid.events.at(-1) as EventOf<'turn_end'>).stats!.session, 3.5);
  // (an API key: no plan limits, nothing said)
  const key = run([null, null]);
  await key.a.send('bonjour');
  assert.equal((key.events.at(-1) as EventOf<'turn_end'>).stats!.session, undefined);
  // (a new window started meanwhile: what it used)
  const reset = run([98, 1]);
  await reset.a.send('bonjour');
  assert.equal((reset.events.at(-1) as EventOf<'turn_end'>).stats!.session, 1);
});

test('the files attached: Claude may read the conversation\'s private folder, once it exists', async () => {
  const { a, calls } = agent([init, done]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poney-attach-'));
  a.attachDir = path.join(dir, 'private');
  await a.send('a');
  assert.equal(calls[0].options.additionalDirectories, undefined);
  await fs.mkdir(a.attachDir);
  await a.send('b');
  assert.deepEqual(calls[1].options.additionalDirectories, [a.attachDir]);
});
