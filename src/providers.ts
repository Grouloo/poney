// Where models come from: Poney's own engine, servers, Claude accounts, Antigravity. A provider has a
// stable id and a type, so that a conversation can name its own and that new
// types can come. See docs/instances.md.
import { randomUUID } from 'node:crypto';
import { isRecord, rec } from './unknown.ts';
import type { Choice, Config, Provider, ProviderType } from './types.ts';

export const SERVER_TYPES: ProviderType[] = ['openai', 'ollama'];
/** The machine's Claude account (in ~/.claude); those added in Poney follow it. */
export const CLAUDE = 'claude';
const isClaudeId = (id: string) => id === CLAUDE || id.startsWith(`${CLAUDE}-`);
/** The machine's Antigravity login (agy's). */
export const ANTIGRAVITY = 'antigravity';
const ANTIGRAVITY_PROVIDER: Provider = { id: ANTIGRAVITY, type: 'antigravity', name: 'Antigravity', enabled: true };

/** The list saved in the settings; from a configuration of before, its server becomes the first entry. */
export function loadProviders(saved: Provider[] | undefined, config: Pick<Config, 'provider' | 'baseUrl' | 'apiKey'>): Provider[] {
  // (a list saved before Antigravity came gets it, last)
  if (Array.isArray(saved) && saved.length) return saved.some((p) => p.id === ANTIGRAVITY) ? saved : [...saved, ANTIGRAVITY_PROVIDER];
  return [
    { id: 'poney', type: 'poney', name: 'Poney', enabled: false }, // (on once scripts/compare-engine.ts has passed: until then the server stays the default)
    { id: 'server-1', type: config.provider === 'ollama' ? 'ollama' : 'openai', name: '', baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', enabled: true },
    { id: 'claude', type: 'claude', name: 'Claude', enabled: true },
    ANTIGRAVITY_PROVIDER,
  ];
}

export const isServer = (p: Pick<Provider, 'type'>) => SERVER_TYPES.includes(p.type);

export function addServer(providers: Provider[], { type = 'openai', name = '', baseUrl = '', apiKey = '' }: Partial<Pick<Provider, 'type' | 'name' | 'baseUrl' | 'apiKey'>> = {}): Provider[] {
  const added: Provider = { id: `server-${randomUUID()}`, type, name, baseUrl, apiKey, enabled: true };
  const at = providers.findIndex((p) => p.type === 'claude');
  return [...providers.slice(0, at < 0 ? providers.length : at), added, ...(at < 0 ? [] : providers.slice(at))];
}

/** Another Claude account, after the others; it logs in from the providers' page. */
export function addClaudeAccount(providers: Provider[]): { providers: Provider[]; id: string } {
  const added: Provider = { id: `${CLAUDE}-${randomUUID()}`, type: 'claude', name: '', enabled: true };
  const at = providers.findLastIndex((p) => p.type === 'claude') + 1;
  return { providers: [...providers.slice(0, at || providers.length), added, ...(at ? providers.slice(at) : [])], id: added.id };
}

/** Poney, the machine's Claude account and Antigravity can be turned off, not removed. */
export const removeProvider = (providers: Provider[], id: string) => providers.filter((p) => p.id !== id || p.id === 'poney' || p.id === CLAUDE || p.id === ANTIGRAVITY);

export const updateProvider = (providers: Provider[], id: string, patch: Partial<Provider>) => providers.map((p): Provider => {
  if (p.id !== id) return p;
  const { id: _, type, ...rest } = patch;
  return { ...p, ...rest, ...(isServer(p) && type && SERVER_TYPES.includes(type) ? { type } : {}) };
});

/**
 * The provider of a conversation (one from before providers: the first server). For Claude, its
 * account: the machine's when it names none (or a server's id, left from a model chosen before).
 */
export function providerOf(providers: Provider[], choice?: Choice | null): Provider | undefined {
  if (choice?.engine === 'claude') return providers.find((p) => p.id === claudeAccountOf(choice));
  if (choice?.engine === 'antigravity') return providers.find((p) => p.id === ANTIGRAVITY);
  return choice?.provider ? providers.find((p) => p.id === choice.provider) : providers.find(isServer);
}

/** Why a conversation cannot send with this provider, or null. */
export function unavailable(provider: Provider | undefined): string | null {
  if (!provider) return 'Le fournisseur de cette conversation a été supprimé : choisissez un autre modèle.';
  if (!provider.enabled) return `Le fournisseur ${provider.name || provider.baseUrl} est désactivé : choisissez un autre modèle ou réactivez-le dans Réglages › Fournisseurs.`;
  return null;
}

/** The config of a settings file, brought up to date. Writes nothing: saving it is the caller's choice. */
export function savedConfig(saved: unknown): Partial<Config> {
  const file = rec(saved);
  const config: Partial<Config> = isConfig(file.config) ? { ...file.config } : {};
  // The setting for sub-agents became the limit of all the calls to local models.
  if (isConfig(file.config) && file.config.maxInferences === undefined) {
    config.maxInferences = file.config.parallelAgents === false ? 1 : file.config.maxParallelAgents ?? 2;
  }
  // 0.2 used to be the default (saved as is): now the model's own temperature is used.
  if (!file.temperatureFromModel && config.temperature === 0.2) config.temperature = null;
  return config;
}

/** The config part of a settings file, written by this app. */
const isConfig = (v: unknown): v is Partial<Config> => isRecord(v);

/** What calls to this conversation's model use: its provider's address, and the model's context. */
export function modelConfig(config: Config, provider: Pick<Provider, 'type' | 'baseUrl' | 'apiKey'> | null | undefined, model: string | null | undefined, contexts: Record<string, number> = {}): Config {
  const name = model || config.model;
  return {
    ...config,
    ...(provider?.type === 'poney' ? { provider: 'poney' } : provider && isServer(provider) ? { provider: provider.type, baseUrl: provider.baseUrl ?? '', apiKey: provider.apiKey ?? '' } : {}),
    model: name,
    numCtx: contexts[name] ?? config.numCtx,
    // (the limit of calls also sets how many sub-agents run)
    parallelAgents: config.maxInferences !== 1,
    maxParallelAgents: config.maxInferences ? Math.min(config.maxInferences, 8) : 8,
  };
}

/** The Claude account a choice names. */
export const claudeAccountOf = (choice: Choice) => (choice.provider && isClaudeId(choice.provider) ? choice.provider : CLAUDE);
