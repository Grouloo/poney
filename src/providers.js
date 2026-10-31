// Where models come from: Poney's own engine, servers, Claude. A provider has a
// stable id and a type, so that a conversation can name its own and that new
// types can come. See docs/instances.md.
import { randomUUID } from 'node:crypto';

export const SERVER_TYPES = ['openai', 'ollama'];
const FIXED = { poney: 'Poney', claude: 'Claude' };

/** The list saved in the settings; from a configuration of before, its server becomes the first entry. */
export function loadProviders(saved, config) {
  if (Array.isArray(saved) && saved.length) return saved;
  return [
    { id: 'poney', type: 'poney', name: 'Poney', enabled: true },
    { id: 'server-1', type: config.provider === 'ollama' ? 'ollama' : 'openai', name: '', baseUrl: config.baseUrl, apiKey: config.apiKey ?? '', enabled: true },
    { id: 'claude', type: 'claude', name: 'Claude', enabled: true },
  ];
}

export const isServer = (p) => SERVER_TYPES.includes(p.type);

export function addServer(providers, { type = 'openai', name = '', baseUrl = '', apiKey = '' } = {}) {
  const added = { id: `server-${randomUUID()}`, type, name, baseUrl, apiKey, enabled: true };
  const at = providers.findIndex((p) => p.type === 'claude');
  return [...providers.slice(0, at < 0 ? providers.length : at), added, ...(at < 0 ? [] : providers.slice(at))];
}

/** Poney and Claude can be turned off, not removed. */
export const removeProvider = (providers, id) => providers.filter((p) => p.id !== id || FIXED[p.type]);

export const updateProvider = (providers, id, patch) => providers.map((p) => {
  if (p.id !== id) return p;
  const { id: _, type, ...rest } = patch;
  return { ...p, ...rest, ...(isServer(p) && SERVER_TYPES.includes(type) ? { type } : {}) };
});

/** The provider of a conversation (one from before providers: the first server). */
export function providerOf(providers, choice) {
  if (choice?.engine === 'claude') return providers.find((p) => p.type === 'claude');
  return choice?.provider ? providers.find((p) => p.id === choice.provider) : providers.find(isServer);
}

/** Why a conversation cannot send with this provider, or null. */
export function unavailable(provider) {
  if (!provider) return 'Le fournisseur de cette conversation a été supprimé : choisissez un autre modèle.';
  if (!provider.enabled) return `Le fournisseur ${provider.name || provider.baseUrl} est désactivé : choisissez un autre modèle ou réactivez-le dans Réglages › Fournisseurs.`;
  return null;
}

/** What calls to this conversation's model use: its provider's address, and the model's context. */
export function modelConfig(config, provider, model, contexts = {}) {
  const name = model || config.model;
  return {
    ...config,
    ...(provider?.type === 'poney' ? { provider: 'poney' } : provider && isServer(provider) ? { provider: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey } : {}),
    model: name,
    numCtx: contexts[name] ?? config.numCtx,
    // (the limit of calls also sets how many sub-agents run)
    parallelAgents: config.maxInferences !== 1,
    maxParallelAgents: config.maxInferences ? Math.min(config.maxInferences, 8) : 8,
  };
}
