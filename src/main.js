import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, DEFAULT_CONFIG } from './agent/agent.js';
import { listModels } from './agent/llm.js';

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
    agent.on('event', (ev) => send('agent:event', ev));
  }
  agent.config = { ...DEFAULT_CONFIG, ...settings.config };
  return agent;
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
  agent?.reset();
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
ipcMain.handle('agent:send', async (_, text) => {
  const a = getAgent();
  if (a.running) throw new Error('L’agent est déjà en cours d’exécution.');
  // Events stream back through 'agent:event'.
  a.send(text).catch((e) => send('agent:event', { type: 'error', message: e.message }));
  return true;
});
ipcMain.handle('agent:stop', () => {
  resolveApprovals(false);
  agent?.stop();
});
ipcMain.handle('agent:reset', () => {
  resolveApprovals(false);
  agent?.reset();
});
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
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => {
  agent?.stop();
  if (process.platform !== 'darwin') app.quit();
});
