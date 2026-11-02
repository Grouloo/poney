import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProviders, addServer, addClaudeAccount, removeProvider, updateProvider, providerOf, unavailable, modelConfig, isServer } from '../src/providers.ts';
import { cfg } from './helpers.ts';
import type { Provider } from '../src/types.ts';

const config = cfg({ provider: 'openai', baseUrl: 'http://localhost:1234/v1', apiKey: 'k', model: 'm', numCtx: 32000, maxInferences: 1 });

test('the server of before becomes the first entry, between Poney and Claude', () => {
  const list = loadProviders(undefined, config);
  assert.deepEqual(list.map((p) => p.type), ['poney', 'openai', 'claude']);
  assert.equal(list[1].baseUrl, config.baseUrl);
  assert.equal(list[0].enabled, false); // (the engine is not the default yet)
  assert.equal(loadProviders(list, config), list);
});

test('a conversation from before keeps its server', () => {
  const list = loadProviders(undefined, config);
  assert.equal((providerOf(list, { engine: 'local', model: 'm' }))!.id, 'server-1');
  assert.equal((providerOf(list, { engine: 'local', provider: 'poney' }))!.id, 'poney');
  assert.equal((providerOf(list, { engine: 'claude' }))!.id, 'claude');
});

test('servers are added before Claude; Poney and Claude cannot be removed', () => {
  let list = addServer(loadProviders(undefined, config), { type: 'ollama', baseUrl: 'http://x' });
  assert.deepEqual(list.map((p) => p.type), ['poney', 'openai', 'ollama', 'claude']);
  const added = list[2].id;
  assert.ok(added.length > 10);
  list = removeProvider(removeProvider(removeProvider(list, added), 'poney'), 'claude');
  assert.deepEqual(list.map((p) => p.id), ['poney', 'server-1', 'claude']);
});

test('an update cannot change an id, nor the type of Poney', () => {
  const list = updateProvider(updateProvider(loadProviders(undefined, config), 'server-1', { id: 'x', name: 'Bureau', type: 'ollama' }), 'poney', { type: 'ollama', enabled: false });
  assert.deepEqual([list[1].id, list[1].name, list[1].type], ['server-1', 'Bureau', 'ollama']);
  assert.deepEqual([list[0].type, list[0].enabled], ['poney', false]);
});

test('a provider gone or off stops the sending, and says why', () => {
  assert.match(unavailable(undefined)!, /supprimé/);
  assert.match((unavailable({ name: 'LM Studio', enabled: false } as Provider))!, /désactivé/);
  assert.equal(unavailable({ enabled: true } as Provider), null);
});

test('a conversation calls its provider, with the context of its model', () => {
  const list = loadProviders(undefined, config);
  const own = modelConfig(config, list[0], 'gemma', { gemma: 8000 });
  assert.deepEqual([own.provider, own.model, own.numCtx], ['poney', 'gemma', 8000]);
  const other = modelConfig({ ...config, provider: 'ollama' }, list[1], null);
  assert.deepEqual([other.provider, other.baseUrl, other.model, other.numCtx], ['openai', config.baseUrl, 'm', 32000]);
});

test('the limit of calls sets how many sub-agents run', () => {
  const server: Provider = { id: 's', type: 'openai', name: '', baseUrl: 'x', enabled: true };
  assert.equal(isServer(server), true);
  const of = (maxInferences: number | undefined) => { const c = modelConfig(cfg({ ...config, maxInferences }), server, 'm'); return [c.parallelAgents, c.maxParallelAgents]; };
  assert.deepEqual(of(1), [false, 1]);
  assert.deepEqual(of(3), [true, 3]);
  assert.deepEqual(of(0), [true, 8]);
});

test('Claude accounts: added after the others, chosen by a conversation, removed but not the machine\'s', () => {
  const first = addClaudeAccount(loadProviders(undefined, config));
  const second = addClaudeAccount(first.providers);
  let list = addServer(second.providers);
  assert.deepEqual(list.map((p) => p.type), ['poney', 'openai', 'openai', 'claude', 'claude', 'claude']);
  assert.deepEqual(list.slice(3).map((p) => p.id), ['claude', first.id, second.id]);
  assert.equal((providerOf(list, { engine: 'claude', provider: second.id }))!.id, second.id);
  // (none named, or a server's left from a model chosen before: the machine's)
  assert.equal((providerOf(list, { engine: 'claude' }))!.id, 'claude');
  assert.equal((providerOf(list, { engine: 'claude', provider: 'server-1' }))!.id, 'claude');
  list = removeProvider(removeProvider(list, first.id), 'claude');
  assert.deepEqual(list.filter((p) => p.type === 'claude').map((p) => p.id), ['claude', second.id]);
  // (a conversation of a removed account says so, it does not move to another)
  assert.match(unavailable(providerOf(list, { engine: 'claude', provider: first.id }))!, /supprimé/);
});
