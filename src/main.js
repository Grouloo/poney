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

// ---------- agent ----------
let win = null;
let agent = null;
let store = null;
let conv = null; // current conversation, created on the first message
const pendingApprovals = new Map();

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// A conversation outside any project works in its own folder, inside the app's
// data: { id, dir } while one is open (or being started), null otherwise.
let offProject = null;
const offProjectRoot = () => path.join(app.getPath('userData'), 'off-project');
const activeCwd = () => offProject?.dir ?? settings.workspace;

function startOffProject(id = ConversationStore.newId(), dir = path.join(offProjectRoot(), id)) {
  leaveOffProject();
  fs.mkdirSync(dir, { recursive: true });
  offProject = { id, dir };
}

/** Leaves the conversation outside projects; its folder goes if nothing was ever sent nor written. */
function leaveOffProject() {
  if (offProject && conv?.id !== offProject.id) removeIfEmpty(offProject.dir);
  offProject = null;
}

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

/** The settings, plus where the agent works now (for the window). */
const publicSettings = () => ({ ...settings, active: { offProject: Boolean(offProject), cwd: activeCwd() || '' } });

function getAgent() {
  if (!activeCwd()) throw new Error('Choisissez d’abord un dossier de projet.');
  if (!agent || agent.cwd !== activeCwd()) {
    agent?.reset();
    agent = new Agent({
      cwd: activeCwd(),
      offProject: Boolean(offProject),
      config: settings.config,
      approve: (req) => new Promise((resolve) => {
        pendingApprovals.set(req.id, resolve);
        send('agent:approval', req);
      }),
    });
    agent.on('event', (ev) => {
      send('agent:event', ev);
      if (!conv) return;
      store.record(conv, ev);
      // Saved during the turn too: a crash or a forced quit loses a few seconds, not the turn.
      if (ev.type === 'turn_start') conv.inProgress = true;
      if (ev.type === 'turn_end') {
        conv.inProgress = false;
        saveConversation();
      } else if (!ev.agentId && SAVED_DURING_TURN.has(ev.type)) saveSoon();
    });
  }
  agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return agent;
}

const SAVED_DURING_TURN = new Set(['assistant_end', 'action_end', 'compaction', 'error', 'notice']);
let saveTimer = null;
function saveSoon() {
  saveTimer ??= setTimeout(saveConversation, 3000);
}

function saveConversation() {
  clearTimeout(saveTimer);
  saveTimer = null;
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

function startNewConversation() {
  resolveApprovals(false);
  agent?.reset();
  conv = null;
}

function resolveApprovals(value) {
  for (const resolve of pendingApprovals.values()) resolve(value);
  pendingApprovals.clear();
}

function setWorkspace(dir) {
  if (agent && agent.running) throw new Error('L’agent est en cours d’exécution.');
  settings.workspace = dir;
  settings.recent = [dir, ...settings.recent.filter((d) => d !== dir)].slice(0, 8);
  saveSettings();
  startNewConversation();
  leaveOffProject();
  agent = null;
}

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:setConfig', (_, patch) => {
  settings.config = { ...settings.config, ...patch };
  saveSettings();
  if (agent) agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return publicSettings();
});
ipcMain.handle('workspace:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.workspace || undefined });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  setWorkspace(r.filePaths[0]);
  return publicSettings();
});
ipcMain.handle('workspace:set', (_, dir) => {
  setWorkspace(dir);
  return publicSettings();
});
ipcMain.handle('workspace:reveal', () => activeCwd() && shell.openPath(activeCwd()));
ipcMain.handle('models:list', async (_, cfg) => listModels({ ...settings.config, ...cfg }));
ipcMain.handle('agent:send', async (_, text, turnId) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est déjà en cours d’exécution.');
  if (!conv) {
    conv = offProject
      ? store.create(offProject.dir, text, { id: offProject.id, offProject: true })
      : store.create(settings.workspace, text);
    conv.systemPrompt = a.systemPrompt; // edited before the first message
  }
  store.record(conv, { type: 'user_message', text, turnId });
  // Events stream back through 'agent:event'.
  a.send(text, { turnId }).catch((e) => send('agent:event', { type: 'error', message: e.message }));
  saveConversation(); // after send() has set this message's rewind point, so that it is saved with it
  return true;
});
// Restart the conversation from an earlier user message (edited by the user):
// the agent goes back to its state before that message, and the transcript is cut there.
ipcMain.handle('agent:rewind', (_, turnId) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
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
  saveConversation();
  return { events: conv.events };
});
ipcMain.handle('agent:stop', () => {
  resolveApprovals(false);
  agent?.stop();
});
ipcMain.handle('agent:reset', () => {
  leaveOffProject(); // "new conversation": back to the project
  startNewConversation();
  return publicSettings();
});

// Resume the conversation from a past action: everything after it is removed,
// the action runs again and the agent goes on (events stream as for a message).
ipcMain.handle('agent:resumeFrom', (_, actId) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  if (!conv) throw new Error('Aucune conversation ouverte.');
  const cp = a.findActionCheckpoint(actId);
  if (cp) {
    // Cut the transcript at the first action re-run (a sub-agent group restarts as a whole).
    const at = conv.events.findIndex((e) => e.type === 'action_start' && !e.agentId && cp.actIds.includes(e.id));
    if (at < 0) throw new Error('Action introuvable dans cette conversation.');
    conv.events = conv.events.slice(0, at);
    store.save(conv);
    a.resumeFrom(actId).catch((e) => send('agent:event', { type: 'error', message: e.message }));
    return { events: conv.events };
  }
  // No resume point (action saved before they existed): rebuild the state from the transcript.
  const rebuilt = rebuildForAction(conv.events, actId);
  if (!rebuilt) throw new Error('Impossible de reprendre depuis cette action : elle est introuvable dans la conversation.');
  conv.events = conv.events.slice(0, rebuilt.cutAt);
  store.save(conv);
  a.resumeFromRebuilt(rebuilt).catch((e) => send('agent:event', { type: 'error', message: e.message }));
  return { events: conv.events };
});

// Every conversation, with its project (the window groups them by project).
ipcMain.handle('conversations:list', () => ({
  current: conv?.id ?? offProject?.id ?? null,
  all: store.listAll(),
  recent: settings.recent || [],
}));
// A new conversation outside any project (the agent works in a folder of its own).
ipcMain.handle('conversations:newOffProject', () => {
  if (agent?.running) throw new Error('L’agent est en cours d’exécution.');
  startNewConversation();
  startOffProject();
  return publicSettings();
});
ipcMain.handle('session:current', () => ({ events: conv?.events ?? [], running: !!agent?.running }));
ipcMain.handle('conversations:open', (_, id) => {
  if (agent?.running) throw new Error('L’agent est en cours d’exécution.');
  const loaded = store.load(id);
  // Conversations saved before rewind points existed: give them some.
  if (migrateLegacy(loaded)) store.save(loaded, { touch: false });
  if (loaded.offProject) startOffProject(loaded.id, loaded.workspace);
  else {
    leaveOffProject();
    if (loaded.workspace !== settings.workspace) setWorkspace(loaded.workspace);
  }
  const a = getAgent();
  a.reset();
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
  conv = loaded;
  return { events: loaded.events, settings: publicSettings() };
});
ipcMain.handle('conversations:rename', (_, id, title) => {
  // The open conversation is held in memory and saved after each turn: rename
  // it there too, or the next save would bring the old title back.
  if (conv?.id === id) {
    const clean = ConversationStore.cleanTitle(title);
    if (clean) conv.title = clean;
    store.save(conv, { touch: false });
    return conv.title;
  }
  return store.rename(id, title);
});
ipcMain.handle('conversations:delete', (_, id) => {
  if (conv?.id === id) {
    if (agent?.running) throw new Error('L’agent est en cours d’exécution.');
    startNewConversation();
  }
  let removed = null;
  try { removed = store.load(id); } catch {}
  store.delete(id);
  // Outside any project, the conversation's folder goes with it (only that folder).
  if (removed?.offProject && path.dirname(removed.workspace) === offProjectRoot()) {
    fs.rmSync(removed.workspace, { recursive: true, force: true });
    if (offProject?.id === id) startOffProject(); // the window stays outside projects, on a new conversation
  }
});

// The conversation's memory, seen and edited by the user.
ipcMain.handle('memory:get', () => (activeCwd() ? getAgent().memory : []));
ipcMain.handle('memory:set', (_, notes) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  a.setMemory(notes); // (its 'memory' event is recorded with the conversation)
  saveConversation();
  return a.memory;
});

ipcMain.handle('prompt:get', async () => {
  const a = getAgent();
  return { default: await a.defaultSystemPrompt(), custom: a.systemPrompt, running: a.running };
});
ipcMain.handle('prompt:set', async (_, text) => {
  const a = getAgent();
  const def = await a.defaultSystemPrompt();
  a.systemPrompt = text == null || text.trim() === def.trim() ? null : text;
  if (conv) {
    conv.systemPrompt = a.systemPrompt;
    store.save(conv);
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
  return getAgent().contextStats();
});
ipcMain.handle('context:compact', async () => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  if (!a.messages.length) return { compacted: false, reason: 'La conversation est vide.' };
  const r = await a.compact();
  saveConversation();
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
    if (agent) agent.config.approval = 'auto';
  }
  pendingApprovals.get(id)?.(ok);
  pendingApprovals.delete(id);
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
    saveConversation();
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  win.on('unresponsive', () => {
    logError('unresponsive', 'window not responding');
    saveConversation();
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
app.on('before-quit', () => saveConversation());
// Ctrl-C in the terminal, kill: Electron quits without 'before-quit'.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    saveConversation();
    app.exit(0);
  });
}
process.on('uncaughtException', (e) => {
  logError('uncaughtException', e);
  saveConversation();
  send('agent:event', { type: 'error', message: `Erreur interne (détails dans logs/main.log) : ${e.message}` });
});
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
app.on('window-all-closed', () => {
  agent?.stop();
  if (process.platform !== 'darwin') app.quit();
});
