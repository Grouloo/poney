import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, DEFAULT_CONFIG } from './agent/agent.js';
import { listModels } from './agent/llm.js';
import { ConversationStore, moveAppData } from './conversations.js';
import { listDir, readFileForViewer } from './files.js';
import { migrateLegacy, rebuildHistory, rebuildForAction } from './agent/rebuild.js';
import { checkTor, torStatus, newCircuits, findTorProxy } from './agent/tor.js';

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
function logError(what, detail) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const text = detail instanceof Error ? detail.stack : typeof detail === 'string' ? detail : JSON.stringify(detail);
    fs.appendFileSync(path.join(dir, 'main.log'), `${new Date().toISOString()} ${what}: ${text}\n`);
  } catch {}
}

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { config: { ...DEFAULT_CONFIG }, workspace: '', recent: [] };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...settings, ...saved, config: { ...DEFAULT_CONFIG, ...saved.config } };
    // 0.2 used to be the default (saved as is): now the model's own temperature is used.
    if (!settings.temperatureFromModel) {
      if (settings.config.temperature === 0.2) settings.config.temperature = null;
      settings.temperatureFromModel = true;
      saveSettings();
    }
  } catch {}
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
let win = null;
let store = null;
const sessions = new Map(); // key (the conversation id, chosen up front) -> Session
let active = null;
const MAX_IDLE_SESSIONS = 8; // sessions kept in memory while idle (the others are reloaded from disk)

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

const offProjectRoot = () => path.join(app.getPath('userData'), 'off-project');

class Session {
  constructor({ id = ConversationStore.newId(), cwd, offProject = false, conv = null }) {
    this.key = id;
    this.cwd = cwd;
    this.offProject = offProject; // a conversation outside any project: cwd is its own folder
    this.conv = conv; // saved conversation, created on the first message
    this.agent = null;
    this.approvals = new Map(); // id -> { req, resolve }
    this.saveTimer = null;
    this.partial = null; // the answer being written: { id, text, thinking }
    this.unread = false; // finished in the background, not seen since
    this.usedAt = Date.now();
  }

  get running() { return Boolean(this.agent?.running); }

  getAgent() {
    if (!this.cwd) throw new Error('Choisissez d’abord un dossier de projet.');
    if (!this.agent || this.agent.cwd !== this.cwd) {
      this.agent?.reset();
      const agent = new Agent({
        cwd: this.cwd,
        offProject: this.offProject,
        config: settings.config,
        approve: (req) => new Promise((resolve) => {
          this.approvals.set(req.id, { req, resolve });
          if (this === active) send('agent:approval', { ...req, session: this.key });
        }),
      });
      agent.on('event', (ev) => this.onEvent(ev));
      this.agent = agent;
    }
    this.agent.config = { ...DEFAULT_CONFIG, ...settings.config };
    return this.agent;
  }

  onEvent(ev) {
    // The answer being written, to draw it again when the user comes back mid-generation.
    if (!ev.agentId) {
      if (ev.type === 'assistant_start') this.partial = { id: ev.id, text: '', thinking: '' };
      else if (ev.type === 'delta' && this.partial?.id === ev.id && ev.kind !== 'tool') this.partial[ev.kind === 'thinking' ? 'thinking' : 'text'] += ev.text;
      else if (ev.type === 'assistant_end') this.partial = null;
    }
    if (this === active) send('agent:event', { ...ev, session: this.key });
    if (ev.type === 'turn_start' || ev.type === 'turn_end') {
      if (ev.type === 'turn_end' && this !== active) this.unread = true;
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

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const { conv, agent } = this;
    if (!conv || !agent) return;
    conv.messages = agent.messages;
    conv.untested = agent.untested;
    conv.plan = agent.taskPlan;
    conv.memory = agent.memory;
    conv.memoryShownAt = agent.memoryShownAt;
    conv.chapters = agent.chapters;
    conv.systemPrompt = agent.systemPrompt;
    conv.checkpoints = agent.checkpoints;
    conv.archives = agent.archives;
    store.save(conv);
    send('conversations:changed', conv.id);
  }

  resolveApprovals(value) {
    for (const { resolve } of this.approvals.values()) resolve(value);
    this.approvals.clear();
  }

  /** Gone from memory: idle, saved. Its folder goes too if it is outside projects and was never used. */
  close() {
    this.save();
    this.resolveApprovals(false);
    this.agent?.stop();
    if (this.offProject && !this.conv) removeIfEmpty(this.cwd);
    sessions.delete(this.key);
  }
}

const SAVED_DURING_TURN = new Set(['assistant_end', 'action_end', 'compaction', 'error', 'notice']);

function removeIfEmpty(dir) {
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
}

/** Folders of conversations never started (the app was closed before the first message). */
function pruneOffProject() {
  try {
    for (const id of fs.readdirSync(offProjectRoot())) {
      if (!fs.existsSync(path.join(store.dir, `${id}.json`))) removeIfEmpty(path.join(offProjectRoot(), id));
    }
  } catch {}
}

/** Makes a session the one shown. The previous one goes on; if it was empty and idle, it goes away. */
function activate(s) {
  const prev = active;
  active = s;
  sessions.set(s.key, s);
  s.unread = false;
  s.usedAt = Date.now();
  if (prev && prev !== s && !prev.conv && !prev.running) prev.close();
  // Idle sessions beyond the limit: saved and dropped (reloaded from disk when opened).
  const idle = [...sessions.values()].filter((x) => x !== active && !x.running && !x.approvals.size).sort((a, b) => b.usedAt - a.usedAt);
  for (const x of idle.slice(MAX_IDLE_SESSIONS)) x.close();
  send('sessions:changed');
  return s;
}

const activeCwd = () => active?.cwd ?? settings.workspace;
/** The active session, a new one in the current project if there is none. */
const current = () => active ?? activate(new Session({ cwd: settings.workspace }));
const saveAll = () => { for (const s of sessions.values()) s.save(); };

/** The settings, plus where the agent works now (for the window). */
const publicSettings = () => ({ ...settings, active: { offProject: Boolean(active?.offProject), cwd: activeCwd() || '', session: active?.key ?? null } });

/** Changes the current project (sessions in other folders go on). */
function setWorkspace(dir) {
  settings.workspace = dir;
  settings.recent = [dir, ...settings.recent.filter((d) => d !== dir)].slice(0, 8);
  saveSettings();
}

/** What the window needs to show a session. */
function sessionView(s) {
  return {
    events: s.conv?.events ?? [],
    running: s.running,
    partial: s.partial,
    approvals: [...s.approvals.values()].map(({ req }) => ({ ...req, session: s.key })),
    // (from the agent, not the transcript: notes added before the first message left no event there)
    memory: s.agent?.memory ?? s.conv?.memory ?? [],
    session: s.key,
    settings: publicSettings(),
  };
}

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:setConfig', (_, patch) => {
  settings.config = { ...settings.config, ...patch };
  saveSettings();
  for (const s of sessions.values()) if (s.agent) s.agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return publicSettings();
});
ipcMain.handle('workspace:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.workspace || undefined });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  setWorkspace(r.filePaths[0]);
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});
ipcMain.handle('workspace:set', (_, dir) => {
  setWorkspace(dir);
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});
ipcMain.handle('workspace:reveal', () => activeCwd() && shell.openPath(activeCwd()));
ipcMain.handle('models:list', async (_, cfg) => listModels({ ...settings.config, ...cfg }));
ipcMain.handle('agent:send', async (_, text, turnId) => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est déjà en cours d’exécution.');
  if (!s.conv) {
    s.conv = store.create(s.cwd, text, { id: s.key, offProject: s.offProject });
    s.conv.systemPrompt = a.systemPrompt; // edited before the first message
  }
  store.record(s.conv, { type: 'user_message', text, turnId });
  // Events stream back through 'agent:event'.
  a.send(text, { turnId }).catch((e) => s.onEvent({ type: 'error', message: e.message }));
  s.save(); // after send() has set this message's rewind point, so that it is saved with it
  send('sessions:changed');
  return true;
});
// Restart the conversation from an earlier user message (edited by the user):
// the agent goes back to its state before that message, and the transcript is cut there.
ipcMain.handle('agent:rewind', (_, turnId) => {
  const s = current();
  const a = s.getAgent();
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
    keepTurnIds: new Set(before.filter((e) => e.type === 'user_message' && e.turnId).map((e) => e.turnId)),
  } : {});
  conv.events = conv.events.slice(0, at);
  s.save();
  return { events: conv.events };
});
ipcMain.handle('agent:stop', () => {
  if (!active) return;
  active.resolveApprovals(false);
  active.agent?.stop();
});
// "New conversation" in the current project; the one shown before goes on.
ipcMain.handle('agent:reset', () => {
  activate(new Session({ cwd: settings.workspace }));
  return publicSettings();
});

// Resume the conversation from a past action: everything after it is removed,
// the action runs again and the agent goes on (events stream as for a message).
ipcMain.handle('agent:resumeFrom', (_, actId) => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  const { conv } = s;
  if (!conv) throw new Error('Aucune conversation ouverte.');
  const cp = a.findActionCheckpoint(actId);
  if (cp) {
    // Cut the transcript at the first action re-run (a sub-agent group restarts as a whole).
    const at = conv.events.findIndex((e) => e.type === 'action_start' && !e.agentId && cp.actIds.includes(e.id));
    if (at < 0) throw new Error('Action introuvable dans cette conversation.');
    conv.events = conv.events.slice(0, at);
    store.save(conv);
    a.resumeFrom(actId).catch((e) => s.onEvent({ type: 'error', message: e.message }));
    return { events: conv.events };
  }
  // No resume point (action saved before they existed): rebuild the state from the transcript.
  const rebuilt = rebuildForAction(conv.events, actId);
  if (!rebuilt) throw new Error('Impossible de reprendre depuis cette action : elle est introuvable dans la conversation.');
  conv.events = conv.events.slice(0, rebuilt.cutAt);
  store.save(conv);
  a.resumeFromRebuilt(rebuilt).catch((e) => s.onEvent({ type: 'error', message: e.message }));
  return { events: conv.events };
});

// Every conversation, with its project (the window groups them by project), and
// which ones are working or have finished in the background.
ipcMain.handle('conversations:list', () => ({
  current: active?.key ?? null,
  all: store.listAll(),
  recent: settings.recent || [],
  running: [...sessions.values()].filter((s) => s.running).map((s) => s.key),
  unread: [...sessions.values()].filter((s) => s.unread).map((s) => s.key),
  waiting: [...sessions.values()].filter((s) => s.approvals.size).map((s) => s.key),
}));
// A new conversation outside any project (the agent works in a folder of its own).
ipcMain.handle('conversations:newOffProject', () => {
  const id = ConversationStore.newId();
  const dir = path.join(offProjectRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  activate(new Session({ id, cwd: dir, offProject: true }));
  return publicSettings();
});
ipcMain.handle('session:current', () => sessionView(current()));
ipcMain.handle('conversations:open', (_, id) => {
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
  a.systemPrompt = loaded.systemPrompt ?? null;
  a.checkpoints = loaded.checkpoints ?? [];
  a.archives = loaded.archives ?? [];
  a.upgradeReasoning(); // older reasoning blocks -> short notes
  if (loaded.inProgress) {
    // The app stopped during a turn (crash, forced quit): say so, and how to go on.
    loaded.inProgress = false;
    store.record(loaded, { type: 'notice', text: 'L’app s’est arrêtée pendant ce tour. Le travail est sauvegardé jusqu’ici : « ↻ Reprendre d’ici » sur la dernière action pour continuer, ou envoyez un message.' });
    store.save(loaded, { touch: false });
  }
  return sessionView(activate(s));
});
ipcMain.handle('conversations:rename', (_, id, title) => {
  // An open conversation is held in memory and saved after each turn: rename
  // it there too, or the next save would bring the old title back.
  const s = sessions.get(id);
  if (s?.conv) {
    const clean = ConversationStore.cleanTitle(title);
    if (clean) s.conv.title = clean;
    store.save(s.conv, { touch: false });
    return s.conv.title;
  }
  return store.rename(id, title);
});
ipcMain.handle('conversations:delete', (_, id) => {
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
  // Outside any project, the conversation's folder goes with it (only that folder).
  if (removed?.offProject && path.dirname(removed.workspace) === offProjectRoot()) {
    fs.rmSync(removed.workspace, { recursive: true, force: true });
  }
  send('sessions:changed');
});

// The conversation's memory, seen and edited by the user.
ipcMain.handle('memory:get', () => (activeCwd() ? current().getAgent().memory : []));
ipcMain.handle('memory:set', (_, notes) => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  a.setMemory(notes); // (its 'memory' event is recorded with the conversation)
  s.save();
  return a.memory;
});

ipcMain.handle('prompt:get', async () => {
  const a = current().getAgent();
  return { default: await a.defaultSystemPrompt(), custom: a.systemPrompt, running: a.running };
});
ipcMain.handle('prompt:set', async (_, text) => {
  const s = current();
  const a = s.getAgent();
  const def = await a.defaultSystemPrompt();
  a.systemPrompt = text == null || text.trim() === def.trim() ? null : text;
  if (s.conv) {
    s.conv.systemPrompt = a.systemPrompt;
    store.save(s.conv);
  }
  return { default: def, custom: a.systemPrompt, running: a.running };
});

ipcMain.handle('tor:status', () => torStatus(settings.config).catch((e) => ({ state: 'off', detail: e.message })));
ipcMain.handle('tor:newnym', async () => {
  const proxy = await findTorProxy(settings.config.torProxy);
  return { ok: Boolean(proxy) && (await newCircuits(proxy)) };
});
ipcMain.handle('tor:check', async () => {
  try {
    return { ok: true, ...(await checkTor(settings.config.torProxy)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('context:get', async () => {
  if (!activeCwd()) return null;
  return current().getAgent().contextStats();
});
ipcMain.handle('context:compact', async () => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  if (!a.messages.length) return { compacted: false, reason: 'La conversation est vide.' };
  const r = await a.compact();
  s.save();
  return r;
});

ipcMain.handle('files:list', (_, rel) => listDir(activeCwd(), rel));
ipcMain.handle('files:read', (_, rel) => readFileForViewer(activeCwd(), rel));
ipcMain.handle('files:openExternal', (_, rel) => shell.openPath(path.join(activeCwd(), rel)));
ipcMain.handle('files:reveal', (_, rel) => shell.showItemInFolder(path.join(activeCwd(), rel)));
ipcMain.handle('agent:approve', (_, { id, ok, always }) => {
  if (always) {
    settings.config.approval = 'auto';
    saveSettings();
    for (const s of sessions.values()) if (s.agent) s.agent.config.approval = 'auto';
  }
  // (the approval may belong to any session)
  for (const s of sessions.values()) {
    const p = s.approvals.get(id);
    if (!p) continue;
    p.resolve(ok);
    s.approvals.delete(id);
    send('sessions:changed');
  }
  return publicSettings();
});

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(here, '..', 'assets', 'icon-square.png'), // taskbar (Windows, Linux)
    width: 1200,
    height: 820,
    minWidth: 720,
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
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  // The window's page crashed or froze: the agent (here) goes on; save, and give a fresh page.
  win.webContents.on('render-process-gone', (_, details) => {
    logError('render-process-gone', details);
    saveAll();
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  win.on('unresponsive', () => {
    logError('unresponsive', 'window not responding');
    saveAll();
  });
  win.webContents.on('console-message', (_, level, message, line, source) => {
    if (level >= 3) logError('renderer', `${message} (${source}:${line})`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(here, '..', 'assets', 'icon.png'));
  loadSettings();
  store = new ConversationStore(path.join(app.getPath('userData'), 'conversations'));
  pruneOffProject();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('before-quit', () => saveAll());
// Ctrl-C in the terminal, kill: Electron quits without 'before-quit'.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    saveAll();
    app.exit(0);
  });
}
process.on('uncaughtException', (e) => {
  logError('uncaughtException', e);
  saveAll();
  send('agent:event', { type: 'error', message: `Erreur interne (détails dans logs/main.log) : ${e.message}` });
});
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.agent?.stop();
  if (process.platform !== 'darwin') app.quit();
});
