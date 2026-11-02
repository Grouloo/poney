import { app, BrowserWindow, Menu, Notification, ipcMain, dialog, safeStorage, shell, nativeImage, nativeTheme } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, DEFAULT_CONFIG } from './agent/agent.ts';
import { loadSkills, skillDirs } from './agent/skills.ts';
import { ClaudeAgent, findClaude, claudeAuth, claudeEnv, machineClaudeDir, claudeLogin, claudeModels, claudeUsage, linkUserSettings } from './agent/claude.ts';
import { listModels, lmStudioModels, setInferenceService } from './agent/llm.ts';
import { ModelEngine } from './engine/engine.ts';
import { ENGINE_BUILD, engineSupported, installEngine, installedEngine } from './engine/install.ts';
import { scanModels, sameModelFile } from './engine/models.ts';
import type { LocalModel } from './types.ts';
import { addClaudeAccount, addServer, CLAUDE, claudeAccountOf, loadProviders, modelConfig, providerOf, removeProvider, savedConfig, unavailable, updateProvider } from './providers.ts';
import { ConversationStore, moveAppData } from './conversations.ts';
import { listDir, readFileForViewer } from './files.ts';
import { resolveInside } from './agent/tools.ts';
import { gitFileStates, gitBranches, gitSwitch, gitCreateBranch, createGithubRepo, findGh, GITHUB_TOKEN_PAGE, gitChangeRemote, githubAccount, gitStatus, gitConnect, gitDiff, gitFetch, gitRemote, gitRemoveRemote, gitSync, readyGh } from './git.ts';
import { migrateLegacy, rebuildHistory, rebuildForAction } from './agent/rebuild.ts';
import { checkTor, torStatus, newCircuits, findTorProxy, requireTor, proxyEnv } from './agent/tor.ts';
import { errorMessage, isBoolean, isNumber, isRecord, isString, isStringArray, list, parseJson, rec, str } from './unknown.ts';
import type { AppAlert, Args, Channel, ClaudeAccount, ClaudeUsage, Reply, SessionView } from './ipc.ts';
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, AskDraft, Choice, ConversationFile, ProjectIcon, Provider, PublicSettings, Settings } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// Apps launched from Finder get a minimal PATH; borrow the login shell's so
// that python, node (nvm), cargo... are found by the agent's commands.
function loadShellPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000, encoding: 'utf8' });
    const m = out.match(/__PATH__(.*)__PATH__/);
    if (m && m[1]) process.env.PATH = m[1];
  } catch {}
}
loadShellPath();
const dataOverride = process.env.PONEY_DATA || process.env.LOCAL_CODEX_DATA; // (old name)
if (dataOverride) app.setPath('userData', dataOverride);
else {
  // Fixed folder name: the displayed name ("Poney") may change case, the data must not move.
  app.setPath('userData', path.join(app.getPath('appData'), 'poney'));
  // The app was called Local Codex: move its data (settings, conversations, logs)
  // to the new folder once. (Electron creates that folder before this runs.)
  moveAppData(path.join(app.getPath('appData'), 'local-codex'), app.getPath('userData'));
}

// ---------- crash log ----------
// Errors and crashes go to <userData>/logs/main.log, so that the next one can be explained.
function logError(what: string, detail: unknown) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const text = detail instanceof Error ? detail.stack : typeof detail === 'string' ? detail : JSON.stringify(detail);
    fs.appendFileSync(path.join(dir, 'main.log'), `${new Date().toISOString()} ${what}: ${text}\n`);
  } catch {}
}

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings: Settings = { config: { ...DEFAULT_CONFIG }, workspace: '', recent: [], projectIcons: {}, modelContexts: {}, engine: { idleMinutes: 15, cacheGb: 10 }, projectNames: {}, hiddenProjects: [], projectOrder: [], providers: [] };

/** The settings file, written by this app. */
const isSettingsFile = (v: unknown): v is Partial<Settings> => isRecord(v);

function loadSettings() {
  try {
    const saved = parseJson(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...settings, ...(isSettingsFile(saved) ? saved : {}), config: { ...DEFAULT_CONFIG, ...savedConfig(saved) } };
    if (!settings.temperatureFromModel) {
      settings.temperatureFromModel = true;
      saveSettings();
    }
  } catch {}
}
const engineDir = () => path.join(app.getPath('userData'), 'engine');
const modelDirs = () => [path.join(app.getPath('userData'), 'models'), path.join(os.homedir(), '.lmstudio', 'models')];
let engine!: ModelEngine; // (from startEngine on)
let poneyModelList: LocalModel[] | null = null;
/** The GGUF files here. (Read again when the menu asks, not for each call.) */
const poneyModels = async ({ fresh = false } = {}) => {
  if (fresh || !poneyModelList) poneyModelList = await scanModels(modelDirs());
  return poneyModelList;
};
const engineOptions = () => ({
  limit: settings.config.maxInferences ?? 1,
  idleMs: settings.engine.idleMinutes * 60 * 1000,
  cacheBytes: settings.engine.cacheGb * 1024 ** 3,
});
/** A model server left behind by a crash of the app would hold its memory for nothing. */
function killLeftovers() {
  execFile('pgrep', ['-f', engineDir()], (error, stdout) => {
    if (error) return;
    for (const pid of stdout.split('\n').filter(Boolean)) if (Number(pid) !== process.pid) try { process.kill(Number(pid)); } catch {}
  });
}
/** A model added to (or removed from) a folder shows at once. (A copy gives many events: the end counts.) */
function watchModels() {
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => send('models:changed'), 800);
  };
  fs.mkdirSync(modelDirs()[0], { recursive: true });
  for (const dir of modelDirs()) {
    try {
      fs.watch(dir, { recursive: true }, changed).on('error', (e) => logError('models folder', e));
    } catch {} // (LM Studio's may not exist)
  }
}
function startEngine() {
  killLeftovers();
  watchModels();
  engine = new ModelEngine({
    binary: async (onStatus) => {
      const binary = await installEngine(engineDir(), { onProgress: (p) => onStatus(`Installation du moteur… ${Math.floor(p * 100)} %`) });
      if (!binary) throw new Error('Le moteur n’existe pas pour cette machine.');
      return binary;
    },
    cacheDir: path.join(app.getPath('userData'), 'prompt-cache'),
    build: ENGINE_BUILD,
    log: logError,
    ...engineOptions(),
  });
  setInferenceService({
    acquire: async ({ provider, model, numCtx, signal, onStatus }) => {
      if (provider !== 'poney') return engine.acquire({ signal, onStatus });
      const found = (await poneyModels()).find((m) => m.id === model) ?? (await poneyModels({ fresh: true })).find((m) => m.id === model);
      if (!found) throw new Error(`Le modèle ${model} est introuvable sur cette machine.`);
      return engine.acquire({ model: found, numCtx, signal, onStatus });
    },
  });
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- sessions ----------
// Each open conversation is a session: its agent, its transcript, its pending
// approvals. The window shows the active one; the others go on in the background
// (a generation is not stopped by switching), and keep their state for when the
// user comes back.
let win: BrowserWindow | null = null;
let store!: ConversationStore; // (from the app's start on)
const sessions = new Map<string, Session>(); // key (the conversation id, chosen up front) -> Session
let active: Session | null = null;
const MAX_IDLE_SESSIONS = 8; // sessions kept in memory while idle (the others are reloaded from disk)

const send = (channel: string, payload?: unknown) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

const userSkills = () => path.join(app.getPath('userData'), 'skills');
const offProjectRoot = () => path.join(app.getPath('userData'), 'off-project');
/** A conversation's private folder, .poney/ for the local models (created on first use). */
const scratchRoot = () => path.join(app.getPath('userData'), 'scratch');
const scratchOf = (id: string) => path.join(scratchRoot(), id);

const LOCAL_ONLY = 'Cette action n’existe pas pour les modèles Claude.';

/** The folder of a Claude account added in Poney (its login, its sessions); null: the machine's, ~/.claude. */
const claudeDirOf = (id: string | undefined) => (id && id !== CLAUDE ? path.join(app.getPath('userData'), 'claude-accounts', id) : null);

class Session {
  key: string;
  cwd: string;
  offProject: boolean;
  conv: ConversationFile | null;
  agent: Agent | ClaudeAgent | null;
  approvals: Map<number, { req: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }>;
  saveTimer?: NodeJS.Timeout;
  partial: SessionView['partial'];
  unread: number;
  finished: boolean;
  failed: boolean;
  draft: string;
  askDraft: AskDraft | null; // a questionnaire being answered (kept across restarts)
  choice: Choice;
  draftTimer?: NodeJS.Timeout;
  workingSince: number | null;
  sleeping: boolean;
  usedAt: number;
  lastAnswer: string;
  lastError: string;

  constructor({ id = ConversationStore.newId(), cwd, offProject = false, conv = null }: { id?: string; cwd: string; offProject?: boolean; conv?: ConversationFile | null }) {
    this.key = id;
    this.cwd = cwd;
    this.offProject = offProject; // a conversation outside any project: cwd is its own folder
    this.conv = conv; // saved conversation, created on the first message
    this.agent = null;
    this.approvals = new Map(); // id -> { req, resolve }
    this.partial = null; // the answer being written: { id, text, thinking }
    this.unread = conv?.unread ?? 0; // answers finished in the background, not seen since (saved with the conversation)
    this.finished = false; // finished while shown: stays with the finished ones until the user leaves it
    this.failed = conv?.failed ?? false; // its last turn ended on an error: until it is taken up again
    this.draft = conv?.draft ?? ''; // what is typed in the input, not sent
    this.askDraft = conv?.askDraft ?? null;
    // The model of this conversation: { engine: 'local' | 'claude', model, effort, mode }.
    this.choice = conv ? conv.choice ?? { engine: 'local', model: null } : { ...(settings.lastChoice ?? { engine: 'local', model: null }) };
    this.workingSince = null; // when the turn under way started
    this.sleeping = false; // its turn under way waits for a background task
    this.usedAt = Date.now();
    this.lastAnswer = ''; // of the turn under way: what the notification of its end says
    this.lastError = '';
  }

  get running() { return Boolean(this.agent?.running); }
  get started() { return Boolean((this.agent?.messages ?? this.conv?.messages)?.length); }

  getAgent(): Agent | ClaudeAgent {
    if (!this.cwd) throw new Error('Choisissez d’abord un dossier de projet.');
    const claude = this.choice.engine === 'claude';
    if (!this.agent || this.agent.cwd !== this.cwd || Boolean(this.agent.isClaude) !== claude) {
      this.agent?.reset();
      const approve = (req: ApprovalRequest) => new Promise<ApprovalAnswer>((resolve) => {
        this.approvals.set(req.id, { req, resolve });
        if (this === active) send('agent:approval', { ...req, session: this.key });
        send('sessions:changed');
        updateBadge();
        if (req.questions) alertUser(this, 'question', req.questions.map((q) => q.question).join(' · '));
        else alertUser(this, 'approval', `Autorisation demandée${req.agentTitle ? ` (${req.agentTitle})` : ''} : ${req.command ?? req.tool}`);
      });
      const onEvent = (ev: AgentEvent) => this.onEvent(ev);
      if (claude) this.agent = new ClaudeAgent({ cwd: this.cwd, executable: findClaude(), configDir: claudeDirOf(claudeAccountOf(this.choice)), approve, skillsDir: userSkills() }).on('event', onEvent);
      else {
        this.agent = new Agent({
          cwd: this.cwd,
          offProject: this.offProject,
          scratch: scratchOf(this.key),
          triage: true, // the assessment before acting, on unless the conversation's steps turn it off
          skillsDir: userSkills(),
          config: settings.config,
          approve,
        }).on('event', onEvent);
      }
    }
    this.applyConfig();
    if (!this.agent) throw new Error('No agent.');
    return this.agent;
  }

  /** For what only the local agent does. */
  localAgent(): Agent {
    const agent = this.getAgent();
    if (agent.isClaude) throw new Error(LOCAL_ONLY);
    return agent;
  }

  /** The settings, and this conversation's model. */
  applyConfig() {
    if (!this.agent) return;
    const local = this.choice.engine === 'local';
    this.agent.config = { ...DEFAULT_CONFIG, ...modelConfig(settings.config, local ? providerOf(settings.providers, this.choice) : null, local ? this.choice.model : null, settings.modelContexts) };
    if (this.agent.isClaude) {
      this.agent.choice = this.choice;
      this.agent.configDir = claudeDirOf(claudeAccountOf(this.choice));
      this.agent.accountDirs = settings.providers.filter((p) => p.type === 'claude').map((p) => claudeDirOf(p.id) ?? machineClaudeDir());
      if (this.agent.configDir) linkUserSettings(this.agent.configDir); // (what the user added since)
      this.agent.autoSkills = settings.config.autoSkills;
    }
  }

  onEvent(ev: AgentEvent) {
    if (ev.type === 'sleeping') { // (a state of the list, not of the conversation)
      this.sleeping = ev.on;
      send('sessions:changed');
      return;
    }
    // The answer being written, to draw it again when the user comes back mid-generation.
    if (!ev.agentId) {
      if (ev.type === 'assistant_start') this.partial = { id: ev.id, text: '', thinking: '' };
      else if (ev.type === 'delta' && this.partial?.id === ev.id && ev.kind !== 'tool') this.partial[ev.kind === 'thinking' ? 'thinking' : 'text'] += ev.text;
      else if (ev.type === 'assistant_end') this.partial = null;
    }
    if (this === active) send('agent:event', { ...ev, session: this.key });
    if (!ev.agentId && ev.type === 'final') this.lastAnswer = ev.text;
    if (!ev.agentId && ev.type === 'error') this.lastError = ev.message;
    if (ev.type === 'turn_start') this.lastAnswer = this.lastError = '';
    if (ev.type === 'turn_end') this.alertEnd(ev.reason);
    if (ev.type === 'turn_start' || ev.type === 'turn_end') {
      this.finished = ev.type === 'turn_end';
      this.failed = ev.type === 'turn_end' && ev.reason === 'error';
      this.workingSince = ev.type === 'turn_start' ? Date.now() : null;
      if (this.finished && this !== active) this.unread++;
      send('sessions:changed');
    }
    if (!this.conv) return;
    store.record(this.conv, ev);
    // Saved during the turn too: a crash or a forced quit loses a few seconds, not the turn.
    if (ev.type === 'turn_start') this.conv.inProgress = true;
    if (ev.type === 'turn_end') {
      this.conv.inProgress = false;
      this.save();
    } else if (!ev.agentId && SAVED_DURING_TURN.has(ev.type)) this.saveSoon();
  }

  saveSoon() {
    this.saveTimer ??= setTimeout(() => this.save(), 3000);
  }

  save({ touch = true } = {}) {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const { conv, agent } = this;
    if (!conv) return;
    if (agent) {
      conv.messages = agent.messages;
      conv.untested = agent.untested;
      conv.plan = agent.taskPlan;
      conv.memory = agent.memory;
      conv.memoryShownAt = agent.memoryShownAt;
      conv.chapters = agent.chapters;
      conv.steps = agent.steps;
      conv.systemPrompt = agent.systemPrompt;
      conv.checkpoints = agent.checkpoints;
      conv.archives = agent.archives;
    }
    conv.choice = this.choice;
    conv.failed = this.failed;
    if (agent?.isClaude) {
      conv.claudeSession = agent.sessionId;
      conv.claudeContext = agent.context;
    }
    if (this.draft.trim()) conv.draft = this.draft;
    else delete conv.draft;
    if (this.askDraft) conv.askDraft = this.askDraft;
    else delete conv.askDraft;
    conv.unread = this.unread;
    store.save(conv, { touch });
    send('conversations:changed', conv.id);
  }

  /** The user leaves it or the app quits: an unsent text keeps it, even if nothing was ever sent. */
  keepDraft() {
    clearTimeout(this.draftTimer);
    if (!this.conv && this.draft.trim()) {
      this.conv = store.create(this.cwd, this.draft, { id: this.key, offProject: this.offProject });
      this.conv.titleFromDraft = true;
    }
    if (!this.conv) return;
    const sent = (this.agent?.messages ?? this.conv.messages).length;
    if (!sent && !this.draft.trim() && !this.running) { // (its text was erased: nothing left of it)
      store.delete(this.conv.id);
      send('conversations:changed', this.conv.id);
      this.conv = null;
      return;
    }
    this.save({ touch: false });
  }

  /** What is typed in its input: a draft at the first character, and until sent, the title of a new conversation. */
  noteDraft(text: string) {
    const changed = Boolean(this.draft.trim()) !== Boolean(text.trim());
    this.draft = text;
    clearTimeout(this.draftTimer);
    if (this.conv?.titleFromDraft) this.conv.title = ConversationStore.cleanTitle(text) || this.conv.title;
    if (!this.conv || changed || this.conv.titleFromDraft) this.keepDraft();
    else this.draftTimer = setTimeout(() => this.save({ touch: false }), 2000);
  }

  resolveApprovals(value: ApprovalAnswer) {
    for (const { resolve } of this.approvals.values()) resolve(value);
    if (this.approvals.size) send('sessions:changed');
    this.approvals.clear();
    updateBadge();
  }

  /** Its turn ended: said to the user, unless they stopped it. */
  alertEnd(reason: string) {
    if (reason === 'stopped') return;
    if (reason === 'error') return alertUser(this, 'error', this.lastError || 'Erreur.');
    const stop = TURN_STOPS[reason];
    alertUser(this, stop ? 'error' : 'done', stop ?? (this.lastAnswer.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Terminé.'));
  }

  /** Gone from memory: idle, saved. Its folder goes too if it is outside projects and was never used. */
  close() {
    this.keepDraft();
    this.resolveApprovals(false);
    this.agent?.stop();
    if (this.offProject && !this.conv) removeIfEmpty(this.cwd);
    sessions.delete(this.key);
  }
}

const SAVED_DURING_TURN = new Set<string>(['assistant_end', 'action_end', 'compaction', 'error', 'notice']);
const TURN_STOPS: Record<string, string> = {
  max_steps: 'Arrêté : limite d’étapes atteinte.',
  loop: 'Arrêté : le modèle tournait en boucle.',
  empty: 'Arrêté : le modèle ne répond plus.',
};

// ---------- notifications ----------
// A conversation finished, failed or asks for an approval: the user hears of it where they
// are not looking. Window in front: a toast, for a conversation in the background. Window
// behind: the system's notification, whose click shows the conversation. The dock's badge
// counts the approvals waiting.
const notifications = new Map<Notification, string>(); // shown -> its session (kept: a collected one loses its click)

function alertUser(s: Session, kind: AppAlert['kind'], body: string) {
  if (settings.config.notifications === false) return;
  const focused = Boolean(win && !win.isDestroyed() && win.isFocused());
  if (focused && s === active) return; // (in view)
  const title = s.conv?.title || 'Nouvelle conversation';
  if (focused) return void send('ui:alert', { session: s.key, kind, title, body } satisfies AppAlert);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: kind === 'done' });
  n.on('click', () => {
    notifications.delete(n);
    showConversation(s.key);
  });
  n.on('close', () => notifications.delete(n));
  notifications.set(n, s.key);
  n.show();
  if (kind !== 'done') app.dock?.bounce('informational');
}

/** The notifications of a conversation the user now sees. */
function clearNotifications(key: string) {
  for (const [n, k] of notifications) if (k === key) { n.close(); notifications.delete(n); }
}

/** The window in front, on this conversation. */
function showConversation(key: string) {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    win.webContents.once('did-finish-load', () => send('ui:openConversation', key));
  } else send('ui:openConversation', key);
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

function updateBadge() {
  let n = 0;
  for (const s of sessions.values()) n += s.approvals.size;
  app.setBadgeCount(n);
}

function removeIfEmpty(dir: string) {
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
}

/** Folders of conversations never started (the app was closed before the first message). */
function pruneOffProject() {
  try {
    for (const id of fs.readdirSync(offProjectRoot())) {
      if (!fs.existsSync(path.join(store.dir, `${id}.json`))) removeIfEmpty(path.join(offProjectRoot(), id));
    }
  } catch {}
  // Private folders whose conversation is gone (never saved, or deleted).
  try {
    for (const id of fs.readdirSync(scratchRoot())) {
      if (!fs.existsSync(path.join(store.dir, `${id}.json`))) fs.rmSync(scratchOf(id), { recursive: true, force: true });
    }
  } catch {}
}

/** Makes a session the one shown. The previous one goes on; if it was empty and idle, it goes away. */
function activate(s: Session) {
  const prev = active;
  active = s;
  sessions.set(s.key, s);
  if (prev && prev !== s) {
    prev.finished = false; // left: read, it goes to the archived ones
    prev.keepDraft();
  }
  if (s.unread && s.conv) {
    s.conv.unread = 0;
    store.save(s.conv, { touch: false });
  }
  s.unread = 0;
  s.usedAt = Date.now();
  clearNotifications(s.key);
  observed = null; // (the files card follows the conversation shown)
  if (prev && prev !== s && !prev.conv && !prev.running) prev.close();
  // Idle sessions beyond the limit: saved and dropped (reloaded from disk when opened).
  const idle = [...sessions.values()].filter((x) => x !== active && !x.running && !x.approvals.size).sort((a, b) => b.usedAt - a.usedAt);
  for (const x of idle.slice(MAX_IDLE_SESSIONS)) x.close();
  send('sessions:changed');
  return s;
}

const activeCwd = () => active?.cwd ?? settings.workspace;
// Another project looked at in the files card (its files and Git), while the conversation stays.
let observed: string | null = null;
const viewCwd = () => observed ?? activeCwd();
/** The private folder shown with the files: the conversation's, local models only. */
const viewScratch = () => (!observed && active && active.choice.engine !== 'claude' ? scratchOf(active.key) : null);
/** The active session, a new one in the current project if there is none. */
const current = () => active ?? activate(new Session({ cwd: settings.workspace }));
const saveAll = () => { for (const s of sessions.values()) s.keepDraft(); };

/** The settings, plus where the agent works now (for the window). */
const publicSettings = (): PublicSettings => ({
  ...settings,
  active: {
    offProject: Boolean(active?.offProject), cwd: activeCwd() || '', session: active?.key ?? null,
    choice: active?.choice ?? { engine: 'local', model: null },
    blocked: unavailable(providerOf(settings.providers, active?.choice ?? { engine: 'local' })),
    started: Boolean(active?.started),
  },
});

/** Changes the current project (sessions in other folders go on). */
function setWorkspace(dir: string) {
  settings.workspace = dir;
  settings.recent = [dir, ...settings.recent.filter((d) => d !== dir)].slice(0, 8);
  settings.hiddenProjects = settings.hiddenProjects.filter((d) => d !== dir); // (chosen again: it is wanted)
  saveSettings();
}

/** What the window needs to show a session. */
function sessionView(s: Session): SessionView {
  return {
    events: s.conv?.events ?? [],
    running: s.running,
    partial: s.partial,
    approvals: [...s.approvals.values()].map(({ req }) => ({ ...req, session: s.key })),
    // (from the agent, not the transcript: notes added before the first message left no event there)
    memory: s.agent?.memory ?? s.conv?.memory ?? [],
    draft: s.draft,
    askDraft: s.askDraft,
    session: s.key,
    settings: publicSettings(),
  };
}

const pickFrom = (options: Electron.OpenDialogOptions) => (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));

// What comes from the window is checked here, against the contract of src/ipc.ts.
type Guard<T> = (v: unknown) => v is T;
type Guards<T extends unknown[]> = { [K in keyof T]-?: Guard<T[K]> } & readonly ((v: unknown) => boolean)[];

const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
/** An object of the window, whose fields are read one by one. */
const isObject = <T extends object>(v: unknown): v is T => isRecord(v);
const optional = <T>(guard: Guard<T>) => (v: unknown): v is T | undefined => v === undefined || guard(v);
const orNull = <T>(guard: Guard<T>) => (v: unknown): v is T | null => v === null || guard(v);
const nullable = <T>(guard: Guard<T>) => (v: unknown): v is T | null | undefined => v === undefined || v === null || guard(v);

const matches = <T extends unknown[]>(args: unknown[], guards: Guards<T>): args is T => guards.every((guard, i) => guard(args[i]));

function handle<C extends Channel>(channel: C, guards: Guards<Args<C>>, fn: (...args: Args<C>) => Reply<C> | Promise<Reply<C>>) {
  ipcMain.handle(channel, (_, ...args: unknown[]) => {
    if (!matches<Args<C>>(args, guards)) throw new Error(`Invalid arguments on ${channel}.`);
    return fn(...args);
  });
}

handle('settings:get', [], () => publicSettings());
handle('settings:setConfig', [isObject], (patch) => {
  settings.config = { ...settings.config, ...patch };
  saveSettings();
  nativeTheme.themeSource = settings.config.theme;
  for (const s of sessions.values()) if (s.agent) s.applyConfig();
  engine.setOptions(engineOptions());
  return publicSettings();
});
handle('workspace:choose', [], async () => {
  const r = await pickFrom({ properties: ['openDirectory', 'createDirectory'], defaultPath: settings.workspace || undefined });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  setWorkspace(r.filePaths[0]);
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});
handle('workspace:set', [isString], (dir) => {
  setWorkspace(dir);
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});
// A project's icon, shown on its conversations and in the sidebar: an emoji
// ({ emoji }), an icon of the window's set in a color ({ icon, color }), a small
// picture ({ image }: a data URL), or none (null).
// The key is the project's folder, or '@off-project' for the conversations outside projects.
handle('project:setIcon', [isString, orNull<ProjectIcon>(isObject)], (key, icon) => {
  const fields = rec(icon);
  const emoji = typeof fields.emoji === 'string' ? [...fields.emoji.trim()].slice(0, 8).join('') : '';
  const name = typeof fields.icon === 'string' && /^[a-z-]{1,24}$/.test(fields.icon) ? fields.icon : '';
  const color = typeof fields.color === 'string' && /^#[0-9a-f]{6}$/i.test(fields.color) ? fields.color : undefined;
  settings.projectIcons = { ...settings.projectIcons };
  if (emoji) settings.projectIcons[key] = { emoji };
  else if (name) settings.projectIcons[key] = { icon: name, color };
  else delete settings.projectIcons[key];
  saveSettings();
  return publicSettings();
});
// The name shown, the folder staying as it is. Empty: the folder's.
handle('project:setName', [isString, isString], (dir, name) => {
  settings.projectNames = { ...settings.projectNames };
  const clean = String(name ?? '').trim().slice(0, 80);
  if (clean) settings.projectNames[dir] = clean;
  else delete settings.projectNames[dir];
  saveSettings();
  return publicSettings();
});
handle('project:setOrder', [isArray], (keys) => {
  settings.projectOrder = keys.filter(isString);
  saveSettings();
  return publicSettings();
});
// Hidden: out of the sidebar with its conversations, nothing removed.
handle('project:setHidden', [isString, isBoolean], (dir, hidden) => {
  if (hidden && [...sessions.values()].some((s) => !s.offProject && s.cwd === dir && s.running)) {
    throw new Error('Une conversation de ce projet est en cours : arrêtez-la d’abord.');
  }
  settings.hiddenProjects = settings.hiddenProjects.filter((d) => d !== dir);
  if (hidden) settings.hiddenProjects.push(dir);
  saveSettings();
  return publicSettings();
});
handle('project:pickIcon', [isString], async (key) => {
  const r = await pickFrom({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns'] }] });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Image illisible.');
  settings.projectIcons = { ...settings.projectIcons, [key]: { image: img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL() } };
  saveSettings();
  return publicSettings();
});
// The text menu's commands, on the focused field or the selection.
handle('ui:edit', [isString, optional(isString)], (cmd, arg) => {
  const wc = win?.webContents;
  if (!wc) return;
  if (cmd === 'undo') wc.undo();
  else if (cmd === 'redo') wc.redo();
  else if (cmd === 'cut') wc.cut();
  else if (cmd === 'copy') wc.copy();
  else if (cmd === 'paste') wc.paste();
  else if (cmd === 'selectAll') wc.selectAll();
  else if (cmd === 'replace') wc.replaceMisspelling(String(arg));
  else if (cmd === 'learn') wc.session.addWordToSpellCheckerDictionary(String(arg));
});
handle('workspace:reveal', [], () => activeCwd() && shell.openPath(activeCwd()));
// The icon of the app behind a server, if it is installed here.
const appIcons = new Map<string, string | null>();
async function appIcon(name: string) {
  if (!appIcons.has(name)) {
    appIcons.set(name, await nativeImage.createThumbnailFromPath(`/Applications/${name}.app`, { width: 32, height: 32 }).then((i) => (i.isEmpty() ? null : i.toDataURL())).catch(() => null));
  }
  return appIcons.get(name) ?? null;
}
async function serverModels(p: Provider) {
  const lms = p.type === 'openai' ? await lmStudioModels(p) : null;
  if (lms) {
    // (a file Poney can run shows once, under Poney)
    const own = settings.providers.find((x) => x.type === 'poney')?.enabled ? await poneyModels() : [];
    const models = lms.filter((m) => m.type !== 'embeddings' && !(m.compatibility_type === 'gguf' && sameModelFile(m.id, own))).map((m) => ({ id: m.id, name: m.id }));
    return { name: p.name || 'LM Studio', icon: await appIcon('LM Studio'), models };
  }
  const models = (await listModels({ provider: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey })).map((id) => ({ id, name: id }));
  return { name: p.name || (p.type === 'ollama' ? 'Ollama' : p.baseUrl), icon: p.type === 'ollama' ? await appIcon('Ollama') : null, models };
}
// The models by provider, Poney first. Claude's come through claude:status.
handle('providers:models', [], async () => {
  const groups = await Promise.all(settings.providers.filter((p) => p.enabled && p.type !== 'claude').map(async (p) => {
    const provider = { id: p.id, type: p.type };
    if (p.type === 'poney') {
      const models = engineSupported() ? await poneyModels({ fresh: true }) : [];
      return { provider, name: 'Poney', models: models.map((m) => ({ id: m.id, name: m.name, contextLength: m.info.contextLength })) };
    }
    try {
      return { provider, ...(await serverModels(p)) };
    } catch (e) {
      return { provider, name: p.name || p.baseUrl, models: [], error: errorMessage(e) };
    }
  }));
  return groups;
});
const changeProviders = (providers: Provider[]) => {
  settings.providers = providers;
  saveSettings();
  for (const s of sessions.values()) if (s.agent) s.applyConfig();
  return publicSettings();
};
handle('providers:add', [isObject], (server) => changeProviders(addServer(settings.providers, server)));
handle('providers:update', [isString, isObject], (id, patch) => changeProviders(updateProvider(settings.providers, id, patch)));
handle('providers:remove', [isString], async (id) => {
  // An added Claude account: logged out (its keychain entry goes), and its folder removed.
  const dir = settings.providers.some((p) => p.id === id && p.type === 'claude') ? claudeDirOf(id) : null;
  const executable = findClaude();
  if (dir && executable) await new Promise<void>((done) => execFile(executable, ['auth', 'logout'], { timeout: 15000, env: claudeEnv(process.env, dir) }, () => done()));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  claudeInfo.delete(id);
  return changeProviders(removeProvider(settings.providers, id));
});
handle('engine:status', [], async () => ({
  supported: engineSupported(),
  installed: Boolean(await installedEngine(engineDir())),
  loaded: engine.status(),
  folder: modelDirs()[0],
}));
handle('engine:openModels', [], async () => {
  fs.mkdirSync(modelDirs()[0], { recursive: true });
  await shell.openPath(modelDirs()[0]);
});
handle('engine:setContext', [isString, orNull(isNumber)], (model, numCtx) => {
  if (numCtx) settings.modelContexts = { ...settings.modelContexts, [model]: numCtx };
  else {
    settings.modelContexts = { ...settings.modelContexts };
    delete settings.modelContexts[model];
  }
  saveSettings();
  for (const s of sessions.values()) if (s.agent) s.applyConfig();
  return publicSettings();
});
handle('engine:setOptions', [isObject], (patch) => {
  settings.engine = { ...settings.engine, ...patch };
  saveSettings();
  engine.setOptions(engineOptions());
  return publicSettings();
});
handle('agent:send', [isString, optional(isString)], async (text, turnId) => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est déjà en cours d’exécution.');
  const blocked = unavailable(providerOf(settings.providers, s.choice));
  if (blocked) throw new Error(blocked);
  if (!s.conv) {
    s.conv = store.create(s.cwd, text, { id: s.key, offProject: s.offProject });
    s.conv.systemPrompt = a.systemPrompt; // edited before the first message
  }
  if (s.conv.titleFromDraft) {
    s.conv.title = ConversationStore.cleanTitle(text) || s.conv.title;
    s.conv.systemPrompt = a.systemPrompt; // edited before the first message
    delete s.conv.titleFromDraft;
  }
  s.draft = '';
  clearTimeout(s.draftTimer);
  store.record(s.conv, { type: 'user_message', text, turnId });
  // Events stream back through 'agent:event'.
  a.send(text, { turnId }).catch((e) => s.onEvent({ type: 'error', message: errorMessage(e) }));
  s.save(); // after send() has set this message's rewind point, so that it is saved with it
  send('sessions:changed');
  return true;
});
// Restart the conversation from an earlier user message (edited by the user):
// the agent goes back to its state before that message, and the transcript is cut there.
handle('agent:rewind', [isString], (turnId) => {
  const s = current();
  const a = s.localAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  const { conv } = s;
  if (!conv) throw new Error('Aucune conversation ouverte.');
  const at = conv.events.findIndex((e) => e.type === 'user_message' && e.turnId === turnId);
  if (at < 0) throw new Error('Message introuvable dans cette conversation.');
  const cp = a.checkpoints.find((c) => c.turnId === turnId);
  // No exact rewind point (lost in a crash, old conversation): rebuild from the transcript.
  const before = conv.events.slice(0, at);
  a.rewind(turnId, !cp || cp.rebuild ? {
    rebuilt: rebuildHistory(before),
    keepTurnIds: new Set(before.flatMap((e) => (e.type === 'user_message' && e.turnId ? [e.turnId] : []))),
  } : {});
  conv.events = conv.events.slice(0, at);
  s.save();
  return { events: conv.events };
});
handle('agent:stop', [], () => {
  if (!active) return;
  active.resolveApprovals(false);
  active.agent?.stop();
});
// "New conversation" in the current project; the one shown before goes on.
handle('agent:reset', [], () => {
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});

// What to send to take up a turn that failed. A Claude conversation that failed before
// it had a session has nothing to go on from: its request again.
handle('agent:retryText', [], () => {
  const s = current();
  const a = s.getAgent();
  const asked = a.isClaude && !a.sessionId ? s.conv?.events.findLast((e) => e.type === 'user_message')?.text : null;
  return asked ?? 'Reprends là où tu t’es arrêté.';
});
// Resume the conversation from a past action: everything after it is removed,
// the action runs again and the agent goes on (events stream as for a message).
handle('agent:resumeFrom', [isNumber], (actId) => {
  const s = current();
  const a = s.localAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  const { conv } = s;
  if (!conv) throw new Error('Aucune conversation ouverte.');
  const cp = a.findActionCheckpoint(actId);
  if (cp) {
    // Cut the transcript at the first action re-run (a sub-agent group restarts as a whole).
    const at = conv.events.findIndex((e) => e.type === 'action_start' && !e.agentId && cp.actIds?.includes(e.id));
    if (at < 0) throw new Error('Action introuvable dans cette conversation.');
    conv.events = conv.events.slice(0, at);
    store.save(conv);
    a.resumeFrom(actId).catch((e) => s.onEvent({ type: 'error', message: errorMessage(e) }));
    return { events: conv.events };
  }
  // No resume point (action saved before they existed): rebuild the state from the transcript.
  const rebuilt = rebuildForAction(conv.events, actId);
  if (!rebuilt) throw new Error('Impossible de reprendre depuis cette action : elle est introuvable dans la conversation.');
  conv.events = conv.events.slice(0, rebuilt.cutAt);
  store.save(conv);
  a.resumeFromRebuilt(rebuilt).catch((e) => s.onEvent({ type: 'error', message: errorMessage(e) }));
  return { events: conv.events };
});

// Every conversation, with its project, and where it stands: working, asleep until
// a background task ends, waiting for approvals (how many), finished (answers not seen yet), or done and read.
handle('conversations:list', [], () => {
  const all = store.listAll();
  for (const c of all) {
    const s = sessions.get(c.id);
    if (!s) continue;
    c.unread = s.unread;
    c.approvals = s.approvals.size;
    c.running = s.running;
    c.sleeping = s.sleeping;
    c.finished = s.finished;
    c.failed = s.failed;
    c.draft = Boolean(s.draft.trim());
    c.draftText = s.draft.slice(0, 600);
    c.engine = s.choice.engine ?? 'local';
    c.provider = s.choice.provider;
    c.workingSince = s.workingSince;
    c.engine = s.choice.engine;
  }
  return { current: active?.key ?? null, all };
});
// A new conversation outside any project (the agent works in a folder of its own).
handle('conversations:newOffProject', [], () => {
  const id = ConversationStore.newId();
  const dir = path.join(offProjectRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  activate(new Session({ id, cwd: dir, offProject: true }));
  return publicSettings();
});
handle('session:current', [], () => sessionView(current()));
// Each Claude account: who it is logged in as, and its models (asked once: it starts a process).
const claudeInfo = new Map<string, Promise<ClaudeAccount>>();
async function claudeAccount(p: Provider, executable: string): Promise<ClaudeAccount> {
  const configDir = claudeDirOf(p.id);
  const auth = await claudeAuth(executable, configDir);
  const base = { id: p.id, name: p.name, email: auth.email, plan: auth.plan, loggedIn: auth.loggedIn, models: [] };
  if (!auth.loggedIn) return base;
  const models = await claudeModels(executable, { configDir }).catch((e) => {
    logError('claude', e);
    return null;
  });
  if (!models) claudeInfo.delete(p.id); // (asked again next time)
  return { ...base, models: models ?? [] };
}
handle('claude:status', [], async () => {
  const executable = findClaude();
  if (!executable) return { installed: false, accounts: [] };
  const accounts = settings.providers.filter((p) => p.type === 'claude' && p.enabled);
  return {
    installed: true,
    accounts: await Promise.all(accounts.map((p) => {
      const known = claudeInfo.get(p.id);
      if (known) return known.then((a) => ({ ...a, name: p.name }));
      const asked = claudeAccount(p, executable);
      claudeInfo.set(p.id, asked);
      return asked;
    })),
  };
});
// The plan's limits of the conversation's account, asked at most once a minute (it starts a process).
const claudeUsageInfo = new Map<string, { at: number; usage: ClaudeUsage }>();
handle('claude:usage', [], async () => {
  const executable = findClaude();
  if (!executable) return null;
  const id = claudeAccountOf(current().choice);
  const known = claudeUsageInfo.get(id);
  if (known && Date.now() - known.at < 60000) return known.usage;
  const usage = await claudeUsage(executable, { configDir: claudeDirOf(id) }).catch((e) => { logError('claude usage', e); return null; });
  claudeUsageInfo.set(id, { at: Date.now(), usage });
  return usage;
});
// Another account: its folder takes the user's settings; it logs in next.
handle('claude:addAccount', [], () => {
  const added = addClaudeAccount(settings.providers);
  linkUserSettings(claudeDirOf(added.id)!);
  return { settings: changeProviders(added.providers), id: added.id };
});
// One login at a time: the browser opens on Claude's page; a code it shows comes by claude:loginCode.
let login: ReturnType<typeof claudeLogin> | null = null;
handle('claude:login', [isString], async (id) => {
  const executable = findClaude();
  if (!executable) throw new Error('Claude n’est pas installé sur cette machine.');
  if (!settings.providers.some((p) => p.id === id && p.type === 'claude')) throw new Error('Ce compte Claude n’existe plus.');
  login?.cancel();
  const started = claudeLogin(executable, claudeDirOf(id));
  login = started;
  const ok = await started.done;
  if (login === started) login = null;
  claudeInfo.delete(id);
  claudeUsageInfo.delete(id);
  return ok;
});
handle('claude:loginCode', [isString], (code) => { login?.code(code); });
handle('claude:loginCancel', [], () => { login?.cancel(); });
// The model of the conversation shown. Once it has started, its engine stays: the two
// keep their histories apart.
handle('session:setChoice', [isObject], (patch) => {
  const s = current();
  if (s.started && patch.engine && patch.engine !== s.choice.engine) return publicSettings();
  s.choice = { ...s.choice, ...patch };
  settings.lastChoice = s.choice;
  saveSettings();
  if (s.agent && Boolean(s.agent.isClaude) === (s.choice.engine === 'claude')) s.applyConfig();
  if (s.conv) s.save({ touch: false });
  return publicSettings();
});
// The skills for the menu of the input (what /name can call here).
handle('skills:list', [], () => loadSkills(skillDirs(activeCwd(), userSkills())).map(({ name, description, author, origin }) => ({ name, description, author, origin })));
// What is typed in the input of the conversation shown (saved soon, and when the user leaves it).
handle('session:setDraft', [isString], (text) => {
  current().noteDraft(String(text ?? ''));
});
// The questionnaire being answered in the conversation shown (null: answered, or given up).
handle('session:setAskDraft', [(v): v is AskDraft | null => v === null || isRecord(v)], (draft) => {
  const s = current();
  const d = rec(draft);
  s.askDraft = draft === null ? null : {
    key: str(d.key).slice(0, 20000),
    answers: list(d.answers).map(rec).map((a) => ({ choices: list(a.choices).filter(isString), other: str(a.other).slice(0, 2000) })),
    step: Math.max(0, Math.floor(isNumber(d.step) ? d.step : 0)),
  };
  if (s.conv) s.save({ touch: false });
});
handle('conversations:open', [isString], (id) => {
  // Already open (maybe still working): shown as it is now.
  const open = sessions.get(id);
  if (open) return sessionView(activate(open));
  const loaded = store.load(id);
  // Conversations saved before rewind points existed: give them some.
  if (migrateLegacy(loaded)) store.save(loaded, { touch: false });
  if (loaded.offProject) fs.mkdirSync(loaded.workspace, { recursive: true });
  else if (loaded.workspace !== settings.workspace) setWorkspace(loaded.workspace);
  const s = new Session({ id: loaded.id, cwd: loaded.workspace, offProject: Boolean(loaded.offProject), conv: loaded });
  const a = s.getAgent();
  a.messages = loaded.messages;
  a.untested = loaded.untested;
  a.taskPlan = loaded.plan ?? null;
  a.memory = loaded.memory ?? [];
  a.memoryShownAt = loaded.memoryShownAt ?? 0;
  a.chapters = loaded.chapters ?? [];
  a.steps = loaded.steps ?? null;
  a.systemPrompt = loaded.systemPrompt ?? null;
  a.checkpoints = loaded.checkpoints ?? [];
  a.archives = loaded.archives ?? [];
  if (a.isClaude) {
    a.sessionId = loaded.claudeSession ?? null;
    a.context = loaded.claudeContext ?? null;
  }
  a.upgradeReasoning(); // older reasoning blocks -> short notes
  if (loaded.inProgress) {
    // The app stopped during a turn (crash, forced quit): say so, and how to go on.
    loaded.inProgress = false;
    // (a questionnaire left waiting is asked again by the window, where it was left)
    const last = loaded.events.findLast((e) => e.type === 'action_start' && !e.agentId);
    const asking = last?.type === 'action_start' && last.tool === 'ask' && !loaded.events.some((e) => e.type === 'action_end' && e.id === last.id && !e.agentId);
    if (!asking) store.record(loaded, { type: 'notice', text: 'L’app s’est arrêtée pendant ce tour. Le travail est sauvegardé jusqu’ici : « ↻ Reprendre d’ici » sur la dernière action pour continuer, ou envoyez un message.' });
    store.save(loaded, { touch: false });
  }
  return sessionView(activate(s));
});
handle('conversations:rename', [isString, isString], (id, title) => {
  // An open conversation is held in memory and saved after each turn: rename
  // it there too, or the next save would bring the old title back.
  const s = sessions.get(id);
  if (s?.conv) {
    const clean = ConversationStore.cleanTitle(title);
    if (clean) s.conv.title = clean;
    delete s.conv.titleFromDraft;
    store.save(s.conv, { touch: false });
    return s.conv.title;
  }
  return store.rename(id, title);
});
handle('conversations:delete', [isString], (id) => {
  const s = sessions.get(id);
  if (s?.running) throw new Error('Cette conversation est en cours : arrêtez-la d’abord.');
  let removed = null;
  try { removed = store.load(id); } catch {}
  if (s) {
    s.resolveApprovals(false);
    sessions.delete(id);
    if (s === active) {
      active = null;
      // The window stays where it was: a new conversation there.
      if (s.offProject) {
        const nid = ConversationStore.newId();
        const dir = path.join(offProjectRoot(), nid);
        fs.mkdirSync(dir, { recursive: true });
        activate(new Session({ id: nid, cwd: dir, offProject: true }));
      } else activate(new Session({ cwd: settings.workspace }));
    }
  }
  store.delete(id);
  fs.rmSync(scratchOf(id), { recursive: true, force: true });
  // Outside any project, the conversation's folder goes with it (only that folder).
  if (removed?.offProject && path.dirname(removed.workspace) === offProjectRoot()) {
    fs.rmSync(removed.workspace, { recursive: true, force: true });
  }
  send('sessions:changed');
});

// Conversations marked as read: no answer left to read, so they go to the archived ones.
handle('conversations:markRead', [isStringArray], (ids) => {
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) {
      s.finished = false;
      if (s.unread && s.conv) {
        s.conv.unread = 0;
        store.save(s.conv, { touch: false });
      }
      s.unread = 0;
      continue;
    }
    try {
      const conv = store.load(id);
      if (conv.unread) {
        conv.unread = 0;
        store.save(conv, { touch: false });
      }
    } catch {}
  }
  send('sessions:changed');
});

// A project removed from the app: its conversations are deleted and it leaves the
// lists. Its folder and files on disk are not touched.
handle('project:delete', [isString], (dir) => {
  const ids = store.listAll().filter((c) => !c.offProject && c.workspace === dir).map((c) => c.id);
  if (ids.some((id) => sessions.get(id)?.running)) throw new Error('Une conversation de ce projet est en cours : arrêtez-la d’abord.');
  let shown = false;
  for (const s of [...sessions.values()]) {
    if (s.offProject || s.cwd !== dir) continue;
    if (s.running) throw new Error('Une conversation de ce projet est en cours : arrêtez-la d’abord.');
    s.resolveApprovals(false);
    sessions.delete(s.key);
    if (s === active) shown = true;
  }
  for (const id of ids) {
    store.delete(id);
    fs.rmSync(scratchOf(id), { recursive: true, force: true });
  }
  settings.recent = (settings.recent || []).filter((d) => d !== dir);
  settings.projectIcons = { ...settings.projectIcons };
  delete settings.projectIcons[dir];
  settings.projectNames = { ...settings.projectNames };
  delete settings.projectNames[dir];
  settings.hiddenProjects = settings.hiddenProjects.filter((d) => d !== dir);
  settings.projectOrder = settings.projectOrder.filter((d) => d !== dir);
  if (settings.workspace === dir) settings.workspace = settings.recent[0] || '';
  saveSettings();
  if (shown) {
    // The window was in that project: a new conversation elsewhere (outside projects if none is left).
    active = null;
    if (settings.workspace) activate(new Session({ cwd: settings.workspace }));
    else {
      const id = ConversationStore.newId();
      const cwd = path.join(offProjectRoot(), id);
      fs.mkdirSync(cwd, { recursive: true });
      activate(new Session({ id, cwd, offProject: true }));
    }
  }
  send('sessions:changed');
  return publicSettings();
});

// The conversation's memory, seen and edited by the user.
handle('memory:get', [], () => (activeCwd() ? current().getAgent().memory : []));
handle('memory:set', [isArray], (notes) => {
  const s = current();
  const a = s.localAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  a.setMemory(notes); // (its 'memory' event is recorded with the conversation)
  s.save();
  return a.memory;
});

// Steps the agent does before and after answering, set per conversation.
handle('steps:get', [], () => (activeCwd() ? current().getAgent().steps : null));
handle('steps:set', [isObject], (steps) => {
  const s = current();
  const a = s.getAgent();
  const clean = {
    before: String(steps?.before ?? '').trim().slice(0, 2000),
    after: String(steps?.after ?? '').trim().slice(0, 2000),
    afterOnlyIfChanged: Boolean(steps?.afterOnlyIfChanged),
    triage: steps?.triage !== false, // the assessment before acting: on by default
  };
  a.steps = clean.before || clean.after || !clean.triage ? clean : null;
  s.save();
  return a.steps;
});

handle('prompt:get', [], async () => {
  const a = current().getAgent();
  if (a.isClaude) return null; // (the Claude harness has its own)
  return { default: await a.defaultSystemPrompt(), custom: a.systemPrompt, running: a.running };
});
handle('prompt:set', [orNull(isString)], async (text) => {
  const s = current();
  const a = s.localAgent();
  const def = await a.defaultSystemPrompt();
  a.systemPrompt = text == null || text.trim() === def.trim() ? null : text;
  if (s.conv) {
    s.conv.systemPrompt = a.systemPrompt;
    store.save(s.conv);
  }
  return { default: def, custom: a.systemPrompt, running: a.running };
});

handle('tor:status', [], () => torStatus(settings.config).catch((e) => ({ state: 'off', detail: errorMessage(e) })));
handle('tor:newnym', [], async () => {
  const proxy = await findTorProxy(settings.config.torProxy);
  return { ok: proxy ? await newCircuits(proxy) : false };
});
handle('tor:check', [], async () => {
  try {
    return { ok: true, ...(await checkTor(settings.config.torProxy)) };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
});
handle('context:get', [], async () => {
  if (!activeCwd()) return null;
  return current().getAgent().contextStats();
});
handle('context:compact', [], async () => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  if (!a.messages.length) return { compacted: false, reason: 'La conversation est vide.' };
  if (a.isClaude) throw new Error(LOCAL_ONLY);
  const r = await a.compact();
  s.save();
  return r;
});

// A project of the list, or null: back to the conversation's.
handle('files:observe', [(v: unknown): v is string | null => v === null || isString(v)], (dir) => {
  const known = dir && (settings.recent.includes(dir) || dir === settings.workspace || store.listAll().some((c) => c.workspace === dir && !c.offProject));
  observed = known && dir !== activeCwd() ? dir : null;
});
handle('files:list', [optional(isString)], (rel) => listDir(viewCwd(), rel, viewScratch()));
handle('files:read', [isString], (rel) => readFileForViewer(viewCwd(), rel, viewScratch()));
handle('files:openExternal', [isString], (rel) => shell.openPath(resolveInside(viewCwd(), rel, viewScratch()).abs));
handle('files:reveal', [isString], (rel) => shell.showItemInFolder(resolveInside(viewCwd(), rel, viewScratch()).abs));
// (git goes through the network like a terminal command: the same Tor setting)
const gitEnv = async () => settings.config.torEnabled && settings.config.torShell ? proxyEnv(await requireTor(settings.config.torProxy)) : {};
handle('git:status', [], () => gitStatus(viewCwd()));
handle('git:fileStates', [], () => gitFileStates(viewCwd()));
handle('git:diff', [isString, optional(isObject)], (file, opts) => gitDiff(viewCwd(), file, opts));
handle('git:fetch', [], async () => gitFetch(viewCwd(), await gitEnv()));
handle('git:branches', [], () => viewCwd() ? gitBranches(viewCwd()) : { current: null, local: [], remote: [] });
handle('git:switch', [isString], (name) => gitSwitch(viewCwd(), name));
handle('git:createBranch', [isString], (name) => gitCreateBranch(viewCwd(), name));
handle('git:sync', [], async () => gitSync(viewCwd(), await gitEnv()));
handle('git:connect', [isString], async (url) => gitConnect(viewCwd(), url, await gitEnv()));
handle('git:remote', [nullable(isString)], (dir) => gitRemote(dir));
handle('git:setRemote', [isString, isString], async (dir, url) => gitChangeRemote(dir, url, await gitEnv()));
handle('git:removeRemote', [isString], (dir) => gitRemoveRemote(dir));

// ---------- GitHub ----------
// The token is encrypted by the system, in a file of its own: the settings go to the
// interface, it never does.
const githubTokenFile = () => path.join(app.getPath('userData'), 'github-token');
const savedGithubToken = () => {
  try {
    return safeStorage.decryptString(fs.readFileSync(githubTokenFile()));
  } catch {
    return '';
  }
};
// (a token goes through this process, which no proxy covers)
const noDirectGithub = () => settings.config.torEnabled && settings.config.torShell;
async function githubStatus() {
  const env = await gitEnv().catch(() => ({}));
  const gh = await readyGh();
  const token = savedGithubToken();
  const account = (o: { gh?: string; token?: string }) => githubAccount({ ...o, env }).catch(() => null);
  return {
    ghInstalled: Boolean(findGh()),
    gh: gh ? await account({ gh }) ?? '?' : null, // (logged in: its account, if it answers)
    tokenSaved: Boolean(token),
    token: token && !noDirectGithub() ? await account({ token }) : null,
    canSave: safeStorage.isEncryptionAvailable(),
  };
}
handle('github:status', [], githubStatus);
handle('github:openTokenPage', [], () => shell.openExternal(GITHUB_TOKEN_PAGE));
handle('github:setToken', [isString], async (token) => {
  if (noDirectGithub()) throw new Error('Un jeton ne peut pas être vérifié à travers Tor : utilisez gh.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Le chiffrement du système n’est pas disponible : le jeton ne peut pas être enregistré.');
  const clean = String(token ?? '').trim();
  if (!clean) throw new Error('Collez un jeton GitHub.');
  await githubAccount({ token: clean });
  fs.writeFileSync(githubTokenFile(), safeStorage.encryptString(clean), { mode: 0o600 });
  return githubStatus();
});
handle('github:removeToken', [], () => {
  fs.rmSync(githubTokenFile(), { force: true });
  return githubStatus();
});
handle('git:createGithub', [isObject], async ({ name, isPrivate, token }) => {
  const env = await gitEnv();
  const gh = await readyGh();
  if (!gh && noDirectGithub()) throw new Error('La création sur GitHub avec un jeton ne passe pas par Tor : installez gh, ou raccordez un dépôt existant.');
  const url = await createGithubRepo({ name, isPrivate, gh, token: token || savedGithubToken(), env });
  await gitConnect(viewCwd(), url, env, { keep: true });
});
handle('agent:approve', [isObject], ({ id, ok, always, reason, answers }) => {
  if (always) {
    settings.config.approval = 'auto';
    saveSettings();
    for (const s of sessions.values()) if (s.agent) s.applyConfig();
  }
  // (the approval may belong to any session)
  for (const s of sessions.values()) {
    const p = s.approvals.get(id);
    if (!p) continue;
    // (a questionnaire's answers are narrowed by the agent, against its questions)
    if (p.req.questions) s.askDraft = null;
    if (p.req.questions) p.resolve(ok ? { ok: true, answers: list(answers).map(rec).map((a) => ({ choices: list(a.choices).filter(isString), other: str(a.other) })) } : false);
    else p.resolve(!ok && reason?.trim() ? { ok: false, reason: String(reason).slice(0, 2000) } : ok);
    s.approvals.delete(id);
    send('sessions:changed');
  }
  updateBadge();
  return publicSettings();
});

function createWindow() {
  const window = new BrowserWindow({
    icon: path.join(here, '..', 'assets', 'icon-square.png'), // taskbar (Windows, Linux)
    width: 1280,
    height: 820,
    minWidth: 1200, // (the two sidebars' deck, the conversation and a side panel, without squeezing them)
    minHeight: 500,
    title: 'Poney',
    backgroundColor: '#14161a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win = window;
  window.loadFile(path.join(here, 'renderer', 'index.html'));
  // The window's page crashed or froze: the agent (here) goes on; save, and give a fresh page.
  window.webContents.on('render-process-gone', (_, details) => {
    logError('render-process-gone', details);
    saveAll();
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  // Back to the window: what it shows is seen.
  window.on('focus', () => { if (active) clearNotifications(active.key); });
  window.on('unresponsive', () => {
    logError('unresponsive', 'window not responding');
    saveAll();
  });
  window.webContents.on('console-message', (_, level, message, line, source) => {
    if (level >= 3) logError('renderer', `${message} (${source}:${line})`);
  });
  // Right click on text (a selection, the input): the window draws its own menu,
  // with the spelling suggestions only this side knows.
  // Three fingers (macOS, when the system's "Swipe between pages" allows them): one sidebar or the other.
  window.on('swipe', (_, direction) => {
    if (direction === 'left' || direction === 'right') send('ui:swipe', direction);
  });
  window.webContents.on('context-menu', (_, p) => send('ui:contextMenu', {
    x: p.x, y: p.y, isEditable: p.isEditable, selectionText: p.selectionText,
    misspelledWord: p.misspelledWord, suggestions: p.dictionarySuggestions, editFlags: p.editFlags,
  }));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return window;
}

/** Electron's default menus, plus the settings and the renaming; ⌘R is the renaming, not a reload. */
function appMenu() {
  const toWindow = (channel: string) => () => {
    if (win && !win.isDestroyed()) return void send(channel);
    win = createWindow();
    win.webContents.once('did-finish-load', () => send(channel));
  };
  const mac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Réglages…', accelerator: 'Cmd+,', click: toWindow('ui:openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } satisfies Electron.MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'Conversation', submenu: [{ label: 'Renommer', accelerator: 'CmdOrCtrl+R', click: toWindow('ui:renameConversation') }] },
    {
      label: 'View',
      submenu: [
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(here, '..', 'assets', 'icon.png'));
  appMenu();
  loadSettings();
  settings.providers = loadProviders(settings.providers, settings.config);
  startEngine();
  nativeTheme.themeSource = settings.config.theme;
  store = new ConversationStore(path.join(app.getPath('userData'), 'conversations'));
  pruneOffProject();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('before-quit', () => saveAll());
// The models are stopped and their caches saved before the app goes.
let engineStopped = false;
app.on('will-quit', (e) => {
  if (engineStopped || !engine?.status().length) return;
  e.preventDefault();
  engine.shutdown().finally(() => {
    engineStopped = true;
    app.quit();
  });
});
// Ctrl-C in the terminal, kill: Electron quits without 'before-quit'.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    saveAll();
    engine?.kill();
    app.exit(0);
  });
}
process.on('uncaughtException', (e) => {
  logError('uncaughtException', e);
  saveAll();
  send('agent:event', { type: 'error', message: `Erreur interne (détails dans logs/main.log) : ${errorMessage(e)}` });
});
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.agent?.stop();
  if (process.platform !== 'darwin') app.quit();
});
