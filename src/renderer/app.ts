import { parseActions, splitThinking, normalizeToolCalls, liveAction, partialEditPairs } from '../agent/protocol.ts';
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';
import { fmtNum, fmtDuration } from './format.ts';
import { parsePlan, taskParts } from '../agent/plan.ts';
import { parseQuestions, cleanAnswers } from '../agent/ask.ts';
import { markdown, esc } from './markdown.ts';
import { documentHtml } from './document.ts';
import { SwipeDetector } from './swipe.ts';
import { EMOJIS, ICONS, ICON_COLORS, iconSvg } from './project-icons.ts';
import { fileIconSvg, folderIconSvg, privateFolderIconSvg } from './file-icons.ts';
import { menuIconSvg, type MenuGlyph } from './menu-icons.ts';
import { findRanges } from './find.ts';
import { wordDiff, type Piece } from './word-diff.ts';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';
import type { Api } from '../preload.cts';
import { isGithub, repoName } from '../remote-url.ts';
import type { RemotesStatus } from '../ipc.ts';
import type { AppAlert, ClaudeAccount, ClaudeStatus, FileStates, ListedSkill, ModelGroup, OpeningApps, SessionApproval, SessionEvent, SessionView, SystemPromptView } from '../ipc.ts';
import type { TorStatus } from '../agent/tor.ts';
import type { GitFile, GitRepoStatus } from '../git.ts';
import type { ViewedFile } from '../files.ts';
import { errorMessage, isRecord, isStringArray, num, str } from '../unknown.ts';
import type { AgentEvent, Choice, ContextStats, ConversationPair, Viewing, ConversationSummary, Effort, EngineName, EventOf, PlanTask, ProjectIcon, Provider, ProviderType, PublicSettings, AskDraft, Question, QuestionAnswer, ToolArgs, TriageItem, TurnStats } from '../types.ts';

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
  icon?: string; // (an image's URL)
  glyph?: MenuGlyph; // (or a line icon)
}

type Viewed = ViewedFile | { path: string; kind: 'error'; message: string; size?: undefined };
type Places = Map<string, { el: HTMLElement; r: DOMRect }>;

const isStats = (v: unknown): v is ContextStats => isRecord(v) && v.type === 'context';

type Timer = ReturnType<typeof setTimeout>;
type PlanBlock = { el: HTMLElement; tasks: PlanTask[]; agents: Map<string, number> };
type AskState = { answers: QuestionAnswer[]; step: number };

// ---------- the panes: one conversation, or two side by side ----------
// Each pane is a copy of the conversation's section of index.html (its elements keep their
// ids, looked up in the pane). The code works on one pane at a time, through the variables
// below: usePane puts a pane's state in them, keeping the other's. The pane worked in is
// the focused one, the user's; the other is worked in for a moment, to draw its events.
interface Pane {
  root: HTMLElement;
  transcript: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  composer: HTMLElement;
  skillMenu: HTMLElement;
  active: PublicSettings['active'] | null; // (its conversation, as settings.active says it while it is worked in)
  running: boolean;
  agentContext: Map<number, ContextStats>;
  bubbles: Map<number, Bubble>;
  cards: Map<number, HTMLElement>;
  planBlock: PlanBlock | null;
  agentViews: Map<number, HTMLElement>;
  memoryNotes: string[];
  draftTimer: Timer | undefined;
  draftChanged: boolean;
  skillMatches: ListedSkill[];
  skillPick: number;
  skillList: ListedSkill[] | null;
  promptProgress: { id: number | string; value: number; t0: number } | null;
  modelStatus: string;
  liveGen: Bubble | null;
  runTimer: ReturnType<typeof setInterval> | undefined;
  askDrafts: Map<string, AskState>;
  askAnswers: Map<number, QuestionAnswer[]>;
  askSaveTimer: Timer | undefined;
}

const div = (cls: string, html?: string) => {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
};
const firstChat = document.querySelector<HTMLElement>('.chat')!;
const CHAT_IDS = new Set([...firstChat.querySelectorAll<HTMLElement>('[id]')].map((el) => el.id).concat(['empty', 'welcomePicker', 'welcomeMenu']));
const secondChat = firstChat.cloneNode(true) as HTMLElement;
secondChat.classList.add('hidden');
const splitDivider = div('split-divider hidden');
splitDivider.setAttribute('role', 'separator');
firstChat.after(splitDivider, secondChat);

function makePane(root: HTMLElement): Pane {
  const el = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  return {
    root, transcript: el('transcript'), input: el<HTMLTextAreaElement>('input'), sendBtn: el<HTMLButtonElement>('sendBtn'), composer: root.querySelector<HTMLElement>('.composer')!,
    skillMenu: root.querySelector<HTMLElement>('.composer-box')!.appendChild(div('skill-menu hidden')),
    active: null, running: false, agentContext: new Map(), bubbles: new Map(), cards: new Map(), planBlock: null, agentViews: new Map(), memoryNotes: [],
    draftTimer: undefined, draftChanged: false, skillMatches: [], skillPick: 0, skillList: null, promptProgress: null, modelStatus: '', liveGen: null, runTimer: undefined,
    askDrafts: new Map(), askAnswers: new Map(), askSaveTimer: undefined,
  };
}
const panes = [makePane(firstChat), makePane(secondChat)];
let pane = panes[0]; // the pane worked in
let focused = panes[0]; // the pane the user works in
let split = false; // two panes shown
const shownPanes = () => (split ? panes : [focused]);
const otherPane = (p: Pane) => panes[1 - panes.indexOf(p)];

/** An element of the page: index.html has them all (those of a conversation, in the pane worked in). */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => (CHAT_IDS.has(id) ? pane.root.querySelector(`#${id}`) : document.getElementById(id)) as T;
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const form = $<HTMLFormElement>('settingsForm');

let settings!: PublicSettings;
// The pane worked in: its elements and its state.
let { root: chat, transcript, input, sendBtn, composer, skillMenu } = pane;
let running = false;
let agentContext = new Map<number, ContextStats>(); // sub-agent id -> its latest context figures
let bubbles = new Map<number, Bubble>(); // assistant id -> {el, raw, thinking}
let cards = new Map<number, HTMLElement>(); // action id -> card element

/** Works in another pane: its state goes in the variables, the one left keeps its own. */
function usePane(p: Pane) {
  if (p === pane) return;
  const q = pane;
  Object.assign(q, {
    active: settings?.active ?? null, running, agentContext, bubbles, cards, planBlock, agentViews, memoryNotes, draftTimer, draftChanged, skillMatches, skillPick, skillList,
    promptProgress, modelStatus, liveGen, runTimer, askDrafts, askAnswers, askSaveTimer,
  });
  pane = p;
  ({ root: chat, transcript, input, sendBtn, composer, skillMenu, running, agentContext, bubbles, cards, planBlock, agentViews, memoryNotes, draftTimer, draftChanged, skillMatches, skillPick, skillList, promptProgress, modelStatus, liveGen, runTimer, askDrafts, askAnswers, askSaveTimer } = p);
  if (settings) settings.active = p.active ?? { offProject: false, cwd: '', session: null, choice: { engine: 'local', model: null }, blocked: null, started: false };
}
/** Something done in a pane (its events, a timer of its own), then back to the one worked in. */
function inPane<T>(p: Pane, fn: () => T): T {
  const was = pane;
  usePane(p);
  try {
    return fn();
  } finally {
    usePane(was);
  }
}
/** The same, in each pane shown. */
const forPanes = (fn: () => unknown) => { for (const p of shownPanes()) inPane(p, fn); };
/** The conversation of a pane. */
const sessionOf = (p: Pane) => (p === pane ? settings?.active?.session : p.active?.session) ?? null;
// Each call to the main process goes to the conversation of the pane worked in.
window.api.beforeCalls(() => {
  const key = split ? sessionOf(pane) : null;
  if (key) void window.api.focusSession(key);
});

// The conversation runs under the input: its end stays above it, whatever its height
// (the plan showing up, a long message), and in view if it was.
const fitComposer = () => transcript.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
for (const p of panes) {
  new ResizeObserver(() => inPane(p, () => {
    const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    fitComposer();
    if (atEnd) transcript.scrollTop = transcript.scrollHeight;
  })).observe(p.composer);
}
// (and under the top bar, which blurs it as it passes: --topbar-h is the bar's height)
const topbar = document.querySelector<HTMLElement>('.topbar')!;
new ResizeObserver(() => document.body.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
// The sidebar cards' lists likewise scroll under their head and foot: --head-h and --foot-h are
// the heights of what lies above and below the pane shown.
for (const card of document.querySelectorAll<HTMLElement>('#sidebar, #filesBar')) {
  const kids = [...card.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('card-glass'));
  const fit = () => {
    const at = kids.findIndex((el) => el.classList.contains('pane') && !el.classList.contains('hidden'));
    const height = (els: HTMLElement[]) => els.reduce((sum, el) => sum + el.offsetHeight, 0);
    card.style.setProperty('--head-h', `${height(kids.slice(0, at))}px`);
    card.style.setProperty('--foot-h', `${height(kids.slice(at + 1).filter((el) => !el.classList.contains('pane')))}px`);
  };
  const watch = new ResizeObserver(fit);
  for (const el of kids) watch.observe(el);
}

// The glint on a glass button follows the pointer.
const GLASS = '.primary, .approval button, .new-conv, .git-sync, .glass-btn, .msg-editor button, .ghost';
document.addEventListener('pointermove', (e) => {
  const b = e.target instanceof Element ? e.target.closest<HTMLElement>(GLASS) : null;
  if (!b) return;
  const r = b.getBoundingClientRect();
  b.style.setProperty('--mx', `${e.clientX - r.left}px`);
  b.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

// One menu open at a time: a click elsewhere than in a menu or on its picker closes it.
// (In the capture phase: the pickers stop their clicks from going further.)
const MENUS: [picker: string, menu: string, close: () => void][] = [
  ['modelPicker', 'modelMenu', () => closeModelMenu()], ['welcomePicker', 'welcomeMenu', () => closeWelcomeMenu()],
  ['projectPicker', 'projectMenu', () => closeProjectMenu()], ['viewPicker', 'viewMenu', () => closeViewMenu()],
  ['sectionPicker', 'sectionMenu', () => closeSectionMenu()], ['branchPicker', 'branchMenu', () => closeBranchMenu()],
];
document.addEventListener('click', (e) => {
  const target = e.target instanceof Node ? e.target : null;
  for (const [picker, menu, close] of MENUS) {
    for (const scope of CHAT_IDS.has(menu) ? panes.map((p) => p.root) : [document.body]) {
      const m = scope.querySelector(`#${menu}`);
      if (!m || m.classList.contains('hidden') || m.contains(target) || scope.querySelector(`#${picker}`)?.contains(target)) continue;
      close();
    }
  }
}, true);

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
    chat.classList.remove('fresh');
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


const SEND_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg>';
const CHEV_LEFT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
const CHEV_RIGHT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor"/></svg>';
for (const p of panes) p.sendBtn.innerHTML = SEND_ICON;
function setRunning(v: boolean) {
  running = v;
  chat.classList.toggle('running', v); // hides the "edit message" buttons
  sendBtn.innerHTML = v ? STOP_ICON : SEND_ICON;
  sendBtn.dataset.tip = v ? 'Arrêter' : 'Envoyer (Entrée)';
  sendBtn.setAttribute('aria-label', v ? 'Arrêter' : 'Envoyer');
  sendBtn.classList.toggle('stop', v);
  if (v) startRunTimer();
  else {
    stopRunTimer();
    $('status').textContent = '';
    // (stopped or interrupted: nothing goes on)
    chat.querySelectorAll<HTMLElement>('.plan-list li.running').forEach((li) => li.classList.replace('running', 'pending'));
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
let listedDir: string | null = null; // (the folder the Files and Git sections show)
const viewOff = () => (observed ? observed === OFF_KEY : offMode());

function renderSettings() {
  syncView();
  forPanes(renderPaneSettings);
  const config: Record<string, unknown> = { ...settings.config };
  for (const el of [...$<HTMLFormElement>('settingsForm').elements] as HTMLInputElement[]) {
    if (!el.name || config[el.name] === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(config[el.name]);
    else el.value = String(config[el.name] ?? '');
  }
  if (Boolean(torTimer) !== Boolean(settings.config.torEnabled)) scheduleTorStatus();
}
/** What a pane shows of the settings: the input's switches, its project, its model. */
function renderPaneSettings() {
  const shellOn = settings.config.shellEnabled !== false;
  $<HTMLInputElement>('webEnabled').checked = settings.config.webEnabled !== false;
  $<HTMLInputElement>('shellEnabled').checked = shellOn;
  $<HTMLInputElement>('autoApprove').checked = settings.config.approval === 'auto';
  $<HTMLInputElement>('autoApprove').disabled = !shellOn;
  $('autoApproveLabel').classList.toggle('disabled', !shellOn);
  $<HTMLInputElement>('torEnabled').checked = Boolean(settings.config.torEnabled);
  $<HTMLInputElement>('subagentsEnabled').checked = settings.config.subagentsEnabled !== false;
  renderWelcomeProject();
  renderChoice();
}
const renderChoices = () => forPanes(renderChoice);

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
  renderChoices();
  claude = await window.api.claudeStatus().catch(() => claude);
  renderChoices();
  refreshConversations(); // (the cards show their provider's icon)
  if ($<HTMLDialogElement>('settingsDialog').open) renderProviders();
  for (const p of shownPanes()) if (!p.root.querySelector('#modelMenu')?.classList.contains('hidden')) inPane(p, openModelMenu);
}
window.api.onModelsChanged(refreshModels);

/** The input follows the model: its name, and what can be set for it. */
function renderChoice() {
  const c = choice();
  const isClaude = c.engine === 'claude';
  if (pane === focused) {
    // (steps and system prompt belong to Poney's harness)
    $<HTMLButtonElement>('convSettingsBtn').disabled = isClaude;
    $<HTMLButtonElement>('convSettingsBtn').title = isClaude ? 'Les modèles Claude n’utilisent ni les étapes ni le prompt système de Poney' : 'Étapes et prompt système de cette conversation';
    document.body.classList.toggle('claude-focus', isClaude);
  }
  headOf(pane)?.classList.toggle('claude', isClaude); // (its own settings button, in a split view)
  const picker = $<HTMLButtonElement>('modelPicker');
  const group = modelGroups.find((g) => g.provider.id === choiceProvider());
  picker.querySelector<HTMLElement>('.model-icon')!.innerHTML = isClaude ? CLAUDE_ICON : groupIcon(group);
  const local = c.model || settings.config.model;
  // (with several Claude accounts, the conversation's is said beside its model)
  const account = isClaude && claude.accounts.length > 1 ? claudeAccount() : undefined;
  const modelName = isClaude ? claudeModel()?.name ?? c.model ?? 'Claude' : group?.models.find((m) => m.id === local)?.name ?? local ?? 'aucun modèle';
  picker.querySelector<HTMLElement>('.model-name')!.textContent = account ? `${modelName} · ${accountShort(account)}` : modelName;
  picker.dataset.tip = account ? `Modèle · ${accountLabel(account)}` : 'Modèle';
  chat.classList.toggle('claude-mode', isClaude);
  $('claudeControls').classList.toggle('hidden', !isClaude);
  chat.querySelector<HTMLElement>('.toggles')!.classList.toggle('hidden', isClaude);
  if (!isClaude) return;
  const levels = claudeModel()?.efforts ?? [];
  $<HTMLSelectElement>('effortSelect').innerHTML = levels.map((l) => `<option value="${l}">${EFFORT_LABEL[l] ?? l}</option>`).join('');
  $<HTMLSelectElement>('effortSelect').classList.toggle('hidden', !levels.length);
  $<HTMLSelectElement>('effortSelect').value = c.effort && levels.includes(c.effort) ? c.effort : levels.includes('high') ? 'high' : levels[0] ?? '';
  $<HTMLSelectElement>('modeSelect').querySelector<HTMLOptionElement>('[value="auto"]')!.disabled = claudeModel()?.auto === false;
  $<HTMLSelectElement>('modeSelect').value = c.mode ?? 'manual';
}

// (a menu opening upward stops below the top bar: the system takes the clicks there before the page does)
function fitBelowBar(menu: HTMLElement, anchor: HTMLElement) {
  const room = anchor.getBoundingClientRect().top - document.querySelector<HTMLElement>('.topbar')!.getBoundingClientRect().bottom - 14;
  menu.style.setProperty('--room', `${Math.max(room, 0)}px`);
}

// The model menu's groups fold, and stay as they were left.
const foldedModels = new Set<string>(((): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem('modelFolded') ?? '[]'); return isStringArray(v) ? v : []; } catch { return []; } })());
function openModelMenu() {
  const menu = $('modelMenu');
  const c = choice();
  menu.innerHTML = '';
  let into: HTMLElement = menu; // (the group the rows go in)
  const row = (engine: EngineName, model: string, name: string, off: boolean, group?: ModelGroup, account?: ClaudeAccount) => {
    const r = into.appendChild(document.createElement('button'));
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
  const label = (text: string, key: string) => {
    const head = menu.appendChild(document.createElement('button'));
    head.type = 'button';
    head.className = `model-sep${foldedModels.has(key) ? ' folded' : ''}`;
    head.innerHTML = `${CHEVRON}<span></span>`;
    head.querySelector('span')!.textContent = text;
    into = menu.appendChild(div(`model-group${foldedModels.has(key) ? ' hidden' : ''}`));
    const group = into;
    head.onclick = () => {
      if (foldedModels.has(key)) foldedModels.delete(key); else foldedModels.add(key);
      try { localStorage.setItem('modelFolded', JSON.stringify([...foldedModels])); } catch {}
      head.classList.toggle('folded', foldedModels.has(key));
      group.classList.toggle('hidden', foldedModels.has(key));
    };
  };
  const several = modelGroups.filter((g) => g.models.length || g.error).length + claude.accounts.length > 1;
  for (const g of modelGroups) {
    if (several && (g.models.length || g.error)) label(g.name ?? (g.provider.type === 'poney' ? 'Poney' : ''), g.provider.id);
    for (const m of g.models) row('local', m.id, m.name, started && c.engine !== 'local', g);
    if (g.error) into.appendChild(div('pm-row muted', `<span class="pm-icon">${groupIcon(g)}</span><span class="pm-name">${esc(g.name)} : injoignable</span>`));
    into = menu;
  }
  if (!modelGroups.some((g) => g.models.length || g.error)) menu.appendChild(div('pm-row muted', 'aucun modèle local'));
  // One group per Claude account; a conversation goes on with another one (its session follows).
  for (const a of claude.accounts) {
    if (several) label(accountLabel(a), a.id);
    for (const m of a.models) row('claude', m.value, m.name, Boolean(started) && c.engine !== 'claude', undefined, a);
    if (!a.loggedIn) {
      const hint = into.appendChild(document.createElement('button'));
      hint.type = 'button';
      hint.className = 'pm-row model-row model-hint';
      hint.innerHTML = `<span class="pm-icon">${CLAUDE_ICON}</span><span class="pm-name">Se connecter…</span>`;
      hint.onclick = () => { closeModelMenu(); loginClaude(a.id); };
    }
  }
  fitBelowBar(menu, $<HTMLButtonElement>('modelPicker'));
  menu.classList.remove('hidden');
}
function closeModelMenu() { for (const p of panes) p.root.querySelector('#modelMenu')!.classList.add('hidden'); }
window.addEventListener('resize', closeModelMenu);
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
// The providers' cards are folded, but for those opened (until the app closes): an added one is.
const openProviders = new Set<string>();
function providerCard(p: Provider) {
  const card = div(`provider-card${p.enabled ? '' : ' off'}${openProviders.has(p.id) ? '' : ' folded'}`);
  const group = modelGroups.find((g) => g.provider.id === p.id);
  const head = card.appendChild(div('provider-head'));
  head.innerHTML = `<span class="provider-chev">${CHEVRON}</span><span class="pm-icon">${p.type === 'claude' ? CLAUDE_ICON : groupIcon(group)}</span><span class="provider-name"></span><div class="spacer"></div><label><input type="checkbox"> Activé</label>`;
  head.onclick = (e) => {
    if (e.target instanceof Element && e.target.closest('label, button, input')) return;
    if (openProviders.has(p.id)) openProviders.delete(p.id); else openProviders.add(p.id);
    card.classList.toggle('folded', !openProviders.has(p.id));
  };
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
  folder.className = 'glass-btn provider-folder';
  folder.innerHTML = `${FILE_MANAGER_ICON}<span>Ouvrir le dossier des modèles</span>`;
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
$<HTMLButtonElement>('addProvider').onclick = async () => {
  const before = new Set(settings.providers.map((p) => p.id));
  const after = await window.api.addProvider({ baseUrl: 'http://localhost:1234/v1' });
  for (const p of after.providers) if (!before.has(p.id)) openProviders.add(p.id);
  await changeProvider(Promise.resolve(after));
};
$<HTMLButtonElement>('addClaudeAccount').onclick = async () => {
  const added = await window.api.addClaudeAccount();
  openProviders.add(added.id);
  await changeProvider(Promise.resolve(added.settings));
  claude = await window.api.claudeStatus().catch(() => claude);
  loginClaude(added.id);
};
// ---------- Tor connection status ----------
let torTimer: ReturnType<typeof setTimeout> | undefined;

function renderTorStatus(s: TorStatus) {
  $('torStateBig').className = `tor-state ${s.state}`;
  for (const p of panes) inPane(p, () => {
    $('torState').className = `tor-state ${s.state}`;
    $('torState').textContent = s.state === 'bootstrapping' || s.state === 'stuck' ? ` ${s.progress} %`
      : s.state === 'reconnecting' ? ' reconnexion' : s.state === 'degraded' ? ' lent' : '';
    $('torToggleLabel').dataset.tip = s.state === 'disabled'
      ? 'Tor : recherche web et lecture de pages via Tor (réglages : ⚙︎ › Confidentialité)'
      : `Tor : ${s.detail}${s.proxy ? ` — ${s.proxy.replace('socks5h://', '')}` : ''}`;
  });
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
  changeRemotes(window.api.remotesStatus);
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
let planBlock: PlanBlock | null = null; // the plan being carried out: { el, tasks, agents (title -> action id) }
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
    return `<li class="${t.status}${agent === shownAgent() && agent !== undefined ? ' shown' : ''}"${agent === undefined ? '' : ` data-agent="${agent}" title="Voir son travail dans le panneau de droite"`}><span class="plan-dot"></span><div class="plan-text"><span>${esc(head)}</span>${sub}</div>${t.parallel ? '<span class="tag">en parallèle</span>' : ''}${resume}</li>`;
  }).join('');
  markWaiting();
}
/** A sub-agent waiting for an approval: the state of its task says so. */
function markWaiting() {
  for (const li of chat.querySelectorAll<HTMLElement>('.plan-list li[data-agent]')) {
    li.classList.toggle('waiting', Boolean(agentViews.get(Number(li.dataset.agent))?.querySelector<HTMLElement>('.approval')));
  }
}

// ---------- a sub-agent's work, in the side panel ----------
let agentViews = new Map<number, HTMLElement>(); // sub-agent action id -> its view (task, log, report)
let panelAgent: number | null = null;
let panelPane: Pane | null = null; // (the pane of the sub-agent shown: action ids are each conversation's own)
/** The sub-agent shown in the side panel, if it is one of the pane worked in. */
const shownAgent = () => (panelPane === pane ? panelAgent : null);

function renderAgentPanelHead() {
  const card = cards.get(shownAgent() ?? -1);
  $('agentPanelTitle').textContent = card?.querySelector<HTMLElement>('.summary')!.textContent || '';
  $('agentPanelInfo').textContent = card ? (card.classList.contains('running') ? 'en cours' : card.classList.contains('ok') ? 'terminé' : 'échec') : '';
  document.querySelectorAll<HTMLElement>('.card.subagent.shown').forEach((c) => c.classList.remove('shown'));
  card?.classList.add('shown');
  document.querySelectorAll<HTMLElement>('.plan-list li.shown').forEach((li) => li.classList.remove('shown'));
  for (const li of chat.querySelectorAll<HTMLElement>('.plan-list li[data-agent]')) li.classList.toggle('shown', Number(li.dataset.agent) === shownAgent());
  renderGauge(agentContext.get(shownAgent() ?? -1), $('agentPanelGauge'), { sub: true });
}

function openAgentPanel(id: number) {
  const view = agentViews.get(id);
  if (!view) return;
  closeViewer(); // (one side panel at a time)
  if (liveBubble) closeLivePanel();
  panelAgent = id;
  panelPane = pane;
  const body = $('agentPanelBody');
  body.replaceChildren(view);
  $('agentPanel').classList.remove('hidden');
  renderAgentPanelHead();
  body.scrollTop = body.scrollHeight; // at the end: what it is doing now
}

function closeAgentPanel() {
  panelAgent = null;
  panelPane = null;
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

function clearTranscript() {
  closeQuestionnaire();
  closePanelsOfPane();
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
  chat.classList.add('fresh');
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
  chat.querySelector<HTMLElement>('#empty .welcome-hint')!.textContent = key === OFF_KEY
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
  menu.appendChild(div('pm-sep'));
  row('＋', 'Ajouter un projet…', 'Choisir un dossier', addProject);
  row(CLONE_ICON, 'Ajouter depuis un dépôt distant…', 'Cloner un dépôt Git dans un nouveau dossier', openCloneDialog);
  menu.classList.remove('hidden');
  $('welcomePicker').classList.add('open');
}
function closeWelcomeMenu() {
  for (const p of panes) {
    p.root.querySelector('#welcomeMenu')?.classList.add('hidden');
    p.root.querySelector('#welcomePicker')?.classList.remove('open');
  }
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
  transcript.querySelectorAll<HTMLElement>('.retry-row').forEach((r) => r.remove()); // (taken up, or a new message)
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
  if ((running && !asking()) || m.classList.contains('editing')) return; // (a questionnaire waiting is given up on relaunch)
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
    if (!newText || !(await stopAsking())) return;
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
  const head = card.querySelector<HTMLElement>('.card-head')!;
  if (EDIT_FIELDS[ev.tool]) {
    const edit = document.createElement('button');
    edit.className = 'resume-btn';
    edit.textContent = '✎ Modifier';
    edit.title = 'Modifier cet appel, puis le relancer et reprendre la conversation à partir de lui (la suite est retirée)';
    edit.onclick = (e) => { e.stopPropagation(); startEditAction(card, ev); };
    head.appendChild(edit);
  }
  head.appendChild(btn);
}

/** The arguments of a tool call the user can change before running it again, multi-line ones marked. */
const EDIT_FIELDS: Record<string, [key: string, label: string, multiline?: boolean][]> = {
  run: [['command', 'Commande', true]],
  read: [['path', 'Fichier'], ['start', 'Première ligne'], ['end', 'Dernière ligne']],
  write: [['path', 'Fichier'], ['content', 'Contenu', true]],
  edit: [['path', 'Fichier'], ['body', 'Modifications', true]],
  list: [['path', 'Dossier'], ['depth', 'Profondeur']],
  search: [['query', 'Recherche'], ['pattern', 'Motif de fichiers'], ['path', 'Dossier']],
  web_search: [['query', 'Recherche']],
  fetch: [['url', 'Adresse']],
  agent: [['title', 'Titre'], ['task', 'Tâche', true]],
  remember: [['note', 'Note', true]],
  forget: [['id', 'Numéro de la note']],
  recall: [['query', 'Recherche']],
};

/** Inline editor on a past tool call: "Relancer" runs it as edited and the conversation goes on from it. */
function startEditAction(card: HTMLElement, ev: EventOf<'action_start'>) {
  if ((running && !asking()) || card.querySelector('.action-editor')) return;
  const args = ev.args ?? {};
  const editor = div('msg-editor action-editor');
  editor.innerHTML = `${EDIT_FIELDS[ev.tool].map(([key, label, multi]) => `<label><span>${esc(label)}</span>${multi ? `<textarea data-key="${key}" rows="2"></textarea>` : `<input data-key="${key}">`}</label>`).join('')}
    <p class="edit-note">L’appel modifié sera relancé, et tout ce qui le suit sera retiré de la conversation. Les fichiers déjà modifiés ne sont pas restaurés.</p>
    <div class="edit-actions"><button class="ghost cancel">Annuler</button><button class="primary relaunch">Relancer</button></div>`;
  const fields = [...editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-key]')];
  for (const f of fields) f.value = args[f.dataset.key!] ?? '';
  editor.onclick = (e) => e.stopPropagation(); // (a sub-agent card opens its panel on click)
  card.querySelector<HTMLElement>('.card-head')!.after(editor);
  const fit = (area: HTMLTextAreaElement) => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 360)}px`; };
  for (const area of editor.querySelectorAll('textarea')) { fit(area); area.addEventListener('input', () => fit(area)); }
  fields[0].focus();
  const close = () => editor.remove();
  const relaunch = () => {
    const edited: ToolArgs = { ...args };
    for (const f of fields) {
      const v = f instanceof HTMLTextAreaElement ? f.value : f.value.trim();
      if (v.trim()) edited[f.dataset.key!] = v;
      else delete edited[f.dataset.key!];
    }
    void resumeFromAction(ev.id, { ask: false, edited });
  };
  editor.querySelector<HTMLElement>('.cancel')!.onclick = close;
  editor.querySelector<HTMLElement>('.relaunch')!.onclick = relaunch;
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); relaunch(); }
  });
}

/** Takes up a turn that ended on an error. */
async function retryTurn() {
  if (running) return;
  await sendMessage(await window.api.retryText());
}

async function resumeFromAction(id: number, { ask = true, edited }: { ask?: boolean; edited?: ToolArgs } = {}) {
  if (running && !asking()) return;
  if (ask && !confirm('Reprendre à partir de cette action ?\n\nElle sera relancée, et tout ce qui la suit sera retiré de la conversation. Les fichiers déjà modifiés ne sont pas restaurés.')) return;
  if (!(await stopAsking())) return;
  // A questionnaire asked again starts from the answers given: they can be changed.
  const card = cards.get(id);
  const given = askAnswers.get(id);
  if (card?.dataset.tool === 'ask' && given) {
    const draft = { key: askKey(parseQuestions(card.dataset.body)), answers: given, step: 0 };
    askDrafts.set(draft.key, draft);
    saveAskDraft(draft);
  }
  try {
    const { events } = await window.api.resumeFrom(id, edited);
    replayTranscript(events);
    setRunning(true);
    refreshGauge();
  } catch (e) {
    add(div('error', esc(errorText(e))));
  }
}

function replayTranscript(events: AgentEvent[]) {
  closeQuestionnaire(); // (drawn again with the approvals, if it still waits)
  if (livePane === pane) closeLivePanel(); // (the answers are drawn again)
  const agentShown = shownAgent();
  agentViews.clear();
  agentContext.clear();
  planBlock = null;
  renderMemory([]); // (same for the memory)
  transcript.innerHTML = '';
  chat.classList.remove('fresh');
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
  if (agentShown && agentViews.has(agentShown)) openAgentPanel(agentShown);
  else if (panelPane === pane) closeAgentPanel();
}

// ---------- the text of the input, kept as the conversation's draft ----------
let draftTimer: Timer | undefined;
let draftChanged = false;
/** Sends the main process what is typed, now (before leaving the conversation). */
function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = undefined;
  if (!draftChanged) return;
  draftChanged = false;
  return window.api.setDraft(input.value);
}
function noteDraft() {
  draftChanged = true;
  clearTimeout(draftTimer);
  const c = lastConversations.find((x) => x.id === currentConversation());
  const p = pane;
  // (a card that changes follows the keys, without waiting for the list: a new conversation's title, a draft begun or erased)
  if (c && !c.titleFromDraft && c.draft === Boolean(input.value.trim())) draftTimer = setTimeout(() => inPane(p, flushDraft), 250);
  else {
    if (c?.titleFromDraft) showDraftTitle(c);
    flushDraft();
  }
}
/** The title of a conversation named by its input, as typed now (the list may be a key behind). */
function showDraftTitle(c: ConversationSummary) {
  c.title = input.value.replace(/\s+/g, ' ').trim().slice(0, 80) || c.title;
  const title = document.querySelector<HTMLElement>(`#convList .title[data-conv="${CSS.escape(c.id)}"]`);
  if (title) title.textContent = c.title;
  renderConvHead();
}
function setInput(text: string) {
  clearTimeout(draftTimer);
  draftChanged = false;
  input.value = text;
  autosize();
}

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
  const startsHere = chat.classList.contains('fresh');
  const top = composer.getBoundingClientRect().top;
  addUserMessage(text, turnId);
  if (startsHere) { // (from the middle of the page to its place at the bottom)
    const from = `translateY(${top - composer.getBoundingClientRect().top}px)`;
    if (!calm) composer.animate([{ transform: from }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
  setRunning(true);
  try {
    await window.api.send(text, turnId, viewing());
    viewerSelection = null; // (said once)
    return true;
  } catch (e) {
    add(div('error', esc(errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    setRunning(false);
    return false;
  }
}


// ---------- /skill: suggestions while typing ----------
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
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
}

// Links in the answers: web pages in the browser, never in this window.
for (const area of [...panes.map((p) => p.transcript), $('agentPanelBody')]) {
  area.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('.bubble a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) window.open(href);
  });
}

// ---------- ⌘F: search the conversation worked in, or the file in the viewer (the one clicked last) ----------
let findZone: 'chat' | 'viewer' = 'chat';
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('.find-bar')) return;
  findZone = t.closest('#viewer') ? 'viewer' : t.closest('.chat') ? 'chat' : findZone;
}, true);
const findBar = document.body.appendChild(div('find-bar hidden', '<input type="text" spellcheck="false" autocomplete="off" placeholder="Rechercher"><span class="find-count"></span><button type="button" class="ghost icon find-prev" title="Précédent (⇧↩)">↑</button><button type="button" class="ghost icon find-next" title="Suivant (↩)">↓</button><button type="button" class="ghost icon find-close" title="Fermer (Échap)">✕</button>'));
const findInput = findBar.querySelector('input')!;
let findRoot: HTMLElement | null = null; // (what is searched)
let found: Range[] = [];
let foundAt = 0;

function openFind() {
  findRoot = findZone === 'viewer' && !$('viewer').classList.contains('hidden') ? $('viewerBody') : focused.transcript;
  const sel = window.getSelection()?.toString().trim();
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findBar.classList.remove('hidden');
  placeFind();
  findInput.focus();
  findInput.select();
  runFind(false);
}
function closeFind() {
  findBar.classList.add('hidden');
  CSS.highlights.delete('find');
  CSS.highlights.delete('find-current');
  findRoot = null;
  found = [];
}
/** At the top right of what is searched, under the bar of the window. */
function placeFind() {
  if (!findRoot) return;
  const r = findRoot.getBoundingClientRect();
  findBar.style.top = `${Math.max(r.top, topbar.getBoundingClientRect().bottom) + 8}px`;
  findBar.style.left = `${Math.max(r.left + 8, r.right - findBar.offsetWidth - 18)}px`;
}
/** The matches, again; step: to the next (1) or previous (-1) one, or false for a new text (the first one on screen). */
function runFind(step: number | false) {
  if (!findRoot) return;
  const root = findRoot;
  found = findRanges(root, findInput.value, '.gutter');
  if (step === false) {
    const top = root.getBoundingClientRect().top;
    foundAt = Math.max(0, found.findIndex((r) => r.getBoundingClientRect().bottom >= top));
  } else foundAt = found.length ? (foundAt + step + found.length) % found.length : 0;
  CSS.highlights.set('find', new Highlight(...found));
  const cur = found[foundAt];
  if (cur) {
    CSS.highlights.set('find-current', new Highlight(cur));
    const r = cur.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.top < box.top + 50 || r.bottom > box.bottom - 30) root.scrollTop += r.top - box.top - box.height / 3;
  } else CSS.highlights.delete('find-current');
  findBar.querySelector<HTMLElement>('.find-count')!.textContent = found.length ? `${foundAt + 1}/${found.length}` : findInput.value.trim() ? 'Aucun' : '';
}
findInput.addEventListener('input', () => runFind(false));
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
findBar.querySelector<HTMLElement>('.find-prev')!.onclick = () => runFind(-1);
findBar.querySelector<HTMLElement>('.find-next')!.onclick = () => runFind(1);
findBar.querySelector<HTMLElement>('.find-close')!.onclick = closeFind;
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey || !(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  openFind();
});
window.addEventListener('resize', placeFind);

// ---------- quote a passage of the conversation (select it, then "Citer") ----------
const quoteBtn = document.createElement('button');
quoteBtn.className = 'quote-btn hidden';
quoteBtn.type = 'button';
quoteBtn.textContent = '❝ Citer';
quoteBtn.title = 'Citer ce passage dans votre message';
document.body.appendChild(quoteBtn);
let quoteRange: Range | null = null;
let quoteFile = false; // (the passage is of the file in the viewer)

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

/** The "Citer" button under a selection of the conversation or of the viewer. */
function showQuoteBtn(range: Range, file: boolean) {
  quoteRange = range.cloneRange();
  quoteFile = file;
  const rects = range.getClientRects();
  const r = rects[rects.length - 1] || range.getBoundingClientRect();
  quoteBtn.classList.remove('hidden');
  const w = quoteBtn.offsetWidth;
  quoteBtn.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w / 2))}px`;
  quoteBtn.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 6)}px`;
}

document.addEventListener('mousedown', (e) => { if (e.target !== quoteBtn) hideQuoteBtn(); });
for (const p of panes) p.transcript.addEventListener('scroll', hideQuoteBtn);
quoteBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
quoteBtn.onclick = () => quoteRange && (quoteFile ? quoteViewer(quoteRange) : quote(quoteRange));

/** The passage (a range of the conversation) goes into the input, as a quote; `from`: the file it comes from, first. */
function quote(range: Range, from = '') {
  const text = selectionText(range);
  hideQuoteBtn();
  window.getSelection()?.removeAllRanges();
  if (!text) return;
  const quote = [...(from ? [from] : []), ...text.split('\n')].map((l) => `> ${l}`.trimEnd()).join('\n');
  const cur = input.value;
  const sep = !cur ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
  input.value = `${cur}${sep}${quote}\n\n`;
  autosize();
  noteDraft();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---------- generation timing ----------

/** A share of the plan's session: "+2 %", "+0,4 %", "< 0,1 %" (tenths only below 10, when there are some). */
const fmtSession = (p: number) => (p < 0.05 ? '< 0,1 %' : `+${fmtNum(p, Number.isInteger(p) || p >= 10 ? 0 : 1)} %`);

function formatStats(s: TurnStats) {
  return [fmtDuration(s.totalMs), `${s.exact ? '' : '≈'}${s.tokens} tokens`, s.session === undefined ? '' : `${fmtSession(s.session)} de session`, `${fmtNum(s.tps ?? 0)} tok/s`].filter(Boolean).join(' · ');
}

function statsDetails(s: TurnStats) {
  return [
    `Durée totale de la réponse : ${fmtDuration(s.totalMs)} (${s.steps} appel${s.steps > 1 ? 's' : ''} au modèle, outils compris)`,
    `Génération : ${fmtDuration(s.genMs)} pour ${s.tokens} tokens${s.exact ? '' : ' (en partie estimés : le flux est arrêté après chaque action)'}`,
    `Vitesse moyenne de génération : ${fmtNum(s.tps ?? 0)} tokens/s`,
    `Lecture du prompt : ${fmtDuration(s.promptMs)}`,
    ...(s.session === undefined ? [] : [`Session de l’abonnement utilisée par cette réponse : ${fmtSession(s.session)} (fenêtre de 5 heures)`]),
  ].join('\n');
}

// Progress of the prompt reading (before the first token), when the server reports it.
let promptProgress: Pane['promptProgress'] = null; // { id, value, t0 }
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

/** What the agent kept before a compaction: its memory notes, and the lines added to the project's notes file. */
function keptCard(ev: EventOf<'kept'>): HTMLElement {
  const d = div('kept');
  d.appendChild(div('kept-title', '🧠 Retenu avant le compactage'));
  const row = (text: string, where: string, title: string, quoted = true) => {
    const r = d.appendChild(div('kept-row'));
    r.title = title;
    r.append(div('kept-text', quoted ? `« ${esc(text)} »` : `<code>${esc(text)}</code>`), div('kept-where', esc(where)));
  };
  for (const note of ev.memory) row(note, 'dans la mémoire', 'Gardé pour toute la conversation. Retirable via 🧠 sous la zone de saisie.');
  if (ev.update) row(ev.update, 'confié à un sous-agent', 'Mis à jour par un sous-agent avant le résumé : il reçoit tout ce qu’il faut savoir, et a la place de lire le fichier.', false);
  for (const { fact, section } of ev.project) row(fact, `ajouté à ${ev.file} › ${section}`, `Ajouté à ${ev.file}, section « ${section} » : lu au début de chaque conversation de ce projet.`);
  return d;
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
let runTimer: Pane['runTimer'];
function startRunTimer() {
  const t0 = performance.now();
  const p = pane;
  clearInterval(runTimer);
  const tick = () => inPane(p, () => {
    const extra = modelStatus || promptProgressText() || liveGenText();
    $('status').textContent = `L’agent travaille… ${fmtDuration(performance.now() - t0)}${extra ? ` · ${extra}` : ''}`;
  });
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
    case 'ask': {
      const n = parseQuestions(args.body).length;
      return `${n} question${n > 1 ? 's' : ''}`;
    }
    case 'plan': {
      const n = parsePlan(args.body).length; // (as the agent counts them: a step's commands are part of it)
      return `${n} tâche${n > 1 ? 's' : ''}`;
    }
    default: return args.path || '.';
  }
}

const TOOL_LABEL: Record<string, string> = { list: 'Lister', read: 'Lire', search: 'Chercher', write: 'Écrire', edit: 'Modifier', run: 'Exécuter', web_search: 'Web', fetch: 'Page web', agent: 'Sous-agent', plan: 'Plan', remember: 'Mémoriser', forget: 'Oublier', recall: 'Retrouver', ask: 'Questions' };

function renderDiff(diff: string) {
  const lines = diff.split('\n');
  const kind = (l: string) => (l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx');
  // The words changed inside a line: lines removed then added, taken in pairs (the first removed with the first added…).
  const marks = new Map<number, Piece[]>();
  for (let i = 0; i < lines.length;) {
    if (kind(lines[i]) !== 'del') { i++; continue; }
    const del = i;
    while (i < lines.length && kind(lines[i]) === 'del') i++;
    const add = i;
    while (i < lines.length && kind(lines[i]) === 'add') i++;
    for (let k = 0; k < Math.min(add - del, i - add); k++) {
      const d = wordDiff(lines[del + k].slice(1), lines[add + k].slice(1));
      if (!d) continue;
      marks.set(del + k, d.before);
      marks.set(add + k, d.after);
    }
  }
  return `<pre class="diff">${lines.map((l, i) => {
    const pieces = marks.get(i);
    const text = pieces ? esc(l[0]) + pieces.map(([t, changed]) => (changed ? `<span class="wd">${esc(t)}</span>` : esc(t))).join('') : esc(l);
    return `<span class="${kind(l)}">${text || ' '}</span>`;
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
  forPanes(() => scrollDown());
}

// ---------- a file being written or edited, followed live in the side panel ----------
let liveBubble: Bubble | null = null;
let livePane: Pane | null = null; // (the pane of the answer followed)
let viewerPane: Pane | null = null; // (the pane whose project the file shown is from: its reads go through it)
/** The side panels of the pane worked in are closed (its conversation is drawn again, or another one shown). */
function closePanelsOfPane() {
  if (livePane === pane) closeLivePanel();
  if (panelPane === pane) closeAgentPanel();
  if (split) closeTabsOf(pane); // (perhaps of another project)
}

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
  livePane = pane;
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
  livePane = null;
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
      if (shownAgent() === ev.agentId) renderGauge(ev, $('agentPanelGauge'), { sub: true });
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
      if (ev.tool === 'run' || ev.tool === 'ask') {
        card.classList.add('open');
        summaryEl.title = ev.args?.command || '';
      }
      card.dataset.tool = ev.tool;
      card.dataset.path = ev.args?.path || '';
      if (ev.tool === 'ask') card.dataset.body = ev.args?.body || '';
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
      card.querySelector<HTMLElement>('.approval, .ask-wait')?.remove();
      closeQuestionnaire(ev.id);
      if (card.dataset.tool === 'ask' && ev.meta?.answers) askAnswers.set(ev.id, cleanAnswers(parseQuestions(card.dataset.body), ev.meta.answers));
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
        if (shownAgent() === ev.id) renderAgentPanelHead();
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
      if (ev.questions?.length) parts.push(count(ev.questions.length, 'question', 'questions'));
      d.innerHTML = `<summary>🧭 ${ev.update ? 'Bilan mis à jour' : 'Bilan'}${parts.length ? ` : ${parts.join(', ')}` : ''} → ${route}</summary>${list('Sait', ev.known)}${list('Doute', ev.doubts)}${list('Ignore', ev.unknowns)}${list('À demander', ev.questions)}`;
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
    case 'hint': {
      // What the app told the agent with the message: files changed without it, the file looked at.
      const msg = [...(target || transcript).querySelectorAll<HTMLElement>('.msg.user')].pop();
      if (!msg) break;
      const d = div('noted');
      d.textContent = `${ev.kind === 'changes' ? '✎' : '👁'} ${ev.text}`;
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
    case 'keep_start':
      if (replaying) break;
      (target ?? transcript).querySelector<HTMLElement>('.compaction.pending')?.remove();
      add(div('compaction pending', '<span class="spin">◌</span> Avant le compactage : ce qui mérite d’être retenu…'));
      break;
    case 'kept':
      (target ?? transcript).querySelector<HTMLElement>('.compaction.pending')?.remove();
      if (ev.memory.length || ev.project.length || ev.update) add(keptCard(ev));
      // (nothing kept: said all the same, so the review is not taken for one that did not run)
      else add(div('notice', esc(ev.failed ? `🧠 Bilan avant le compactage impossible : ${ev.failed}.` : `🧠 Avant le compactage : rien de nouveau à retenir${ev.dropped ? ` (${ev.dropped} proposition${ev.dropped > 1 ? 's' : ''} écartée${ev.dropped > 1 ? 's' : ''} : déjà en mémoire ou trop vague${ev.dropped > 1 ? 's' : ''})` : ''}.`)));
      break;
    case 'compaction_start':
      (target ?? transcript).querySelector<HTMLElement>('.compaction.pending')?.remove();
      add(div('compaction pending', '<span class="spin">◌</span> Compactage du contexte : résumé des anciens messages…'));
      break;
    case 'compaction': {
      if (promptProgress?.id === 'compaction') promptProgress = null;
      (target ?? transcript).querySelector<HTMLElement>('.compaction.pending')?.remove();
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
      if (pane === focused) input.focus();
      break;
  }
}

function onApproval(req: SessionApproval) {
  const card = cards.get(req.id);
  if (!card) return;
  if (req.questions) return showQuestionnaire(card, req.id, req.questions);
  // A sub-agent's command: its view is shown, or the question would go unseen.
  for (const [id, view] of agentViews) if (view.contains(card) && shownAgent() !== id) openAgentPanel(id);
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

// The agent's questions (<ask>): proposed answers to pick (one, or several), and a field
// for the user's own words under each. The turn waits for them like an approval. They
// take the place of the message field (its draft is kept); the card says it waits.
// One question at a time, with a stepper: going back keeps the answers, and so does
// drawing the conversation again (another one shown, then this one).
// (by its questions: a questionnaire asked again, resumed or after a restart, has another id)
let askDrafts = new Map<string, AskState>();
const askKey = (questions: Question[]) => JSON.stringify(questions);
let askAnswers = new Map<number, QuestionAnswer[]>(); // the answers given, by card (resuming from it starts from them)
let askSaveTimer: Timer | undefined;

/** The questionnaire's state, kept with the conversation (soon, not at each key). */
function saveAskDraft(draft: AskDraft | null) {
  clearTimeout(askSaveTimer);
  if (!draft) return void window.api.setAskDraft(null);
  const p = pane;
  askSaveTimer = setTimeout(() => inPane(p, () => window.api.setAskDraft(draft)), 300);
}

function showQuestionnaire(card: HTMLElement, id: number, questions: Question[]) {
  closeQuestionnaire();
  if (!card.querySelector('.ask-wait')) card.appendChild(div('ask-wait', 'En attente de vos réponses, dans la zone de saisie'));
  const form = document.createElement('form');
  form.className = 'questionnaire';
  form.dataset.id = String(id);
  const n = questions.length;
  const key = askKey(questions);
  form.innerHTML = questions.map((q, i) => `<fieldset class="q" data-step="${i}"><legend>${esc(q.question)}${q.multiple || !q.options.length ? '' : ' <span class="muted">(un seul choix)</span>'}</legend>${
    q.options.map((o) => `<label class="q-opt"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join('')
  }<input type="text" class="q-other" name="other${i}" placeholder="${q.options.length ? 'Autre réponse ou précision…' : 'Votre réponse…'}"></fieldset>`).join('') +
    `<div class="q-actions"><button type="button" class="ghost q-skip">Ignorer</button><div class="q-steps" role="group">${questions.map((q, i) => `<button type="button" class="q-step" data-step="${i}" title="${esc(q.question)}">${i + 1}</button>`).join('<span class="q-link"></span>')}</div><div class="q-nav"><button type="button" class="ghost q-prev">${CHEV_LEFT}<span>Précédent</span></button><button type="submit" class="primary q-next"></button></div></div>`;
  const field = (i: number) => form.querySelector<HTMLInputElement>(`input[name="other${i}"]`)!;
  const answers = (): QuestionAnswer[] => questions.map((_, i) => ({
    choices: [...form.querySelectorAll<HTMLInputElement>(`input[name="q${i}"]:checked`)].map((x) => x.value),
    other: field(i).value.trim(),
  }));
  const answered = (a: QuestionAnswer) => Boolean(a.choices.length || a.other);
  // (what was answered before: drawn again, resumed from its card, or before a restart)
  const kept = askDrafts.get(key);
  kept?.answers.slice(0, n).forEach((a, i) => {
    form.querySelectorAll<HTMLInputElement>(`input[name="q${i}"]`).forEach((x) => { x.checked = a.choices.includes(x.value); });
    field(i).value = a.other;
  });
  let step = Math.min(kept?.step ?? 0, n - 1);
  let shownStep = step; // (the question shown before: going back, the next one slides the other way)
  let reached = Math.max(step, ...answers().map((a, i) => (answered(a) ? i : 0))); // the furthest question seen
  const keep = () => {
    const draft = { key, answers: answers(), step };
    askDrafts.set(key, draft);
    saveAskDraft(draft);
  };
  const go = (to: number) => {
    step = Math.max(0, Math.min(n - 1, to));
    reached = Math.max(reached, step);
    const given = answers();
    form.querySelectorAll<HTMLElement>('.q').forEach((f, i) => {
      f.classList.toggle('hidden', i !== step);
      f.classList.toggle('back', i === step && i < shownStep);
    });
    shownStep = step;
    // (a question already seen or answered can be gone back to; the next ones, through Next)
    form.querySelectorAll<HTMLButtonElement>('.q-step').forEach((b, i) => {
      b.classList.toggle('current', i === step);
      b.classList.toggle('done', i !== step && answered(given[i]));
      b.disabled = i === step || (i > reached && !answered(given[i]));
    });
    form.querySelector<HTMLElement>('.q-steps')!.ariaLabel = `Question ${step + 1} sur ${n}`;
    form.querySelector<HTMLButtonElement>('.q-prev')!.disabled = step === 0;
    form.querySelector<HTMLElement>('.q-next')!.innerHTML = step === n - 1 ? `<span>Envoyer</span>${SEND_ICON}` : `<span>Suivant</span>${CHEV_RIGHT}`;
    form.querySelectorAll<HTMLElement>('.q-link').forEach((l, i) => l.classList.toggle('done', i < step));
    form.querySelector<HTMLElement>('.q-steps')!.classList.toggle('hidden', n < 2);
    form.querySelector<HTMLElement>('.q-prev')!.classList.toggle('hidden', n < 2);
    keep();
    (form.querySelector<HTMLElement>(`.q[data-step="${step}"] input:checked`) ?? form.querySelector<HTMLElement>(`.q[data-step="${step}"] input`))?.focus();
    fitComposer();
  };
  // (a radio picked again is unpicked: a single choice can be left empty)
  form.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((r) => {
    r.onpointerdown = () => { r.dataset.was = String(r.checked); };
    r.onclick = () => {
      const was = r.dataset.was;
      delete r.dataset.was; // (set by a pointer only: arrow keys also click, and only move among the choices)
      if (was === 'true') { r.checked = false; keep(); return; }
      // A single choice picked: the next question (not on the last one: sending stays the user's click).
      const from = step;
      if (was && from < n - 1) setTimeout(() => { if (step === from && r.checked) go(from + 1); }, 220);
    };
  });
  form.oninput = keep;
  form.onchange = keep;
  const send = (given: QuestionAnswer[] | null) => {
    askDrafts.delete(key);
    saveAskDraft(null);
    closeQuestionnaire();
    window.api.answer(id, given);
  };
  // (Enter, or the button: the next question, then sending on the last one)
  form.onsubmit = (e) => {
    e.preventDefault();
    if (step < n - 1) go(step + 1);
    else send(answers());
  };
  form.querySelector<HTMLElement>('.q-prev')!.onclick = () => go(step - 1);
  form.querySelectorAll<HTMLElement>('.q-step').forEach((b) => { b.onclick = () => go(Number(b.dataset.step)); });
  form.querySelector<HTMLElement>('.q-skip')!.onclick = () => send(null);
  form.onkeydown = (e) => {
    // (Escape in a field: back to the previous question)
    if (e.key === 'Escape' && step > 0) { e.preventDefault(); go(step - 1); }
  };
  input.before(form);
  chat.querySelector<HTMLElement>('.composer-box')!.classList.add('asking');
  go(step);
  scrollDown(true);
}

/** A questionnaire waiting is given up (its turn stops), so that the conversation can be rewound or resumed. */
const asking = () => Boolean(chat.querySelector('.composer .questionnaire'));

async function stopAsking(): Promise<boolean> {
  if (!running) return true;
  if (!asking()) return false;
  // (its answers go with it: what follows a rewind starts clean)
  askDrafts.clear();
  saveAskDraft(null);
  closeQuestionnaire();
  await window.api.stop();
  for (let i = 0; i < 100 && running; i++) await new Promise((r) => setTimeout(r, 50));
  return !running;
}

/** The message field back (answered, or another conversation shown). */
function closeQuestionnaire(id?: number) {
  const form = chat.querySelector<HTMLElement>('.composer .questionnaire');
  if (!form || (id !== undefined && form.dataset.id !== String(id))) return;
  form.remove();
  chat.querySelector<HTMLElement>('.composer-box')!.classList.remove('asking');
  autosize(); // (its height, measured while hidden, was none)
  fitComposer();
}

// Only the events of the conversations shown are drawn, each in its pane (the others are replayed when opened).
const paneOf = (x: { session?: string }) => (!x.session ? focused : shownPanes().find((p) => sessionOf(p) === x.session));
window.api.onEvent((ev) => { const p = paneOf(ev); if (p) inPane(p, () => onEvent(ev)); });
window.api.onConversationsChanged(() => refreshConversations());
window.api.onSessionsChanged(() => refreshConversations());
window.api.onApproval((req) => { const p = paneOf(req); if (p) inPane(p, () => onApproval(req)); });

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
  newConversation: async (key) => { await putPairAside(); return key === ALL ? newConversationHere() : newConversationIn(key === OFF_KEY ? null : key); },
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
  const slots = items.some((it) => it !== '-' && (it.icon !== undefined || it.glyph)); // (the labels stay aligned)
  for (const it of items) {
    if (it === '-') { ctxMenu.appendChild(document.createElement('div')).className = 'ctx-sep'; continue; }
    const row = ctxMenu.appendChild(document.createElement('button'));
    row.type = 'button';
    row.className = `ctx-item${it.danger ? ' danger' : ''}${it.strong ? ' strong' : ''}`;
    row.disabled = Boolean(it.disabled);
    const icon = it.icon !== undefined ? `<img src="${esc(it.icon)}" alt="">` : it.glyph ? menuIconSvg(it.glyph) : '';
    row.innerHTML = `${slots ? `<span class="ctx-glyph">${icon}</span>` : ''}<span class="ctx-label"></span><span class="ctx-kbd">${it.kbd ?? (it.action && SHORTCUTS[it.action] ? shortcutText(SHORTCUTS[it.action]) : '')}</span>`;
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
    { glyph: 'newConversation', label: 'Nouvelle conversation', action: 'newConversation', run: () => projectActions.newConversation(key) },
    { glyph: 'markRead', label: n ? `Marquer comme lues (${n})` : 'Marquer comme lues', action: 'markRead', disabled: !n, run: () => projectActions.markRead(key) },
    '-',
    { glyph: 'settings', label: key === ALL ? 'Paramètres des projets…' : 'Paramètres du projet…', action: 'projectSettings', run: () => openProjectSettings(key) },
    { glyph: 'addProject', label: 'Ajouter un projet…', action: 'addProject', run: addProject },
  ]);
});

// Right click on text: in a field, the usual editing (with the spelling
// suggestions); on a selection of the conversation, copy and quote.
const editKey = (k: string) => MAC ? `⌘${k}` : `Ctrl+${k}`;
window.api.onContextMenu((p) => {
  const f = p.editFlags || {};
  const editing: MenuItem[] = [
    { glyph: 'cut', label: 'Couper', kbd: editKey('X'), disabled: !f.canCut, run: () => window.api.edit('cut') },
    { glyph: 'copy', label: 'Copier', kbd: editKey('C'), disabled: !f.canCopy, run: () => window.api.edit('copy') },
    { glyph: 'paste', label: 'Coller', kbd: editKey('V'), disabled: !f.canPaste, run: () => window.api.edit('paste') },
  ];
  if (p.isEditable) {
    const spelling: (MenuItem | '-')[] = p.misspelledWord ? [
      ...(p.suggestions?.length
        ? p.suggestions.slice(0, 5).map((w) => ({ label: w, strong: true, run: () => window.api.edit('replace', w) }))
        : [{ label: 'Aucune suggestion', disabled: true, run() {} }]),
      { glyph: 'dictionary', label: `Ajouter « ${p.misspelledWord} » au dictionnaire`, run: () => window.api.edit('learn', p.misspelledWord) },
      '-',
    ] : [];
    showContextMenu(p.x, p.y, null, [
      ...spelling,
      { glyph: 'undo', label: 'Annuler', kbd: editKey('Z'), disabled: !f.canUndo, run: () => window.api.edit('undo') },
      '-',
      ...editing,
      '-',
      { glyph: 'selectAll', label: 'Tout sélectionner', kbd: editKey('A'), disabled: !f.canSelectAll, run: () => window.api.edit('selectAll') },
    ]);
    return;
  }
  if (!p.selectionText?.trim()) return;
  const sel = window.getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const where = range && panes.find((x) => x.transcript.contains(range.commonAncestorContainer));
  const inViewer = Boolean(range && $('viewerBody').contains(range.commonAncestorContainer));
  hideQuoteBtn();
  showContextMenu(p.x, p.y, null, [
    ...editing,
    '-',
    { glyph: 'quote', label: 'Citer dans le message', kbd: '❝', disabled: !where && !inViewer, run: () => {
      if (range && inViewer) quoteViewer(range);
      else if (range && where) { focusPane(where); quote(range); }
    } },
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
const ALERT_LABELS: Record<AppAlert['kind'], string> = { done: 'Terminé', error: 'Erreur', approval: 'Autorisation demandée', question: 'Questions de l’agent' };
function showAlert(a: AppAlert) {
  if (shownPanes().some((p) => sessionOf(p) === a.session)) return;
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
    if (!(e.target as HTMLElement).closest('.toast-close')) goTo(a.session);
  };
  // (an approval waits for an answer: it stays; the others go after a while, not while pointed at)
  const waits = a.kind === 'approval' || a.kind === 'question';
  let timer = waits ? undefined : setTimeout(close, 8000);
  t.onmouseenter = () => clearTimeout(timer);
  t.onmouseleave = () => { if (!waits) timer = setTimeout(close, 3000); };
  toasts.prepend(t);
  for (const extra of [...toasts.children].slice(4)) extra.remove();
}
const clearAlerts = (session: string) => { for (const t of toasts.querySelectorAll<HTMLElement>(`[data-session="${CSS.escape(session)}"]`)) t.remove(); };
window.api.onAlert(showAlert);
window.api.onOpenConversation((id) => goTo(id)); // (a notification of the system, clicked)

// ---------- sidebar ----------
let replaying = false;
/** The conversation of the pane worked in (its id, as its session's). */
const currentConversation = () => settings.active?.session ?? null;

$<HTMLButtonElement>('sidebarBtn').onclick = () => projectActions.toggleSidebar(projectFilter);
// The conversations and the files, as a deck of two cards (the one in front: remembered).
let filesInFront = false;
try { filesInFront = localStorage.getItem('deckFront') === 'files'; } catch {}
// On the card of the files, two sections, gone through as the projects are on the other card.
// A branch (the Git section has the Git mark).
const BRANCH_ICON = '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="2.5" r="1.6"/><circle cx="3" cy="9.5" r="1.6"/><circle cx="9" cy="3.5" r="1.6"/><path class="line" d="M3 3v6M9 4.5C9 7 3 6 3 8.5"/></svg>';
const SECTIONS = [
  { key: 'files', label: 'Fichiers', shortcut: 'showFiles', icon: '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 3a1 1 0 0 1 1-1h2.6l1.2 1.3H10a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/></svg>' },
  { key: 'git', label: 'Git', shortcut: 'showGit', icon: '<svg class="proj-icon dot-icon" viewBox="0 0 12 12" aria-hidden="true"><path class="line" d="M6 .9 11.1 6 6 11.1.9 6z" stroke-linejoin="round"/><path class="line" d="M4.3 3.6 6 5.3v2.6M6 5.3l1.9 1.9"/><circle cx="6" cy="8.1" r="1"/><circle cx="8" cy="7.3" r="1"/></svg>' },
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
// Two conversations side by side make one card, in the most pressing of their two places.
const PRIORITY = ['waiting', 'failed', 'busy', 'sleeping', 'done', 'drafts', 'archived'];
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
  menu.append(div('pm-sep'), add, cloneRow(closeProjectMenu));
  menu.classList.remove('hidden');
  $<HTMLButtonElement>('projectPicker').classList.add('open');
}
/** The row of a project menu that clones a remote repository. */
function cloneRow(close: () => void) {
  const row = div('pm-row', `<span class="pm-icon">${CLONE_ICON}</span><span class="pm-name">Ajouter depuis un dépôt distant…</span>`);
  row.dataset.tip = 'Cloner un dépôt Git dans un nouveau dossier';
  row.onclick = () => { close(); openCloneDialog(); };
  return row;
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
  menu.append(div('pm-sep'), add, cloneRow(closeViewMenu));
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
/** The files card on the project it should show (the focused conversation's); the chat greyed when it is not the conversation's. */
const syncView = () => inPane(focused, syncFocusedView);
async function syncFocusedView() {
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
  if (next === observed) {
    // (the other pane of a split view, in another folder: its files)
    if (listedDir !== null && viewDir() !== listedDir) {
      expanded.clear();
      refreshTree();
    }
    return;
  }
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
/** Greyed, out of reach of the keyboard: a click on it only brings it back (its controls wait for the next one). */
function greyChat(on: boolean) {
  document.body.classList.toggle('observing', on);
  for (const p of panes) for (const el of p.root.children) (el as HTMLElement).inert = on;
}
for (const p of panes) p.root.addEventListener('mousedown', () => endObserving());

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

/** At the top of the window: the project and the title of the conversation shown (of each pane, in a split view). */
function renderConvHead() {
  if (split) return renderSplitHeads();
  inPane(focused, () => fillHead($('convHead')));
  $<HTMLButtonElement>('headRename').classList.toggle('hidden', !lastConversations.some((x) => x.id === sessionOf(focused)));
}
/** A head: the project and the title of the conversation of the pane worked in. */
function fillHead(head: HTMLElement) {
  const c = lastConversations.find((x) => x.id === currentConversation());
  const off = c ? c.offProject : offMode();
  const dir = c ? c.workspace : activeDir();
  const key = off ? OFF_KEY : dir;
  const project = head.querySelector<HTMLElement>('.head-project')!;
  project.innerHTML = off || dir ? `${projectGlyph(key)} ${esc(projectLabel(key))}` : '';
  const title = c?.title || 'Nouvelle conversation';
  head.querySelector<HTMLElement>('.head-title')!.textContent = title;
  head.title = title;
}
const renameTip = () => `Renommer (${MAC ? '⌘R' : 'Ctrl+R'})`;
/** Renames the conversation shown (the focused one), in place at the top of the window. */
function renameCurrent() {
  const c = lastConversations.find((x) => x.id === sessionOf(focused));
  const head = split ? splitHead(focused) : $('convHead');
  if (c && !document.querySelector<HTMLElement>('dialog[open]')) startRename(head, c, head.querySelector<HTMLElement>('.head-title')!);
}
$('convHead').querySelector<HTMLElement>('.head-title')!.ondblclick = renameCurrent;
$<HTMLButtonElement>('headRename').onclick = renameCurrent;
$<HTMLButtonElement>('headRename').dataset.tip = renameTip();
window.api.onRenameConversation(renameCurrent); // (the application menu, ⌘R)

async function refreshConversations({ slide = 0 } = {}) {
  if (renaming || !settings) return;
  const { all: every } = await window.api.listConversations();
  const current = sessionOf(focused);
  everyConversation = every;
  lastConversations = every.filter((c) => !isHiddenProject(projectOf(c)));
  renderConvHead();
  for (const p of shownPanes()) {
    const named = lastConversations.find((c) => c.id === sessionOf(p) && c.titleFromDraft);
    if (named) inPane(p, () => showDraftTitle(named));
  }
  const keys = projectKeys();
  if (!keys.includes(projectFilter)) projectFilter = ALL;
  renderProjectBar(keys);
  const inList = (c: ConversationSummary) => projectFilter === ALL || projectOf(c) === projectFilter;
  syncPair();
  // (a pair whose conversation is gone comes apart)
  const known = new Set(every.map((c) => c.id));
  const whole = pairs.filter((x) => x === shownPair || (known.has(x.left) && known.has(x.right)));
  if (whole.length !== pairs.length) { pairs = whole; savePairs(); }
  // Each pair: its two conversations, left then right, as one card where the more recent would be.
  const leads = new Map<ConversationSummary, { card: PairCard; place?: string }>();
  const inPairs = new Set<ConversationSummary>();
  for (const pr of pairs) {
    const card = { pair: pr, members: [pr.left, pr.right].map((id) => lastConversations.find((c) => c.id === id)) };
    const paired = card.members.filter((c): c is ConversationSummary => Boolean(c));
    for (const c of paired) inPairs.add(c);
    if (!paired.some(inList)) continue;
    const lead = paired.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    leads.set(lead, { card, place: PRIORITY.find((k) => paired.some((c) => category(c) === k)) });
  }
  const all = lastConversations.filter((c) => leads.has(c) || (inList(c) && !inPairs.has(c)));
  const placeOf = (c: ConversationSummary) => (leads.has(c) ? leads.get(c)!.place : category(c));
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
  addButton.onclick = async () => { await putPairAside(); newConversationHere(); };
  middleClick(addButton, () => openBeside(null));
  list.appendChild(add);
  for (const cat of CATEGORIES) {
    const items = all.filter((c) => placeOf(c) === cat.key);
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
    for (const c of items) { const lead = leads.get(c); ul.appendChild(lead ? pairItem(lead.card, placeOf(c) ?? '') : conversationItem(c, current)); }
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
const newConversationHere = (key = defaultProject()) => newConversationIn(key === OFF_KEY ? null : key);

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
    return false;
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
  return true;
}

const CLOCK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

/** How many things wait for the user: approvals (orange), answers to read (blue, or red after an error). Asleep, nothing does: a clock in the same place. */
function fillPill(pill: HTMLElement, c: ConversationSummary) {
  if (c.approvals) {
    pill.textContent = String(c.approvals);
    pill.classList.add('warn');
    pill.title = c.approvals > 1 ? `${c.approvals} demandes en attente de votre réponse` : 'Une demande en attente de votre réponse';
  } else if (c.sleeping) {
    pill.innerHTML = CLOCK_ICON;
    pill.classList.add('clock');
    pill.title = 'En veille : attend la fin d’une tâche';
  } else if (c.unread) {
    pill.textContent = String(c.unread);
    pill.title = category(c) === 'failed' ? (c.unread > 1 ? `${c.unread} messages à consulter` : 'Un message à consulter')
      : c.unread > 1 ? `${c.unread} réponses à lire` : 'Une réponse à lire';
  } else pill.remove();
}

const TRASH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.8v4.4M9.2 6.8v4.4"/></svg>';
function conversationItem(c: ConversationSummary, current: string | null) {
  const li = document.createElement('li');
  li.className = `conv-card ${category(c)}`;
  li.dataset.place = c.id;
  li.dataset.project = projectOf(c);
  li.classList.toggle('active', c.id === current);
  li.innerHTML = '<div class="card-top"><span class="title"></span><span class="state"></span><span class="pill"></span><span class="card-actions"><button class="ren">✎</button><button class="del" title="Supprimer">' + TRASH_ICON + '</button></span></div><div class="card-meta"><span class="project"></span><span class="when"></span><span class="card-engine"></span></div>';
  li.querySelector<HTMLElement>('.title')!.textContent = c.title;
  li.querySelector<HTMLElement>('.title')!.dataset.conv = c.id;
  if (c.draft) { // (the card shows its prompt on hover, instead of the title in full)
    li.dataset.tip = c.draftText;
    li.dataset.tipSide = '';
  } else li.querySelector<HTMLElement>('.title')!.title = c.title;
  fillPill(li.querySelector<HTMLElement>('.pill')!, c);
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
  li.onclick = () => goTo(c.id);
  // A click with the wheel, or the card dropped on one side of the chat: beside the one shown.
  middleClick(li, () => openBeside(c.id));
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    if (li.classList.contains('editing') || !e.dataTransfer) return e.preventDefault();
    dragged = c.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.title);
    hideTip();
  });
  li.addEventListener('dragend', () => { dragged = null; showDropZone(null); });
  li.querySelector<HTMLElement>('.ren')!.dataset.tip = renameTip();
  li.querySelector<HTMLElement>('.ren')!.onclick = (e) => { e.stopPropagation(); startRename(li, c); };
  li.querySelector<HTMLElement>('.title')!.ondblclick = (e) => { e.stopPropagation(); startRename(li, c); };
  li.querySelector<HTMLElement>('.del')!.onclick = (e) => { e.stopPropagation(); deleteConversation(c, current); };
  // Right click: this conversation's actions.
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeProjectMenu();
    const here = !split && c.id === current;
    const beside = split ? sideOf(otherPane(focused)) : 'right';
    showContextMenu(e.clientX, e.clientY, esc(c.title), [
      { glyph: 'left', label: split ? 'Remplacer la conversation de gauche' : 'Ouvrir à gauche', kbd: beside === 'left' ? 'clic molette' : '', disabled: here, run: () => openAside(c.id, 'left') },
      { glyph: 'right', label: split ? 'Remplacer la conversation de droite' : 'Ouvrir à droite', kbd: beside === 'right' ? 'clic molette' : '', disabled: here, run: () => openAside(c.id, 'right') },
      '-',
      { glyph: 'markRead', label: 'Marquer comme lue', disabled: !(c.unread || c.finished), run: () => window.api.markConversationsRead([c.id]) },
      { glyph: 'rename', label: 'Renommer', run: () => startRename(li, c) },
      '-',
      { glyph: 'trash', label: 'Supprimer…', danger: true, run: () => deleteConversation(c, current) },
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
  if (view.askDraft) askDrafts.set(view.askDraft.key, view.askDraft);
  for (const req of view.approvals || []) onApproval(req);
  // A questionnaire left unanswered when the app was closed: asked again, where it was left.
  const lastAsk = view.events.findLast((e): e is EventOf<'action_start'> => e.type === 'action_start' && !e.agentId);
  if (!view.running && !view.approvals?.length && lastAsk?.tool === 'ask' && !view.events.some((e) => e.type === 'action_end' && e.id === lastAsk.id && !e.agentId)) {
    void resumeFromAction(lastAsk.id, { ask: false });
  }
  setInput(view.draft || '');
  fitComposer(); // (its plan may be there or not: the position is that of the page at its final height)
  const pos = scrollPos.get(view.session);
  transcript.scrollTop = typeof pos === 'number' ? pos : transcript.scrollHeight;
}

async function openConversation(id: string) {
  const there = shownPanes().find((p) => sessionOf(p) === id);
  if (there) return void focusPane(there); // (already shown)
  rememberScroll(); // (the conversation shown goes on in the background)
  await flushDraft();
  let view;
  try {
    view = await window.api.openConversation(id);
  } catch (e) {
    $('status').textContent = errorText(e);
    return false;
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
  return true;
}

// ---------- the split view: two conversations side by side ----------
// A conversation opens beside the one shown (a click with the wheel on its card, or on
// « Nouvelle conversation »; its card's menu; the card dropped on one side of the chat),
// each pane with its own input. Two shown, a card dropped on one replaces it. Their two
// titles are at the top of the window, each with its ✕; in the sidebar, the two make one
// card until one is closed. The side panels float over one pane instead of taking room.
type Side = 'left' | 'right';
let leftPane = panes[0];
let splitAt = 0.5; // the left pane's share of the room
let panelSide: Side = 'right'; // the pane the side panels float over
let panelPlaced = false; // (put there by the user: it stays)
let dragged: string | null = null; // the conversation whose card is dragged
let draggedFile: string | null = null; // the file of the tree dragged
let panelTarget: Pane | null = null; // (the pane a side panel about to open goes over)
const chats = $('chats');
const sideOf = (p: Pane): Side => (p === leftPane ? 'left' : 'right');
const paneAt = (side: Side) => (side === 'left' ? leftPane : otherPane(leftPane));

/** A click with the wheel (no scrolling cursor on the way). */
function middleClick(el: HTMLElement, run: () => unknown) {
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  });
}

/** The pane the user works in: its input, its model, the files of its project. */
function focusPane(p: Pane) {
  if (p === focused || !split) return;
  inPane(focused, rememberScroll);
  usePane(p);
  focused = p;
  for (const x of panes) x.root.classList.toggle('focused', x === p);
  renderSettings();
  renderConvHead();
  refreshPromptBadge();
  refreshGauge();
}

/** Beside the conversation shown: in a second pane, or in place of the other one. */
const openBeside = (id: string | null, project?: string) => (split ? openAside(id, sideOf(otherPane(focused)), project) : openAside(id, 'right', project));

/** A conversation (null: a new one, in this project or the default one) in the pane on that side, a second pane if there is one. */
async function openAside(id: string | null, side: Side, project?: string) {
  const open = () => (id !== null ? openConversation(id) : project && project !== ALL ? newConversationHere(project) : newConversationHere());
  if (split) {
    focusPane(paneAt(side));
    return open();
  }
  if (id !== null && id === sessionOf(focused)) return;
  const kept = focused;
  rememberScroll();
  await flushDraft();
  await window.api.split();
  const fresh = otherPane(kept);
  fresh.active = { ...settings.active, session: null, started: false };
  leftPane = side === 'left' ? fresh : kept;
  setSplit(true);
  focused = kept; // (focusPane works from the one shown)
  focusPane(fresh);
  if (!(await open())) await closePane(fresh);
}

/**
 * A pane closed: the other one takes the whole room, and the conversation goes back to the
 * sidebar as a card of its own. keepPair: the pair is only put aside (its card shows it again).
 */
async function closePane(p: Pane, { keepPair = false } = {}) {
  if (!split) return;
  if (!keepPair) pairs = pairs.filter((x) => x !== shownPair);
  shownPair = null;
  savePairs();
  const keep = otherPane(p);
  await inPane(p, () => { rememberScroll(); return flushDraft(); });
  focusPane(keep);
  settings = await window.api.unsplit(sessionOf(keep));
  inPane(p, () => {
    clearTranscript();
    setRunning(false);
    setInput('');
    $('status').textContent = '';
  });
  p.active = null;
  setSplit(false);
  renderSettings();
  refreshConversations();
}

function setSplit(on: boolean) {
  split = on;
  document.body.classList.toggle('split', on);
  for (const p of panes) {
    p.root.classList.toggle('hidden', !on && p !== focused);
    p.root.classList.toggle('focused', on && p === focused);
  }
  splitDivider.classList.toggle('hidden', !on);
  leftPane.root.style.order = '0';
  otherPane(leftPane).root.style.order = '2';
  panelPlaced = false;
  applySplitAt();
  renderConvHead();
}

function applySplitAt() {
  leftPane.root.style.flexGrow = split ? String(splitAt) : '';
  otherPane(leftPane).root.style.flexGrow = split ? String(1 - splitAt) : '';
}
// The divider moves the room between the two (a double click shares it again).
splitDivider.addEventListener('pointerdown', (down) => {
  if (down.button) return;
  down.preventDefault();
  splitDivider.setPointerCapture(down.pointerId);
  splitDivider.classList.add('dragging');
  const move = (e: PointerEvent) => {
    const box = chats.getBoundingClientRect();
    const min = Math.min(0.45, 340 / box.width);
    splitAt = Math.max(min, Math.min(1 - min, (e.clientX - box.left) / box.width));
    applySplitAt();
  };
  const up = () => {
    splitDivider.removeEventListener('pointermove', move);
    splitDivider.classList.remove('dragging');
    syncPair(); // (its share is kept with the pair)
  };
  splitDivider.addEventListener('pointermove', move);
  splitDivider.addEventListener('pointerup', up, { once: true });
  splitDivider.addEventListener('pointercancel', up, { once: true });
});
splitDivider.ondblclick = () => { splitAt = 0.5; applySplitAt(); syncPair(); };

// The two titles, at the top of the window above their panes.
const splitHeads = new Map(panes.map((p) => {
  const head = $('splitHeads').appendChild(div('conv-head split-head', '<span class="head-project"></span><span class="head-title"></span><button class="head-settings" type="button" aria-label="Paramètres de la conversation"></button><button class="head-close" type="button" aria-label="Fermer">✕</button>'));
  const settingsBtn = head.querySelector<HTMLElement>('.head-settings')!;
  settingsBtn.innerHTML = $('convSettingsBtn').querySelector('svg')!.outerHTML;
  settingsBtn.dataset.tip = 'Étapes et prompt système de cette conversation';
  settingsBtn.onclick = (e) => { e.stopPropagation(); focusPane(p); openConvSettings(); };
  head.querySelector<HTMLElement>('.head-close')!.dataset.tip = 'Fermer cette conversation (elle continue en arrière-plan)';
  head.querySelector<HTMLElement>('.head-close')!.onclick = (e) => { e.stopPropagation(); closePane(p); };
  head.addEventListener('mousedown', () => focusPane(p));
  head.querySelector<HTMLElement>('.head-title')!.ondblclick = () => { focusPane(p); renameCurrent(); };
  return [p, head];
}));
const splitHead = (p: Pane) => splitHeads.get(p)!;
/** A pane's title, or none before they are made (they come in the order of the panes). */
function headOf(p: Pane) {
  return [...document.querySelectorAll<HTMLElement>('.split-head')].at(panes.indexOf(p));
}
function renderSplitHeads() {
  for (const p of panes) {
    inPane(p, () => fillHead(splitHead(p)));
    splitHead(p).classList.toggle('focused', p === focused);
  }
  placeHeads();
}
/** Each title centered above its pane, between the buttons of the bar. */
function placeHeads() {
  if (!split) return;
  const bar = topbar.getBoundingClientRect();
  const lo = document.querySelector<HTMLElement>('.brand')!.getBoundingClientRect().right + 14;
  const hi = $('settingsBtn').getBoundingClientRect().left - 14;
  for (const p of panes) {
    const head = splitHead(p);
    const r = p.root.getBoundingClientRect();
    const a = Math.max(r.left + 10, lo);
    const b = Math.min(r.right - 10, hi);
    head.style.maxWidth = `${Math.max(0, b - a)}px`;
    const w = head.offsetWidth;
    head.style.left = `${Math.max(a, Math.min(b - w, r.left + r.width / 2 - w / 2)) - bar.left}px`;
  }
}

/** The card of the two conversations side by side: left, then right; a click goes to one. */
// ---------- pairs: conversations side by side, kept (and saved) until one of them is closed ----------
// The split view shows one pair. A plain click elsewhere puts it aside (one pane again);
// its card shows it again. A click with the wheel replaces the other pane: the pair changes.
let pairs: ConversationPair[] = [];
let shownPair: ConversationPair | null = null;
type PairCard = { pair: ConversationPair; members: (ConversationSummary | undefined)[] };
const samePair = (x: ConversationPair, a: string, b: string) => (x.left === a && x.right === b) || (x.left === b && x.right === a);
const pairOf = (id: string) => pairs.find((x) => x.left === id || x.right === id);
const savePairs = () => { window.api.setPairs(pairs, shownPair?.left ?? null).catch(() => {}); };

/** The pair shown follows the panes: one replaced, it changes; another pair that had one of them comes apart. */
function syncPair() {
  if (!split) return;
  const left = sessionOf(leftPane);
  const right = sessionOf(otherPane(leftPane));
  if (!left || !right) return;
  const before = JSON.stringify([pairs, shownPair?.left]);
  shownPair ??= pairs.find((x) => samePair(x, left, right)) ?? null;
  if (!shownPair) pairs.push(shownPair = { left, right, at: splitAt });
  Object.assign(shownPair, { left, right, at: splitAt });
  pairs = pairs.filter((x) => x === shownPair || ![x.left, x.right].some((id) => id === left || id === right));
  if (JSON.stringify([pairs, shownPair.left]) !== before) savePairs();
}

/** One pane again, the pair shown kept for its card (the pane worked in stays). */
const putPairAside = () => closePane(otherPane(focused), { keepPair: true });

/** A pair in the split view (the one shown before put aside), the pane of `focusOn` worked in. */
async function showPair(pr: ConversationPair, focusOn?: string) {
  await putPairAside();
  if ((await openConversation(pr.left)) === false) return;
  splitAt = pr.at;
  await openAside(pr.right, 'right');
  if (focusOn === pr.left) focusPane(leftPane);
}

/** A conversation from its card (or a notification): with its pair if it has one; else alone, the pair shown put aside. */
async function goTo(id: string) {
  const pr = pairOf(id);
  if (pr && pr !== shownPair) return showPair(pr, id);
  if (split && !shownPanes().some((p) => sessionOf(p) === id)) await putPairAside();
  return openConversation(id);
}

function pairItem({ pair: pr, members }: PairCard, cat: string) {
  const shown = pr === shownPair;
  const li = document.createElement('li');
  li.className = `conv-card pair${shown ? ' active' : ''} ${cat}`;
  li.dataset.place = shown ? 'pair' : `pair ${pr.left}`;
  const sides: [Side, ConversationSummary | undefined, string][] = [['left', members[0], pr.left], ['right', members[1], pr.right]];
  for (const [side, c, id] of sides) {
    const row = li.appendChild(div(`card-top pair-row${c ? ` ${category(c)}` : ''}${shown && paneAt(side) === focused ? ' focused' : ''}`, `<span class="pair-side ${side}"></span><span class="title"></span><span class="state"></span><span class="pill"></span>`));
    const title = row.querySelector<HTMLElement>('.title')!;
    title.textContent = c?.title ?? 'Nouvelle conversation';
    title.title = title.textContent;
    if (c) {
      title.dataset.conv = c.id;
      fillPill(row.querySelector<HTMLElement>('.pill')!, c);
    } else row.querySelector<HTMLElement>('.pill')!.remove();
    row.onclick = () => (shown ? focusPane(paneAt(side)) : showPair(pr, id));
  }
  const meta = li.appendChild(div('card-meta', '<span class="project"></span><span class="when"></span>'));
  const projects = [...new Set(members.flatMap((c) => (c ? [projectOf(c)] : [])))];
  meta.querySelector<HTMLElement>('.project')!.innerHTML = projects.map((k) => `${projectGlyph(k)} ${esc(projectLabel(k || ''))}`).join(' · ');
  const latest = Math.max(...members.map((c) => c?.updatedAt ?? 0));
  meta.querySelector<HTMLElement>('.when')!.textContent = latest ? relativeTime(latest) : '';
  li.dataset.tip = shown ? 'Côte à côte : fermez l’une des deux pour les séparer' : 'Côte à côte : un clic les affiche ensemble';
  li.dataset.tipSide = '';
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeProjectMenu();
    const name = (c?: ConversationSummary) => `« ${c?.title ?? 'Nouvelle conversation'} »`;
    const read: MenuItem = { glyph: 'markRead', label: 'Marquer comme lues', disabled: !members.some((c) => c && (c.unread || c.finished)), run: () => window.api.markConversationsRead(members.flatMap((c) => (c ? [c.id] : []))) };
    showContextMenu(e.clientX, e.clientY, 'Côte à côte', shown ? [
      read,
      '-',
      { glyph: 'close', label: `Fermer ${name(members[0])}`, run: () => closePane(paneAt('left')) },
      { glyph: 'close', label: `Fermer ${name(members[1])}`, run: () => closePane(paneAt('right')) },
    ] : [
      { glyph: 'left', label: 'Afficher côte à côte', run: () => showPair(pr) },
      read,
      '-',
      { glyph: 'close', label: 'Séparer', run: () => { pairs = pairs.filter((x) => x !== pr); savePairs(); refreshConversations(); } },
    ]);
  });
  return li;
}

// A card dragged over the chat: the side it would open on (one pane: a half of it; two: the pane under it, replaced).
function dropSide(e: DragEvent): Side {
  const box = (split ? splitDivider : chats).getBoundingClientRect();
  return e.clientX < box.left + box.width / 2 ? 'left' : 'right';
}
function showDropZone(side: Side | null) {
  const zone = $('dropZone');
  zone.classList.toggle('shown', Boolean(side));
  if (!side) return;
  const box = chats.getBoundingClientRect();
  const whole = draggedFile && !split; // (one pane: the file opens beside it)
  const r = split ? paneAt(side).root.getBoundingClientRect() : whole ? box : { left: box.left + (side === 'left' ? 0 : box.width / 2), width: box.width / 2 };
  zone.style.left = `${r.left - box.left}px`;
  zone.style.width = `${r.width}px`;
  const title = split ? lastConversations.find((c) => c.id === sessionOf(paneAt(side)))?.title : null;
  zone.querySelector<HTMLElement>('span')!.textContent = draggedFile ? (split ? `Ouvrir le fichier sur « ${title ?? 'Nouvelle conversation'} »` : 'Ouvrir le fichier')
    : split ? `Remplacer « ${title ?? 'Nouvelle conversation'} »` : side === 'left' ? 'Ouvrir à gauche' : 'Ouvrir à droite';
}
chats.addEventListener('dragover', (e) => {
  if (draggedFile) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    return showDropZone(dropSide(e));
  }
  if (!dragged || (!split && dragged === sessionOf(focused)) || (split && dragged === sessionOf(paneAt(dropSide(e))))) return showDropZone(null);
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  showDropZone(dropSide(e));
});
chats.addEventListener('dragleave', (e) => { if (!(e.relatedTarget instanceof Node && chats.contains(e.relatedTarget))) showDropZone(null); });
chats.addEventListener('drop', (e) => {
  e.preventDefault();
  showDropZone(null);
  const id = dragged;
  const file = draggedFile;
  dragged = draggedFile = null;
  if (id) openAside(id, dropSide(e));
  else if (file) openFile(file, { over: paneAt(dropSide(e)) });
});

// The side panels, in a split view: over one pane, the one not focused when they open, the
// one of the project of the file they show, or the one they were dragged over (by their head).
const SIDE_PANELS = ['viewer', 'agentPanel', 'diffPanel', 'livePanel'].map((id) => $(id));
const layout = document.querySelector<HTMLElement>('.layout')!;
function placePanels() {
  if (!split) return;
  const box = layout.getBoundingClientRect();
  const r = paneAt(panelSide).root.getBoundingClientRect();
  layout.style.setProperty('--panel-left', `${r.left - box.left}px`);
  layout.style.setProperty('--panel-width', `${r.width}px`);
}
let panelsOpen = false;
const watchPanels = new MutationObserver(() => {
  const open = SIDE_PANELS.some((el) => !el.classList.contains('hidden'));
  if (open && !panelsOpen && split && (panelTarget || !panelPlaced)) {
    panelSide = sideOf(panelTarget ?? otherPane(focused));
    for (const el of SIDE_PANELS) el.classList.add('placing'); // (where it opens: no slide from elsewhere)
    placePanels();
    requestAnimationFrame(() => { for (const el of SIDE_PANELS) el.classList.remove('placing'); });
  }
  panelsOpen = open;
  panelTarget = null;
});
/** A side panel opening (or open) over this pane. */
function panelOver(p: Pane) {
  if (!split) return;
  if (!panelsOpen) {
    panelTarget = p;
    return;
  }
  panelPlaced = true;
  if (sideOf(p) === panelSide) return;
  panelSide = sideOf(p);
  placePanels();
}
/** The pane whose project the Files and Git sections show: the other one if both are there (the focused one stays free), none if neither. */
function paneOfFolder() {
  if (!split) return null;
  const dir = viewDir();
  const other = otherPane(focused);
  if (inPane(other, activeDir) === dir) return other;
  return inPane(focused, activeDir) === dir ? focused : null;
}
/** The pane a file's panel goes over: not the conversation of its project (the file is seen beside it); with both there, the one not worked in. */
function paneForFile() {
  const owner = paneOfFolder();
  if (!owner || inPane(otherPane(owner), activeDir) === viewDir()) return otherPane(focused);
  return otherPane(owner);
}
for (const el of SIDE_PANELS) {
  watchPanels.observe(el, { attributes: true, attributeFilter: ['class'] });
  el.querySelector<HTMLElement>('.viewer-head')!.addEventListener('pointerdown', (down) => {
    if (!split || down.button || (down.target as HTMLElement).closest('button, input, select, a')) return;
    const from = parseFloat(layout.style.getPropertyValue('--panel-left')) || 0;
    let moving = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - down.clientX;
      if (!moving && Math.abs(dx) < 5) return;
      if (!moving) window.getSelection()?.removeAllRanges(); // (the press began one)
      moving = true;
      el.classList.add('dragging');
      document.body.classList.add('panel-dragging');
      el.style.left = `${from + dx}px`;
    };
    const up = (e: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!moving) return;
      document.body.classList.remove('panel-dragging');
      const r = splitDivider.getBoundingClientRect();
      panelSide = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
      panelPlaced = true;
      placePanels();
      void el.offsetWidth;
      el.classList.remove('dragging');
      el.style.left = ''; // (it slides from where it was let go)
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
for (const el of [...panes.map((p) => p.root), topbar]) new ResizeObserver(() => { placePanels(); placeHeads(); }).observe(el);

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
      node.addEventListener('auxclick', (ev) => { if (ev.button === 1) openFile(e.path, { tab: true }); });
      node.ondblclick = () => startFileRename(node.querySelector<HTMLElement>('.name')!, e.path, null);
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation(); // (not the sidebar's menu)
        showContextMenu(ev.clientX, ev.clientY, esc(e.name), [
          { glyph: 'open', label: 'Ouvrir', run: () => openFile(e.path) },
          { glyph: 'openWith', label: 'Ouvrir avec…', run: () => openWithMenu(e.path, null, ev.clientX, ev.clientY) },
          '-',
          { glyph: 'rename', label: 'Renommer…', run: () => startFileRename(node.querySelector<HTMLElement>('.name')!, e.path, null) },
          { glyph: 'reveal', label: `Afficher dans ${FILE_MANAGER}`, run: () => window.api.revealFile(e.path) },
          '-',
          { glyph: 'trash', label: 'Mettre à la corbeille', danger: true, run: () => trashFile(e.path) },
        ]);
      });
      // (dropped on a pane of the conversations: the file opens over it)
      node.draggable = true;
      node.addEventListener('dragstart', (ev) => {
        draggedFile = e.path;
        ev.dataTransfer?.setData('text/plain', e.path);
      });
      node.addEventListener('dragend', () => { draggedFile = null; showDropZone(null); });
    }
    ul.appendChild(li);
  }
  if (!entries.length && rel === '.') ul.innerHTML = '<li class="node muted">Dossier vide</li>';
}

let treeRefresh: ReturnType<typeof setTimeout> | undefined;
let treeStates: FileStates = {}; // the git state of each path, for its color
async function refreshTree() {
  if (document.querySelector('#fileTree .rename-file')) return; // (a name being typed: drawn again after)
  listedDir = viewDir();
  renderFilesHead();
  refreshGit();
  if (!viewDir()) {
    $('fileTree').innerHTML = '';
    return;
  }
  treeStates = viewOff() ? {} : await window.api.gitFileStates().catch(() => ({}));
  for (const t of viewerTabs) if (t.dir === listedDir) t.state = treeStates[t.path];
  renderTabs();
  await renderDir('.', $('fileTree'));
}
$<HTMLButtonElement>('refreshFiles').onclick = () => filesSection === 'git' ? refreshGit({ force: true }) : refreshTree();

// ---------- the sections of the second card: the files and Git ----------
function renderFilesHead() {
  const git = filesSection === 'git';
  const root = $('filesRoot');
  const line = root.querySelector<HTMLElement>('.files-root-line')!;
  root.classList.toggle('branch', git);
  $('revealRoot').classList.toggle('hidden', git || viewOff() || !viewDir());
  // (on Git, the branch is a picker beside the section's: switch to another, or start a new one)
  const picker = $<HTMLButtonElement>('branchPicker');
  picker.classList.toggle('hidden', !(git && gitState?.repo));
  if (git && gitState?.repo) {
    picker.innerHTML = `${BRANCH_ICON}<span class="branch-name"></span>${CHEVRON}`;
    picker.querySelector<HTMLElement>('.branch-name')!.textContent = gitState.branch || 'Tête détachée';
    picker.dataset.tip = `${gitState.branch || 'Tête détachée'} : changer de branche, ou en créer une`;
  } else closeBranchMenu();
  line.textContent = git || viewOff() ? '' : `\u200e${shortPath(viewDir())}`; // (the mark keeps ~ first: the line is right to left, to cut from the left)
  line.title = git ? '' : viewDir();
}
$<HTMLButtonElement>('branchPicker').onclick = (e) => { e.stopPropagation(); toggleBranchMenu(); };

// The branches: those here, then those only on the remote (switching to one brings it here),
// and a new one, made from where the project stands.
function closeBranchMenu() {
  $('branchMenu').classList.add('hidden');
  $('branchPicker').classList.remove('open');
}
async function toggleBranchMenu() {
  const menu = $('branchMenu');
  if (!menu.classList.contains('hidden')) return closeBranchMenu();
  menu.replaceChildren(div('pm-row muted', 'Chargement…'));
  menu.classList.remove('hidden');
  $('branchPicker').classList.add('open');
  const branches = await window.api.gitBranches().catch(() => null);
  if (menu.classList.contains('hidden')) return;
  if (!branches) return menu.replaceChildren(div('pm-row muted', 'Branches illisibles.'));
  const rows: HTMLElement[] = [];
  const row = (name: string, remote: boolean) => {
    const r = div(`pm-row${name === branches.current ? ' selected' : ''}`);
    r.innerHTML = '<span class="pm-name"></span>';
    r.querySelector<HTMLElement>('.pm-name')!.textContent = name;
    r.dataset.tip = remote ? `${name} : sur le dépôt distant, elle sera récupérée ici` : name;
    r.onclick = () => name === branches.current ? closeBranchMenu() : changeBranch(() => window.api.gitSwitch(name));
    return r;
  };
  rows.push(...branches.local.map((name) => row(name, false)));
  if (branches.remote.length) rows.push(div('pm-head', 'Sur le dépôt distant'), ...branches.remote.map((name) => row(name, true)));
  const add = div('pm-row branch-new', '<span class="pm-icon">＋</span><span class="pm-name">Nouvelle branche…</span>');
  add.onclick = () => {
    const form = document.createElement('form');
    form.className = 'branch-form';
    form.innerHTML = '<input class="rename" maxlength="200" placeholder="nom-de-la-branche" spellcheck="false" autocomplete="off">';
    const input = form.querySelector('input')!;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (input.value.trim()) changeBranch(() => window.api.gitCreateBranch(input.value.trim()));
    };
    add.replaceWith(form);
    input.focus();
  };
  rows.push(add);
  menu.replaceChildren(...rows);
}
async function changeBranch(change: () => Promise<void>) {
  const menu = $('branchMenu');
  menu.querySelector('.branch-error')?.remove();
  try {
    await change();
  } catch (e) {
    menu.appendChild(div('pm-row branch-error', '')).textContent = errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return;
  }
  closeBranchMenu();
  refreshTree(); // (the files are those of the branch now; this refreshes Git too)
}
$('branchMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeBranchMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBranchMenu(); });

// The project's folder, opened in the system's file manager.
const FILE_MANAGER = window.api.platform === 'darwin' ? 'le Finder' : window.api.platform === 'win32' ? 'l’Explorateur de fichiers' : 'le gestionnaire de fichiers';
const FILE_MANAGER_NAME = window.api.platform === 'darwin' ? 'Finder' : window.api.platform === 'win32' ? 'Explorateur' : 'Dossier';
const FILE_MANAGER_ICON = window.api.platform === 'darwin'
  ? '<svg class="fm-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3.2" fill="#9ed2ff"/><path d="M4.2 1h4.6C8 4 7.4 6.6 7.3 9h1.2c0 2 .2 4 .5 6H4.2A3.2 3.2 0 0 1 1 11.8V4.2A3.2 3.2 0 0 1 4.2 1z" fill="#1f7ae8"/><path d="M5 4.8v1.7M11 4.8v1.7" stroke="#0b2a55" stroke-width="1.1" stroke-linecap="round"/><path d="M4 10.4c2.4 1.6 5.6 1.6 8 0" fill="none" stroke="#0b2a55" stroke-width="1" stroke-linecap="round"/></svg>'
  : window.api.platform === 'win32'
    ? '<svg class="fm-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.6 0-1.2-.5-1.2-1.2z" fill="#f4c542"/><path d="M1.5 6.4h13v1.5h-13z" fill="#3c8ce7"/></svg>'
    : '<svg class="fm-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.4l1.4 1.5h5.8c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.6 0-1.2-.5-1.2-1.2z"/></svg>';
$('revealRoot').innerHTML = FILE_MANAGER_ICON;
$('revealRoot').dataset.tip = `Ouvrir le dossier dans ${FILE_MANAGER}`;
$<HTMLButtonElement>('revealRoot').onclick = () => window.api.openFileExternal('.');
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
// ---------- a project from a remote repository: cloned into a folder named after it ----------
const CLONE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.8 5a2.8 2.8 0 0 1 .2 6.5"/><path d="M8 7.5v6M5.8 11.3 8 13.5l2.2-2.2"/></svg>';
const cloneDialog = $<HTMLDialogElement>('cloneDialog');
closeOnOutside(cloneDialog, () => Boolean($<HTMLInputElement>('cloneUrl').value));
const cloneTarget = () => {
  const place = $<HTMLInputElement>('clonePlace').value.trim().replace(/[\\/]+$/, '');
  const name = repoName($<HTMLInputElement>('cloneUrl').value);
  return place && name ? `${place}/${name}` : '';
};
const showCloneTarget = () => {
  const target = cloneTarget();
  $('cloneTargetLine').classList.toggle('hidden', !$<HTMLInputElement>('cloneUrl').value.trim()); // (once there is an address)
  $('cloneTarget').textContent = target || (repoName($<HTMLInputElement>('cloneUrl').value) ? 'l’emplacement manque' : 'cette adresse ne donne pas de nom de dossier');
  $('cloneTarget').classList.toggle('muted', !target);
};
async function openCloneDialog() {
  $<HTMLInputElement>('cloneUrl').value = '';
  $<HTMLInputElement>('clonePlace').value = await window.api.desktopPath().catch(() => '');
  $('cloneError').textContent = '';
  $<HTMLButtonElement>('cloneSubmit').disabled = false;
  showCloneTarget();
  cloneDialog.showModal();
  $('cloneUrl').focus();
}
for (const id of ['cloneUrl', 'clonePlace']) $(id).addEventListener('input', showCloneTarget);
$<HTMLButtonElement>('cloneChoose').onclick = async () => {
  const dir = await window.api.chooseFolder($<HTMLInputElement>('clonePlace').value.trim() || null);
  if (dir) $<HTMLInputElement>('clonePlace').value = dir;
  showCloneTarget();
};
for (const id of ['cloneCancel', 'cloneClose']) $(id).onclick = () => cloneDialog.close();
$<HTMLFormElement>('cloneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cloneTarget()) { $('cloneError').textContent = 'Indiquez l’adresse du dépôt et son emplacement.'; return; }
  $<HTMLButtonElement>('cloneSubmit').disabled = true;
  $<HTMLButtonElement>('cloneSubmit').textContent = 'Clonage…';
  $('cloneError').textContent = '';
  try {
    const dir = await window.api.gitClone($<HTMLInputElement>('cloneUrl').value, $<HTMLInputElement>('clonePlace').value.trim());
    cloneDialog.close();
    await newConversationIn(dir);
  } catch (err) {
    $('cloneError').textContent = errorText(err);
  } finally {
    $<HTMLButtonElement>('cloneSubmit').disabled = false;
    $<HTMLButtonElement>('cloneSubmit').textContent = 'Cloner';
  }
});

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
  const gh = await window.api.remotesStatus().catch(() => null);
  const tokenSaved = Boolean(gh?.tokens.some((t) => isGithub(t.url)));
  $('remoteTokenRow').classList.toggle('hidden', Boolean(gh?.gh || tokenSaved));
  $('remoteNote').textContent = gh?.gh
    ? 'Le dépôt est créé avec le compte connecté à gh, puis la branche y est envoyée.'
    : tokenSaved
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

// The page of the settings for remote repositories: gh's login, and the tokens by address.
function showRemotes(st: RemotesStatus) {
  $('remotesGh').textContent = st.gh ? `gh : connecté${st.gh === '?' ? '' : ` en tant que ${st.gh}`} (utilisé en premier pour GitHub).`
    : st.ghInstalled ? 'gh : installé, mais pas connecté. Lancez « gh auth login » dans un terminal.' : 'gh : pas installé.';
  const rows = st.tokens.map((t) => {
    const row = div('token-row');
    row.innerHTML = '<span class="token-url"></span><span class="token-who muted"></span><button type="button" class="ghost">Retirer</button>';
    row.querySelector<HTMLElement>('.token-url')!.textContent = t.url.replace(/^https:\/\//, '');
    row.querySelector<HTMLElement>('.token-who')!.textContent = t.account ? `compte ${t.account}` : isGithub(t.url) ? 'compte non vérifié' : t.user;
    row.querySelector('button')!.onclick = () => {
      if (confirm(`Retirer le jeton de ${t.url} ? Il reste valide sur le service tant que vous ne l’y révoquez pas.`)) changeRemotes(() => window.api.removeRemoteToken(t.id));
    };
    return row;
  });
  $('remoteTokens').replaceChildren(...(rows.length ? rows : [div('token-row muted', 'Aucun jeton : Git utilise votre connexion habituelle.')]));
  $<HTMLButtonElement>('tokenAdd').disabled = !st.canSave;
}
async function changeRemotes(change: () => Promise<RemotesStatus>) {
  $('remotesError').textContent = '';
  try {
    showRemotes(await change());
    return true;
  } catch (e) {
    $('remotesError').textContent = errorText(e);
    return false;
  }
}
async function addToken() {
  const field = (id: string) => $<HTMLInputElement>(id).value;
  if (await changeRemotes(() => window.api.addRemoteToken({ url: field('tokenUrl'), token: field('tokenValue'), user: field('tokenUser') }))) {
    for (const id of ['tokenValue', 'tokenUser']) $<HTMLInputElement>(id).value = '';
  }
}
$<HTMLButtonElement>('tokenAdd').onclick = addToken;
const showTokenKind = () => {
  const github = /^(https?:\/\/)?github\.com(\/|$)/i.test($<HTMLInputElement>('tokenUrl').value.trim());
  $('githubCreateToken').classList.toggle('hidden', !github);
  $<HTMLInputElement>('tokenValue').placeholder = github ? 'github_pat_…' : 'le jeton d’accès';
};
$('tokenUrl').addEventListener('input', showTokenKind);
for (const id of ['githubCreateToken', 'remoteCreateToken']) $(id).onclick = () => window.api.githubOpenTokenPage();
for (const id of ['tokenUrl', 'tokenValue', 'tokenUser']) $<HTMLInputElement>(id).addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // (not the settings' form)
  addToken();
});
settingsDialog.addEventListener('close', () => { $<HTMLInputElement>('tokenValue').value = ''; });

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
    panelOver(paneForFile());
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

// The selection in the viewer, kept when the focus goes to the input box (where the page's
// selection moves): sent with the next message, with its lines in the code view.
let viewerSelection: { text: string; start?: number; end?: number } | null = null;
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  const body = $('viewerBody');
  if (!body.contains(range.commonAncestorContainer)) return; // (elsewhere: the viewer's is kept)
  const text = sel.toString();
  if (!text.trim()) { viewerSelection = null; return; }
  const lines = selectedLines(range, text);
  viewerSelection = lines ? { text, ...lines } : { text };
});
/** The lines of the file a selection of its code covers (none in a formatted view). */
function selectedLines(range: Range, text: string) {
  const code = $('viewerBody').querySelector('code');
  if (!code?.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.setStart(code, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().split('\n').length;
  return { start, end: start + text.replace(/\n$/, '').split('\n').length - 1 };
}
/** A passage of the file in the viewer, quoted in the input of the conversation it is beside: its path and lines first. */
function quoteViewer(range: Range) {
  const path = openPath;
  if (!path) return;
  const lines = selectedLines(range, range.toString());
  const where = `\`${path}${lines ? `:${lines.start}${lines.end > lines.start ? `-${lines.end}` : ''}` : ''}\``;
  const p = viewerPane ?? focused;
  focusPane(p);
  inPane(p, () => quote(range, where));
}
const viewerBodyEl = $('viewerBody');
viewerBodyEl.addEventListener('mouseup', () => setTimeout(() => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideQuoteBtn();
  const range = sel.getRangeAt(0);
  if (!viewerBodyEl.contains(range.commonAncestorContainer) || !sel.toString().trim()) return hideQuoteBtn();
  showQuoteBtn(range, true);
}, 0));
viewerBodyEl.addEventListener('scroll', hideQuoteBtn);

/** The file open in the viewer, for the agent: the lines on screen, or the selection. */
function viewing(): Viewing | null {
  if (!openPath || $('viewer').classList.contains('hidden')) return null;
  const body = $('viewerBody');
  const code = body.querySelector<HTMLElement>('code');
  let visible: [number, number] | undefined;
  if (code) {
    const total = (code.textContent ?? '').replace(/\n$/, '').split('\n').length;
    const lh = parseFloat(getComputedStyle(code).lineHeight) || 20;
    const top = Math.max(0, body.scrollTop - code.offsetTop);
    const first = Math.min(total, Math.floor(top / lh) + 1);
    visible = [first, Math.min(total, first + Math.max(0, Math.floor(body.clientHeight / lh) - 1))];
  }
  return { path: openPath, ...(visible ? { visible } : {}), ...(viewerSelection ? { selection: viewerSelection } : {}) };
}

// ---------- the viewer's tabs: a middle click opens a file beside the one shown ----------
/** The files open in the viewer (a bar shows from two), each read through its pane. */
let viewerTabs: { path: string; pane: Pane | null; scroll: number; dir: string | null; state?: string }[] = [];

function renderTabs() {
  const bar = $('viewerTabs');
  if (bar.querySelector('.rename-file')) return; // (a name being typed: drawn again after)
  bar.classList.toggle('hidden', viewerTabs.length < 2);
  bar.innerHTML = '';
  for (const t of viewerTabs) {
    const tab = document.createElement('div');
    tab.className = 'viewer-tab' + (t.path === openPath ? ' active' : '') + (t.state ? ` gs-${t.state}` : ''); // (its Git state, as in the tree)
    tab.title = t.path;
    const name = t.path.split('/').pop() ?? t.path;
    tab.innerHTML = `${fileIconSvg(name)}<span class="name">${esc(name)}</span><button class="ghost icon" title="Fermer">✕</button>`;
    tab.onclick = () => { if (t.path !== openPath) openFile(t.path); };
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.path); });
    tab.querySelector('button')!.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };
    tab.ondblclick = () => startFileRename(tab.querySelector<HTMLElement>('.name')!, t.path, t.pane);
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, esc(name), [
        { glyph: 'rename', label: 'Renommer…', run: () => startFileRename(tab.querySelector<HTMLElement>('.name')!, t.path, t.pane) },
        { glyph: 'close', label: 'Fermer l’onglet', run: () => closeTab(t.path) },
        '-',
        { glyph: 'reveal', label: `Afficher dans ${FILE_MANAGER}`, run: () => inFilePane(t.pane, () => window.api.revealFile(t.path)) },
        { glyph: 'openWith', label: 'Ouvrir avec…', run: () => openWithMenu(t.path, t.pane, e.clientX, e.clientY) },
      ]);
    });
    bar.appendChild(tab);
  }
  bar.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(path: string) {
  const at = viewerTabs.findIndex((t) => t.path === path);
  if (at < 0) return;
  viewerTabs.splice(at, 1);
  if (!viewerTabs.length) return closeViewer();
  if (path === openPath) openFile(viewerTabs[Math.min(at, viewerTabs.length - 1)].path);
  else renderTabs();
}

/** The tabs read through a pane are closed (its conversation is no longer shown there). */
function closeTabsOf(p: Pane) {
  const kept = viewerTabs.filter((t) => t.pane !== p);
  if (kept.length === viewerTabs.length) return;
  if (!kept.length) return closeViewer();
  const shown = kept.some((t) => t.path === openPath);
  viewerTabs = kept;
  if (shown) renderTabs();
  else openFile(kept[0].path);
}

function closeViewer() {
  closeDiffPanel();
  viewerSelection = null;
  openPath = null;
  viewerTabs = [];
  renderTabs();
  $('viewer').classList.add('hidden');
  document.querySelectorAll<HTMLElement>('.tree .node.active').forEach((n) => n.classList.remove('active'));
}

/** Opens a file in the viewer: in place of the one shown, or in a tab of its own beside it. */
async function openFile(rel: string, { keepScroll = false, over, tab = false }: { keepScroll?: boolean; over?: Pane; tab?: boolean } = {}) {
  const body = $('viewerBody');
  const shown = $('viewer').classList.contains('hidden') ? null : openPath;
  const current = viewerTabs.find((t) => t.path === shown);
  if (current && rel !== shown) current.scroll = body.scrollTop;
  const existing = shown ? viewerTabs.find((t) => t.path === rel) : undefined;
  const scroll = keepScroll && rel === shown ? body.scrollTop : rel === shown ? 0 : existing?.scroll ?? 0;
  if (existing && !over) viewerPane = existing.pane; // (a tab of the other project stays read there)
  else if (rel !== shown || over) {
    viewerPane = paneOfFolder() ?? focused;
    panelOver(over ?? paneForFile());
  }
  let read: Viewed;
  try {
    read = await inPane(viewerPane ?? focused, () => window.api.readFile(rel));
  } catch (e) {
    if (keepScroll) return; // file deleted meanwhile: leave the viewer as is
    read = { path: rel, kind: 'error', message: errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  const f = read;
  if (f.path !== openPath) viewerSelection = null;
  openPath = f.path;
  const dir = inPane(viewerPane ?? focused, activeDir);
  const entry = { path: f.path, pane: viewerPane, scroll, dir, state: dir === listedDir ? treeStates[f.path] : undefined };
  const at = viewerTabs.findIndex((t) => t.path === f.path);
  const from = viewerTabs.findIndex((t) => t.path === shown);
  if (at >= 0) viewerTabs[at].pane = viewerPane;
  else if (from < 0) viewerTabs = [entry];
  else if (tab) viewerTabs.splice(from + 1, 0, entry);
  else viewerTabs[from] = entry; // (a click replaces the file shown)
  renderTabs();
  if (panelAgent) closeAgentPanel(); // (one side panel at a time)
  if (liveBubble) closeLivePanel();
  closeDiffPanel();
  $('viewer').classList.remove('hidden');
  $('viewerPath').textContent = `\u200e${f.path}`; // (the mark keeps a leading dot first in the right-to-left line)
  $('viewerPath').title = f.path;
  if (f.path !== shown) showOpeners(f.path);
  document.querySelectorAll<HTMLElement>('.tree .node').forEach((n) => n.classList.toggle('active', n.dataset.path === f.path));

  const markdownFile = f.kind === 'text' && /\.(md|markdown|mdx)$/i.test(f.path);
  const proseFile = f.kind === 'text' && /\.txt$/i.test(f.path);
  $<HTMLButtonElement>('viewerMode').classList.toggle('hidden', !markdownFile && !proseFile);
  if ((markdownFile || proseFile) && f.kind === 'text' && mdView === 'preview') {
    $<HTMLButtonElement>('viewerMode').textContent = 'Code';
    $('viewerInfo').textContent = `${f.content.split('\n').length} lignes · ${formatSize(f.size)}${f.truncated ? ' · tronqué' : ''}`;
    if (markdownFile) showDocument(body, f);
    else showProse(body, f.content);
  } else if (f.kind === 'text') {
    if (markdownFile || proseFile) $<HTMLButtonElement>('viewerMode').textContent = 'Aperçu';
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

/** A text file as a page: its paragraphs wrapped, its web addresses as links. */
function showProse(body: HTMLElement, text: string) {
  const doc = document.createElement('article');
  doc.className = 'md-doc prose-doc';
  const linked = (s: string) => esc(s).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (url) => `<a href="${url}">${url}</a>`);
  doc.innerHTML = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).filter((p) => p.trim())
    .map((p) => `<p>${p.replace(/^\n+|\n+$/g, '').split('\n').map(linked).join('<br>')}</p>`).join('');
  doc.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!a) return;
    e.preventDefault();
    window.open(a.getAttribute('href') ?? '');
  });
  body.replaceChildren(doc);
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
$<HTMLButtonElement>('viewerOpen').onclick = () => openPath && inPane(viewerPane ?? focused, () => window.api.openFileExternal(openPath!));

// ---------- the applications that open the file shown: the default one's icon on "Ouvrir", the others in a menu ----------
const openers = new Map<string, Promise<OpeningApps>>(); // (by extension: they rarely change)
/** The applications that open a file (through the pane its project is read in, or the one worked in). */
function appsFor(rel: string, p: Pane | null) {
  const name = rel.split('/').pop() ?? rel;
  const key = name.includes('.') ? name.split('.').pop()!.toLowerCase() : rel;
  let apps = openers.get(key);
  if (!apps) openers.set(key, apps = inFilePane(p, () => window.api.appsToOpen(rel)).catch(() => ({ default: null, others: [] })));
  return apps;
}
/** A call through a pane, or through the one worked in. */
function inFilePane<T>(p: Pane | null, fn: () => T): T {
  return p ? inPane(p, fn) : fn();
}
/** The menu of the applications that open a file, at (x, y). */
async function openWithMenu(rel: string, p: Pane | null, x: number, y: number) {
  const apps = await appsFor(rel, p);
  const open = (app: string | null) => inFilePane(p, () => window.api.openFileWith(rel, app)).catch((err: unknown) => { $('status').textContent = errorText(err); });
  const items: (MenuItem | '-')[] = [];
  if (apps.default) items.push({ label: `${apps.default.name} (par défaut)`, icon: apps.default.icon, strong: true, run: () => open(apps.default!.path) });
  if (apps.others.length) items.push('-', ...apps.others.map((a) => ({ label: a.name, icon: a.icon, run: () => open(a.path) })));
  if (items.length) items.push('-');
  items.push({ glyph: 'openWith', label: 'Autre application…', run: () => open(null) });
  showContextMenu(x, y, 'Ouvrir avec', items);
}
async function showOpeners(rel: string) {
  const found = await appsFor(rel, viewerPane ?? focused);
  if (rel !== openPath) return; // (another file since)
  const btn = $<HTMLButtonElement>('viewerOpen');
  btn.innerHTML = found.default?.icon ? `<img class="app-icon" src="${esc(found.default.icon)}" alt="">Ouvrir` : 'Ouvrir';
  btn.title = found.default ? `Ouvrir avec ${found.default.name}` : 'Ouvrir avec l’application par défaut';
  $('viewerOpenWith').classList.toggle('hidden', window.api.platform !== 'darwin');
}
$<HTMLButtonElement>('viewerOpenWith').innerHTML = CHEVRON;
$<HTMLButtonElement>('viewerOpenWith').onclick = (e) => {
  e.stopPropagation();
  if (!openPath) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openWithMenu(openPath, viewerPane ?? focused, r.right - 220, r.bottom + 4);
};

// ---------- renaming and deleting a file (the tree, the tabs) ----------
const BUSY = 'Un agent travaille dans ce projet en ce moment';
/** Its name becomes a field: Enter or leaving it renames, Escape gives up. */
function startFileRename(nameEl: HTMLElement, rel: string, p: Pane | null) {
  const old = rel.split('/').pop() ?? rel;
  const field = document.createElement('input');
  field.className = 'rename-file';
  field.value = old;
  field.spellcheck = false;
  nameEl.replaceWith(field);
  field.focus();
  const dot = old.lastIndexOf('.');
  field.setSelectionRange(0, dot > 0 ? dot : old.length); // (the name, not its extension)
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    field.replaceWith(nameEl);
    const name = field.value.trim();
    if (keep && name && name !== old) renameFile(rel, name, p);
    else { renderTabs(); refreshTree(); } // (what was not drawn meanwhile)
  };
  field.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  field.onblur = () => finish(true);
  for (const type of ['click', 'dblclick', 'mousedown', 'auxclick'] as const) field.addEventListener(type, (e) => e.stopPropagation());
  field.draggable = false;
}
async function renameFile(rel: string, name: string, p: Pane | null) {
  if (await inFilePane(p, () => window.api.projectBusy()).catch(() => false)
    && !confirm(`${BUSY} : renommer « ${rel.split('/').pop()} » peut gêner son travail. Renommer quand même ?`)) return renderTabs();
  let to: string;
  try {
    to = await inFilePane(p, () => window.api.renameFile(rel, name));
  } catch (e) {
    alert(errorText(e));
    return renderTabs();
  }
  for (const t of viewerTabs) if (t.path === rel) t.path = to;
  if (openPath === rel) {
    openPath = to;
    openFile(to, { keepScroll: true });
  }
  renderTabs();
  refreshTree();
}
async function trashFile(rel: string) {
  const busy = await window.api.projectBusy().catch(() => false);
  if (!confirm(`Mettre « ${rel.split('/').pop()} » à la corbeille ?${busy ? `\n\n${BUSY} : il pourrait en avoir besoin.` : ''}`)) return;
  try {
    await window.api.trashFile(rel);
  } catch (e) {
    alert(errorText(e));
    return;
  }
  closeTab(rel);
  refreshTree();
}
$('viewerReveal').innerHTML = `${FILE_MANAGER_ICON}${FILE_MANAGER_NAME}`;
$('viewerReveal').title = `Afficher dans ${FILE_MANAGER}`;
$<HTMLButtonElement>('viewerReveal').onclick = () => openPath && window.api.revealFile(openPath);

// ---------- system prompt ----------
let promptInfo: SystemPromptView | null = null;

const errorText = (e: unknown) => errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- conversation settings: its steps and its system prompt ----------
const convDialog = $<HTMLDialogElement>('convDialog');
const showConvPage = navDialog(convDialog);
let openedSteps: string | null = null;

async function refreshPromptBadge() {
  const head = headOf(focused);
  let steps = null;
  try {
    steps = await window.api.getSteps();
    promptInfo = await window.api.getSystemPrompt();
  } catch {
    promptInfo = null;
  }
  $('convBadge').classList.toggle('hidden', !steps && !promptInfo?.custom);
  head?.classList.toggle('modified', Boolean(steps || promptInfo?.custom));
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

$<HTMLButtonElement>('convSettingsBtn').onclick = openConvSettings;
/** The steps and system prompt of the conversation in focus. */
async function openConvSettings() {
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
}
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
  const claude = usesClaude();
  const usage = claude ? await window.api.claudeUsage().catch(() => null) : null;
  g.classList.toggle('hidden', !usage || !claude);
  if (!usage) return;
  const used = Math.round(usage.utilization);
  g.querySelector<HTMLElement>('.gauge-fill')!.style.width = `${Math.min(100, used)}%`;
  g.classList.toggle('warn', used >= 80);
  g.classList.toggle('full', used >= 100);
  g.querySelector<HTMLElement>('.gauge-text')!.textContent = `session ${used} %`;
  g.dataset.tip = `Session de votre abonnement : ${used} % utilisés${usage.resetsAt ? `. Remise à zéro le ${resetDate(usage.resetsAt)}` : ''}`;
}
setInterval(() => forPanes(refreshUsage), 5 * 60 * 1000);

async function refreshGauge() {
  refreshUsage();
  const g = $('ctxGauge'); // (of this pane, whichever is worked in when the figures come)
  try {
    renderGauge(await window.api.getContext(), g);
  } catch {
    renderGauge(null, g);
  }
}


// ---------- each pane's controls ----------
// Bound in each pane, worked in when they are used: a press or the focus in a pane makes it the focused one.
function bindPane(p: Pane) {
  p.root.addEventListener('pointerdown', () => focusPane(p), true);
  p.root.addEventListener('focusin', () => focusPane(p), true);
  $<HTMLSelectElement>('effortSelect').addEventListener('change', (e) => setChoice({ effort: (e.target as HTMLInputElement).value as Effort }));
  $<HTMLSelectElement>('modeSelect').addEventListener('change', (e) => setChoice({ mode: (e.target as HTMLInputElement).value }));

  $<HTMLButtonElement>('modelPicker').onclick = async (e) => {
    e.stopPropagation();
    if (!$('modelMenu').classList.contains('hidden')) return closeModelMenu();
    settings = await window.api.getSettings(); // (has it started since?)
    if (claude.accounts.some((a) => !a.loggedIn)) claude = await window.api.claudeStatus().catch(() => claude); // (logged in since?)
    openModelMenu();
    refreshModels(); // (a server started or stopped since)
  };
  $('modelMenu').onclick = (e) => e.stopPropagation();

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

  $<HTMLButtonElement>('memoryBtn').onclick = () => $('memoryPanel').classList.toggle('hidden');
  $<HTMLButtonElement>('memoryClose').onclick = () => $('memoryPanel').classList.add('hidden');
  $<HTMLFormElement>('memoryForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('memoryInput').value.trim();
    if (!v) return;
    $<HTMLInputElement>('memoryInput').value = '';
    saveMemory([...memoryNotes, v]);
  };

  input.addEventListener('input', noteDraft);

  sendBtn.onclick = submit;
  input.addEventListener('keydown', (e) => {
    if (skillKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', updateSkillMenu);
  input.addEventListener('blur', hideSkillMenu);
  skillMenu.addEventListener('mousedown', (e) => {
    e.preventDefault(); // (the input keeps the focus)
    const row = (e.target as HTMLElement).closest<HTMLElement>('.skill-row');
    if (row) acceptSkill(Number(row.dataset.i));
  });

  input.addEventListener('input', autosize);

  transcript.addEventListener('mouseup', () => setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideQuoteBtn();
    const range = sel.getRangeAt(0);
    if (!transcript.contains(range.commonAncestorContainer) || !sel.toString().trim()) return hideQuoteBtn();
    showQuoteBtn(range, false);
  }, 0));

  $<HTMLButtonElement>('ctxGauge').onclick = async () => {
    if (running || usesClaude()) return; // (the Claude harness compacts by itself)
    if (!confirm('Compacter maintenant ? Les anciens messages seront remplacés par un résumé (le fil affiché reste intact).')) return;
    const p = pane;
    setRunning(true);
    stopRunTimer();
    $('status').textContent = 'Compactage…';
    let message = '';
    try {
      const r = await window.api.compactContext();
      if (!r.compacted) message = r.reason || 'Rien à compacter.';
    } catch (e) {
      inPane(p, () => {
        transcript.querySelector<HTMLElement>('.compaction.pending')?.remove();
        add(div('error', esc(errorText(e))));
      });
    } finally {
      inPane(p, () => {
        setRunning(false);
        $('status').textContent = message;
        refreshGauge();
      });
    }
  };
}
for (const p of panes) inPane(p, () => bindPane(p));

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
const { partner } = await window.api.listConversations();
if (session.events.length || session.partial || partner) showSession(session);
else if (activeProject() !== defaultProject()) await newConversationHere(); // (the same page as a new conversation)
else {
  clearTranscript();
  setInput(session.draft || '');
}
// (and the other one of a split view, on the side it was)
pairs = settings.pairs ?? [];
const beside = partner ? await window.api.sessionView(partner).catch(() => null) : null;
if (beside) {
  const p = otherPane(focused);
  p.active = beside.settings.active;
  const pr = pairs.find((x) => samePair(x, session.session, beside.session));
  if (pr?.left === beside.session) leftPane = p;
  if (pr) splitAt = pr.at;
  setSplit(true);
  inPane(p, () => {
    showSession(beside);
    renderPaneSettings();
    refreshGauge();
  });
  refreshConversations();
} else if (partner) await window.api.unsplit(session.session);
else {
  // (the app restarted: the pair shown when it closed)
  const pr = pairs.find((x) => x.left === settings.pairShown);
  if (pr) await showPair(pr);
}
input.focus();
