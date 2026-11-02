import { parseActions, splitThinking, normalizeToolCalls, liveAction, partialEditPairs } from '../agent/protocol.ts';
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';
import { fmtNum, fmtDuration } from './format.ts';
import { parsePlan, taskParts } from '../agent/plan.ts';
import { markdown, esc } from './markdown.ts';
import { documentHtml } from './document.ts';
import { SwipeDetector } from './swipe.ts';
import { EMOJIS, ICONS, ICON_COLORS, iconSvg } from './project-icons.ts';
import { fileIconSvg, folderIconSvg, privateFolderIconSvg } from './file-icons.ts';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';
import type { Api } from '../preload.cts';
import type { AppAlert, ClaudeAccount, ClaudeStatus, FileStates, GithubStatus, ListedSkill, ModelGroup, SessionApproval, SessionEvent, SessionView, SystemPromptView } from '../ipc.ts';
import type { TorStatus } from '../agent/tor.ts';
import type { GitFile, GitRepoStatus } from '../git.ts';
import type { ViewedFile } from '../files.ts';
import { errorMessage, isRecord, num, str } from '../unknown.ts';
import type { AgentEvent, Choice, ContextStats, ConversationSummary, Effort, EngineName, EventOf, PlanTask, ProjectIcon, Provider, ProviderType, PublicSettings, ToolArgs, TriageItem, TurnStats } from '../types.ts';

declare global {
  interface Window {
    api: Api;
  }
}

/** The answer being written, or written. */
interface Bubble {
  el: HTMLElement;
  bubble: HTMLElement;
  raw: string;
  thinking: string;
  thinkingEl: HTMLDetailsElement | null;
  located: EventOf<'edit_located'>[];
  live?: NonNullable<ReturnType<typeof liveAction>> | null;
  liveFile?: { path: string; text: string | null } | null;
  thinkPieces?: number;
  toolName?: string;
  toolPending?: boolean;
  ended?: boolean;
  pieces?: number;
  firstAt?: number;
}

interface Shortcut {
  keys: string[];
  shift?: boolean;
}

interface MenuItem {
  label: string;
  run: () => unknown;
  kbd?: string;
  action?: string;
  danger?: boolean;
  strong?: boolean;
  disabled?: boolean;
}

type Viewed = ViewedFile | { path: string; kind: 'error'; message: string; size?: undefined };
type Places = Map<string, { el: HTMLElement; r: DOMRect }>;

const isStats = (v: unknown): v is ContextStats => isRecord(v) && v.type === 'context';

/** An element of the page: index.html has them all. */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const transcript = $('transcript');
const input = $<HTMLTextAreaElement>('input');
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sendBtn = $<HTMLButtonElement>('sendBtn');
const form = $<HTMLFormElement>('settingsForm');

let settings!: PublicSettings;
let running = false;
const agentContext = new Map<number, ContextStats>(); // sub-agent id -> its latest context figures
const bubbles = new Map<number, Bubble>(); // assistant id -> {el, raw, thinking}
const cards = new Map<number, HTMLElement>(); // action id -> card element

// The conversation runs under the input: its end stays above it, whatever its height
// (the plan showing up, a long message), and in view if it was.
const composer = document.querySelector<HTMLElement>('.composer')!;
const fitComposer = () => transcript.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
new ResizeObserver(() => {
  const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  fitComposer();
  if (atEnd) transcript.scrollTop = transcript.scrollHeight;
}).observe(composer);

// ---------- helpers ----------
function scrollDown(force?: boolean) {
  if (replaying) return; // (a conversation is drawn at once, and placed once at the end)
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 160;
  if (force || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

// Where new elements go: the transcript, or a sub-agent's card while its events are drawn.
let target: HTMLElement | null = null;

function add<T extends HTMLElement>(el: T): T {
  if ($('empty')) {
    $('empty').remove();
    document.querySelector<HTMLElement>('.chat')!.classList.remove('fresh');
  }
  if (target) {
    // Inside a sub-agent's view: the side panel follows it when it shows it and is at the end.
    const panel = $('agentPanelBody');
    const follow = panel.contains(target) && panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
    target.appendChild(el);
    if (follow) panel.scrollTop = panel.scrollHeight;
    return el;
  }
  transcript.appendChild(el);
  scrollDown(true);
  return el;
}

function div(cls: string, html?: string) {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

function setRunning(v: boolean) {
  running = v;
  document.body.classList.toggle('running', v); // hides the "edit message" buttons
  sendBtn.textContent = v ? 'Arrêter' : 'Envoyer';
  sendBtn.classList.toggle('stop', v);
  if (v) startRunTimer();
  else {
    stopRunTimer();
    $('status').textContent = '';
    // (stopped or interrupted: nothing goes on)
    document.querySelectorAll<HTMLElement>('.plan-list li.running').forEach((li) => li.classList.replace('running', 'pending'));
  }
}

// ---------- settings ----------
function shortPath(p: string) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : 'Choisir un dossier…';
}

// Outside any project, the agent works in a folder of the conversation's own.
const offMode = () => Boolean(settings.active?.offProject);
const activeDir = () => settings.active?.cwd || '';
// The files card shows the project listed in the other card (the conversation's when all
// are listed). Another than the conversation's: its files and Git, the chat greyed until
// the user comes back to it. ('Hors projet' there: no folder to show.)
let observed: string | null = null;
const viewDir = () => (observed === OFF_KEY ? '' : observed ?? activeDir());
const viewOff = () => (observed ? observed === OFF_KEY : offMode());

function renderSettings() {
  syncView();
  const shellOn = settings.config.shellEnabled !== false;
  $<HTMLInputElement>('webEnabled').checked = settings.config.webEnabled !== false;
  $<HTMLInputElement>('shellEnabled').checked = shellOn;
  $<HTMLInputElement>('autoApprove').checked = settings.config.approval === 'auto';
  $<HTMLInputElement>('autoApprove').disabled = !shellOn;
  $('autoApproveLabel').classList.toggle('disabled', !shellOn);
  const config: Record<string, unknown> = { ...settings.config };
  for (const el of [...$<HTMLFormElement>('settingsForm').elements] as HTMLInputElement[]) {
    if (!el.name || config[el.name] === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(config[el.name]);
    else el.value = String(config[el.name] ?? '');
  }
  $<HTMLInputElement>('torEnabled').checked = Boolean(settings.config.torEnabled);
  $<HTMLInputElement>('subagentsEnabled').checked = settings.config.subagentsEnabled !== false;
  if (Boolean(torTimer) !== Boolean(settings.config.torEnabled)) scheduleTorStatus();
  renderWelcomeProject();
  renderChoice();
}

// ---------- the model of the conversation ----------
const LOCAL_ICON = '<svg class="engine-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 13.5h5M8 11v2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const CLAUDE_ICON = `<svg class="engine-icon" viewBox="0 0 16 16" aria-hidden="true"><g stroke="#d97757" stroke-width="1.5" stroke-linecap="round">${[0, 30, 60, 90, 120, 150].map((a) => `<path d="M8 1.5v13" transform="rotate(${a} 8 8)"/>`).join('')}</g></svg>`;
const engineIcon = (engine?: string) => (engine === 'claude' ? CLAUDE_ICON : LOCAL_ICON);
const SERVER_ICON = '<svg class="engine-icon" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.75h.01M5 11.25h.01"/></g></svg>';
/** A server's app when it is known, else a server; Poney's models keep the computer. */
const groupIcon = (g?: ModelGroup) => (g?.icon ? `<img class="engine-img" src="${esc(g.icon)}" alt="">` : g && g.provider.type !== 'poney' ? SERVER_ICON : LOCAL_ICON);
const EFFORT_LABEL: Record<string, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximum' };
let modelGroups: ModelGroup[] = []; // the models by provider
let claude: ClaudeStatus = { installed: false, accounts: [] };
const choice = () => settings.active?.choice ?? { engine: 'local', model: null };
const usesClaude = () => choice().engine === 'claude';
/** The Claude account a choice names (the machine's when none). */
const accountId = (c: Choice) => (c.provider === 'claude' || c.provider?.startsWith('claude-') ? c.provider : 'claude');
const claudeAccount = () => claude.accounts.find((a) => a.id === accountId(choice()));
const claudeModel = () => claudeAccount()?.models.find((m) => m.value === choice().model) ?? claudeAccount()?.models[0];
/** An account by the name given, else by who it is logged in as. */
const accountLabel = (a: Pick<ClaudeAccount, 'id' | 'name' | 'email'>) => (a.name && a.name !== 'Claude' ? a.name : a.email ? `Claude · ${a.email}` : a.id === 'claude' ? 'Claude' : 'Compte Claude');
const accountShort = (a: Pick<ClaudeAccount, 'id' | 'name' | 'email'>) => (a.name && a.name !== 'Claude' ? a.name : a.email ?? accountLabel(a));

async function setChoice(patch: Choice) {
  settings = await window.api.setChoice(patch);
  renderSettings();
  refreshGauge();
  refreshConversations();
}

/** The provider of the conversation shown (one from before providers: the first server). */
const firstServer = () => settings.providers?.find((p) => p.type !== 'poney' && p.type !== 'claude')?.id;
const choiceProvider = () => choice().provider ?? firstServer();

async function refreshModels() {
  modelGroups = await window.api.providerModels().catch(() => []);
  const failed = modelGroups.find((g) => g.error && g.provider.id === choiceProvider());
  if (failed) $('status').textContent = `Serveur de modèles injoignable (${failed.name})`;
  const first = modelGroups.find((g) => g.provider.type !== 'poney' && g.models.length);
  if (!settings.config.model && first) settings = await window.api.setConfig({ model: first.models[0].id });
  renderChoice();
  claude = await window.api.claudeStatus().catch(() => claude);
  renderChoice();
  refreshConversations(); // (the cards show their provider's icon)
  if ($<HTMLDialogElement>('settingsDialog').open) renderProviders();
  if (!$('modelMenu').classList.contains('hidden')) openModelMenu();
}
window.api.onModelsChanged(refreshModels);

/** The input follows the model: its name, and what can be set for it. */
function renderChoice() {
  const c = choice();
  const isClaude = c.engine === 'claude';
  // (steps and system prompt belong to Poney's harness)
  $<HTMLButtonElement>('convSettingsBtn').disabled = isClaude;
  $<HTMLButtonElement>('convSettingsBtn').title = isClaude ? 'Les modèles Claude n’utilisent ni les étapes ni le prompt système de Poney' : 'Étapes et prompt système de cette conversation';
  const picker = $<HTMLButtonElement>('modelPicker');
  const group = modelGroups.find((g) => g.provider.id === choiceProvider());
  picker.querySelector<HTMLElement>('.model-icon')!.innerHTML = isClaude ? CLAUDE_ICON : groupIcon(group);
  const local = c.model || settings.config.model;
  // (with several Claude accounts, the conversation's is said beside its model)
  const account = isClaude && claude.accounts.length > 1 ? claudeAccount() : undefined;
  const modelName = isClaude ? claudeModel()?.name ?? c.model ?? 'Claude' : group?.models.find((m) => m.id === local)?.name ?? local ?? 'aucun modèle';
  picker.querySelector<HTMLElement>('.model-name')!.textContent = account ? `${modelName} · ${accountShort(account)}` : modelName;
  picker.dataset.tip = account ? `Modèle · ${accountLabel(account)}` : 'Modèle';
  document.body.classList.toggle('claude-mode', isClaude);
  $('claudeControls').classList.toggle('hidden', !isClaude);
  document.querySelector<HTMLElement>('.toggles')!.classList.toggle('hidden', isClaude);
  if (!isClaude) return;
  const levels = claudeModel()?.efforts ?? [];
  $<HTMLSelectElement>('effortSelect').innerHTML = levels.map((l) => `<option value="${l}">${EFFORT_LABEL[l] ?? l}</option>`).join('');
  $<HTMLSelectElement>('effortSelect').classList.toggle('hidden', !levels.length);
  $<HTMLSelectElement>('effortSelect').value = c.effort && levels.includes(c.effort) ? c.effort : levels.includes('high') ? 'high' : levels[0] ?? '';
  $<HTMLSelectElement>('modeSelect').querySelector<HTMLOptionElement>('[value="auto"]')!.disabled = claudeModel()?.auto === false;
  $<HTMLSelectElement>('modeSelect').value = c.mode ?? 'manual';
}
$<HTMLSelectElement>('effortSelect').addEventListener('change', (e) => setChoice({ effort: (e.target as HTMLInputElement).value as Effort }));
$<HTMLSelectElement>('modeSelect').addEventListener('change', (e) => setChoice({ mode: (e.target as HTMLInputElement).value }));

// (a menu opening upward stops below the top bar: the system takes the clicks there before the page does)
function fitBelowBar(menu: HTMLElement, anchor: HTMLElement) {
  const room = anchor.getBoundingClientRect().top - document.querySelector<HTMLElement>('.topbar')!.getBoundingClientRect().bottom - 14;
  menu.style.setProperty('--room', `${Math.max(room, 0)}px`);
}

function openModelMenu() {
  const menu = $('modelMenu');
  const c = choice();
  menu.innerHTML = '';
  const row = (engine: EngineName, model: string, name: string, off: boolean, group?: ModelGroup, account?: ClaudeAccount) => {
    const r = menu.appendChild(document.createElement('button'));
    r.type = 'button';
    const same = engine === 'claude' ? account?.id === accountId(c) : group?.provider.id === choiceProvider();
    r.className = `pm-row model-row${engine === c.engine && same && model === (c.model ?? (engine === 'local' ? settings.config.model : claudeModel()?.value)) ? ' selected' : ''}`;
    r.innerHTML = `<span class="pm-icon">${group ? groupIcon(group) : engineIcon(engine)}</span><span class="pm-name">${esc(name)}</span>`;
    r.disabled = off;
    if (off) r.title = 'Une conversation commencée garde son type de modèle';
    r.onclick = () => {
      closeModelMenu();
      const m = account?.models.find((x) => x.value === model);
      setChoice(engine === 'claude' ? { engine, model, provider: account?.id, effort: c.effort ?? (m?.efforts.includes('high') ? 'high' : m?.efforts[0]), mode: c.mode ?? 'manual' } : { engine, model, provider: group?.provider.id });
    };
  };
  const started = settings.active?.started;
  const label = (text: string) => menu.appendChild(div('model-sep')).appendChild(document.createElement('span')).append(text);
  for (const g of modelGroups) {
    if (g.provider.type !== 'poney' && (g.models.length || g.error)) label(g.name ?? '');
    for (const m of g.models) row('local', m.id, m.name, started && c.engine !== 'local', g);
    if (g.error) menu.appendChild(div('pm-row muted', `<span class="pm-icon">${groupIcon(g)}</span><span class="pm-name">${esc(g.name)} : injoignable</span>`));
  }
  if (!modelGroups.some((g) => g.models.length || g.error)) menu.appendChild(div('pm-row muted', 'aucun modèle local'));
  // One group per Claude account; a conversation goes on with another one (its session follows).
  for (const a of claude.accounts) {
    label(accountLabel(a));
    for (const m of a.models) row('claude', m.value, m.name, Boolean(started) && c.engine !== 'claude', undefined, a);
    if (!a.loggedIn) {
      const hint = menu.appendChild(document.createElement('button'));
      hint.type = 'button';
      hint.className = 'pm-row model-row model-hint';
      hint.innerHTML = `<span class="pm-icon">${CLAUDE_ICON}</span><span class="pm-name">Se connecter…</span>`;
      hint.onclick = () => { closeModelMenu(); loginClaude(a.id); };
    }
  }
  fitBelowBar(menu, $<HTMLButtonElement>('modelPicker'));
  menu.classList.remove('hidden');
}
function closeModelMenu() { $('modelMenu').classList.add('hidden'); }
window.addEventListener('resize', closeModelMenu);
$<HTMLButtonElement>('modelPicker').onclick = async (e) => {
  e.stopPropagation();
  if (!$('modelMenu').classList.contains('hidden')) return closeModelMenu();
  settings = await window.api.getSettings(); // (has it started since?)
  if (claude.accounts.some((a) => !a.loggedIn)) claude = await window.api.claudeStatus().catch(() => claude); // (logged in since?)
  openModelMenu();
  refreshModels(); // (a server started or stopped since)
};
$('modelMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeModelMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });

form.addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement;
  if (!el.name) return;
  let value = el.type === 'number' ? (el.value.trim() === '' ? null : Number(el.value)) : el.type === 'checkbox' ? el.checked : el.value;
  const patch: Record<string, unknown> = { [el.name]: value };
  if (el.name === 'provider') {
    patch.baseUrl = value === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1';
    patch.model = '';
  }
  settings = await window.api.setConfig(patch);
  renderSettings();
  refreshGauge();
  if (el.name === 'torProxy') scheduleTorStatus();
});

// ---------- providers ----------
const fieldIn = (parent: HTMLElement, label: string, value: string | number | undefined, onChange: (v: string) => unknown, attrs: Record<string, string | number> = {}) => {
  const l = parent.appendChild(document.createElement('label'));
  l.textContent = label;
  const i = l.appendChild(document.createElement('input'));
  Object.assign(i, attrs);
  i.value = String(value ?? '');
  i.onchange = () => onChange(i.value.trim());
  return i;
};
async function changeProvider(call: Promise<PublicSettings>) {
  settings = await call;
  renderSettings();
  refreshGauge();
  refreshModels();
}
function providerCard(p: Provider) {
  const card = div(`provider-card${p.enabled ? '' : ' off'}`);
  const group = modelGroups.find((g) => g.provider.id === p.id);
  const head = card.appendChild(div('provider-head'));
  head.innerHTML = `<span class="pm-icon">${p.type === 'claude' ? CLAUDE_ICON : groupIcon(group)}</span><span class="provider-name"></span><div class="spacer"></div><label><input type="checkbox"> Activé</label>`;
  head.querySelector<HTMLElement>('.provider-name')!.textContent = p.name || group?.name || 'Serveur';
  const on = head.querySelector<HTMLInputElement>('input')!;
  on.checked = p.enabled;
  on.onchange = () => changeProvider(window.api.updateProvider(p.id, { enabled: on.checked }));
  return card;
}
function serverCard(p: Provider) {
  const card = providerCard(p);
  const remove = card.querySelector<HTMLElement>('.provider-head')!.appendChild(document.createElement('button'));
  remove.type = 'button';
  remove.className = 'ghost';
  remove.textContent = 'Supprimer';
  remove.onclick = () => confirm(`Supprimer ce serveur ? Ses conversations restent lisibles.`) && changeProvider(window.api.removeProvider(p.id));
  const update = (patch: Partial<Provider>) => changeProvider(window.api.updateProvider(p.id, patch));
  fieldIn(card, 'Nom', p.name, (name) => update({ name }), { placeholder: 'automatique' });
  const type = card.appendChild(document.createElement('label'));
  type.textContent = 'Type';
  const select = type.appendChild(document.createElement('select'));
  select.innerHTML = '<option value="openai">Compatible OpenAI (LM Studio, llama.cpp, vLLM…)</option><option value="ollama">Ollama (API native)</option>';
  select.value = p.type;
  select.onchange = () => update({ type: select.value as ProviderType, baseUrl: select.value === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1' });
  fieldIn(card, 'URL', p.baseUrl, (baseUrl) => update({ baseUrl }), { placeholder: 'http://localhost:1234/v1' });
  fieldIn(card, 'Clé API (optionnelle)', p.apiKey, (apiKey) => update({ apiKey }), { type: 'password', autocomplete: 'off' });
  return card;
}
async function poneyCard(p: Provider) {
  const card = providerCard(p);
  const engine = await window.api.engineStatus();
  const state = card.appendChild(div('muted'));
  state.textContent = !engine.supported ? 'Pas encore disponible sur cette machine.'
    : engine.loaded.length ? `En mémoire : ${engine.loaded.map((m) => m.id).join(', ')}`
      : engine.installed ? 'Prêt. Les modèles se chargent au premier message.' : 'Le moteur sera téléchargé à la première utilisation d’un de ces modèles.';
  if (!engine.supported) return card;
  const folder = card.appendChild(document.createElement('button'));
  folder.type = 'button';
  folder.className = 'ghost provider-folder';
  folder.textContent = 'Ouvrir le dossier des modèles';
  folder.title = engine.folder;
  folder.onclick = () => window.api.openModelsFolder();
  const options = settings.engine;
  fieldIn(card, 'Décharger un modèle inactif après (minutes)', options.idleMinutes, (v) => changeProvider(window.api.setEngineOptions({ idleMinutes: Math.max(1, Number(v) || 15) })), { type: 'number', min: 1 });
  fieldIn(card, 'Cache de prompt sur disque (Go)', options.cacheGb, (v) => changeProvider(window.api.setEngineOptions({ cacheGb: Math.max(0, Number(v) || 0) })), { type: 'number', min: 0 });
  for (const m of modelGroups.find((g) => g.provider.id === p.id)?.models ?? []) {
    const row = card.appendChild(div('provider-model'));
    row.appendChild(document.createElement('span')).textContent = m.name;
    row.title = 'Taille du contexte de ce modèle, en tokens. Vide : celle des réglages. Elle s’applique au message suivant.';
    const i = row.appendChild(document.createElement('input'));
    Object.assign(i, { type: 'number', min: 2048, step: 1024, placeholder: String(settings.config.numCtx), value: settings.modelContexts?.[m.id] ?? '' });
    i.onchange = () => changeProvider(window.api.setModelContext(m.id, Number(i.value) || null));
  }
  return card;
}
/** A Claude account: who it is logged in as; a name to tell it apart; the login. */
function claudeCard(p: Provider) {
  const card = providerCard(p);
  const head = card.querySelector<HTMLElement>('.provider-head')!;
  const a = claude.accounts.find((x) => x.id === p.id);
  head.querySelector<HTMLElement>('.provider-name')!.textContent = a ? accountLabel(a) : p.name || 'Compte Claude';
  if (p.id !== 'claude') {
    const remove = head.appendChild(document.createElement('button'));
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = 'Supprimer';
    remove.onclick = () => confirm('Supprimer ce compte Claude de Poney ? Il y est déconnecté, et ses conversations ne pourront plus continuer (elles restent lisibles).') && changeProvider(window.api.removeProvider(p.id));
  }
  const state = card.appendChild(div('muted'));
  state.textContent = !claude.installed ? 'Claude n’est pas installé sur cette machine.'
    : !a ? '' : a.loggedIn ? `Connecté : ${a.email ?? 'compte inconnu'}${a.plan ? ` (${a.plan})` : ''}` : 'Non connecté.';
  if (p.id === 'claude') state.title = 'Le compte de cette machine, partagé avec Claude Code et l’application Claude.';
  fieldIn(card, 'Nom', p.name === 'Claude' ? '' : p.name, (name) => changeProvider(window.api.updateProvider(p.id, { name: name || (p.id === 'claude' ? 'Claude' : '') })), { placeholder: a?.email ?? 'automatique' });
  if (claude.installed && a && (!a.loggedIn || p.id !== 'claude')) {
    const login = card.appendChild(document.createElement('button'));
    login.type = 'button';
    login.className = 'ghost provider-folder';
    login.textContent = a.loggedIn ? 'Changer de compte…' : 'Se connecter…';
    login.onclick = () => loginClaude(p.id);
  }
  return card;
}

// ---------- Claude login ----------
// Claude's page opens in the browser; the login comes back by itself, or with a code the page shows.
const loginDialog = $<HTMLDialogElement>('claudeLoginDialog');
async function loginClaude(id: string) {
  const a = claude.accounts.find((x) => x.id === id);
  const p = settings.providers.find((x) => x.id === id);
  $('claudeLoginAccount').textContent = a ? accountLabel(a) : p?.name || 'ce compte';
  $<HTMLInputElement>('claudeLoginCode').value = '';
  $('claudeLoginError').textContent = '';
  loginDialog.showModal();
  const ok = await window.api.claudeLogin(id).catch(() => false);
  claude = await window.api.claudeStatus().catch(() => claude);
  const now = claude.accounts.find((x) => x.id === id);
  if (ok && now?.loggedIn) {
    loginDialog.close();
    $('status').textContent = `Claude connecté : ${now.email ?? accountLabel(now)}`;
  } else if (loginDialog.open) $('claudeLoginError').textContent = 'La connexion n’a pas abouti. Réessayez, ou annulez.';
  renderChoice();
  if (settingsDialog.open) renderProviders();
}
$('claudeLoginForm').onsubmit = (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('claudeLoginCode').value.trim();
  if (code) window.api.claudeLoginCode(code);
};
$<HTMLButtonElement>('claudeLoginCancel').onclick = () => {
  window.api.claudeLoginCancel();
  loginDialog.close();
};
loginDialog.addEventListener('cancel', () => window.api.claudeLoginCancel()); // (Escape)

async function renderProviders() {
  const cards = await Promise.all((settings.providers ?? []).map((p) => (p.type === 'poney' ? poneyCard(p) : p.type === 'claude' ? claudeCard(p) : serverCard(p))));
  $('providersList').replaceChildren(...cards);
}
$<HTMLButtonElement>('addProvider').onclick = () => changeProvider(window.api.addProvider({ baseUrl: 'http://localhost:1234/v1' }));
$<HTMLButtonElement>('addClaudeAccount').onclick = async () => {
  const added = await window.api.addClaudeAccount();
  await changeProvider(Promise.resolve(added.settings));
  claude = await window.api.claudeStatus().catch(() => claude);
  loginClaude(added.id);
};
$<HTMLInputElement>('autoApprove').onchange = async (e) => {
  settings = await window.api.setConfig({ approval: (e.target as HTMLInputElement).checked ? 'auto' : 'ask' });
  renderSettings();
};
for (const flag of ['webEnabled', 'shellEnabled', 'torEnabled', 'subagentsEnabled']) {
  $(flag).onchange = async (e) => {
    settings = await window.api.setConfig({ [flag]: (e.target as HTMLInputElement).checked });
    renderSettings();
  };
}
// ---------- Tor connection status ----------
let torTimer: ReturnType<typeof setTimeout> | undefined;

function renderTorStatus(s: TorStatus) {
  for (const id of ['torState', 'torStateBig']) $(id).className = `tor-state ${s.state}`;
  $('torState').textContent = s.state === 'bootstrapping' || s.state === 'stuck' ? ` ${s.progress} %`
    : s.state === 'reconnecting' ? ' reconnexion' : s.state === 'degraded' ? ' lent' : '';
  $('torToggleLabel').dataset.tip = s.state === 'disabled'
    ? 'Tor : recherche web et lecture de pages via Tor (réglages : ⚙︎ › Confidentialité)'
    : `Tor : ${s.detail}${s.proxy ? ` — ${s.proxy.replace('socks5h://', '')}` : ''}`;
  $('torStatusLine').textContent = s.detail;
}

async function refreshTorStatus() {
  try {
    renderTorStatus(await window.api.torStatus());
  } catch {}
}

/** Polls Tor's state while it is enabled (local control port; a test connection at most every 30 s otherwise). */
function scheduleTorStatus() {
  clearInterval(torTimer);
  torTimer = undefined;
  if (!settings.config.torEnabled) {
    renderTorStatus({ state: 'disabled', detail: 'Tor désactivé' });
    return;
  }
  refreshTorStatus();
  torTimer = setInterval(refreshTorStatus, 3000);
}

$<HTMLButtonElement>('torNewnym').onclick = async () => {
  $('torResult').textContent = 'Demande de nouveaux circuits…';
  const r = await window.api.torNewCircuits();
  $('torResult').textContent = r.ok
    ? 'Nouveaux circuits demandés : les prochaines requêtes les utiliseront.'
    : '✗ Impossible : le port de contrôle de Tor n’est pas accessible.';
  refreshTorStatus();
};
$<HTMLButtonElement>('torTest').onclick = async () => {
  const out = $('torResult');
  out.textContent = 'Test en cours…';
  const r = await window.api.checkTor();
  out.textContent = r.ok
    ? (r.isTor ? `✓ Connecté via Tor (${r.proxy?.replace('socks5h://', '')}), IP de sortie ${r.ip}` : `⚠ Le proxy répond mais le trafic ne sort pas par Tor (IP ${r.ip})`)
    : `✗ ${r.error}`;
};
/** A dialog with its categories on the left: returns the function that shows one. */
function navDialog(dialog: HTMLElement) {
  const show = (page?: string) => {
    for (const b of dialog.querySelectorAll<HTMLElement>('.dialog-nav button')) b.classList.toggle('active', b.dataset.page === page);
    for (const p of dialog.querySelectorAll<HTMLElement>('.nav-page')) p.classList.toggle('hidden', p.dataset.page !== page);
    dialog.querySelector<HTMLElement>('.nav-pages')!.scrollTop = 0;
  };
  dialog.querySelector<HTMLElement>('.dialog-nav')!.onclick = (e) => { const { page } = (e.target as HTMLElement).dataset; if (page) show(page); };
  show(dialog.querySelector<HTMLElement>('.dialog-nav button')!.dataset.page);
  return show;
}
/** A click beside a dialog closes it; with changes not saved, it only nudges it. */
function closeOnOutside(dialog: HTMLDialogElement, unsaved: () => boolean = () => false) {
  let pressed = false; // (a selection dragged out of the dialog is not a click beside it)
  dialog.addEventListener('mousedown', (e) => { pressed = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog || !pressed || ctxMenu.matches(':popover-open')) return;
    if (!unsaved()) return dialog.close();
    dialog.animate([{ transform: 'none' }, { transform: 'scale(1.015)' }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  });
}
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
closeOnOutside(settingsDialog);
closeOnOutside($<HTMLDialogElement>('projectDialog'));
const showSettingsPage = navDialog(settingsDialog);
function openSettings(page?: string) {
  changeGithub(window.api.githubStatus);
  if (page) showSettingsPage(page);
  renderProviders();
  refreshModels(); // (a server started or stopped since)
  if (!settingsDialog.open) settingsDialog.showModal();
}
$<HTMLButtonElement>('settingsBtn').onclick = () => openSettings();
$<HTMLButtonElement>('closeSettings').onclick = () => settingsDialog.close();
window.api.onOpenSettings(() => openSettings()); // (the application menu, ⌘,)
/** A new project: a folder to choose, and a new conversation in it. */
async function addProject() {
  rememberScroll();
  await flushDraft();
  const before = activeDir();
  settings = await window.api.chooseWorkspace();
  renderSettings();
  if (activeDir() !== before) onWorkspaceChanged();
}
function onWorkspaceChanged() {
  setRunning(false); // a new conversation there (the one shown before goes on in the background)
  clearTranscript();
  setInput('');
  closeViewer();
  expanded.clear();
  refreshConversations();
  refreshTree();
  refreshPromptBadge();
  refreshGauge();
}

// A plan, in the conversation: its tasks, with the state of each. The sub-agent that
// carries out a task has no card of its own: a click on the task shows its work.
let planBlock: { el: HTMLElement; tasks: PlanTask[]; agents: Map<string, number> } | null = null; // the plan being carried out: { el, tasks, agents (title -> action id) }
const planTitle = (t: PlanTask) => taskParts(t.text).head.slice(0, 60); // (the title of its sub-agent)

function startPlanBlock(card: HTMLElement) {
  const el = div('plan-panel', '<div class="plan-head" role="button"><span class="plan-title">Plan</span><span class="plan-count"></span><span class="plan-chev">▾</span></div><ol class="plan-list"></ol>');
  const resume = card.querySelector<HTMLElement>('.resume-btn');
  if (resume) el.querySelector<HTMLElement>('.plan-head')!.append(resume);
  el.querySelector<HTMLElement>('.plan-head')!.onclick = () => el.classList.toggle('collapsed');
  el.querySelector<HTMLElement>('.plan-list')!.onclick = (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-agent]');
    if (!li) return;
    if ((e.target as HTMLElement).closest<HTMLElement>('.resume-btn')) resumeFromAction(Number(li.dataset.agent));
    else openAgentPanel(Number(li.dataset.agent));
  };
  add(el);
  planBlock = { el, tasks: [], agents: new Map() };
}

function renderPlan(tasks: PlanTask[]) {
  if (!planBlock) return;
  planBlock.tasks = tasks;
  const { el, agents } = planBlock;
  const done = tasks.filter((t) => t.status === 'done').length;
  el.querySelector<HTMLElement>('.plan-count')!.textContent = `${done}/${tasks.length}`;
  el.querySelector<HTMLElement>('.plan-list')!.innerHTML = tasks.map((t) => {
    // (the commands of a step, which parsePlan puts in its task, as a list under it)
    const { head, parts } = taskParts(t.text);
    const sub = parts.length ? `<ul class="plan-parts">${parts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
    const agent = agents.get(planTitle(t));
    const resume = agent !== undefined && cards.get(agent)?.querySelector<HTMLElement>('.resume-btn') ? '<button class="resume-btn" type="button" title="Relancer cette action et reprendre la conversation à partir d’elle (la suite est retirée)">↻ Reprendre d’ici</button>' : '';
    return `<li class="${t.status}${agent === panelAgent && agent !== undefined ? ' shown' : ''}"${agent === undefined ? '' : ` data-agent="${agent}" title="Voir son travail dans le panneau de droite"`}><span class="plan-dot"></span><div class="plan-text"><span>${esc(head)}</span>${sub}</div>${t.parallel ? '<span class="tag">en parallèle</span>' : ''}${resume}</li>`;
  }).join('');
  markWaiting();
}
/** A sub-agent waiting for an approval: the state of its task says so. */
function markWaiting() {
  for (const li of document.querySelectorAll<HTMLElement>('.plan-list li[data-agent]')) {
    li.classList.toggle('waiting', Boolean(agentViews.get(Number(li.dataset.agent))?.querySelector<HTMLElement>('.approval')));
  }
}

// ---------- a sub-agent's work, in the side panel ----------
const agentViews = new Map<number, HTMLElement>(); // sub-agent action id -> its view (task, log, report)
let panelAgent: number | null = null;

function renderAgentPanelHead() {
  const card = cards.get(panelAgent ?? -1);
  $('agentPanelTitle').textContent = card?.querySelector<HTMLElement>('.summary')!.textContent || '';
  $('agentPanelInfo').textContent = card ? (card.classList.contains('running') ? 'en cours' : card.classList.contains('ok') ? 'terminé' : 'échec') : '';
  document.querySelectorAll<HTMLElement>('.card.subagent.shown').forEach((c) => c.classList.remove('shown'));
  card?.classList.add('shown');
  for (const li of document.querySelectorAll<HTMLElement>('.plan-list li[data-agent]')) li.classList.toggle('shown', Number(li.dataset.agent) === panelAgent);
  renderGauge(agentContext.get(panelAgent ?? -1), $('agentPanelGauge'), { sub: true });
}

function openAgentPanel(id: number) {
  const view = agentViews.get(id);
  if (!view) return;
  closeViewer(); // (one side panel at a time)
  if (liveBubble) closeLivePanel();
  panelAgent = id;
  const body = $('agentPanelBody');
  body.replaceChildren(view);
  $('agentPanel').classList.remove('hidden');
  renderAgentPanelHead();
  body.scrollTop = body.scrollHeight; // at the end: what it is doing now
}

function closeAgentPanel() {
  panelAgent = null;
  $('agentPanel').classList.add('hidden');
  $('agentPanelBody').replaceChildren();
  document.querySelectorAll<HTMLElement>('.card.subagent.shown, .plan-list li.shown').forEach((c) => c.classList.remove('shown'));
}
$<HTMLButtonElement>('agentPanelClose').onclick = closeAgentPanel;

// ---------- the conversation's memory (notes kept with <remember>) ----------
let memoryNotes: string[] = [];
function renderMemory(notes: string[] = memoryNotes) {
  memoryNotes = notes;
  $('memoryCount').textContent = String(notes.length);
  $<HTMLButtonElement>('memoryBtn').classList.toggle('has-notes', notes.length > 0);
  const list = $('memoryList');
  list.innerHTML = notes.length ? '' : '<li class="empty-note">Aucune note pour l’instant.</li>';
  notes.forEach((n, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="memory-text"></span><button class="ghost icon" type="button" title="Retirer cette note">✕</button>';
    li.querySelector<HTMLElement>('.memory-text')!.textContent = n;
    li.querySelector<HTMLElement>('button')!.onclick = () => saveMemory(memoryNotes.filter((_, k) => k !== i));
    list.appendChild(li);
  });
}
async function saveMemory(notes: string[]) {
  try {
    renderMemory(await window.api.setMemory(notes));
  } catch (e) {
    $('status').textContent = errorText(e);
  }
}
$<HTMLButtonElement>('memoryBtn').onclick = () => $('memoryPanel').classList.toggle('hidden');
$<HTMLButtonElement>('memoryClose').onclick = () => $('memoryPanel').classList.add('hidden');
$<HTMLFormElement>('memoryForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>('memoryInput').value.trim();
  if (!v) return;
  $<HTMLInputElement>('memoryInput').value = '';
  saveMemory([...memoryNotes, v]);
};

function clearTranscript() {
  closeLivePanel();
  closeAgentPanel();
  agentViews.clear();
  agentContext.clear();
  renderMemory([]);
  planBlock = null;
  transcript.innerHTML = '';
  bubbles.clear();
  cards.clear();
  renderWelcome();
}

// ---------- new conversation page ----------
const CHEVRON = '<svg class="picker-chev" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The project of the conversation shown (OFF_KEY outside projects), null if none. */
const activeProject = () => offMode() ? OFF_KEY : activeDir() || null;
/** The project of the last conversation looked at, for the next new one. */
function rememberProject() {
  const key = activeProject();
  try { if (key) localStorage.setItem('lastProject', key); } catch {}
}
/** Where a new conversation goes: the project listed in the sidebar, else that of the last conversation looked at, else outside projects. */
function defaultProject() {
  if (projectFilter !== ALL) return projectFilter;
  let last = null;
  try { last = localStorage.getItem('lastProject'); } catch {}
  return last && projectKeys().includes(last) ? last : OFF_KEY;
}

// The same at launch and for a new conversation: a title, the project it will
// work in (a picker like the sidebar's), and the input just below, higher up in
// the page until the conversation starts.
function renderWelcome() {
  const el = document.createElement('div');
  el.id = 'empty';
  el.className = 'empty';
  el.innerHTML = `<h1>Que dois-je construire ?</h1>
    <p>L’agent lit et modifie les fichiers du projet, lance des commandes, cherche sur le web, et teste son code avant de conclure.</p>
    <div class="welcome-project"><span class="muted">Dans</span>
      <div class="welcome-picker-wrap">
        <button id="welcomePicker" class="project-picker" type="button"><span class="picker-icon"></span><span class="picker-name"></span>${CHEVRON}</button>
        <div id="welcomeMenu" class="project-menu hidden"></div>
      </div>
    </div>
    <p class="welcome-hint muted"></p>`;
  transcript.appendChild(el);
  document.querySelector<HTMLElement>('.chat')!.classList.add('fresh');
  $('welcomePicker').onclick = (e) => {
    e.stopPropagation();
    if ($('welcomeMenu').classList.contains('hidden')) openWelcomeMenu(); else closeWelcomeMenu();
  };
  $('welcomeMenu').onclick = (e) => e.stopPropagation();
  renderWelcomeProject();
}

function renderWelcomeProject() {
  const picker = $('welcomePicker');
  if (!picker || !settings) return;
  const key = activeProject();
  picker.querySelector<HTMLElement>('.picker-icon')!.innerHTML = key ? projectGlyph(key) : '';
  picker.querySelector<HTMLElement>('.picker-name')!.textContent = key ? projectLabel(key) : 'Choisir un projet…';
  picker.title = key && key !== OFF_KEY ? key : '';
  document.querySelector<HTMLElement>('#empty .welcome-hint')!.textContent = key === OFF_KEY
    ? 'Hors projet : les fichiers de l’agent restent dans un dossier propre à cette conversation.'
    : '';
}

function openWelcomeMenu() {
  const menu = $('welcomeMenu');
  menu.innerHTML = '';
  const row = (icon: string, name: string, title: string, onclick: () => unknown, selected = false) => {
    const r = document.createElement('div');
    r.className = `pm-row${selected ? ' selected' : ''}`;
    r.innerHTML = `<span class="pm-icon">${icon}</span><span class="pm-name"></span>`;
    r.querySelector<HTMLElement>('.pm-name')!.textContent = name;
    r.title = title;
    r.onclick = () => { closeWelcomeMenu(); onclick(); };
    menu.appendChild(r);
  };
  for (const key of projectKeys().filter((k) => k !== ALL)) {
    row(projectGlyph(key), projectLabel(key), key === OFF_KEY ? '' : key,
      () => key !== activeProject() && newConversationIn(key === OFF_KEY ? null : key, { keepText: true }), key === activeProject());
  }
  row('＋', 'Ajouter un projet…', 'Choisir un dossier', addProject);
  menu.classList.remove('hidden');
  $('welcomePicker').classList.add('open');
}
function closeWelcomeMenu() {
  $('welcomeMenu')?.classList.add('hidden');
  $('welcomePicker')?.classList.remove('open');
}
document.addEventListener('click', closeWelcomeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWelcomeMenu(); });

/** A user message: plain text, with the quoted lines ("> …") shown as quotes. */
function fillUserBubble(bubble: HTMLElement, text: string) {
  bubble.textContent = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length;) {
    if (/^>\s?/.test(lines[i])) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ''));
      bubble.appendChild(document.createElement('blockquote')).textContent = quoted.join('\n');
      if (lines[i] === '') i++; // the blank line after a quote is the quote's margin
    } else {
      const plain = [];
      while (i < lines.length && !/^>\s?/.test(lines[i])) plain.push(lines[i++]);
      bubble.appendChild(document.createTextNode(plain.join('\n')));
    }
  }
}

function addUserMessage(text: string, turnId?: string) {
  document.querySelectorAll<HTMLElement>('.retry-row').forEach((r) => r.remove()); // (taken up, or a new message)
  if (!target) planBlock = null; // a plan is the plan of one request
  const m = div('msg user');
  fillUserBubble(m.appendChild(div('bubble')), text);
  if (turnId) {
    // Messages sent before this feature have no rewind point: no edit button.
    const btn = document.createElement('button');
    btn.className = 'edit-msg';
    btn.textContent = '✎ Modifier';
    btn.title = 'Modifier ce message et relancer la conversation à partir d’ici';
    btn.onclick = () => startEditMessage(m, turnId, text);
    m.appendChild(btn);
  }
  add(m);
}

/** Inline editor on a previous user message; "Relancer" restarts the conversation from it. */
function startEditMessage(m: HTMLElement, turnId: string, text: string) {
  if (running || m.classList.contains('editing')) return;
  m.classList.add('editing');
  const editor = div('msg-editor');
  editor.innerHTML = `<textarea rows="3"></textarea>
    <p class="edit-note">Les messages qui suivent seront supprimés de la conversation. Les fichiers déjà modifiés par l’agent ne sont pas restaurés.</p>
    <div class="edit-actions"><button class="ghost cancel">Annuler</button><button class="primary relaunch">Relancer</button></div>`;
  const area = editor.querySelector<HTMLTextAreaElement>('textarea')!;
  area.value = text;
  m.appendChild(editor);
  const fit = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 360)}px`; };
  fit();
  area.addEventListener('input', fit);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const close = () => { editor.remove(); m.classList.remove('editing'); };
  const relaunch = async () => {
    const newText = area.value.trim();
    if (!newText || running) return;
    try {
      const { events } = await window.api.rewind(turnId);
      replayTranscript(events);
    } catch (e) {
      // The editor stays open with the text: nothing typed is lost.
      editor.querySelector<HTMLElement>('.edit-error')?.remove();
      editor.querySelector<HTMLElement>('.edit-actions')!.before(div('edit-error error', esc(errorText(e))));
      return;
    }
    refreshGauge();
    if (!(await sendMessage(newText))) {
      input.value = newText;
      autosize();
    }
  };
  editor.querySelector<HTMLElement>('.cancel')!.onclick = close;
  editor.querySelector<HTMLElement>('.relaunch')!.onclick = relaunch;
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); relaunch(); }
  });
}

/** "Resume from here" on the agent's own actions (not the app's checks, not inside a sub-agent). */
function addResumeButton(card: HTMLElement, ev: EventOf<'action_start'>) {
  if (target || ev.auto) return;
  const btn = document.createElement('button');
  btn.className = 'resume-btn';
  btn.textContent = '↻ Reprendre d’ici';
  btn.title = 'Relancer cette action et reprendre la conversation à partir d’elle (la suite est retirée)';
  btn.onclick = (e) => { e.stopPropagation(); resumeFromAction(ev.id); };
  card.querySelector<HTMLElement>('.card-head')!.appendChild(btn);
}

/** Takes up a turn that ended on an error. */
async function retryTurn() {
  if (running) return;
  await sendMessage(await window.api.retryText());
}

async function resumeFromAction(id: number) {
  if (running) return;
  if (!confirm('Reprendre à partir de cette action ?\n\nElle sera relancée, et tout ce qui la suit sera retiré de la conversation. Les fichiers déjà modifiés ne sont pas restaurés.')) return;
  try {
    const { events } = await window.api.resumeFrom(id);
    replayTranscript(events);
    setRunning(true);
    refreshGauge();
  } catch (e) {
    add(div('error', esc(errorText(e))));
  }
}

function replayTranscript(events: AgentEvent[]) {
  closeLivePanel(); // (the answers are drawn again)
  const shownAgent = panelAgent;
  agentViews.clear();
  agentContext.clear();
  planBlock = null;
  renderMemory([]); // (same for the memory)
  transcript.innerHTML = '';
  document.querySelector<HTMLElement>('.chat')!.classList.remove('fresh');
  bubbles.clear();
  cards.clear();
  if (!events.length) renderWelcome();
  replaying = true;
  try {
    for (const ev of events) onEvent(ev);
  } finally {
    replaying = false;
  }
  transcript.scrollTop = transcript.scrollHeight;
  // The side panel showed a sub-agent: shown again from the redrawn conversation, or closed.
  if (shownAgent && agentViews.has(shownAgent)) openAgentPanel(shownAgent);
  else closeAgentPanel();
}

// ---------- the text of the input, kept as the conversation's draft ----------
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let draftChanged = false;
/** Sends the main process what is typed, now (before leaving the conversation). */
function flushDraft() {
  clearTimeout(draftTimer);
  if (!draftChanged) return;
  draftChanged = false;
  return window.api.setDraft(input.value);
}
function noteDraft() {
  draftChanged = true;
  clearTimeout(draftTimer);
  const c = lastConversations.find((x) => x.id === currentConversation);
  // (a card that changes follows the keys, without waiting for the list: a new conversation's title, a draft begun or erased)
  if (c && !c.titleFromDraft && c.draft === Boolean(input.value.trim())) draftTimer = setTimeout(flushDraft, 250);
  else {
    if (c?.titleFromDraft) showDraftTitle(c);
    flushDraft();
  }
}
/** The title of a conversation named by its input, as typed now (the list may be a key behind). */
function showDraftTitle(c: ConversationSummary) {
  c.title = input.value.replace(/\s+/g, ' ').trim().slice(0, 80) || c.title;
  const title = document.querySelector<HTMLElement>('.conv-card.active .title');
  if (title) title.textContent = c.title;
  renderConvHead();
}
function setInput(text: string) {
  clearTimeout(draftTimer);
  draftChanged = false;
  input.value = text;
  autosize();
}
input.addEventListener('input', noteDraft);

// ---------- sending ----------
async function submit() {
  if (running) {
    await window.api.stop();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  if (!activeDir()) {
    settings = await window.api.chooseWorkspace();
    renderSettings();
    if (!activeDir()) return;
    onWorkspaceChanged();
    setInput(text);
  }
  if (settings.active?.blocked) {
    $('status').textContent = settings.active.blocked;
    setTimeout(openModelMenu); // (after this click, which closes menus)
    return;
  }
  if (!usesClaude() && !choice().model && !settings.config.model) {
    openSettings('providers');
    $('status').textContent = 'Choisissez un modèle.';
    return;
  }
  setInput('');
  // Not sent: the text goes back into the box (unless something new was typed).
  if (!(await sendMessage(text)) && !input.value) {
    setInput(text);
    noteDraft();
  }
}

async function sendMessage(text: string) {
  const turnId = crypto.randomUUID();
  rememberProject();
  const startsHere = document.querySelector<HTMLElement>('.chat')!.classList.contains('fresh');
  const top = composer.getBoundingClientRect().top;
  addUserMessage(text, turnId);
  if (startsHere) { // (from the middle of the page to its place at the bottom)
    const from = `translateY(${top - composer.getBoundingClientRect().top}px)`;
    if (!calm) composer.animate([{ transform: from }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
  setRunning(true);
  try {
    await window.api.send(text, turnId);
    return true;
  } catch (e) {
    add(div('error', esc(errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    setRunning(false);
    return false;
  }
}

sendBtn.onclick = submit;
input.addEventListener('keydown', (e) => {
  if (skillKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

// ---------- /skill: suggestions while typing ----------
const skillMenu = document.querySelector<HTMLElement>('.composer-box')!.appendChild(div('skill-menu hidden'));
let skillMatches: ListedSkill[] = [];
let skillPick = 0;
let skillList: ListedSkill[] | null = null;

/** The /word being typed where the cursor is, if any. */
function skillToken() {
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
  return m ? { query: m[1].toLowerCase(), start: before.length - m[1].length - 1 } : null;
}
function hideSkillMenu() {
  skillMenu.classList.add('hidden');
  skillList = null; // (read again next time: the project may have changed)
}
async function updateSkillMenu() {
  const token = skillToken();
  if (!token) return hideSkillMenu();
  skillList ??= await window.api.listSkills().catch(() => []);
  const { query } = token;
  skillMatches = [
    ...skillList.filter((s) => s.name.startsWith(query)),
    ...skillList.filter((s) => !s.name.startsWith(query) && query && `${s.name} ${s.description}`.toLowerCase().includes(query)),
  ];
  if (!skillMatches.length) return skillMenu.classList.add('hidden');
  skillPick = 0;
  renderSkillMenu();
  fitBelowBar(skillMenu, skillMenu.parentElement!);
  skillMenu.classList.remove('hidden');
}
function renderSkillMenu() {
  skillMenu.innerHTML = skillMatches.map((s, i) => `<button type="button" class="skill-row${i === skillPick ? ' active' : ''}" data-i="${i}"><span class="skill-name">/${esc(s.name)}</span><span class="skill-desc">${esc(s.description)}</span>${s.author ? `<span class="skill-author">${esc(s.author)}</span>` : ''}</button>`).join('');
  skillMenu.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' });
}
function acceptSkill(i: number) {
  const token = skillToken();
  if (!token) return hideSkillMenu();
  input.setRangeText(`/${skillMatches[i].name} `, token.start, input.selectionStart, 'end');
  hideSkillMenu();
  autosize();
  noteDraft();
  input.focus();
}
/** The keys of the open menu; true when it used the key. */
function skillKey(e: KeyboardEvent) {
  if (skillMenu.classList.contains('hidden') || e.isComposing) return false;
  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
  if (e.key in moves) {
    skillPick = (skillPick + moves[e.key] + skillMatches.length) % skillMatches.length;
    renderSkillMenu();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) acceptSkill(skillPick);
  else if (e.key === 'Escape') hideSkillMenu();
  else return false;
  e.preventDefault();
  return true;
}
input.addEventListener('input', updateSkillMenu);
input.addEventListener('blur', hideSkillMenu);
skillMenu.addEventListener('mousedown', (e) => {
  e.preventDefault(); // (the input keeps the focus)
  const row = (e.target as HTMLElement).closest<HTMLElement>('.skill-row');
  if (row) acceptSkill(Number(row.dataset.i));
});
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
}
input.addEventListener('input', autosize);

// Links in the answers: web pages in the browser, never in this window.
for (const area of [transcript, $('agentPanelBody')]) {
  area.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('.bubble a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) window.open(href);
  });
}

// ---------- quote a passage of the conversation (select it, then "Citer") ----------
const quoteBtn = document.createElement('button');
quoteBtn.className = 'quote-btn hidden';
quoteBtn.type = 'button';
quoteBtn.textContent = '❝ Citer';
quoteBtn.title = 'Citer ce passage dans votre message';
document.body.appendChild(quoteBtn);
let quoteRange: Range | null = null;

/** The selected text; formulas give back their LaTeX source instead of their rendering. */
function selectionText(range: Range) {
  const box = document.createElement('div');
  box.appendChild(range.cloneContents());
  box.querySelectorAll<HTMLElement>('.katex').forEach((k) => {
    const src = k.querySelector<HTMLElement>('annotation')?.textContent;
    const display = Boolean(k.closest<HTMLElement>('.katex-display'));
    k.replaceWith(src ? (display ? `$$${src}$$` : `$${src}$`) : k.textContent);
  });
  box.querySelectorAll<HTMLElement>('.edit-msg, .resume-btn, button').forEach((b) => b.remove());
  box.style.cssText = 'position:fixed;left:-10000px;top:0;white-space:pre-wrap;width:600px';
  document.body.appendChild(box);
  const text = box.innerText;
  box.remove();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function hideQuoteBtn() {
  quoteBtn.classList.add('hidden');
  quoteRange = null;
}

transcript.addEventListener('mouseup', () => setTimeout(() => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideQuoteBtn();
  const range = sel.getRangeAt(0);
  if (!transcript.contains(range.commonAncestorContainer) || !sel.toString().trim()) return hideQuoteBtn();
  quoteRange = range.cloneRange();
  const rects = range.getClientRects();
  const r = rects[rects.length - 1] || range.getBoundingClientRect();
  quoteBtn.classList.remove('hidden');
  const w = quoteBtn.offsetWidth;
  quoteBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w / 2))}px`;
  quoteBtn.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 6)}px`;
}, 0));
document.addEventListener('mousedown', (e) => { if (e.target !== quoteBtn) hideQuoteBtn(); });
transcript.addEventListener('scroll', hideQuoteBtn);
quoteBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
quoteBtn.onclick = () => quoteRange && quote(quoteRange);

/** The passage (a range of the conversation) goes into the input, as a quote. */
function quote(range: Range) {
  const text = selectionText(range);
  hideQuoteBtn();
  window.getSelection()?.removeAllRanges();
  if (!text) return;
  const quote = text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
  const cur = input.value;
  const sep = !cur ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
  input.value = `${cur}${sep}${quote}\n\n`;
  autosize();
  noteDraft();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---------- generation timing ----------

function formatStats(s: TurnStats) {
  return [fmtDuration(s.totalMs), `${s.exact ? '' : '≈'}${s.tokens} tokens`, `${fmtNum(s.tps ?? 0)} tok/s`].join(' · ');
}

function statsDetails(s: TurnStats) {
  return [
    `Durée totale de la réponse : ${fmtDuration(s.totalMs)} (${s.steps} appel${s.steps > 1 ? 's' : ''} au modèle, outils compris)`,
    `Génération : ${fmtDuration(s.genMs)} pour ${s.tokens} tokens${s.exact ? '' : ' (en partie estimés : le flux est arrêté après chaque action)'}`,
    `Vitesse moyenne de génération : ${fmtNum(s.tps ?? 0)} tokens/s`,
    `Lecture du prompt : ${fmtDuration(s.promptMs)}`,
  ].join('\n');
}

// Progress of the prompt reading (before the first token), when the server reports it.
let promptProgress: { id: number | string; value: number; t0: number } | null = null; // { id, value, t0 }
let modelStatus = ''; // what the call waits for: its turn, the model

function promptProgressText() {
  if (!promptProgress) return '';
  const { value, t0 } = promptProgress;
  let text = `lecture du prompt ${Math.floor(value * 100)} %`;
  if (value >= 0.03 && value < 1) {
    const remaining = ((performance.now() - t0) * (1 - value)) / value;
    if (remaining >= 1000) text += `, encore ≈ ${fmtDuration(remaining)}`;
  }
  return text;
}

function onPromptProgress(ev: EventOf<'prompt_progress'>) {
  if (!promptProgress || promptProgress.id !== ev.id) promptProgress = { id: ev.id, t0: performance.now(), value: 0 };
  promptProgress.value = ev.progress;
  if (ev.progress >= 1) promptProgress = null;
  // Manual compaction has no running timer: show it directly.
  if (!runTimer && running) $('status').textContent = `Compactage… ${promptProgressText()}`;
}

// Generation in progress (after the prompt was read).
let liveGen: Bubble | null = null;

function liveGenText() {
  if (!liveGen || promptProgress) return '';
  const secs = (performance.now() - (liveGen.firstAt ?? 0)) / 1000;
  const rate = secs > 1 ? ` · ${fmtNum((liveGen.pieces ?? 0) / secs)} tok/s` : '';
  return `génération ${liveGen.pieces} tokens${rate}`;
}

// Live timer for the whole answer, in the status line.
let runTimer: ReturnType<typeof setInterval> | undefined;
function startRunTimer() {
  const t0 = performance.now();
  clearInterval(runTimer);
  const tick = () => {
    const extra = modelStatus || promptProgressText() || liveGenText();
    $('status').textContent = `L’agent travaille… ${fmtDuration(performance.now() - t0)}${extra ? ` · ${extra}` : ''}`;
  };
  tick();
  runTimer = setInterval(tick, 100);
}
function stopRunTimer() {
  modelStatus = '';
  clearInterval(runTimer);
  runTimer = undefined;
}

// ---------- rendering agent events ----------
function summarize(tool: string, args: ToolArgs = {}) {
  switch (tool) {
    case 'run': return args.command || '';
    case 'web_search': return args.query || '';
    case 'fetch': return args.url || '';
    case 'search': return `${args.query || args.pattern || ''}  ${args.path && args.path !== '.' ? `in ${args.path}` : ''}`;
    case 'read': return `${args.path || ''}${args.start ? `:${args.start}-${args.end || ''}` : ''}`;
    case 'recall': return args.query || '';
    case 'remember': return args.note || '';
    case 'forget': return `note ${args.id || ''}`;
    case 'plan': {
      const n = parsePlan(args.body).length; // (as the agent counts them: a step's commands are part of it)
      return `${n} tâche${n > 1 ? 's' : ''}`;
    }
    default: return args.path || '.';
  }
}

const TOOL_LABEL: Record<string, string> = { list: 'Lister', read: 'Lire', search: 'Chercher', write: 'Écrire', edit: 'Modifier', run: 'Exécuter', web_search: 'Web', fetch: 'Page web', agent: 'Sous-agent', plan: 'Plan', remember: 'Mémoriser', forget: 'Oublier', recall: 'Retrouver' };

function renderDiff(diff: string) {
  return `<pre class="diff">${diff.split('\n').map((l) => {
    const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('')}</pre>`;
}

function streamingDisplay(raw: string) {
  // Hide tool tags while streaming; show only the prose.
  // Complete native calls become our tags; one still left is not complete yet: hide it.
  let visible = normalizeToolCalls(splitThinking(raw).text);
  const open = visible.indexOf('<|tool_call>');
  const nativePending = open >= 0;
  if (nativePending) visible = visible.slice(0, open);
  const { text, actions } = parseActions(visible, { final: false });
  const pending = nativePending || actions.some((a) => !a.complete);
  return { text: text.replace(/<\|?[a-z_]*$/, ''), pending };
}

// Streaming redraws are batched: redrawing a long answer (Markdown, KaTeX) and
// its reflection at every token saturates the window over a long generation.
const dirty = new Set<Bubble>();
let drawTimer: ReturnType<typeof setTimeout> | null = null;
let drawCost = 0;

function scheduleDraw(b: Bubble) {
  dirty.add(b);
  if (drawTimer) return;
  // At most ~10 redraws per second, fewer when a redraw is slow.
  drawTimer = setTimeout(drawStreaming, Math.max(100, drawCost * 4));
}

function drawStreaming() {
  drawTimer = null;
  const t0 = performance.now();
  for (const b of dirty) {
    if (b.ended) continue;
    // Reasoning written in the answer itself (<think>, or <reasoning> as in the
    // notes of the history, which the model imitates after a tool result): shown
    // live too, not only once the generation is over.
    const inline = splitThinking(b.raw).thinking;
    if (inline.trim() && !b.thinkingEl) {
      b.thinkingEl = document.createElement('details');
      b.thinkingEl.className = 'thinking';
      b.thinkingEl.innerHTML = '<summary>Réflexion…</summary><div></div>';
      b.el.insertBefore(b.thinkingEl, b.bubble);
    }
    if (b.thinkingEl) {
      b.thinkingEl.querySelector<HTMLElement>('summary')!.textContent = b.thinkPieces ? `Réflexion… ${b.thinkPieces} tokens` : 'Réflexion…';
      b.thinkingEl.querySelector<HTMLElement>('div')!.textContent = b.thinking + inline;
    }
    const { text, pending } = streamingDisplay(b.raw);
    const tool = b.toolPending && b.toolName ? ` (${esc(b.toolName)})` : '';
    // A file being written or edited: a card to follow it in the side panel.
    b.live = liveAction(normalizeToolCalls(splitThinking(b.raw).text));
    const live = b.live ? liveCard(b) : '';
    b.bubble.innerHTML = markdown(text) + (live || (pending || b.toolPending ? `<p class="muted"><span class="spin">◌</span> prépare une action${tool}…</p>` : ''));
    if (liveBubble === b) renderLivePanel();
  }
  dirty.clear();
  drawCost = performance.now() - t0;
  scrollDown();
}

// ---------- a file being written or edited, followed live in the side panel ----------
let liveBubble: Bubble | null = null;

function liveCard(b: Bubble) {
  const a = b.live;
  if (!a) return '';
  const lines = (s?: string) => (s ? s.split('\n').length : 0);
  let info = '';
  if (a.tool === 'write') info = `${lines(a.content)} ligne${lines(a.content) > 1 ? 's' : ''}`;
  else {
    const pairs = partialEditPairs(a.body);
    const found = pairs.map((_, k) => b.located[k]).filter(Boolean);
    info = !pairs.length ? 'bloc à remplacer…' : found.length ? `bloc trouvé (l. ${found.map((f) => (f.startLine === f.endLine ? f.startLine : `${f.startLine}–${f.endLine}`)).join(', ')})` : 'recherche du bloc…';
  }
  const label = a.tool === 'write' ? 'Écriture' : 'Modification';
  return `<div class="live-action${liveBubble === b ? ' shown' : ''}" title="Suivre dans le panneau de droite">${a.complete ? '✓' : '<span class="spin">◌</span>'} <b>${label}</b> <code>${esc(a.path || '…')}</code> <span class="muted">· ${esc(info)}</span><span class="sub-open">›</span></div>`;
}

async function openLivePanel(b: Bubble) {
  if (!b.live) return;
  closeViewer();
  closeAgentPanel();
  liveBubble = b;
  $('livePanelBody').dataset.scrolled = '';
  $('livePanel').classList.remove('hidden');
  // An edit: the file as it is, to show the block found and its replacement.
  if (b.live.tool === 'edit' && b.live.path && b.liveFile?.path !== b.live.path) {
    try {
      const f = await window.api.readFile(b.live.path);
      b.liveFile = { path: b.live.path, text: f.kind === 'text' ? f.content.replace(/\r\n/g, '\n') : null };
    } catch { b.liveFile = { path: b.live.path, text: null }; }
  }
  renderLivePanel(true);
  scheduleDraw(b);
}

function closeLivePanel() {
  liveBubble = null;
  $('livePanel').classList.add('hidden');
  $('livePanelBody').replaceChildren();
}
$<HTMLButtonElement>('livePanelClose').onclick = closeLivePanel;

/** Draws the panel: the content being written, or the file with the block found and the new text. */
function renderLivePanel(first = false) {
  const b = liveBubble;
  const a = b?.live;
  if (!a) return;
  const body = $('livePanelBody');
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  $('livePanelTool').textContent = a.tool === 'write' ? 'Écriture' : 'Modification';
  $('livePanelPath').textContent = a.path || '…';
  $('livePanelInfo').textContent = b.ended ? 'terminé' : 'en cours';
  const row = (n: string | number, text: string, cls = '') => `<div class="ln ${cls}"><span class="no">${n}</span><span class="tx">${esc(text) || ' '}</span></div>`;
  let html;
  if (a.tool === 'write') {
    html = (a.content || '').split('\n').map((l, i) => row(i + 1, l)).join('');
  } else {
    const pairs = partialEditPairs(a.body);
    const file = b.liveFile?.text;
    if (file == null) {
      html = `<div class="center">${b.liveFile ? 'Fichier illisible ou introuvable.' : 'Lecture du fichier…'}</div>`;
    } else {
      const lines = file.split('\n');
      const marks = new Map<number, { p: (typeof pairs)[number]; loc: (typeof b.located)[number] }>(); // last line of a block -> its pair
      pairs.forEach((p, k) => { const loc = b.located[k]; if (loc) marks.set(loc.endLine, { p, loc }); });
      const inBlock = (n: number) => pairs.some((_, k) => b.located[k] && n >= b.located[k].startLine && n <= b.located[k].endLine);
      html = lines.map((l, i) => {
        const n = i + 1;
        let out = row(n, l, inBlock(n) ? 'old-block' : '');
        const m = marks.get(n);
        if (m && m.p.newOpen) out += `<div class="new-block">${m.p.new.replace(/^\n/, '').replace(/\n$/, '').split('\n').map((x: string) => row('+', x, 'new')).join('')}</div>`;
        return out;
      }).join('');
      // A block still being written or not found yet: shown under the file.
      const waiting = pairs.filter((p, k) => !b.located[k]);
      if (waiting.length) html += `<div class="seeking"><div class="muted">${b.ended ? 'Bloc non trouvé' : 'Bloc à remplacer, recherché dans le fichier'} :</div>${waiting.map((p) => `<pre>${esc(p.old)}</pre>`).join('')}</div>`;
    }
  }
  body.innerHTML = `<div class="live-code">${html}</div>`;
  const firstBlock = body.querySelector<HTMLElement>('.old-block');
  if (first && firstBlock) firstBlock.scrollIntoView({ block: 'center' });
  else if (a.tool === 'write' ? (first || atEnd) : false) body.scrollTop = body.scrollHeight;
  else if (firstBlock && !body.dataset.scrolled) { firstBlock.scrollIntoView({ block: 'center' }); body.dataset.scrolled = '1'; }
}

function onEvent(ev: SessionEvent) {
  // A sub-agent's events are drawn in its view (shown in the side panel), with the same rendering;
  // its card in the conversation shows its latest activity.
  if (ev.agentId) {
    const card = cards.get(ev.agentId);
    const log = agentViews.get(ev.agentId)?.querySelector<HTMLElement>('.sub-log');
    if (!card || !log || ev.type === 'final' || ev.type === 'plan' || ev.type === 'memory') return; // (a sub-agent's own plan/memory are not shown)
    if (ev.type === 'context') {
      // Its own context: on its card, and in the panel when it is the one shown.
      agentContext.set(ev.agentId, ev);
      renderGauge(ev, card.querySelector<HTMLElement>('.sub-gauge')!, { sub: true });
      if (panelAgent === ev.agentId) renderGauge(ev, $('agentPanelGauge'), { sub: true });
      return;
    }
    if (ev.type === 'delta') {
      card.dataset.tokens = String(Number(card.dataset.tokens || 0) + 1);
      card.querySelector<HTMLElement>('.sub-tokens')!.textContent = `${card.dataset.tokens} tokens`;
    }
    if (ev.type === 'action_start') card.querySelector<HTMLElement>('.sub-line')!.textContent = `${TOOL_LABEL[ev.tool] || ev.tool} · ${summarize(ev.tool, ev.args)}`;
    const saved = target;
    target = log;
    try {
      onEvent({ ...ev, agentId: undefined });
      markWaiting();
    } finally {
      target = saved;
    }
    return;
  }
  switch (ev.type) {
    case 'assistant_start': {
      const el = div('msg assistant');
      const bubble = div('bubble cursor');
      el.appendChild(bubble);
      add(el);
      const b = { el, bubble, raw: '', thinking: '', thinkingEl: null, located: [] };
      bubbles.set(ev.id, b);
      bubble.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest<HTMLElement>('.live-action')) openLivePanel(b); });
      break;
    }
    case 'edit_located': {
      // The <old> block of the edit being written was found: its lines, to show it.
      const b = bubbles.get(ev.id);
      if (!b) break;
      b.located[ev.pair] = ev;
      if (liveBubble === b) renderLivePanel();
      scheduleDraw(b);
      break;
    }
    case 'delta': {
      // Bubble missing: the window was reloaded during this generation.
      if (!bubbles.has(ev.id)) onEvent({ type: 'assistant_start', id: ev.id });
      const b = bubbles.get(ev.id)!;
      if (promptProgress?.id === ev.id) promptProgress = null; // first token: reading is over
      // Live counter (one streamed piece ≈ one token): makes a long generation visible.
      b.pieces = (b.pieces || 0) + 1;
      b.firstAt ??= performance.now();
      liveGen = b;
      if (ev.kind === 'tool') {
        // Native tool call being generated: parsed at the end, show that something is coming.
        b.toolName = ev.name || b.toolName;
        b.toolPending = true;
        scheduleDraw(b);
        break;
      }
      if (ev.kind === 'thinking') {
        b.thinking += ev.text;
        if (!ev.summary) b.thinkPieces = (b.thinkPieces || 0) + 1; // (a summary's pieces say nothing of the tokens spent)
        if (!b.thinkingEl) {
          b.thinkingEl = document.createElement('details');
          b.thinkingEl.className = 'thinking';
          b.thinkingEl.innerHTML = '<summary>Réflexion…</summary><div></div>';
          b.el.insertBefore(b.thinkingEl, b.bubble);
        }
      } else {
        b.raw += ev.text;
      }
      scheduleDraw(b);
      break;
    }
    case 'assistant_end': {
      const b = bubbles.get(ev.id);
      if (!b) break;
      if (liveGen === b) liveGen = null;
      b.ended = true;
      dirty.delete(b);
      if (liveBubble === b) renderLivePanel();
      b.bubble.classList.remove('cursor');
      const thinking = (b.thinking + (ev.thinking && !b.thinking ? ev.thinking : '')).trim();
      if (thinking && !b.thinkingEl) {
        b.thinkingEl = document.createElement('details');
        b.thinkingEl.className = 'thinking';
        b.thinkingEl.innerHTML = '<summary>Réflexion</summary><div></div>';
        b.thinkingEl.querySelector<HTMLElement>('div')!.textContent = thinking;
        b.el.insertBefore(b.thinkingEl, b.bubble);
      } else if (b.thinkingEl) {
        b.thinkingEl.querySelector<HTMLElement>('summary')!.textContent = b.thinkPieces ? `Réflexion (${b.thinkPieces} tokens)` : 'Réflexion';
        b.thinkingEl.querySelector<HTMLElement>('div')!.textContent = thinking; // (a reasoning that ends at once was never drawn; written in the answer: as kept)
      }
      if (ev.text) b.bubble.innerHTML = markdown(ev.text);
      else if (!thinking) b.el.remove();
      else b.bubble.remove();
      break;
    }
    case 'action_start': {
      if (ev.tool === 'agent') {
        // Sub-agent card: compact (its latest activity, then the start of its report); a click shows
        // its whole work in the side panel (its task, a live log, its report).
        const card = div('card subagent running');
        card.innerHTML = `<div class="card-head"><span class="status"><span class="spin">◌</span></span><span class="tool">Sous-agent</span><span class="summary"></span><span class="tag sub-tokens"></span><span class="gauge sub-gauge hidden"><span class="gauge-bar"><span class="gauge-fill"></span><span class="gauge-mark"></span></span></span><span class="sub-open">›</span></div><div class="sub-line">démarre…</div>`;
        card.querySelector<HTMLElement>('.summary')!.textContent = ev.args?.title || 'sous-agent';
        card.title = 'Voir son travail dans le panneau de droite';
        const view = div('agent-view');
        view.innerHTML = '<details class="sub-task"><summary>Tâche</summary><pre></pre></details><div class="sub-log"></div><div class="sub-report"></div>';
        view.querySelector<HTMLElement>('.sub-task pre')!.textContent = ev.args?.task || '';
        agentViews.set(ev.id, view);
        card.onclick = () => openAgentPanel(ev.id);
        card.dataset.tool = 'agent';
        addResumeButton(card, ev);
        cards.set(ev.id, card);
        if (!target && planBlock?.tasks.some((t) => planTitle(t) === ev.args?.title)) { // (shown by its task)
          planBlock.agents.set(ev.args?.title ?? '', ev.id);
          renderPlan(planBlock.tasks);
        } else add(card);
        break;
      }
      const card = div('card running');
      card.innerHTML = `<div class="card-head"><span class="status"><span class="spin">◌</span></span><span class="tool">${esc(TOOL_LABEL[ev.tool] || ev.tool)}</span><span class="summary"></span>${ev.auto ? '<span class="tag">vérification auto</span>' : ''}</div><div class="card-body"><pre class="out"></pre></div>`;
      const summaryEl = card.querySelector<HTMLElement>('.summary')!;
      summaryEl.textContent = summarize(ev.tool, ev.args);
      if (['read', 'write', 'edit'].includes(ev.tool) && ev.args?.path && !/^@turn\//.test(ev.args.path.trim())) { // (@turn/n: a step of the main agent, not a file)
        summaryEl.classList.add('link');
        summaryEl.title = 'Ouvrir dans le visualiseur';
        summaryEl.onclick = (e) => { e.stopPropagation(); openFile(String(ev.args?.path).trim()); };
      }
      // (selecting text in the head, e.g. a long command, does not close the card)
      card.querySelector<HTMLElement>('.card-head')!.onclick = () => !getSelection()?.toString() && card.classList.toggle('open');
      if (ev.tool === 'run') {
        card.classList.add('open');
        summaryEl.title = ev.args?.command || '';
      }
      card.dataset.tool = ev.tool;
      card.dataset.path = ev.args?.path || '';
      addResumeButton(card, ev);
      cards.set(ev.id, card);
      if (ev.tool === 'plan' && !target) startPlanBlock(card);
      else add(card);
      break;
    }
    case 'action_output': {
      const card = cards.get(ev.id);
      if (!card) break;
      const pre = card.querySelector<HTMLElement>('.out')!;
      pre.textContent += ev.text;
      if (pre.textContent.length > 60000) pre.textContent = pre.textContent.slice(-50000);
      pre.scrollTop = pre.scrollHeight;
      scrollDown();
      break;
    }
    case 'action_end': {
      const card = cards.get(ev.id);
      if (!card) break;
      card.classList.remove('running');
      card.classList.add(ev.ok ? 'ok' : 'fail');
      card.querySelector<HTMLElement>('.status')!.textContent = ev.ok ? '✓' : '✗';
      card.querySelector<HTMLElement>('.approval')?.remove();
      if (card.dataset.tool === 'agent') {
        // The report in its view; its first line on the card; the figures.
        const view = agentViews.get(ev.id);
        // (the report is usually its last message, already in the log: not shown twice)
        const last = view && [...view.querySelectorAll<HTMLElement>('.sub-log > .msg.assistant .bubble')].pop()?.textContent.trim();
        if (view && (ev.output || '').trim() && last !== (ev.output || '').trim()) view.querySelector<HTMLElement>('.sub-report')!.innerHTML = markdown(ev.output || '');
        card.querySelector<HTMLElement>('.sub-line')!.textContent = (ev.output || '').replace(/\s+/g, ' ').trim().slice(0, 160) || (ev.ok ? 'terminé' : 'échec');
        const m = ev.meta || {};
        const parts = [m.ms ? fmtDuration(num(m.ms)) : '', m.steps ? `${m.steps} étapes` : ''].filter(Boolean);
        if (parts.length) card.querySelector<HTMLElement>('.sub-tokens')!.textContent = parts.join(' · ');
        if (isStats(m.context)) {
          agentContext.set(ev.id, m.context);
          renderGauge(m.context, card.querySelector<HTMLElement>('.sub-gauge')!, { sub: true });
        }
        if (panelAgent === ev.id) renderAgentPanelHead();
        break;
      }
      const body = card.querySelector<HTMLElement>('.card-body')!;
      if (ev.diff) {
        body.innerHTML = renderDiff(ev.diff) + (ev.ok ? '' : `<pre class="out">${esc(ev.output)}</pre>`);
        const added = (ev.diff.match(/^\+(?!\+\+)/gm) || []).length;
        const removed = (ev.diff.match(/^-(?!--)/gm) || []).length;
        card.querySelector<HTMLElement>('.card-head')!.insertAdjacentHTML('beforeend', `<span class="tag">+${added} −${removed}</span>`);
      } else {
        body.innerHTML = `<pre class="out">${esc(ev.output)}</pre>`;
      }
      if (ev.meta?.tor) card.querySelector<HTMLElement>('.card-head')!.insertAdjacentHTML('beforeend', '<span class="tag" title="Requête passée par Tor">🧅 Tor</span>');
      if (ev.meta?.exit !== undefined) {
        card.querySelector<HTMLElement>('.card-head')!.insertAdjacentHTML('beforeend', `<span class="tag">exit ${ev.meta.exit}</span>`);
      }
      if (card.dataset.tool === 'run' && ev.ok) card.classList.remove('open');
      if (!replaying && ['write', 'edit', 'run'].includes(card.dataset.tool ?? '')) {
        onFilesChanged(str(ev.meta?.path) || (card.dataset.tool !== 'run' ? card.dataset.path : undefined));
      }
      if (!ev.ok) card.classList.add('open');
      scrollDown();
      break;
    }
    case 'notice':
      add(div('notice', esc(ev.text)));
      break;
    case 'plan':
      renderPlan(ev.tasks);
      break;
    case 'memory':
      renderMemory(ev.notes);
      break;
    case 'step': {
      if (ev.phase === 'before') {
        // The step asked first, shown under the user message.
        const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
        if (msg) msg.appendChild(div('fetched', `⤷ étape avant de répondre : ${esc(ev.text)}`));
      } else add(div('notice', `Étape avant de conclure : ${esc(ev.text)}`));
      break;
    }
    case 'triage_start': {
      if (replaying) break;
      const text = ev.update ? 'Mise à jour du bilan…' : 'Bilan avant d’agir…';
      // (a sub-agent's view has no user message: its assessment goes in its log)
      const msg = ev.update ? null : [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (msg) msg.appendChild(div('triage pending', `<span class="spin">◌</span> ${text}`));
      else add(div('triage pending', `<span class="spin">◌</span> ${text}`));
      break;
    }
    case 'triage': {
      // The assessment before acting, under the user message (its updates after outside
      // results, where they were made): what the model knows, doubts and does not know,
      // and the route the app chose.
      const msg = ev.update || target ? null : [...transcript.querySelectorAll<HTMLElement>('.msg.user')].pop();
      (target || transcript).querySelectorAll<HTMLElement>('.triage.pending').forEach((p) => p.remove());
      const place = (el: HTMLElement) => (msg ? msg.appendChild(el) : add(el));
      if (ev.failed) { place(div('triage', ev.update ? '🧭 Mise à jour du bilan illisible : le bilan précédent reste en vigueur.' : '🧭 Bilan illisible : l’agent devra vérifier au moins une source avant de répondre.')); break; }
      const routes: Record<string, string> = { direct: 'agir directement', check: 'vérifier d’abord', investigate: 'lire plusieurs sources' };
      const route = routes[ev.route ?? ''];
      const count = (n: number, one: string, many: string) => (n ? `${n} ${n > 1 ? many : one}` : '');
      const parts = [count(ev.known?.length ?? 0, 'acquis', 'acquis'), count(ev.doubts?.length ?? 0, 'doute', 'doutes'), count(ev.unknowns?.length ?? 0, 'inconnue', 'inconnues')].filter(Boolean);
      const d = document.createElement('details');
      d.className = `triage route-${ev.route}`;
      const list = (title: string, items: (string | TriageItem)[] = []) => (items.length ? `<div class="triage-sec"><b>${title}</b><ul>${items.map((x) => `<li>${esc(typeof x === 'string' ? x : x.point)}${typeof x !== 'string' && x.why ? ` <span class="muted">— ${esc(x.why)}</span>` : ''}</li>`).join('')}</ul></div>` : '');
      d.innerHTML = `<summary>🧭 ${ev.update ? 'Bilan mis à jour' : 'Bilan'}${parts.length ? ` : ${parts.join(', ')}` : ''} → ${route}</summary>${list('Sait', ev.known)}${list('Doute', ev.doubts)}${list('Ignore', ev.unknowns)}`;
      place(d);
      break;
    }
    case 'fetching':
      if (!replaying) $('status').textContent = `Lecture de ${ev.urls.length > 1 ? 'des liens' : 'la page'} du message…`;
      break;
    case 'fetched': {
      // Links of the user message, read by the app before the model answers.
      const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (!msg) break;
      const d = div('fetched');
      const host = (u: string) => { try { const x = new URL(u); return `${x.hostname}${x.pathname === '/' ? '' : x.pathname}`.slice(0, 70); } catch { return u; } };
      d.textContent = ev.pages.map((p) => (p.ok
        ? `🌐 page lue pour l’agent : ${host(p.url)} (${fmtNum(p.chars ?? 0)} caractères)`
        : `⚠ page non lue : ${host(p.url)} (${p.error})`)).join('\n');
      msg.appendChild(d);
      break;
    }
    case 'noted': {
      // Lasting instructions of the user message, noted in the memory by the app.
      const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (!msg) break;
      const d = div('noted');
      d.textContent = `🧠 Noté dans la mémoire : ${ev.notes.map((n) => `« ${n} »`).join(', ')}`;
      d.title = 'Gardé pour toute la conversation (malgré le compactage). Retirable via 🧠 sous la zone de saisie.';
      msg.appendChild(d);
      break;
    }
    case 'skill': {
      // The skills added to the last user message.
      const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (!msg) break;
      const d = div('skills-used');
      for (const s of ev.skills) {
        const name = document.createElement(s.source ? 'a' : 'span');
        name.textContent = s.name;
        if (s.source) {
          (name as HTMLAnchorElement).href = s.source;
          name.onclick = (e) => { e.preventDefault(); window.open(s.source); }; // (in the browser: the window stays on the app)
        }
        name.title = [s.description, s.author ? `par ${s.author}` : '', s.auto ? 'Ajouté automatiquement' : ''].filter(Boolean).join('\n');
        d.append(name, ' ');
      }
      d.prepend(ev.skills.length > 1 ? 'Skills : ' : 'Skill : ');
      msg.appendChild(d);
      scrollDown();
      break;
    }
    case 'recalled': {
      // Passages of the older history attached to the last user message.
      const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (!msg) break;
      const d = document.createElement('details');
      d.className = 'recalled';
      d.innerHTML = `<summary>↩ ${ev.passages.length} passage${ev.passages.length > 1 ? 's' : ''} ancien${ev.passages.length > 1 ? 's' : ''} joint${ev.passages.length > 1 ? 's' : ''} pour l’agent</summary>`;
      for (const p of ev.passages) {
        const q = document.createElement('blockquote');
        q.textContent = `${p.role === 'assistant' ? 'Agent' : 'Vous'} (message ${p.n}) : ${p.excerpt}`;
        d.appendChild(q);
      }
      msg.appendChild(d);
      break;
    }
    case 'context':
      if (!replaying) renderGauge(ev);
      break;
    case 'model_status':
      if (!replaying) modelStatus = ev.text;
      break;
    case 'prompt_progress':
      if (!replaying) onPromptProgress(ev);
      break;
    case 'compaction_start':
      document.querySelector<HTMLElement>('.compaction.pending')?.remove();
      add(div('compaction pending', '<span class="spin">◌</span> Compactage du contexte : résumé des anciens messages…'));
      break;
    case 'compaction': {
      if (promptProgress?.id === 'compaction') promptProgress = null;
      document.querySelector<HTMLElement>('.compaction.pending')?.remove();
      const d = document.createElement('details');
      d.className = 'compaction';
      d.innerHTML = `<summary>🗜 Contexte compacté : ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)} tokens (${ev.removed} messages résumés)${ev.fallback ? ' · résumé de secours' : ''}</summary>${ev.fallback ? `<p class="compaction-why">Le modèle n’a pas pu écrire le résumé (${esc(ev.failure || 'raison inconnue')}) : un résumé de secours a été construit à partir des demandes, du résumé précédent et des dernières notes de l’agent.</p>` : ''}<pre></pre>`;
      d.querySelector<HTMLElement>('pre')!.textContent = ev.summary;
      add(d);
      break;
    }
    case 'error':
      add(div('error', esc(ev.message)));
      break;
    case 'user_message':
      addUserMessage(ev.text, ev.turnId);
      break;
    case 'turn_end':
      promptProgress = null;
      liveGen = null;
      if (ev.reason === 'error') {
        const row = div('retry-row');
        const retry = row.appendChild(document.createElement('button'));
        retry.type = 'button';
        retry.className = 'ghost';
        retry.textContent = '↻ Reprendre';
        retry.onclick = retryTurn;
        add(row);
      }
      // One timing line for the whole answer, not one per tool call.
      if (ev.stats) {
        const meta = div('gen-meta', esc(formatStats(ev.stats) + (ev.reason === 'stopped' ? ' · interrompu' : '')));
        meta.title = statsDetails(ev.stats);
        add(meta);
      }
      if (replaying) break;
      setRunning(false);
      refreshUsage();
      for (const b of bubbles.values()) b.bubble.classList.remove('cursor');
      input.focus();
      break;
  }
}

function onApproval(req: SessionApproval) {
  const card = cards.get(req.id);
  if (!card) return;
  // A sub-agent's command: its view is shown, or the question would go unseen.
  for (const [id, view] of agentViews) if (view.contains(card) && panelAgent !== id) openAgentPanel(id);
  card.classList.add('open');
  setTimeout(markWaiting);
  const bar = div('approval');
  bar.innerHTML = '<span></span><button class="no">Refuser</button><button class="always">Toujours autoriser</button><button class="yes">Exécuter</button>';
  if (req.claude) bar.querySelector<HTMLElement>('.always')!.remove(); // (its own rules are the mode's)
  bar.querySelector<HTMLElement>('span')!.textContent = req.claude ? 'Autoriser cette action ?' : req.agentTitle ? `Sous-agent « ${req.agentTitle} » : exécuter cette commande ?` : 'Exécuter cette commande ?';
  bar.querySelector<HTMLElement>('.yes')!.onclick = () => { bar.remove(); window.api.approve(req.id, true, false); };
  // Refusing asks why (optional): the model is told, and can change its approach.
  bar.querySelector<HTMLElement>('.no')!.onclick = () => {
    const why = div('approval refuse');
    why.innerHTML = '<input type="text" placeholder="Pourquoi ? (facultatif, transmis au modèle)"><button class="back">Annuler</button><button class="no">Refuser</button>';
    const input = why.querySelector<HTMLInputElement>('input')!;
    const refuse = () => { why.remove(); window.api.approve(req.id, false, false, input.value.trim()); };
    why.querySelector<HTMLElement>('.no')!.onclick = refuse;
    why.querySelector<HTMLElement>('.back')!.onclick = () => { why.replaceWith(bar); bar.querySelector<HTMLElement>('.no')!.focus(); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); refuse(); }
      if (e.key === 'Escape') why.querySelector<HTMLElement>('.back')!.click();
    };
    bar.replaceWith(why);
    input.focus();
  };
  if (!req.claude) bar.querySelector<HTMLElement>('.always')!.onclick = async () => {
    bar.remove();
    settings = await window.api.approve(req.id, true, true);
    renderSettings();
  };
  card.appendChild(bar);
  bar.querySelector<HTMLElement>('.yes')!.focus();
  scrollDown(true);
}

// Only the events of the conversation shown are drawn (the others are replayed when opened).
const shown = (x: { session?: string }) => !x.session || x.session === settings.active?.session;
window.api.onEvent((ev) => { if (shown(ev)) onEvent(ev); });
window.api.onConversationsChanged(() => refreshConversations());
window.api.onSessionsChanged(() => refreshConversations());
window.api.onApproval((req) => { if (shown(req)) onApproval(req); });

// ---------- project actions: context menu and shortcuts ----------
// The same actions from a right click on the sidebar (or a project's dot) and
// from the keyboard; the menu shows their shortcuts. ⌘ on macOS, Ctrl elsewhere.
const MAC = window.api.platform === 'darwin';
const SHORTCUTS: Record<string, Shortcut> = {
  newConversation: { keys: ['n', 't'] },
  markRead: { keys: ['u'], shift: true },
  projectSettings: { keys: ['p'], shift: true },
  addProject: { keys: ['o'], shift: true },
  swapDeck: { keys: ['e'], shift: true },
  showFiles: { keys: ['f'], shift: true },
  showGit: { keys: ['g'], shift: true },
  toggleSidebar: { keys: ['s'], shift: true },
};
const shortcutText = ({ keys: [k], shift }: Shortcut) => MAC ? `${shift ? '⇧' : ''}⌘${k.toUpperCase()}` : `Ctrl+${shift ? 'Maj+' : ''}${k.toUpperCase()}`;
$<HTMLButtonElement>('projectSettingsBtn').dataset.tip = `Paramètres des projets (${shortcutText(SHORTCUTS.projectSettings)})`;
$<HTMLButtonElement>('sidebarBtn').dataset.tip = `Afficher / masquer les barres latérales (${shortcutText(SHORTCUTS.toggleSidebar)})`;

/** The conversations of a project (all of them for 'Tous') that have answers to read or just finished. */
const toRead = (key: string) => lastConversations.filter((c) => (key === ALL || projectOf(c) === key) && (c.unread || c.finished));

const projectActions: Record<string, (key: string) => unknown> = {
  newConversation: (key) => key === ALL ? newConversationHere() : newConversationIn(key === OFF_KEY ? null : key),
  markRead: async (key) => {
    const ids = toRead(key).map((c) => c.id);
    if (ids.length) await window.api.markConversationsRead(ids);
  },
  projectSettings: (key) => openProjectSettings(key),
  addProject: () => addProject(),
  swapDeck: () => swapOrShowDeck(),
  showFiles: () => showSection('files'),
  showGit: () => showSection('git'),
  toggleSidebar: () => document.body.classList.toggle('no-sidebar'),
};

window.addEventListener('keydown', (e) => {
  const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return;
  // (by the key's place, not its character: on an AZERTY keyboard, the top row gives &, é…)
  const digit = e.code.match(/^Digit([1-9])$/);
  if (digit && !e.shiftKey) {
    e.preventDefault();
    hideContextMenu();
    showProjectAt(Number(digit[1]) - 1);
    return;
  }
  const name = Object.keys(SHORTCUTS).find((n) => SHORTCUTS[n].keys.includes(e.key.toLowerCase()) && Boolean(SHORTCUTS[n].shift) === e.shiftKey);
  if (!name) return;
  e.preventDefault();
  hideContextMenu();
  projectActions[name](projectFilter); // (the project listed in the sidebar)
});

const ctxMenu = document.body.appendChild(document.createElement('div'));
ctxMenu.className = 'ctx-menu';
ctxMenu.popover = 'manual'; // (in the top layer: above an open dialog)
ctxMenu.addEventListener('click', (e) => e.stopPropagation());
ctxMenu.addEventListener('mousedown', (e) => e.preventDefault()); // (the focus stays in the field: cut, copy and paste act on it)
function hideContextMenu() { if (ctxMenu.matches(':popover-open')) ctxMenu.hidePopover(); }
document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);

/** A menu at (x, y): items { label, action, disabled, danger } or '-' for a separator, and an optional title. */
function showContextMenu(x: number, y: number, title: string | null, items: (MenuItem | '-')[]) {
  ctxMenu.innerHTML = '';
  if (title) {
    const t = ctxMenu.appendChild(document.createElement('div'));
    t.className = 'ctx-title';
    t.innerHTML = title;
  }
  for (const it of items) {
    if (it === '-') { ctxMenu.appendChild(document.createElement('div')).className = 'ctx-sep'; continue; }
    const row = ctxMenu.appendChild(document.createElement('button'));
    row.type = 'button';
    row.className = `ctx-item${it.danger ? ' danger' : ''}${it.strong ? ' strong' : ''}`;
    row.disabled = Boolean(it.disabled);
    row.innerHTML = `<span class="ctx-label"></span><span class="ctx-kbd">${it.kbd ?? (it.action && SHORTCUTS[it.action] ? shortcutText(SHORTCUTS[it.action]) : '')}</span>`;
    row.querySelector<HTMLElement>('.ctx-label')!.textContent = it.label;
    row.onclick = () => { hideContextMenu(); it.run(); };
  }
  hideContextMenu();
  // (outside an open dialog, it could be seen but not clicked)
  ([...document.querySelectorAll<HTMLElement>('dialog[open]')].at(-1) ?? document.body).appendChild(ctxMenu);
  ctxMenu.showPopover();
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
}

// Right click on the sidebar: the actions for the project of what was clicked
// (a dot, a conversation), else for the project listed.
$('sidebar').addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest<HTMLElement>('input, textarea')) return;
  e.preventDefault();
  closeProjectMenu();
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-project]')?.dataset.project || projectFilter;
  const n = toRead(key).length;
  showContextMenu(e.clientX, e.clientY, key === ALL ? 'Tous les projets' : `${projectGlyph(key)} ${esc(projectLabel(key))}`, [
    { label: 'Nouvelle conversation', action: 'newConversation', run: () => projectActions.newConversation(key) },
    { label: n ? `Marquer comme lues (${n})` : 'Marquer comme lues', action: 'markRead', disabled: !n, run: () => projectActions.markRead(key) },
    '-',
    { label: key === ALL ? 'Paramètres des projets…' : 'Paramètres du projet…', action: 'projectSettings', run: () => openProjectSettings(key) },
    { label: 'Ajouter un projet…', action: 'addProject', run: addProject },
  ]);
});

// Right click on text: in a field, the usual editing (with the spelling
// suggestions); on a selection of the conversation, copy and quote.
const editKey = (k: string) => MAC ? `⌘${k}` : `Ctrl+${k}`;
window.api.onContextMenu((p) => {
  const f = p.editFlags || {};
  const editing: MenuItem[] = [
    { label: 'Couper', kbd: editKey('X'), disabled: !f.canCut, run: () => window.api.edit('cut') },
    { label: 'Copier', kbd: editKey('C'), disabled: !f.canCopy, run: () => window.api.edit('copy') },
    { label: 'Coller', kbd: editKey('V'), disabled: !f.canPaste, run: () => window.api.edit('paste') },
  ];
  if (p.isEditable) {
    const spelling: (MenuItem | '-')[] = p.misspelledWord ? [
      ...(p.suggestions?.length
        ? p.suggestions.slice(0, 5).map((w) => ({ label: w, strong: true, run: () => window.api.edit('replace', w) }))
        : [{ label: 'Aucune suggestion', disabled: true, run() {} }]),
      { label: `Ajouter « ${p.misspelledWord} » au dictionnaire`, run: () => window.api.edit('learn', p.misspelledWord) },
      '-',
    ] : [];
    showContextMenu(p.x, p.y, null, [
      ...spelling,
      { label: 'Annuler', kbd: editKey('Z'), disabled: !f.canUndo, run: () => window.api.edit('undo') },
      '-',
      ...editing,
      '-',
      { label: 'Tout sélectionner', kbd: editKey('A'), disabled: !f.canSelectAll, run: () => window.api.edit('selectAll') },
    ]);
    return;
  }
  if (!p.selectionText?.trim()) return;
  const sel = window.getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const inConversation = range && transcript.contains(range.commonAncestorContainer);
  hideQuoteBtn();
  showContextMenu(p.x, p.y, null, [
    ...editing,
    '-',
    { label: 'Citer dans le message', kbd: '❝', disabled: !inConversation, run: () => range && quote(range) },
  ]);
});

// ---------- project settings ----------
let settingsProject!: string;
/** The settings of all the projects, open at this one; for 'Tous', at the project of the conversation shown. */
function openProjectSettings(key: string) {
  if (key === ALL) key = activeProject() || projectKeys()[1];
  settingsProject = key;
  $<HTMLInputElement>('ipSearch').value = '';
  pickerTab = settings.projectIcons?.[key]?.icon ? 'icon' : 'emoji';
  $('projectDialogPath').textContent = key === OFF_KEY ? 'Les conversations sans dossier de projet.' : shortPath(key);
  $('projectDanger').classList.toggle('hidden', key === OFF_KEY);
  $('projectNameField').classList.toggle('hidden', key === OFF_KEY);
  $<HTMLInputElement>('projectName').value = settings.projectNames?.[key] ?? '';
  $<HTMLInputElement>('projectName').placeholder = key === OFF_KEY ? '' : baseName(key);
  renderProjectSettings();
  loadProjectRemote(key);
  if (!$<HTMLDialogElement>('projectDialog').open) $<HTMLDialogElement>('projectDialog').showModal();
  $<HTMLDialogElement>('projectDialog').querySelector<HTMLElement>('.nav-pages')!.scrollTop = 0;
  $('projectNav').querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' });
}
// The project's remote (no field outside a repository).
let projectRemote = '';
async function loadProjectRemote(key: string) {
  $('projectRemoteError').textContent = '';
  const url = key === OFF_KEY ? null : await window.api.gitRemote(key).catch(() => null);
  if (key !== settingsProject) return; // (another project chosen meanwhile)
  projectRemote = url ?? '';
  $('projectRemote').classList.toggle('hidden', url === null);
  $<HTMLInputElement>('projectRemoteUrl').value = projectRemote;
  $<HTMLButtonElement>('projectRemoteRemove').disabled = !projectRemote;
  showRemoteChange();
}
function showRemoteChange() {
  const changed = $<HTMLInputElement>('projectRemoteUrl').value.trim();
  $<HTMLButtonElement>('projectRemoteSave').disabled = !changed || changed === projectRemote;
}
async function changeProjectRemote(change: () => Promise<void>) {
  const key = settingsProject;
  $('projectRemoteError').textContent = '';
  try {
    await change();
  } catch (e) {
    if (key === settingsProject) $('projectRemoteError').textContent = errorText(e);
    return;
  }
  lastFetch.delete(key);
  if (key === settingsProject) await loadProjectRemote(key);
  refreshGit();
}
$<HTMLInputElement>('projectRemoteUrl').addEventListener('input', showRemoteChange);
$<HTMLButtonElement>('projectRemoteSave').onclick = () => changeProjectRemote(() => window.api.gitSetRemote(settingsProject, $<HTMLInputElement>('projectRemoteUrl').value));
$<HTMLButtonElement>('projectRemoteRemove').onclick = () => {
  if (confirm(`Retirer le dépôt distant de ce projet ?\n\n${projectRemote}\n\nLe dépôt lui-même n’est pas touché, et l’historique local reste.`)) changeProjectRemote(() => window.api.gitRemoveRemote(settingsProject));
};

function renderProjectSettings() {
  const key = settingsProject;
  $('projectDialogTitle').textContent = projectLabel(key);
  $('projectIconPreview').innerHTML = projectGlyph(key);
  renderProjectNav();
  renderIconPicker();
}
const EYE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M3 13 13 3"/></svg>';
function renderProjectNav() {
  $('projectNav').replaceChildren(...allProjectKeys().filter((key) => key !== ALL).map((key) => {
    const hidden = isHiddenProject(key);
    const row = div(`project-row${key === OFF_KEY ? '' : ' has-eye'}${hidden ? ' hidden-project' : ''}`);
    row.dataset.project = key;
    const b = row.appendChild(document.createElement('button'));
    b.type = 'button';
    b.className = `project-open${key === settingsProject ? ' active' : ''}`;
    b.innerHTML = `<span class="pm-icon">${projectGlyph(key)}</span><span class="pm-name"></span>`;
    b.querySelector<HTMLElement>('.pm-name')!.textContent = projectLabel(key);
    b.title = key === OFF_KEY ? '' : key;
    b.onclick = () => openProjectSettings(key);
    if (key !== OFF_KEY) { // ('Hors projet' stays: new conversations land there)
      const eye = row.appendChild(document.createElement('button'));
      eye.type = 'button';
      eye.className = 'project-eye';
      eye.innerHTML = hidden ? EYE_OFF : EYE;
      eye.dataset.tip = hidden ? 'Afficher ce projet dans la barre des conversations' : 'Masquer ce projet et ses conversations (rien n’est supprimé)';
      eye.onclick = () => setProjectHidden(key, !hidden);
    }
    return row;
  }));
}
// A row dragged stays under the pointer while the others make room for it. (By
// pointer events: the native drag cannot show the list as it will be.)
$('projectNav').addEventListener('pointerdown', (down) => {
  const nav = $('projectNav');
  const row = (down.target as HTMLElement).closest<HTMLElement>('.project-row');
  if (!row || down.button || (down.target as HTMLElement).closest<HTMLElement>('.project-eye')) return;
  const others = () => [...nav.querySelectorAll<HTMLElement>('.project-row')].filter((r) => r !== row);
  const grab = down.clientY - row.getBoundingClientRect().top;
  let dragging = false;
  let shift = 0; // how far the row is from its place in the list
  const move = (e: PointerEvent) => {
    if (!dragging && Math.abs(e.clientY - down.clientY) < 5) return;
    if (!dragging) {
      dragging = true;
      row.classList.add('dragging');
      nav.classList.add('reordering');
      getSelection()?.removeAllRanges();
    }
    const box = nav.getBoundingClientRect();
    const toScreen = row.getBoundingClientRect().top - shift - row.offsetTop; // (offsetTop ignores transforms)
    const top = Math.max(box.top, Math.min(e.clientY - grab, box.bottom - row.offsetHeight));
    const middle = top - toScreen + row.offsetHeight / 2;
    const rest = others();
    const next = rest.find((r) => middle < r.offsetTop + r.offsetHeight / 2) ?? null;
    if (next !== row.nextElementSibling) {
      const before = new Map(rest.map((r) => [r, r.offsetTop]));
      nav.insertBefore(row, next);
      for (const r of rest) {
        const gap = before.get(r)! - r.offsetTop;
        if (gap) r.animate([{ transform: `translateY(${gap}px)` }, { transform: 'none' }], { duration: calm ? 0 : 140, easing: 'ease-out' });
      }
    }
    shift = top - toScreen - row.offsetTop;
    row.style.transform = `translateY(${shift}px)`;
    if (e.clientY < box.top + 24) nav.scrollTop -= 8;
    else if (e.clientY > box.bottom - 24) nav.scrollTop += 8;
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (!dragging) return;
    // (the click that ends a drag opens nothing)
    const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
    nav.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => nav.removeEventListener('click', swallow, { capture: true }));
    row.style.transform = '';
    await row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: calm ? 0 : 140, easing: 'ease-out' }).finished;
    row.classList.remove('dragging');
    nav.classList.remove('reordering');
    applyProjectChange(() => window.api.setProjectOrder([...nav.querySelectorAll<HTMLElement>('.project-row')].map((r) => r.dataset.project)));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
});
async function applyProjectChange(call: () => Promise<PublicSettings>) {
  try {
    settings = await call();
  } catch (e) {
    $('status').textContent = errorText(e);
    alert(errorText(e));
    return false;
  }
  renderSettings();
  await refreshConversations();
  renderConvHead();
  renderProjectSettings();
  return true;
}
async function setProjectHidden(key: string, hidden: boolean) {
  if (!(await applyProjectChange(() => window.api.setProjectHidden(key, hidden))) || !hidden) return;
  if (projectFilter === key) setProjectFilter(ALL);
  if (activeProject() === key) await newConversationHere(); // (what is shown leaves with it)
}
$<HTMLInputElement>('projectName').addEventListener('change', (e) => applyProjectChange(() => window.api.setProjectName(settingsProject, (e.target as HTMLInputElement).value)));
async function applyProjectIcon(call: () => Promise<PublicSettings>) {
  try {
    settings = await call();
  } catch (e) {
    $('status').textContent = errorText(e);
    return;
  }
  renderSettings();
  refreshConversations();
  renderProjectSettings();
}

// The picker: emoji, or an icon of the set in a color; the search goes through
// their keywords, and an emoji pasted or typed there can be used as it is.
let pickerTab = 'emoji';
let pickerColor = ICON_COLORS[1];
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function renderIconPicker() {
  const current = settings.projectIcons?.[settingsProject] || {};
  if (current.icon && ICONS[current.icon]) pickerColor = current.color || pickerColor;
  for (const b of document.querySelectorAll<HTMLElement>('.ip-tabs button')) b.classList.toggle('active', b.dataset.tab === pickerTab);
  const q = fold($<HTMLInputElement>('ipSearch').value.trim());
  const grid = $('ipGrid');
  grid.innerHTML = '';
  const cell = (html: string, tip: string, selected: boolean, pick: () => unknown) => {
    const b = grid.appendChild(document.createElement('button'));
    b.type = 'button';
    b.className = `ip-cell${selected ? ' selected' : ''}`;
    b.innerHTML = html;
    b.dataset.tip = tip;
    b.onclick = pick;
  };
  const colors = $('ipColors');
  colors.classList.toggle('hidden', pickerTab !== 'icon');
  if (pickerTab === 'emoji') {
    const typed = $<HTMLInputElement>('ipSearch').value.trim();
    if (EMOJI_RE.test(typed) && !EMOJIS.some(([e]) => e === typed)) {
      cell(esc([...typed].slice(0, 8).join('')), 'Utiliser cet émoji', current.emoji === typed, () => setPickedIcon({ emoji: typed }));
    }
    for (const [e, words] of EMOJIS) {
      if (q && !fold(words).includes(q)) continue;
      cell(e, words.split(' ')[0], current.emoji === e, () => setPickedIcon({ emoji: e }));
    }
  } else {
    colors.innerHTML = '';
    for (const c of ICON_COLORS) {
      const sw = colors.appendChild(document.createElement('button'));
      sw.type = 'button';
      sw.className = `ip-color${c === pickerColor ? ' selected' : ''}`;
      sw.style.background = c;
      sw.dataset.tip = c === ICON_COLORS[0] ? 'Gris' : 'Couleur';
      sw.onclick = () => {
        pickerColor = c;
        if (current.icon) setPickedIcon({ icon: current.icon, color: c });
        else renderIconPicker();
      };
    }
    for (const [name, [words]] of Object.entries(ICONS)) {
      if (q && !fold(words).includes(q)) continue;
      cell(iconSvg(name, pickerColor), words.split(' ')[0], current.icon === name, () => setPickedIcon({ icon: name, color: pickerColor }));
    }
  }
  if (!grid.children.length) grid.innerHTML = '<div class="ip-empty muted">Rien ne correspond. Collez un émoji pour l’utiliser tel quel.</div>';
}
const setPickedIcon = (icon: ProjectIcon | null) => applyProjectIcon(() => window.api.setProjectIcon(settingsProject, icon));
for (const b of document.querySelectorAll<HTMLElement>('.ip-tabs button')) b.onclick = () => { pickerTab = b.dataset.tab ?? 'emoji'; renderIconPicker(); };
$<HTMLInputElement>('ipSearch').addEventListener('input', renderIconPicker);
$<HTMLButtonElement>('projectImage').onclick = () => applyProjectIcon(() => window.api.pickProjectIcon(settingsProject));
$<HTMLButtonElement>('projectIconClear').onclick = () => applyProjectIcon(() => window.api.setProjectIcon(settingsProject, null));
$<HTMLButtonElement>('projectDialogClose').onclick = () => $<HTMLDialogElement>('projectDialog').close();
$<HTMLButtonElement>('projectSettingsBtn').onclick = () => openProjectSettings(projectFilter);
$<HTMLButtonElement>('projectDelete').onclick = async () => {
  const dir = settingsProject;
  const n = everyConversation.filter((c) => projectOf(c) === dir).length;
  if (!confirm(`Supprimer le projet « ${projectLabel(dir)} » de Poney ?\n\n${n ? `${n} conversation${n > 1 ? 's seront supprimées' : ' sera supprimée'}. ` : ''}Le dossier ${shortPath(dir)} et ses fichiers ne sont pas touchés.`)) return;
  const before = activeDir();
  try {
    settings = await window.api.deleteProject(dir);
  } catch (e) {
    alert(errorText(e));
    return;
  }
  $<HTMLDialogElement>('projectDialog').close();
  if (projectFilter === dir) setProjectFilter(ALL);
  try { if (localStorage.getItem('lastProject') === dir) localStorage.removeItem('lastProject'); } catch {}
  renderSettings();
  if (activeDir() !== before) onWorkspaceChanged();
  else refreshConversations();
};

// ---------- tooltips ----------
// Elements with data-tip: their tooltip shows at once on hover (the browser's waits).
const tip = document.body.appendChild(document.createElement('div'));
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
let tipFor: HTMLElement | null = null;
function showTip(el: HTMLElement) {
  tip.textContent = el.dataset.tip ?? '';
  const side = 'tipSide' in el.dataset;
  tip.classList.toggle('side', side);
  tip.classList.add('show');
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const top = side ? Math.max(6, Math.min(r.top, innerHeight - t.height - 6))
    : r.top - t.height - 8 >= 4 ? r.top - t.height - 8 : r.bottom + 8; // above, else below
  const left = side ? r.right + 8 : Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 6));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}
function hideTip() {
  tipFor = null;
  tip.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const el = (e.target as HTMLElement).closest?.<HTMLElement>('[data-tip]');
  if (el === tipFor) return;
  if (!el?.dataset.tip) return hideTip();
  tipFor = el;
  showTip(el);
});
document.addEventListener('mousedown', hideTip);
document.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

// ---------- toasts ----------
// A conversation in the background finished, failed or asks for an approval (the window is
// in front: else the system notifies). A click opens it; the one shown has none.
const toasts = document.body.appendChild(div('toasts'));
const ALERT_LABELS: Record<AppAlert['kind'], string> = { done: 'Terminé', error: 'Erreur', approval: 'Autorisation demandée' };
function showAlert(a: AppAlert) {
  if (a.session === currentConversation) return;
  for (const old of toasts.querySelectorAll<HTMLElement>(`[data-session="${CSS.escape(a.session)}"]`)) old.remove(); // (its latest news)
  const t = div(`toast toast-${a.kind}`, `<span class="toast-kind"></span><b></b><span class="toast-body"></span><button class="toast-close" aria-label="Fermer">×</button>`);
  t.dataset.session = a.session;
  t.querySelector('.toast-kind')!.textContent = ALERT_LABELS[a.kind];
  t.querySelector('b')!.textContent = a.title;
  t.querySelector('.toast-body')!.textContent = a.body.replace(/^Autorisation demandée( \([^)]*\))? : /, '');
  const close = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 180);
  };
  t.onclick = (e) => {
    close();
    if (!(e.target as HTMLElement).closest('.toast-close')) openConversation(a.session);
  };
  // (an approval waits for an answer: it stays; the others go after a while, not while pointed at)
  let timer = a.kind === 'approval' ? undefined : setTimeout(close, 8000);
  t.onmouseenter = () => clearTimeout(timer);
  t.onmouseleave = () => { if (a.kind !== 'approval') timer = setTimeout(close, 3000); };
  toasts.prepend(t);
  for (const extra of [...toasts.children].slice(4)) extra.remove();
}
const clearAlerts = (session: string) => { for (const t of toasts.querySelectorAll<HTMLElement>(`[data-session="${CSS.escape(session)}"]`)) t.remove(); };
window.api.onAlert(showAlert);
window.api.onOpenConversation((id) => openConversation(id)); // (a notification of the system, clicked)

// ---------- sidebar ----------
let replaying = false;
let currentConversation: string | null = null;

$<HTMLButtonElement>('sidebarBtn').onclick = () => projectActions.toggleSidebar(projectFilter);
// The conversations and the files, as a deck of two cards (the one in front: remembered).
let filesInFront = false;
try { filesInFront = localStorage.getItem('deckFront') === 'files'; } catch {}
// On the card of the files, two sections, gone through as the projects are on the other card.
const SECTIONS = [
  { key: 'files', label: 'Fichiers', shortcut: 'showFiles', icon: '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 3a1 1 0 0 1 1-1h2.6l1.2 1.3H10a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/></svg>' },
  { key: 'git', label: 'Git', shortcut: 'showGit', icon: '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="2.5" r="1.6"/><circle cx="3" cy="9.5" r="1.6"/><circle cx="9" cy="3.5" r="1.6"/><path class="line" d="M3 3v6M9 4.5C9 7 3 6 3 8.5"/></svg>' },
];
let filesSection = 'files';
try { if (localStorage.getItem('filesSection') === 'git') filesSection = 'git'; } catch {}
const sectionLabel = () => SECTIONS.find((s) => s.key === filesSection)!.label;
function renderDeck() {
  const [front, back] = filesInFront ? [$('filesBar'), $('sidebar')] : [$('sidebar'), $('filesBar')];
  front.className = front.className.replace(/\b(front|back)\b/g, '').trim();
  back.className = back.className.replace(/\b(front|back)\b/g, '').trim();
  front.classList.add('front');
  back.classList.add('back');
  front.inert = false;
  back.inert = true; // (under the other card: out of reach of the keyboard too)
  $<HTMLButtonElement>('deckTab').textContent = filesInFront ? 'Conversations' : sectionLabel();
  $<HTMLButtonElement>('deckTab').setAttribute('aria-label', $<HTMLButtonElement>('deckTab').textContent);
  for (const b of document.querySelectorAll<HTMLElement>('.deck-swap')) b.dataset.tip = `${$<HTMLButtonElement>('deckTab').textContent} (${shortcutText(SHORTCUTS.swapDeck)})`;
}
function swapDeck() {
  filesInFront = !filesInFront;
  try { localStorage.setItem('deckFront', filesInFront ? 'files' : 'conversations'); } catch {}
  renderDeck();
  const deck = $('deck');
  deck.classList.remove('swapping');
  void deck.offsetWidth; // (swapped again during the animation: it starts over)
  deck.classList.add('swapping');
}
$('deck').addEventListener('animationend', (e) => { if ((e.target as HTMLElement).classList.contains('front')) $('deck').classList.remove('swapping'); });
$<HTMLButtonElement>('deckTab').onclick = swapDeck;
renderDeck();
for (const b of document.querySelectorAll<HTMLElement>('.deck-swap')) b.onclick = swapDeck;
function swapOrShowDeck() {
  if (!document.body.classList.contains('no-sidebar')) return swapDeck();
  document.body.classList.remove('no-sidebar'); // (hidden: shown, with the files on top)
  if (!filesInFront) swapDeck();
}
window.api.onSwipe(swapOrShowDeck);

/** How long a conversation has been working (its card counts the seconds). */
const workTime = (ms: number) => (ms < 10000 ? `${Math.floor(Math.max(0, ms) / 1000)} s` : fmtDuration(ms));
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>('.conv-card .when[data-since]')) el.textContent = workTime(Date.now() - Number(el.dataset.since));
}, 1000);

function relativeTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'hier';
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

let renaming = false; // a title is being edited: don't rebuild the list under the cursor

// ---------- conversations, by where they stand ----------
// Finished (answers not read yet, or the one shown that just finished), asleep until
// a background task ends, waiting for an approval, working, then the archived ones: done and read.
const CATEGORIES = [
  { key: 'drafts', label: 'Brouillons' },
  { key: 'failed', label: 'Erreur' },
  { key: 'done', label: 'Terminé' },
  { key: 'sleeping', label: 'En veille' },
  { key: 'waiting', label: 'Action demandée' },
  { key: 'busy', label: 'En cours' },
  { key: 'archived', label: 'Archivées', foldable: true },
];
// (the conversation shown stays where it is: its text is a draft once the user leaves it)
const category = (c: ConversationSummary) => c.draft ? 'drafts' : c.approvals ? 'waiting' : c.sleeping ? 'sleeping' : c.running ? 'busy' : c.failed ? 'failed' : c.unread || c.finished ? 'done' : 'archived';
let collapsedCategories = new Set<string>();
try { collapsedCategories = new Set(JSON.parse(localStorage.getItem('collapsedCategories') || '[]') as string[]); } catch {}
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// ---------- projects: the one whose conversations are listed ----------
// 'Tous', each project (by name), then 'Hors projet'. A two-finger swipe on the
// sidebar goes from one to the next; the dots at the bottom say where we are.
const ALL = '@all';
const OFF_KEY = '@off-project';
let projectFilter = ALL;
try { projectFilter = localStorage.getItem('projectFilter') || ALL; } catch {}
let everyConversation: ConversationSummary[] = [];
let lastConversations: ConversationSummary[] = []; // (without those of hidden projects)
const isHiddenProject = (key: string) => Boolean(settings.hiddenProjects?.includes(key));

function allProjectKeys(all = everyConversation) {
  const dirs = new Set(settings.recent || []);
  if (settings.workspace) dirs.add(settings.workspace);
  for (const c of all) if (!c.offProject && c.workspace) dirs.add(c.workspace);
  // In the order chosen; those not placed yet after, by name, 'Hors projet' last.
  const order = settings.projectOrder ?? [];
  const placed = order.filter((k) => dirs.has(k) || k === OFF_KEY);
  const rest = [...dirs].filter((k) => !order.includes(k)).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'fr'));
  return [ALL, ...placed, ...rest, ...(placed.includes(OFF_KEY) ? [] : [OFF_KEY])];
}
/** The projects of the sidebar. */
const projectKeys = () => allProjectKeys().filter((key) => !isHiddenProject(key));
const projectLabel = (key: string) => key === ALL ? 'Tous' : key === OFF_KEY ? 'Hors projet' : settings.projectNames?.[key] ?? baseName(key);
const projectOf = (c: ConversationSummary) => c.offProject ? OFF_KEY : c.workspace;
// Among the dots, 'Tous': four small squares, every project at once…
const ALL_ICON = '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1.2"/><rect x="7" y="1" width="4" height="4" rx="1.2"/><rect x="1" y="7" width="4" height="4" rx="1.2"/><rect x="7" y="7" width="4" height="4" rx="1.2"/></svg>';
// …and 'Hors projet' (unless it has an icon of its own): a speech bubble.
const OFF_ICON = '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5h7a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H5.5L3 10.5V8.5h-.5A1.5 1.5 0 0 1 1 7V3a1.5 1.5 0 0 1 1.5-1.5z"/></svg>';

// Without an icon of its own: a folder for a project, a speech bubble outside any project.
const svgIcon = (d: string) => `<svg class="proj-icon svg-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const FOLDER_GLYPH = svgIcon('M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.7h4.9A1.5 1.5 0 0 1 14 6.2v5.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z');
const BUBBLE_GLYPH = svgIcon('M3.5 2.8h9A1.5 1.5 0 0 1 14 4.3v5.4a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.3v-2.3h-.5A1.5 1.5 0 0 1 2 9.7V4.3a1.5 1.5 0 0 1 1.5-1.5z');
const projectGlyph = (key: string) => projectIcon(key, key === OFF_KEY ? BUBBLE_GLYPH : FOLDER_GLYPH);

/** A project's icon (emoji or picture) as HTML, or the fallback given. */
function projectIcon(key: string, fallback = '') {
  const icon = settings.projectIcons?.[key];
  if (icon?.image) return `<img class="proj-icon" src="${esc(icon.image)}" alt="">`;
  if (icon?.emoji) return `<span class="proj-icon">${esc(icon.emoji)}</span>`;
  if (icon?.icon) return iconSvg(icon.icon, icon.color) || fallback;
  return fallback;
}

function setProjectFilter(key: string, dir = 0) {
  if (key === projectFilter) return;
  projectFilter = key;
  try { localStorage.setItem('projectFilter', key); } catch {}
  // A new conversation not started yet follows the project listed.
  if ($('empty') && key !== ALL && key !== activeProject()) newConversationIn(key === OFF_KEY ? null : key, { keepText: true });
  refreshConversations({ slide: dir });
  syncView();
}

/** From anywhere: the card of the conversations in front, at this place among the dots. */
function showProjectAt(place: number) {
  const keys = projectKeys();
  if (!keys[place]) return;
  document.body.classList.remove('no-sidebar');
  if (filesInFront) swapDeck();
  setProjectFilter(keys[place], Math.sign(place - keys.indexOf(projectFilter)));
}

function stepProject(dir: number) {
  const keys = projectKeys();
  // (past either end, round to the other)
  setProjectFilter(keys[(keys.indexOf(projectFilter) + dir + keys.length) % keys.length], dir);
}

/** The project of the files card: the one listed, or the conversation's when all are. */
const viewProject = () => (projectFilter === ALL ? activeProject() : projectFilter);
function renderPicker() {
  const key = viewProject();
  const picker = $<HTMLButtonElement>('viewPicker');
  picker.querySelector<HTMLElement>('.picker-icon')!.innerHTML = key ? projectGlyph(key) : '';
  picker.querySelector<HTMLElement>('.picker-name')!.textContent = key ? projectLabel(key) : 'Aucun projet';
  picker.title = key && key !== OFF_KEY ? key : '';
}

function renderProjectBar(keys: string[]) {
  $<HTMLButtonElement>('projectPicker').querySelector<HTMLElement>('.picker-icon')!.innerHTML = projectIcon(projectFilter);
  $<HTMLButtonElement>('projectPicker').querySelector<HTMLElement>('.picker-name')!.textContent = projectLabel(projectFilter);
  syncView();
  const dots = $('projectDots');
  dots.innerHTML = '';
  for (const key of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pdot${key === projectFilter ? ' active' : ''}`;
    b.dataset.project = key;
    const place = keys.indexOf(key) + 1;
    b.dataset.tip = place <= 9 ? `${projectLabel(key)} (${MAC ? '⌘' : 'Ctrl+'}${place})` : projectLabel(key);
    b.innerHTML = key === ALL ? ALL_ICON : projectIcon(key, key === OFF_KEY ? OFF_ICON : '');
    if (b.innerHTML) b.classList.add('has-icon');
    b.onclick = () => setProjectFilter(key, Math.sign(keys.indexOf(key) - keys.indexOf(projectFilter)));
    dots.appendChild(b);
  }
}

function openProjectMenu() {
  const menu = $('projectMenu');
  menu.innerHTML = '';
  for (const key of projectKeys()) {
    const row = document.createElement('div');
    row.className = `pm-row${key === projectFilter ? ' selected' : ''}`;
    row.innerHTML = `<span class="pm-icon">${key === ALL ? '' : projectGlyph(key)}</span><span class="pm-name"></span>${key === ALL ? '' : '<button class="pm-edit" type="button" title="Paramètres du projet (icône, suppression)">⋯</button>'}`;
    row.querySelector<HTMLElement>('.pm-name')!.textContent = projectLabel(key);
    row.title = key === ALL || key === OFF_KEY ? '' : key;
    row.onclick = () => { closeProjectMenu(); setProjectFilter(key); };
    const edit = row.querySelector<HTMLElement>('.pm-edit');
    if (edit) edit.onclick = (e) => { e.stopPropagation(); closeProjectMenu(); openProjectSettings(key); };
    menu.appendChild(row);
  }
  const add = document.createElement('div');
  add.className = 'pm-row';
  add.innerHTML = '<span class="pm-icon">＋</span><span class="pm-name">Ajouter un projet…</span>';
  add.dataset.tip = `Choisir un dossier (${shortcutText(SHORTCUTS.addProject)})`;
  add.onclick = () => { closeProjectMenu(); addProject(); };
  menu.appendChild(add);
  menu.classList.remove('hidden');
  $<HTMLButtonElement>('projectPicker').classList.add('open');
}
function closeProjectMenu() {
  $('projectMenu').classList.add('hidden');
  $<HTMLButtonElement>('projectPicker').classList.remove('open');
}

// The project of the conversation shown, in the menu of the files card: a small speech bubble.
const HERE_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.8h7A1.4 1.4 0 0 1 10.9 3.2v3.9a1.4 1.4 0 0 1-1.4 1.4H5.6L3.2 10.4V8.5h-.7A1.4 1.4 0 0 1 1.1 7.1V3.2a1.4 1.4 0 0 1 1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
/** The menu of the files card: the project to look at. */
function openViewMenu() {
  const menu = $('viewMenu');
  menu.innerHTML = '';
  const own = activeProject();
  const keys = projectKeys().filter((k) => k !== ALL);
  for (const key of keys) {
    const row = document.createElement('div');
    row.className = `pm-row${key === viewProject() ? ' selected' : ''}`;
    row.innerHTML = `<span class="pm-icon">${projectGlyph(key)}</span><span class="pm-name"></span>${key === own ? `<span class="pm-here" data-tip="Projet de la conversation affichée">${HERE_ICON}</span>` : ''}<button class="pm-edit" type="button" title="Paramètres du projet (icône, suppression)">⋯</button>`;
    row.querySelector<HTMLElement>('.pm-name')!.textContent = projectLabel(key);
    row.title = key === OFF_KEY ? '' : key;
    row.onclick = () => { closeViewMenu(); setProjectFilter(key, Math.sign(keys.indexOf(key) - keys.indexOf(viewProject() ?? ''))); };
    const edit = row.querySelector<HTMLElement>('.pm-edit');
    if (edit) edit.onclick = (e) => { e.stopPropagation(); closeViewMenu(); openProjectSettings(key); };
    menu.appendChild(row);
  }
  const add = document.createElement('div');
  add.className = 'pm-row';
  add.innerHTML = '<span class="pm-icon">＋</span><span class="pm-name">Ajouter un projet…</span>';
  add.dataset.tip = `Choisir un dossier (${shortcutText(SHORTCUTS.addProject)})`;
  add.onclick = () => { closeViewMenu(); addProject(); };
  menu.appendChild(add);
  menu.classList.remove('hidden');
  $<HTMLButtonElement>('viewPicker').classList.add('open');
}
function closeViewMenu() {
  $('viewMenu').classList.add('hidden');
  $<HTMLButtonElement>('viewPicker').classList.remove('open');
}
$<HTMLButtonElement>('viewPicker').onclick = (e) => {
  e.stopPropagation();
  if ($('viewMenu').classList.contains('hidden')) openViewMenu(); else closeViewMenu();
};
$('viewMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeViewMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewMenu(); });

let shownSession: string | null | undefined; // (undefined: before the first conversation)
/** The files card on the project it should show; the chat greyed when it is not the conversation's. */
async function syncView() {
  const session = settings.active?.session ?? null;
  const own = activeProject();
  if (session !== shownSession) {
    // Another conversation shown: the user is back to it, the list on its project (unless all are listed).
    const opened = shownSession !== undefined;
    shownSession = session;
    if (opened && own && projectFilter !== ALL && projectFilter !== own) return setProjectFilter(own);
  }
  renderPicker();
  // (on the page of a new conversation, the project chosen is where it goes: nothing to grey)
  const key = viewProject();
  const next = key && key !== own && !$('empty') ? key : null;
  if (next === observed) return;
  observed = next;
  greyChat(Boolean(next));
  await window.api.observeProject(next === OFF_KEY ? null : next);
  closeViewer(); // (what was open belongs to the other project)
  closeDiffPanel();
  expanded.clear();
  refreshTree();
}
/** Back to the conversation: both cards on its project. */
function endObserving() {
  if (observed) setProjectFilter(activeProject() ?? ALL);
}
const chat = document.querySelector<HTMLElement>('.chat')!;
/** Greyed, out of reach of the keyboard: a click on it only brings it back (its controls wait for the next one). */
function greyChat(on: boolean) {
  document.body.classList.toggle('observing', on);
  for (const el of chat.children) (el as HTMLElement).inert = on;
}
chat.addEventListener('mousedown', () => endObserving());

$<HTMLButtonElement>('projectPicker').onclick = (e) => {
  e.stopPropagation();
  if ($('projectMenu').classList.contains('hidden')) openProjectMenu(); else closeProjectMenu();
};
$('projectMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeProjectMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProjectMenu(); });

// Two-finger swipe (horizontal wheel on a trackpad): one project per swipe.
const swipe = new SwipeDetector(stepProject);
$('sidebar').addEventListener('wheel', (e) => swipe.wheel(e.deltaX, e.deltaY, e.timeStamp), { passive: true });

// Anywhere else (not inside the card in front), the same swipe swaps the two cards.
const deckSwipe = new SwipeDetector(swapDeck);
/** Over what scrolls sideways (a code block, a table…), a swipe is for it. */
function scrollsSideways(el: Element | null) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}
window.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || document.body.classList.contains('no-sidebar')) return;
  if ((e.target as HTMLElement).closest?.('.deck .front, dialog') || scrollsSideways(e.target as HTMLElement)) return;
  deckSwipe.wheel(e.deltaX, e.deltaY, e.timeStamp);
}, { passive: true });

/** At the top of the window: the project and the title of the conversation shown. */
function renderConvHead() {
  const c = lastConversations.find((x) => x.id === currentConversation);
  const off = c ? c.offProject : offMode();
  const dir = c ? c.workspace : activeDir();
  const key = off ? OFF_KEY : dir;
  const project = $('convHead').querySelector<HTMLElement>('.head-project')!;
  project.innerHTML = off || dir ? `${projectGlyph(key)} ${esc(projectLabel(key))}` : '';
  const title = c?.title || 'Nouvelle conversation';
  $('convHead').querySelector<HTMLElement>('.head-title')!.textContent = title;
  $('convHead').title = title;
  $<HTMLButtonElement>('headRename').classList.toggle('hidden', !c);
}
const renameTip = () => `Renommer (${MAC ? '⌘R' : 'Ctrl+R'})`;
/** Renames the conversation shown, in place at the top of the window. */
function renameCurrent() {
  const c = lastConversations.find((x) => x.id === currentConversation);
  if (c && !document.querySelector<HTMLElement>('dialog[open]')) startRename($('convHead'), c, $('convHead').querySelector<HTMLElement>('.head-title')!);
}
$('convHead').querySelector<HTMLElement>('.head-title')!.ondblclick = renameCurrent;
$<HTMLButtonElement>('headRename').onclick = renameCurrent;
$<HTMLButtonElement>('headRename').dataset.tip = renameTip();
window.api.onRenameConversation(renameCurrent); // (the application menu, ⌘R)

async function refreshConversations({ slide = 0 } = {}) {
  if (renaming || !settings) return;
  const { current, all: every } = await window.api.listConversations();
  currentConversation = current;
  everyConversation = every;
  lastConversations = every.filter((c) => !isHiddenProject(projectOf(c)));
  const named = lastConversations.find((c) => c.id === current && c.titleFromDraft);
  if (named) showDraftTitle(named);
  else renderConvHead();
  const keys = projectKeys();
  if (!keys.includes(projectFilter)) projectFilter = ALL;
  renderProjectBar(keys);
  const all = projectFilter === ALL ? lastConversations : lastConversations.filter((c) => projectOf(c) === projectFilter);
  const list = $('convList');
  const before = slide ? null : sidebarPlaces();
  list.innerHTML = '';
  if (slide) {
    list.classList.remove('slide-next', 'slide-prev');
    void list.offsetWidth; // (restarts the animation)
    list.classList.add(slide > 0 ? 'slide-next' : 'slide-prev');
  }
  const add = document.createElement('li');
  add.innerHTML = '<button class="new-conv" type="button">＋ Nouvelle conversation<span class="kbd"></span></button>';
  const key = window.api.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const addButton = add.firstChild as HTMLElement;
  addButton.querySelector<HTMLElement>('.kbd')!.textContent = `${key}N`;
  addButton.onclick = newConversationHere;
  list.appendChild(add);
  for (const cat of CATEGORIES) {
    const items = all.filter((c) => category(c) === cat.key);
    if (!items.length) continue;
    const collapsed = cat.foldable && collapsedCategories.has(cat.key);
    const li = document.createElement('li');
    li.className = `group ${cat.key}${collapsed ? ' collapsed' : ''}${cat.foldable ? ' foldable' : ''}`;
    li.innerHTML = '<div class="group-head"><span class="name"></span><span class="count"></span><span class="chev">▾</span></div><ul class="list"></ul>';
    li.querySelector<HTMLElement>('.group-head')!.dataset.place = `category ${cat.key}`;
    li.querySelector<HTMLElement>('.name')!.textContent = cat.label;
    li.querySelector<HTMLElement>('.count')!.textContent = String(items.length);
    if (cat.foldable) {
      li.querySelector<HTMLElement>('.group-head')!.onclick = () => {
        if (collapsedCategories.has(cat.key)) collapsedCategories.delete(cat.key); else collapsedCategories.add(cat.key);
        try { localStorage.setItem('collapsedCategories', JSON.stringify([...collapsedCategories])); } catch {}
        refreshConversations();
      };
    }
    const ul = li.querySelector<HTMLElement>('ul')!;
    for (const c of items) ul.appendChild(conversationItem(c, current));
    list.appendChild(li);
  }
  if (!all.length) {
    const none = document.createElement('li');
    none.className = 'empty-note';
    none.textContent = projectFilter === ALL ? 'Aucune conversation.' : 'Aucune conversation dans ce projet.';
    list.appendChild(none);
  }
  if (before) moveCards(before);
}

/** Where the cards and the category titles are, to animate what a new list changes. */
function sidebarPlaces() {
  if (calm || !$('sidebar').classList.contains('front') || document.body.classList.contains('no-sidebar')) return null;
  const places: Places = new Map();
  for (const el of $('convList').querySelectorAll<HTMLElement>('.conv-card, .group-head')) {
    const r = el.getBoundingClientRect();
    if (r.height) places.set(el.dataset.place ?? '', { el, r });
  }
  return places.size ? places : null;
}
const CARD_MOVE = { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
/** The new list starts from where the old one was: moved, appearing, or fading out. */
function moveCards(before: Places) {
  const seen = new Set();
  for (const el of $('convList').querySelectorAll<HTMLElement>('.conv-card, .group-head')) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    seen.add(el.dataset.place);
    const old = before.get(el.dataset.place ?? '')?.r;
    if (!old) el.animate([{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'none' }], CARD_MOVE);
    else if (old.top !== r.top || old.left !== r.left) {
      el.animate([{ transform: `translate(${old.left - r.left}px, ${old.top - r.top}px)` }, { transform: 'none' }], CARD_MOVE);
    }
  }
  const pane = $('convPane');
  const box = pane.getBoundingClientRect();
  for (const [key, { el, r }] of before) {
    if (seen.has(key)) continue;
    el.classList.add('leaving');
    Object.assign(el.style, { top: `${r.top - box.top + pane.scrollTop}px`, left: `${r.left - box.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    pane.appendChild(el);
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: 200, easing: 'ease-in' }).onfinish = () => el.remove();
  }
}

/** A new conversation in the default project (see defaultProject). */
const newConversationHere = () => {
  const key = defaultProject();
  return newConversationIn(key === OFF_KEY ? null : key);
};

/** A new conversation in a project folder, or outside any project (dir null). */
async function newConversationIn(dir: string | null, { keepText = false } = {}) {
  rememberScroll(); // (the conversation shown goes on in the background)
  // (only another project for the page of a new conversation: what is typed follows)
  const text = keepText ? input.value : '';
  if (keepText) {
    setInput('');
    await window.api.setDraft('');
  } else await flushDraft();
  const before = activeDir();
  try {
    if (dir === null) settings = await window.api.newOffProject();
    else if (dir !== settings.workspace) settings = await window.api.setWorkspace(dir);
    else settings = await window.api.reset();
  } catch (e) {
    $('status').textContent = errorText(e);
    return;
  }
  renderSettings();
  setRunning(false); // a new conversation is idle
  if (activeDir() !== before) onWorkspaceChanged();
  else {
    clearTranscript();
    refreshConversations();
    refreshPromptBadge();
    refreshGauge();
  }
  setInput(text);
  if (text) noteDraft();
  input.focus();
}

const CLOCK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

function conversationItem(c: ConversationSummary, current: string | null) {
  const li = document.createElement('li');
  li.className = `conv-card ${category(c)}`;
  li.dataset.place = c.id;
  li.dataset.project = projectOf(c);
  li.classList.toggle('active', c.id === current);
  li.innerHTML = '<div class="card-top"><span class="title"></span><span class="state"></span><span class="pill"></span><span class="card-actions"><button class="ren">✎</button><button class="del" title="Supprimer">✕</button></span></div><div class="card-meta"><span class="project"></span><span class="when"></span><span class="card-engine"></span></div>';
  li.querySelector<HTMLElement>('.title')!.textContent = c.title;
  if (c.draft) { // (the card shows its prompt on hover, instead of the title in full)
    li.dataset.tip = c.draftText;
    li.dataset.tipSide = '';
  } else li.querySelector<HTMLElement>('.title')!.title = c.title;
  // How many things wait for the user: approvals (orange), answers to read (blue, or red after an error).
  // Asleep, nothing does: a clock in the same place.
  const pill = li.querySelector<HTMLElement>('.pill')!;
  if (c.approvals) {
    pill.textContent = String(c.approvals);
    pill.classList.add('warn');
    pill.title = c.approvals > 1 ? `${c.approvals} autorisations en attente` : 'Une autorisation en attente';
  } else if (c.sleeping) {
    pill.innerHTML = CLOCK_ICON;
    pill.classList.add('clock');
    pill.title = 'En veille : attend la fin d’une tâche';
  } else if (c.unread) {
    pill.textContent = String(c.unread);
    pill.title = category(c) === 'failed' ? (c.unread > 1 ? `${c.unread} messages à consulter` : 'Un message à consulter')
      : c.unread > 1 ? `${c.unread} réponses à lire` : 'Une réponse à lire';
  } else pill.remove();
  const project = li.querySelector<HTMLElement>('.project')!;
  project.innerHTML = `${projectGlyph(projectOf(c))} ${esc(projectLabel(projectOf(c) || ''))}`;
  project.title = c.offProject ? 'Conversation sans dossier de projet' : c.workspace || '';
  const group = modelGroups.find((g) => g.provider.id === (c.provider ?? firstServer()));
  li.querySelector<HTMLElement>('.card-engine')!.innerHTML = c.engine === 'claude' ? CLAUDE_ICON : groupIcon(group);
  li.querySelector<HTMLElement>('.card-engine')!.title = c.engine === 'claude' ? 'Modèle Claude' : group?.name ? `Modèle ${group.name}` : 'Modèle local';
  const when = li.querySelector<HTMLElement>('.when')!;
  if (category(c) === 'busy' && c.workingSince) {
    when.dataset.since = String(c.workingSince);
    when.textContent = workTime(Date.now() - c.workingSince);
  } else when.textContent = relativeTime(c.updatedAt);
  li.onclick = () => openConversation(c.id);
  li.querySelector<HTMLElement>('.ren')!.dataset.tip = renameTip();
  li.querySelector<HTMLElement>('.ren')!.onclick = (e) => { e.stopPropagation(); startRename(li, c); };
  li.querySelector<HTMLElement>('.title')!.ondblclick = (e) => { e.stopPropagation(); startRename(li, c); };
  li.querySelector<HTMLElement>('.del')!.onclick = (e) => { e.stopPropagation(); deleteConversation(c, current); };
  // Right click: this conversation's actions.
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeProjectMenu();
    showContextMenu(e.clientX, e.clientY, esc(c.title), [
      { label: 'Marquer comme lue', disabled: !(c.unread || c.finished), run: () => window.api.markConversationsRead([c.id]) },
      { label: 'Renommer', run: () => startRename(li, c) },
      '-',
      { label: 'Supprimer…', danger: true, run: () => deleteConversation(c, current) },
    ]);
  });
  return li;
}

async function deleteConversation(c: ConversationSummary, current: string | null) {
  if (!confirm(c.offProject
    ? `Supprimer la conversation « ${c.title} » et les fichiers de son dossier ?`
    : `Supprimer la conversation « ${c.title} » ?`)) return;
  try {
    await window.api.deleteConversation(c.id);
  } catch (err) {
    alert(errorMessage(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return;
  }
  if (c.id === current) {
    settings = await window.api.getSettings();
    renderSettings();
    clearTranscript();
    setInput('');
    refreshTree();
  }
  refreshConversations();
}

function startRename(li: HTMLElement, c: ConversationSummary, span = li.querySelector<HTMLElement>('.title')!) {
  if (renaming) return;
  renaming = true;
  const inp = document.createElement('input');
  inp.className = 'rename';
  inp.value = c.title;
  inp.maxLength = 80;
  span.replaceWith(inp);
  li.classList.add('editing');
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const title = inp.value.trim();
    if (save && title && title !== c.title) {
      try {
        await window.api.renameConversation(c.id, title);
      } catch (e) {
        $('status').textContent = errorText(e);
      }
    }
    renaming = false;
    inp.replaceWith(span);
    li.classList.remove('editing');
    refreshConversations();
  };
  inp.onclick = (e) => e.stopPropagation();
  inp.ondblclick = (e) => e.stopPropagation();
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);
}

// Reading position of each conversation ('bottom': it follows what is being written).
const scrollPos = new Map<string, number | 'bottom'>();
function rememberScroll() {
  const key = settings.active?.session;
  if (!key) return;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  scrollPos.set(key, atBottom ? 'bottom' : transcript.scrollTop);
}

/** Draws a session as it is now: transcript, answer being written, pending approvals, reading position. */
function showSession(view: SessionView) {
  replayTranscript(view.events);
  if (view.memory) renderMemory(view.memory);
  const p = view.partial;
  if (p) {
    if (!bubbles.has(p.id)) onEvent({ type: 'assistant_start', id: p.id }); // (the replay may have started it)
    if (p.thinking) onEvent({ type: 'delta', id: p.id, kind: 'thinking', text: p.thinking });
    if (p.text) onEvent({ type: 'delta', id: p.id, kind: 'text', text: p.text });
  }
  setRunning(Boolean(view.running));
  for (const req of view.approvals || []) onApproval(req);
  setInput(view.draft || '');
  fitComposer(); // (its plan may be there or not: the position is that of the page at its final height)
  const pos = scrollPos.get(view.session);
  transcript.scrollTop = typeof pos === 'number' ? pos : transcript.scrollHeight;
}

async function openConversation(id: string) {
  if (id === currentConversation) return;
  rememberScroll(); // (the conversation shown goes on in the background)
  await flushDraft();
  let view;
  try {
    view = await window.api.openConversation(id);
  } catch (e) {
    $('status').textContent = errorText(e);
    return;
  }
  const moved = view.settings.active?.cwd !== activeDir();
  settings = view.settings;
  renderSettings();
  if (moved) {
    expanded.clear();
    closeViewer();
  } else if (openPath?.startsWith('.poney/')) closeViewer(); // (the other conversation's private folder)
  refreshTree(); // (each conversation has its own private folder)
  showSession(view);
  clearAlerts(id);
  rememberProject();
  refreshConversations();
  refreshPromptBadge();
  refreshGauge();
  input.focus();
}

// ---------- file tree ----------
const expanded = new Set<string>(); // expanded directory paths
let openPath: string | null = null;

async function renderDir(rel: string, ul: HTMLElement) {
  let entries;
  try {
    entries = await window.api.listFiles(rel);
  } catch {
    ul.innerHTML = '<li class="node muted">illisible</li>';
    return;
  }
  ul.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const node = div(`node${e.ignored ? ' ignored' : ''}${e.path === openPath ? ' active' : ''}${treeStates[e.path] ? ` gs-${treeStates[e.path]}` : ''}`);
    node.dataset.path = e.path;
    node.innerHTML = `<span class="caret">${e.dir ? (expanded.has(e.path) ? '▾' : '▸') : ''}</span>${e.scratch ? privateFolderIconSvg() : e.dir ? folderIconSvg(expanded.has(e.path)) : fileIconSvg(e.name)}<span class="name"></span>`;
    node.querySelector<HTMLElement>('.name')!.textContent = e.name;
    node.title = e.scratch ? 'Dossier privé de la conversation, hors du projet et de Git' : e.path;
    if (e.scratch) node.classList.add('scratch');
    li.appendChild(node);
    if (e.dir) {
      const sub = document.createElement('ul');
      li.appendChild(sub);
      if (expanded.has(e.path)) await renderDir(e.path, sub);
      node.onclick = async () => {
        if (expanded.has(e.path)) {
          expanded.delete(e.path);
          sub.innerHTML = '';
        } else {
          expanded.add(e.path);
          await renderDir(e.path, sub);
        }
        node.querySelector<HTMLElement>('.caret')!.textContent = expanded.has(e.path) ? '▾' : '▸';
      };
    } else {
      node.onclick = () => openFile(e.path);
    }
    ul.appendChild(li);
  }
  if (!entries.length && rel === '.') ul.innerHTML = '<li class="node muted">Dossier vide</li>';
}

let treeRefresh: ReturnType<typeof setTimeout> | undefined;
let treeStates: FileStates = {}; // the git state of each path, for its color
async function refreshTree() {
  renderFilesHead();
  refreshGit();
  if (!viewDir()) {
    $('fileTree').innerHTML = '';
    return;
  }
  treeStates = viewOff() ? {} : await window.api.gitFileStates().catch(() => ({}));
  await renderDir('.', $('fileTree'));
}
$<HTMLButtonElement>('refreshFiles').onclick = () => filesSection === 'git' ? refreshGit({ force: true }) : refreshTree();

// ---------- the sections of the second card: the files and Git ----------
function renderFilesHead() {
  const git = filesSection === 'git';
  const root = $('filesRoot');
  root.classList.toggle('branch', git);
  root.textContent = git ? (gitState?.repo ? gitState.branch || 'Tête détachée' : '') : viewOff() ? '' : `\u200e${shortPath(viewDir())}`; // (the mark keeps ~ first: the line is right to left, to cut from the left)
  root.title = git ? root.textContent : viewDir();
}
function renderSection() {
  $<HTMLButtonElement>('sectionPicker').querySelector<HTMLElement>('.picker-icon')!.innerHTML = SECTIONS.find((s) => s.key === filesSection)!.icon;
  $<HTMLButtonElement>('sectionPicker').querySelector<HTMLElement>('.picker-name')!.textContent = sectionLabel();
  $('filesPane').classList.toggle('hidden', filesSection !== 'files');
  $('gitPane').classList.toggle('hidden', filesSection !== 'git');
  const dots = $('sectionDots');
  dots.innerHTML = '';
  for (const s of SECTIONS) {
    const b = dots.appendChild(document.createElement('button'));
    b.type = 'button';
    b.className = `pdot has-icon${s.key === filesSection ? ' active' : ''}`;
    b.dataset.tip = `${s.label} (${shortcutText(SHORTCUTS[s.shortcut])})`;
    b.innerHTML = s.icon;
    b.onclick = () => setSection(s.key);
  }
  renderDeck();
}
function setSection(key: string, dir = Math.sign(SECTIONS.findIndex((s) => s.key === key) - SECTIONS.findIndex((s) => s.key === filesSection))) {
  if (key === filesSection) return;
  filesSection = key;
  try { localStorage.setItem('filesSection', key); } catch {}
  renderSection();
  renderFilesHead();
  const pane = $(key === 'git' ? 'gitPane' : 'filesPane');
  pane.classList.remove('slide-next', 'slide-prev');
  void pane.offsetWidth; // (changed again during the animation: it starts over)
  pane.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  refreshGit();
}
/** From anywhere: the card of the files in front, at this section. */
function showSection(key: string) {
  document.body.classList.remove('no-sidebar');
  if (!filesInFront) swapDeck();
  setSection(key);
}
function stepSection(dir: number) {
  setSection(SECTIONS[(SECTIONS.findIndex((s) => s.key === filesSection) + dir + SECTIONS.length) % SECTIONS.length].key, dir);
}
const sectionSwipe = new SwipeDetector(stepSection);
$('filesBar').addEventListener('wheel', (e) => {
  if ($('filesBar').classList.contains('front')) sectionSwipe.wheel(e.deltaX, e.deltaY, e.timeStamp);
}, { passive: true });
function closeSectionMenu() {
  $('sectionMenu').classList.add('hidden');
  $<HTMLButtonElement>('sectionPicker').classList.remove('open');
}
$<HTMLButtonElement>('sectionPicker').onclick = (e) => {
  e.stopPropagation();
  if (!$('sectionMenu').classList.contains('hidden')) return closeSectionMenu();
  $('sectionMenu').replaceChildren(...SECTIONS.map((s) => {
    const row = div(`pm-row${s.key === filesSection ? ' selected' : ''}`);
    row.innerHTML = `<span class="pm-icon">${s.icon}</span><span class="pm-name">${s.label}</span>`;
    row.onclick = () => { closeSectionMenu(); setSection(s.key); };
    return row;
  }));
  $('sectionMenu').classList.remove('hidden');
  $<HTMLButtonElement>('sectionPicker').classList.add('open');
};
$('sectionMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeSectionMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSectionMenu(); });

// ---------- Git ----------
const FETCH_EVERY_MS = 5 * 60 * 1000;
const lastFetch = new Map<string, number>(); // (folder → when: what comes down is counted from the last fetch)
let gitState: GitRepoStatus | null = null;
let gitRefresh = 0;
let gitSyncing = false;
let gitError = '';
let diffFile: (Pick<GitFile, 'path' | 'oldPath'> & { staged: boolean }) | null = null; // the file in the diff panel: { path, oldPath, staged }
let collapsedGit = new Set<string>();
try { collapsedGit = new Set(JSON.parse(localStorage.getItem('gitCollapsed') || '[]') as string[]); } catch {}

async function refreshGit({ force = false } = {}) {
  if (filesSection !== 'git') return;
  const dir = viewOff() ? '' : viewDir();
  const run = ++gitRefresh;
  const st: GitRepoStatus = dir ? await window.api.gitStatus().catch((): GitRepoStatus => ({ repo: false })) : { repo: false };
  if (run !== gitRefresh) return; // (a newer one is on its way, perhaps for another project)
  gitState = st;
  renderGit();
  renderFilesHead();
  if (diffFile) {
    const { path, staged } = diffFile;
    const file = st.repo ? (staged ? st.staged : st.unstaged).find((f) => f.path === path) : undefined;
    if (file) openDiff(file, staged, { keepScroll: true }); else closeDiffPanel();
  }
  if (!st.repo || !st.hasRemote || gitSyncing || (!force && Date.now() - (lastFetch.get(dir) ?? 0) < FETCH_EVERY_MS)) return;
  lastFetch.set(dir, Date.now());
  try { await window.api.gitFetch(); } catch { return; } // (offline: the counts stay as they are)
  if (run === gitRefresh) refreshGit();
}
window.addEventListener('focus', () => refreshTree()); // (a commit made elsewhere; this refreshes Git too)

function gitGroup(key: string, label: string, count: number) {
  const group = div(`group foldable git-group${collapsedGit.has(key) ? ' collapsed' : ''}`);
  group.innerHTML = '<div class="group-head"><span class="name"></span><span class="count"></span><span class="chev">▾</span></div><ul class="list tree"></ul>';
  group.querySelector<HTMLElement>('.name')!.textContent = label;
  group.querySelector<HTMLElement>('.count')!.textContent = String(count);
  group.querySelector<HTMLElement>('.group-head')!.onclick = () => {
    if (collapsedGit.has(key)) collapsedGit.delete(key); else collapsedGit.add(key);
    try { localStorage.setItem('gitCollapsed', JSON.stringify([...collapsedGit])); } catch {}
    group.classList.toggle('collapsed');
  };
  return group;
}
function gitFileRow(file: GitFile, staged: boolean) {
  const name = baseName(file.path);
  const folder = file.path.slice(0, -name.length - 1);
  const li = document.createElement('li');
  const node = li.appendChild(div('node git-file'));
  node.dataset.git = `${staged ? 'staged' : 'unstaged'}:${file.path}`;
  node.classList.toggle('active', diffFile?.staged === staged && diffFile.path === file.path);
  node.innerHTML = `${fileIconSvg(name)}<span class="name"></span><span class="git-dir"></span><span class="git-letter ${esc(file.status)}">${esc(file.status)}</span>`;
  node.querySelector<HTMLElement>('.name')!.textContent = name;
  node.querySelector<HTMLElement>('.git-dir')!.textContent = folder;
  node.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  node.onclick = () => openDiff(file, staged);
  return li;
}
function renderGit() {
  const pane = $('gitPane');
  const st = gitState;
  if (!st?.repo) {
    const none = div('git-empty muted');
    none.textContent = 'Pas de dépôt Git ici.';
    pane.replaceChildren(none);
    return;
  }
  const sync = document.createElement('button');
  sync.type = 'button';
  sync.className = 'git-sync';
  sync.disabled = gitSyncing || (st.hasRemote && !st.branch);
  sync.textContent = !st.hasRemote ? 'Configurer un dépôt distant' : gitSyncing ? 'Synchronisation…' : 'Synchroniser';
  if (st.upstream) {
    const counts = sync.appendChild(document.createElement('span'));
    counts.className = 'git-counts';
    counts.textContent = `↑${st.ahead} ↓${st.behind}`;
  }
  sync.dataset.tip = !st.hasRemote ? 'Raccorder un dépôt existant, ou en créer un sur GitHub' : !st.branch ? 'Aucune branche : la tête est détachée' : st.upstream ? `Avec ${st.upstream}` : 'Publier la branche';
  sync.onclick = st.hasRemote ? syncGit : openRemoteDialog;
  const items: HTMLElement[] = [sync];
  if (gitError) {
    const error = div('git-error');
    error.textContent = gitError;
    items.push(error);
  }
  const groups: [string, string, GitFile[], boolean][] = [['staged', 'Indexés', st.staged, true], ['unstaged', 'Modifiés', st.unstaged, false]];
  for (const [key, label, files, staged] of groups) {
    const group = gitGroup(key, label, files.length);
    group.querySelector<HTMLElement>('.list')!.append(...files.map((f) => gitFileRow(f, staged)));
    items.push(group);
  }
  const history = div('group git-group');
  history.innerHTML = '<div class="group-head"><span class="name">Historique</span></div>';
  for (const c of st.commits) {
    const row = history.appendChild(div('git-commit'));
    row.innerHTML = `<div class="git-subject"></div><div class="git-meta"><code>${esc(c.hash)}</code> · ${esc(c.author)} · ${esc(relativeTime(c.time))}</div>`;
    row.querySelector<HTMLElement>('.git-subject')!.textContent = c.subject;
    row.title = c.subject;
  }
  if (!st.commits.length) history.appendChild(div('git-none muted')).textContent = 'Aucun commit.';
  items.push(history);
  pane.replaceChildren(...items);
}
async function syncGit() {
  const dir = viewDir();
  gitSyncing = true;
  gitError = '';
  renderGit();
  try {
    await window.api.gitSync();
    lastFetch.set(dir, Date.now());
  } catch (e) {
    gitError = errorText(e);
  }
  gitSyncing = false;
  renderGit();
  onFilesChanged(); // (what came down changed the files)
}

// A remote for a repository without one: an existing one, or a new one on GitHub.
const remoteDialog = $<HTMLDialogElement>('remoteDialog');
closeOnOutside(remoteDialog, () => Boolean($<HTMLInputElement>('remoteUrl').value || $<HTMLInputElement>('remoteToken').value));
const remoteKind = () => remoteDialog.querySelector<HTMLInputElement>('[name=remoteKind]:checked')!.value;
let remoteDir = '';

function showRemoteKind() {
  const github = remoteKind() === 'github';
  $('remoteExisting').classList.toggle('hidden', github);
  $('remoteGithub').classList.toggle('hidden', !github);
  $<HTMLButtonElement>('remoteSubmit').textContent = github ? 'Créer sur GitHub' : 'Raccorder';
  $('remoteError').textContent = '';
  (github ? $<HTMLInputElement>('remoteName') : $<HTMLInputElement>('remoteUrl')).focus();
}

async function openRemoteDialog() {
  remoteDir = viewDir();
  $<HTMLInputElement>('remoteUrl').value = '';
  $<HTMLInputElement>('remoteToken').value = '';
  $<HTMLInputElement>('remoteName').value = baseName(remoteDir).replace(/[^\w.-]+/g, '-');
  $<HTMLInputElement>('remotePrivate').checked = true;
  remoteDialog.querySelector<HTMLInputElement>('[value=existing]')!.checked = true;
  $<HTMLButtonElement>('remoteSubmit').disabled = false;
  remoteDialog.showModal();
  showRemoteKind();
  const gh = await window.api.githubStatus().catch(() => null);
  $('remoteTokenRow').classList.toggle('hidden', Boolean(gh?.gh || gh?.tokenSaved));
  $('remoteNote').textContent = gh?.gh
    ? 'Le dépôt est créé avec le compte connecté à gh, puis la branche y est envoyée.'
    : gh?.tokenSaved
      ? 'Le dépôt est créé avec le jeton des réglages, puis la branche y est envoyée avec votre connexion Git habituelle.'
      : 'gh n’est pas disponible : il faut un jeton GitHub (à enregistrer dans Réglages › GitHub, ou pour cette fois ici). Le formulaire de GitHub s’ouvre pré-rempli : choisissez seulement « All repositories ». La branche est ensuite envoyée avec votre connexion Git habituelle.';
}

for (const radio of remoteDialog.querySelectorAll<HTMLElement>('[name=remoteKind]')) radio.onchange = showRemoteKind;
for (const id of ['remoteCancel', 'remoteClose']) $(id).onclick = () => remoteDialog.close();
remoteDialog.addEventListener('close', () => { $<HTMLInputElement>('remoteToken').value = ''; });
$<HTMLFormElement>('remoteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const github = remoteKind() === 'github';
  $<HTMLButtonElement>('remoteSubmit').disabled = true;
  $('remoteError').textContent = '';
  let failure = '';
  try {
    if (github) await window.api.gitCreateGithub({ name: $<HTMLInputElement>('remoteName').value, isPrivate: $<HTMLInputElement>('remotePrivate').checked, token: $<HTMLInputElement>('remoteToken').value });
    else await window.api.gitConnect($<HTMLInputElement>('remoteUrl').value);
  } catch (err) {
    failure = errorText(err);
  }
  $<HTMLButtonElement>('remoteSubmit').disabled = false;
  const st = await window.api.gitStatus().catch(() => null);
  if (failure && !(st?.repo && st.hasRemote)) {
    $('remoteError').textContent = failure;
    return;
  }
  // (the remote is set: what went wrong after that shows in the panel)
  gitError = failure;
  remoteDialog.close();
  lastFetch.set(remoteDir, Date.now());
  refreshGit();
  onFilesChanged();
});

// The GitHub page of the settings.
function showGithub(st: GithubStatus) {
  $('githubGh').textContent = st.gh ? `gh : connecté${st.gh === '?' ? '' : ` en tant que ${st.gh}`} (utilisé en premier).`
    : st.ghInstalled ? 'gh : installé, mais pas connecté. Lancez « gh auth login » dans un terminal.' : 'gh : pas installé.';
  $('githubSaved').textContent = !st.tokenSaved ? 'Jeton : aucun.' : st.token ? `Jeton : enregistré, compte ${st.token}.` : 'Jeton : enregistré, mais son compte n’a pas pu être vérifié.';
  $<HTMLButtonElement>('githubRemove').disabled = !st.tokenSaved;
  $<HTMLButtonElement>('githubSave').disabled = !st.canSave;
}
async function changeGithub(change: () => Promise<GithubStatus>) {
  $('githubError').textContent = '';
  try {
    showGithub(await change());
    $<HTMLInputElement>('githubToken').value = '';
  } catch (e) {
    $('githubError').textContent = errorText(e);
  }
}
const saveGithubToken = () => changeGithub(() => window.api.githubSetToken($<HTMLInputElement>('githubToken').value));
$<HTMLButtonElement>('githubSave').onclick = saveGithubToken;
for (const id of ['githubCreateToken', 'remoteCreateToken']) $(id).onclick = () => window.api.githubOpenTokenPage();
$<HTMLButtonElement>('githubRemove').onclick = () => { if (confirm('Retirer le jeton GitHub de Poney ? Il reste valide chez GitHub tant que vous ne l’y révoquez pas.')) changeGithub(window.api.githubRemoveToken); };
$<HTMLInputElement>('githubToken').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // (not the settings' form)
  saveGithubToken();
});
settingsDialog.addEventListener('close', () => { $<HTMLInputElement>('githubToken').value = ''; });

// The diff of a file, in its own side panel.
function closeDiffPanel() {
  diffFile = null;
  $('diffPanel').classList.add('hidden');
  document.querySelectorAll<HTMLElement>('.git-file.active').forEach((n) => n.classList.remove('active'));
}
$<HTMLButtonElement>('diffPanelClose').onclick = closeDiffPanel;
async function openDiff(file: GitFile, staged: boolean, { keepScroll = false } = {}) {
  const body = $('diffPanelBody');
  const scroll = keepScroll ? body.scrollTop : 0;
  if (!keepScroll) {
    closeViewer(); // (one side panel at a time)
    closeAgentPanel();
    if (liveBubble) closeLivePanel();
  }
  const shown = diffFile = { path: file.path, oldPath: file.oldPath, staged };
  $('diffPanel').classList.remove('hidden');
  $('diffPanelSide').textContent = staged ? 'Indexé' : 'Modifié';
  $('diffPanelPath').textContent = file.path;
  $('diffPanelPath').title = file.path;
  for (const n of document.querySelectorAll<HTMLElement>('.git-file')) n.classList.toggle('active', n.dataset.git === `${staged ? 'staged' : 'unstaged'}:${file.path}`);
  let r: { diff?: string; truncated?: boolean; error?: string };
  try {
    r = await window.api.gitDiff(file.path, { staged, oldPath: file.oldPath });
  } catch (e) {
    r = { error: errorText(e) };
  }
  if (shown !== diffFile) return; // (another file was clicked meanwhile)
  const added = (r.diff?.match(/^\+(?!\+\+)/gm) || []).length;
  const removed = (r.diff?.match(/^-(?!--)/gm) || []).length;
  $('diffPanelInfo').textContent = `+${added} −${removed}${r.truncated ? ' · tronqué' : ''}`;
  body.innerHTML = r.diff ? renderDiff(r.diff.trimEnd()) : `<div class="center">${esc(r.error ?? 'Aucune différence.')}</div>`;
  body.scrollTop = scroll;
}
renderSection();

/** Called after the agent writes/edits/runs: refresh the tree and the open file. */
function onFilesChanged(changedPath?: string) {
  if (changedPath) {
    // Reveal the changed file in the tree.
    const parts = changedPath.split('/');
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  }
  clearTimeout(treeRefresh);
  treeRefresh = setTimeout(async () => {
    await refreshTree();
    if (changedPath) document.querySelector<HTMLElement>(`.tree .node[data-path="${CSS.escape(changedPath)}"]`)?.classList.add('flash');
  }, 150);
  if (openPath && (!changedPath || changedPath === openPath)) openFile(openPath, { keepScroll: true });
}

// ---------- viewer ----------
const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', json: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sql: 'sql', lua: 'lua', r: 'r', dockerfile: 'dockerfile', makefile: 'makefile',
};

function formatSize(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function closeViewer() {
  closeDiffPanel();
  openPath = null;
  $('viewer').classList.add('hidden');
  document.querySelectorAll<HTMLElement>('.tree .node.active').forEach((n) => n.classList.remove('active'));
}

async function openFile(rel: string, { keepScroll = false } = {}) {
  const body = $('viewerBody');
  const scroll = keepScroll && rel === openPath ? body.scrollTop : 0;
  let read: Viewed;
  try {
    read = await window.api.readFile(rel);
  } catch (e) {
    if (keepScroll) return; // file deleted meanwhile: leave the viewer as is
    read = { path: rel, kind: 'error', message: errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  const f = read;
  openPath = f.path;
  if (panelAgent) closeAgentPanel(); // (one side panel at a time)
  if (liveBubble) closeLivePanel();
  closeDiffPanel();
  $('viewer').classList.remove('hidden');
  $('viewerPath').textContent = `\u200e${f.path}`; // (the mark keeps a leading dot first in the right-to-left line)
  $('viewerPath').title = f.path;
  document.querySelectorAll<HTMLElement>('.tree .node').forEach((n) => n.classList.toggle('active', n.dataset.path === f.path));

  const markdownFile = f.kind === 'text' && /\.(md|markdown|mdx)$/i.test(f.path);
  $<HTMLButtonElement>('viewerMode').classList.toggle('hidden', !markdownFile);
  if (markdownFile && mdView === 'preview') {
    $<HTMLButtonElement>('viewerMode').textContent = 'Code';
    $('viewerInfo').textContent = `${f.content.split('\n').length} lignes · ${formatSize(f.size)}${f.truncated ? ' · tronqué' : ''}`;
    showDocument(body, f);
  } else if (f.kind === 'text') {
    if (markdownFile) $<HTMLButtonElement>('viewerMode').textContent = 'Aperçu';
    const lines = f.content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    $('viewerInfo').textContent = `${lines.length} lignes · ${formatSize(f.size)}${f.truncated ? ' · tronqué' : ''}`;
    const name = (f.path.split('/').pop() ?? '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : name;
    const lang = EXT_LANG[ext ?? ''];
    let html;
    if (f.content.length > 400_000) html = esc(f.content);
    else if (lang && hljs.getLanguage(lang)) html = hljs.highlight(f.content, { language: lang, ignoreIllegals: true }).value;
    else html = hljs.highlightAuto(f.content.slice(0, 100_000)).value + esc(f.content.slice(100_000));
    body.innerHTML = '<div class="code-view"><div class="gutter"></div><pre><code class="hljs"></code></pre></div>';
    body.querySelector<HTMLElement>('.gutter')!.textContent = lines.map((_, i) => i + 1).join('\n');
    body.querySelector<HTMLElement>('code')!.innerHTML = html;
  } else if (f.kind === 'image') {
    $('viewerInfo').textContent = formatSize(f.size);
    body.innerHTML = '';
    const img = document.createElement('img');
    img.src = f.src;
    img.alt = f.path;
    body.appendChild(img);
  } else {
    $('viewerInfo').textContent = f.size !== undefined ? formatSize(f.size) : '';
    const msg = f.kind === 'error' ? f.message : f.kind === 'binary' ? 'Fichier binaire : aperçu indisponible.' : 'Fichier trop volumineux pour l’aperçu.';
    body.innerHTML = `<div class="center">${esc(msg)}</div>`;
  }
  body.scrollTop = scroll;
}

// ---------- Markdown documents: formatted view by default, code view on demand ----------
let mdView = 'preview';
try { mdView = localStorage.getItem('mdView') || 'preview'; } catch {}
$<HTMLButtonElement>('viewerMode').onclick = () => {
  mdView = mdView === 'preview' ? 'code' : 'preview';
  try { localStorage.setItem('mdView', mdView); } catch {}
  if (openPath) openFile(openPath);
};

/** A path relative to the folder of `from` (both relative to the project), or null if outside or not a file. */
function resolveLink(from: string, href: string) {
  if (!href || /^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of decodeURI(href.split(/[?#]/)[0]).split('/')) {
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/') || null;
}

function showDocument(body: HTMLElement, f: ViewedFile & { kind: 'text' }) {
  body.innerHTML = '';
  const doc = document.createElement('article');
  doc.className = 'md-doc';
  doc.innerHTML = DOMPurify.sanitize(documentHtml(f.content));
  body.appendChild(doc);
  doc.querySelectorAll<HTMLElement>('pre code').forEach((el) => {
    const lang = (el.className.match(/language-([\w+-]+)/) || [])[1];
    if (lang && hljs.getLanguage(lang)) el.innerHTML = hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
    el.classList.add('hljs');
  });
  // Images of the project: loaded through the app (remote ones are not loaded).
  doc.querySelectorAll<HTMLImageElement>('img').forEach(async (img) => {
    const rel = resolveLink(f.path, img.getAttribute('src') ?? '');
    if (!rel) return;
    try {
      const r = await window.api.readFile(rel);
      if (r.kind === 'image') img.src = r.src;
    } catch {}
  });
  // Links: web pages in the browser, project files in the viewer, never in this window.
  doc.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) window.open(href);
    else if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      const h = [...doc.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find((x) => x.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') === id);
      h?.scrollIntoView({ block: 'start' });
    } else {
      const rel = resolveLink(f.path, href);
      if (rel) openFile(rel);
    }
  });
}

$<HTMLButtonElement>('viewerClose').onclick = closeViewer;
$<HTMLButtonElement>('viewerReload').onclick = () => openPath && openFile(openPath, { keepScroll: true });
$<HTMLButtonElement>('viewerOpen').onclick = () => openPath && window.api.openFileExternal(openPath);
$<HTMLButtonElement>('viewerReveal').onclick = () => openPath && window.api.revealFile(openPath);

// ---------- system prompt ----------
let promptInfo: SystemPromptView | null = null;

const errorText = (e: unknown) => errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- conversation settings: its steps and its system prompt ----------
const convDialog = $<HTMLDialogElement>('convDialog');
const showConvPage = navDialog(convDialog);
let openedSteps: string | null = null;

async function refreshPromptBadge() {
  let steps = null;
  try {
    steps = await window.api.getSteps();
    promptInfo = await window.api.getSystemPrompt();
  } catch {
    promptInfo = null;
  }
  $('convBadge').classList.toggle('hidden', !steps && !promptInfo?.custom);
  return steps;
}

function updatePromptMeta() {
  const text = $<HTMLTextAreaElement>('promptText').value;
  const custom = text.trim() !== promptInfo!.default.trim();
  $('promptState').textContent = custom ? 'personnalisé' : 'par défaut';
  $('promptState').classList.toggle('custom', custom);
  $('promptTokens').textContent = `≈ ${Math.ceil(text.length / 3.2)} tokens`;
  $<HTMLButtonElement>('promptReset').disabled = !custom;
}

const convUnsaved = () => JSON.stringify(stepsForm()) !== openedSteps || $<HTMLTextAreaElement>('promptText').value !== (promptInfo!.custom ?? promptInfo!.default);
closeOnOutside(convDialog, convUnsaved);
const stepsForm = () => ({ before: $<HTMLTextAreaElement>('stepsBefore').value, after: $<HTMLTextAreaElement>('stepsAfter').value, afterOnlyIfChanged: $<HTMLInputElement>('stepsAfterOnlyIfChanged').checked, triage: $<HTMLInputElement>('stepsTriage').checked });

$<HTMLButtonElement>('convSettingsBtn').onclick = async () => {
  const steps = await refreshPromptBadge();
  if (!promptInfo) return;
  $<HTMLTextAreaElement>('stepsBefore').value = steps?.before || '';
  $<HTMLTextAreaElement>('stepsAfter').value = steps?.after || '';
  $<HTMLInputElement>('stepsAfterOnlyIfChanged').checked = Boolean(steps?.afterOnlyIfChanged);
  $<HTMLInputElement>('stepsTriage').checked = steps?.triage !== false;
  openedSteps = JSON.stringify(stepsForm());
  $<HTMLTextAreaElement>('promptText').value = promptInfo!.custom ?? promptInfo!.default;
  $('promptNote').textContent = [
    'Ce prompt s’applique uniquement à la conversation en cours et est enregistré avec elle.',
    'Un prompt personnalisé est utilisé tel quel : il ne suit plus les interrupteurs Web / Terminal ni la commande de test (les outils désactivés restent bloqués).',
    promptInfo.running ? 'L’agent travaille : la modification s’appliquera au prochain message.' : '',
  ].filter(Boolean).join(' ');
  updatePromptMeta();
  showConvPage('steps');
  convDialog.showModal();
  $<HTMLTextAreaElement>('stepsBefore').focus();
  $<HTMLTextAreaElement>('promptText').setSelectionRange(0, 0);
  $<HTMLTextAreaElement>('promptText').scrollTop = 0;
};
$<HTMLTextAreaElement>('promptText').addEventListener('input', updatePromptMeta);
$<HTMLButtonElement>('promptReset').onclick = () => {
  $<HTMLTextAreaElement>('promptText').value = promptInfo!.default;
  updatePromptMeta();
};
for (const id of ['convCancel', 'convClose']) $(id).onclick = () => convDialog.close();
$<HTMLButtonElement>('convSave').onclick = async () => {
  try {
    if (JSON.stringify(stepsForm()) !== openedSteps) await window.api.setSteps(stepsForm());
    if ($<HTMLTextAreaElement>('promptText').value !== (promptInfo!.custom ?? promptInfo!.default)) await window.api.setSystemPrompt($<HTMLTextAreaElement>('promptText').value);
  } catch (e) {
    showConvPage('prompt');
    $('promptNote').textContent = errorText(e);
    return;
  }
  convDialog.close();
  refreshPromptBadge();
  refreshGauge();
};

// ---------- context gauge ----------
const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** A context gauge: the conversation's (under the input), or a sub-agent's (sub: on its card and in its panel). */
function renderGauge(c: ContextStats | null | undefined, g: HTMLElement = $('ctxGauge'), { sub = false } = {}) {
  g.classList.toggle('hidden', sub && !c);
  if (!c) {
    if (g.querySelector<HTMLElement>('.gauge-text')) g.querySelector<HTMLElement>('.gauge-text')!.textContent = sub ? '' : 'contexte';
    g.querySelector<HTMLElement>('.gauge-fill')!.style.width = '0';
    g.title = '';
    return;
  }
  const { used = 0, numCtx = 0, compactAt = 0, limit = 0, settingCtx = 0 } = c;
  const pct = Math.min(100, (used / numCtx) * 100);
  g.querySelector<HTMLElement>('.gauge-fill')!.style.width = `${pct}%`;
  g.querySelector<HTMLElement>('.gauge-mark')!.style.left = `${(compactAt / numCtx) * 100}%`;
  if (g.querySelector<HTMLElement>('.gauge-text')) g.querySelector<HTMLElement>('.gauge-text')!.textContent = `${fmtTokens(used)} / ${fmtTokens(numCtx)}`;
  g.classList.toggle('warn', used >= compactAt * 0.85);
  g.classList.toggle('full', used >= limit);
  if (c.claude) {
    g.title = `Contexte utilisé : ${c.used} tokens sur ${c.numCtx}\nCompactage automatique vers ${c.compactAt} tokens (trait vertical)`;
    return;
  }
  g.title = [
    `${sub ? 'Contexte du sous-agent' : 'Contexte utilisé'} (estimé) : ${c.used} tokens sur ${c.numCtx}`,
    `Compactage automatique seulement quand l’appel suivant ne tiendrait plus : vers ${c.compactAt} tokens (trait vertical)`,
    c.serverCtx && c.serverCtx < settingCtx
      ? `Le serveur a chargé le modèle avec ${c.serverCtx} tokens de contexte : c’est cette limite qui est utilisée (réglage : ${c.settingCtx})`
      : '',
    c.calibrated ? 'Estimation calibrée sur les comptes du serveur (marge 4 %)' : 'Estimation pas encore calibrée (marge 8 %)',
    c.measured ? `Dernière mesure du serveur : ${c.measured} tokens` : '',
    sub ? '' : 'Cliquer pour compacter maintenant',
  ].filter(Boolean).join('\n');
}

// With a Claude model: how much of the plan's session (5 hours) is used.
const resetDate = (iso: string | number) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
};
async function refreshUsage() {
  const g = $('usageGauge');
  const usage = usesClaude() ? await window.api.claudeUsage().catch(() => null) : null;
  g.classList.toggle('hidden', !usage || !usesClaude());
  if (!usage) return;
  const used = Math.round(usage.utilization);
  g.querySelector<HTMLElement>('.gauge-fill')!.style.width = `${Math.min(100, used)}%`;
  g.classList.toggle('warn', used >= 80);
  g.classList.toggle('full', used >= 100);
  g.querySelector<HTMLElement>('.gauge-text')!.textContent = `session ${used} %`;
  g.dataset.tip = `Session de votre abonnement : ${used} % utilisés${usage.resetsAt ? `. Remise à zéro le ${resetDate(usage.resetsAt)}` : ''}`;
}
setInterval(refreshUsage, 5 * 60 * 1000);

async function refreshGauge() {
  refreshUsage();
  try {
    renderGauge(await window.api.getContext());
  } catch {
    renderGauge(null);
  }
}

$<HTMLButtonElement>('ctxGauge').onclick = async () => {
  if (running || usesClaude()) return; // (the Claude harness compacts by itself)
  if (!confirm('Compacter maintenant ? Les anciens messages seront remplacés par un résumé (le fil affiché reste intact).')) return;
  setRunning(true);
  stopRunTimer();
  $('status').textContent = 'Compactage…';
  let message = '';
  try {
    const r = await window.api.compactContext();
    if (!r.compacted) message = r.reason || 'Rien à compacter.';
  } catch (e) {
    document.querySelector<HTMLElement>('.compaction.pending')?.remove();
    add(div('error', esc(errorText(e))));
  } finally {
    setRunning(false);
    $('status').textContent = message;
    refreshGauge();
  }
};

// ---------- init ----------
document.body.classList.add(`platform-${window.api.platform}`);
settings = await window.api.getSettings();
renderSettings();
refreshModels();
refreshConversations();
refreshTree();
refreshPromptBadge();
refreshGauge();
// Window reloaded (after a crash) while a conversation was open: draw it again.
const session = await window.api.currentSession();
settings = session.settings;
if (session.events.length || session.partial) showSession(session);
else if (activeProject() !== defaultProject()) await newConversationHere(); // (the same page as a new conversation)
else {
  clearTranscript();
  setInput(session.draft || '');
}
input.focus();
