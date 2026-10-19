import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, DEFAULT_CONFIG } from './agent/agent.js';
import { listModels } from './agent/llm.js';
import { ConversationStore } from './conversations.js';
import { listDir, readFileForViewer } from './files.js';
import { migrateLegacy, rebuildHistory } from './agent/rebuild.js';
import { checkTor } from './agent/tor.js';

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
if (process.env.LOCAL_CODEX_DATA) app.setPath('userData', process.env.LOCAL_CODEX_DATA);

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { config: { ...DEFAULT_CONFIG }, workspace: '', recent: [] };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...settings, ...saved, config: { ...DEFAULT_CONFIG, ...saved.config } };
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

function getAgent() {
  if (!settings.workspace) throw new Error('Choisissez d’abord un dossier de projet.');
  if (!agent || agent.cwd !== settings.workspace) {
    agent?.reset();
    agent = new Agent({
      cwd: settings.workspace,
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
      if (ev.type === 'turn_end') saveConversation();
    });
  }
  agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return agent;
}

function saveConversation() {
  if (!conv || !agent) return;
  conv.messages = agent.messages;
  conv.untested = agent.untested;
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
  agent = null;
}

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:setConfig', (_, patch) => {
  settings.config = { ...settings.config, ...patch };
  saveSettings();
  if (agent) agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return settings;
});
ipcMain.handle('workspace:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.workspace || undefined });
  if (r.canceled || !r.filePaths[0]) return settings;
  setWorkspace(r.filePaths[0]);
  return settings;
});
ipcMain.handle('workspace:set', (_, dir) => {
  setWorkspace(dir);
  return settings;
});
ipcMain.handle('workspace:reveal', () => settings.workspace && shell.openPath(settings.workspace));
ipcMain.handle('models:list', async (_, cfg) => listModels({ ...settings.config, ...cfg }));
ipcMain.handle('agent:send', async (_, text, turnId) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est déjà en cours d’exécution.');
  if (!conv) {
    conv = store.create(settings.workspace, text);
    conv.systemPrompt = a.systemPrompt; // edited before the first message
  }
  store.record(conv, { type: 'user_message', text, turnId });
  store.save(conv);
  send('conversations:changed', conv.id);
  // Events stream back through 'agent:event'.
  a.send(text, { turnId }).catch((e) => send('agent:event', { type: 'error', message: e.message }));
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
  a.rewind(turnId, cp?.rebuild ? { rebuilt: rebuildHistory(conv.events.slice(0, at)) } : {});
  conv.events = conv.events.slice(0, at);
  saveConversation();
  return { events: conv.events };
});
ipcMain.handle('agent:stop', () => {
  resolveApprovals(false);
  agent?.stop();
});
ipcMain.handle('agent:reset', () => startNewConversation());

ipcMain.handle('conversations:list', () => ({
  current: conv?.id ?? null,
  items: settings.workspace ? store.list(settings.workspace) : [],
}));
ipcMain.handle('conversations:open', (_, id) => {
  if (agent?.running) throw new Error('L’agent est en cours d’exécution.');
  const loaded = store.load(id);
  // Conversations saved before rewind points existed: give them some.
  if (migrateLegacy(loaded)) store.save(loaded, { touch: false });
  if (loaded.workspace !== settings.workspace) setWorkspace(loaded.workspace);
  const a = getAgent();
  a.reset();
  a.messages = loaded.messages;
  a.untested = loaded.untested;
  a.systemPrompt = loaded.systemPrompt ?? null;
  a.checkpoints = loaded.checkpoints ?? [];
  a.archives = loaded.archives ?? [];
  a.upgradeReasoning(); // older reasoning blocks -> short notes
  conv = loaded;
  return { events: loaded.events, settings };
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
  store.delete(id);
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

ipcMain.handle('tor:check', async () => {
  try {
    return { ok: true, ...(await checkTor(settings.config.torProxy)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('context:get', async () => {
  if (!settings.workspace) return null;
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

ipcMain.handle('files:list', (_, rel) => listDir(settings.workspace, rel));
ipcMain.handle('files:read', (_, rel) => readFileForViewer(settings.workspace, rel));
ipcMain.handle('files:openExternal', (_, rel) => shell.openPath(path.join(settings.workspace, rel)));
ipcMain.handle('files:reveal', (_, rel) => shell.showItemInFolder(path.join(settings.workspace, rel)));
ipcMain.handle('agent:approve', (_, { id, ok, always }) => {
  if (always) {
    settings.config.approval = 'auto';
    saveSettings();
    if (agent) agent.config.approval = 'auto';
  }
  pendingApprovals.get(id)?.(ok);
  pendingApprovals.delete(id);
  return settings;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 500,
    title: 'Local Codex',
    backgroundColor: '#14161a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  loadSettings();
  store = new ConversationStore(path.join(app.getPath('userData'), 'conversations'));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('before-quit', () => saveConversation());
app.on('window-all-closed', () => {
  agent?.stop();
  if (process.platform !== 'darwin') app.quit();
});
