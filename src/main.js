import { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeImage, nativeTheme } from 'electron';
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
let settings = { config: { ...DEFAULT_CONFIG }, workspace: '', recent: [], projectIcons: {} };

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
    this.unread = conv?.unread ?? 0; // answers finished in the background, not seen since (saved with the conversation)
    this.finished = false; // finished while shown: stays with the finished ones until the user leaves it
    this.draft = conv?.draft ?? ''; // what is typed in the input, not sent
    this.draftTimer = null;
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
        triage: true, // the assessment before acting, on unless the conversation's steps turn it off
        config: settings.config,
        approve: (req) => new Promise((resolve) => {
          this.approvals.set(req.id, { req, resolve });
          if (this === active) send('agent:approval', { ...req, session: this.key });
          send('sessions:changed');
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
      this.finished = ev.type === 'turn_end';
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
    this.saveTimer = null;
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
    if (this.draft.trim()) conv.draft = this.draft;
    else delete conv.draft;
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
      this.conv = null;
      return;
    }
    this.save({ touch: false });
  }

  resolveApprovals(value) {
    for (const { resolve } of this.approvals.values()) resolve(value);
    if (this.approvals.size) send('sessions:changed');
    this.approvals.clear();
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
const saveAll = () => { for (const s of sessions.values()) s.keepDraft(); };

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
    draft: s.draft,
    session: s.key,
    settings: publicSettings(),
  };
}

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:setConfig', (_, patch) => {
  settings.config = { ...settings.config, ...patch };
  saveSettings();
  nativeTheme.themeSource = settings.config.theme;
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
// A project's icon, shown on its conversations and in the sidebar: an emoji
// ({ emoji }), an icon of the window's set in a color ({ icon, color }), a small
// picture ({ image }: a data URL), or none (null).
// The key is the project's folder, or '@off-project' for the conversations outside projects.
ipcMain.handle('project:setIcon', (_, key, icon) => {
  const emoji = typeof icon?.emoji === 'string' ? [...icon.emoji.trim()].slice(0, 8).join('') : '';
  const name = typeof icon?.icon === 'string' && /^[a-z-]{1,24}$/.test(icon.icon) ? icon.icon : '';
  const color = typeof icon?.color === 'string' && /^#[0-9a-f]{6}$/i.test(icon.color) ? icon.color : undefined;
  settings.projectIcons = { ...settings.projectIcons };
  if (emoji) settings.projectIcons[key] = { emoji };
  else if (name) settings.projectIcons[key] = { icon: name, color };
  else delete settings.projectIcons[key];
  saveSettings();
  return publicSettings();
});
ipcMain.handle('project:pickIcon', async (_, key) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns'] }] });
  if (r.canceled || !r.filePaths[0]) return publicSettings();
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Image illisible.');
  settings.projectIcons = { ...settings.projectIcons, [key]: { image: img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL() } };
  saveSettings();
  return publicSettings();
});
// The text menu's commands, on the focused field or the selection.
ipcMain.handle('ui:edit', (_, cmd, arg) => {
  const wc = win?.webContents;
  if (!wc) return;
  if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(cmd)) wc[cmd]();
  else if (cmd === 'replace') wc.replaceMisspelling(String(arg));
  else if (cmd === 'learn') wc.session.addWordToSpellCheckerDictionary(String(arg));
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
  if (s.conv.titleFromDraft) {
    s.conv.title = ConversationStore.cleanTitle(text) || s.conv.title;
    delete s.conv.titleFromDraft;
  }
  s.draft = '';
  clearTimeout(s.draftTimer);
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

// Every conversation, with its project, and where it stands: working, waiting for
// approvals (how many), finished (answers not seen yet), or done and read.
ipcMain.handle('conversations:list', () => {
  const all = store.listAll();
  for (const c of all) {
    const s = sessions.get(c.id);
    if (!s) continue;
    c.unread = s.unread;
    c.approvals = s.approvals.size;
    c.running = s.running;
    c.finished = s.finished;
    c.draft = Boolean(s.draft.trim());
  }
  return { current: active?.key ?? null, all };
});
// A new conversation outside any project (the agent works in a folder of its own).
ipcMain.handle('conversations:newOffProject', () => {
  const id = ConversationStore.newId();
  const dir = path.join(offProjectRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  activate(new Session({ id, cwd: dir, offProject: true }));
  return publicSettings();
});
ipcMain.handle('session:current', () => sessionView(current()));
// What is typed in the input of the conversation shown (saved soon, and when the user leaves it).
ipcMain.handle('session:setDraft', (_, text) => {
  const s = current();
  s.draft = String(text ?? '');
  clearTimeout(s.draftTimer);
  if (s.conv) s.draftTimer = setTimeout(() => s.save({ touch: false }), 2000);
});
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
  a.steps = loaded.steps ?? null;
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
    delete s.conv.titleFromDraft;
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

// Conversations marked as read: no answer left to read, so they go to the archived ones.
ipcMain.handle('conversations:markRead', (_, ids) => {
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
ipcMain.handle('project:delete', (_, dir) => {
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
  for (const id of ids) store.delete(id);
  settings.recent = (settings.recent || []).filter((d) => d !== dir);
  settings.projectIcons = { ...settings.projectIcons };
  delete settings.projectIcons[dir];
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
ipcMain.handle('memory:get', () => (activeCwd() ? current().getAgent().memory : []));
ipcMain.handle('memory:set', (_, notes) => {
  const s = current();
  const a = s.getAgent();
  if (a.running) throw new Error('L’agent est en cours d’exécution.');
  a.setMemory(notes); // (its 'memory' event is recorded with the conversation)
  s.save();
  return a.memory;
});

// Steps the agent does before and after answering, set per conversation.
ipcMain.handle('steps:get', () => (activeCwd() ? current().getAgent().steps : null));
ipcMain.handle('steps:set', (_, steps) => {
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
ipcMain.handle('agent:approve', (_, { id, ok, always, reason }) => {
  if (always) {
    settings.config.approval = 'auto';
    saveSettings();
    for (const s of sessions.values()) if (s.agent) s.agent.config.approval = 'auto';
  }
  // (the approval may belong to any session)
  for (const s of sessions.values()) {
    const p = s.approvals.get(id);
    if (!p) continue;
    p.resolve(!ok && reason?.trim() ? { ok: false, reason: String(reason).slice(0, 2000) } : ok);
    s.approvals.delete(id);
    send('sessions:changed');
  }
  return publicSettings();
});

function createWindow() {
  win = new BrowserWindow({
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
  // Right click on text (a selection, the input): the window draws its own menu,
  // with the spelling suggestions only this side knows.
  // Three fingers (macOS, when the system's "Swipe between pages" allows them): one sidebar or the other.
  win.on('swipe', (_, direction) => {
    if (direction === 'left' || direction === 'right') send('ui:swipe', direction);
  });
  win.webContents.on('context-menu', (_, p) => send('ui:contextMenu', {
    x: p.x, y: p.y, isEditable: p.isEditable, selectionText: p.selectionText,
    misspelledWord: p.misspelledWord, suggestions: p.dictionarySuggestions, editFlags: p.editFlags,
  }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Electron's default menus, plus the settings and the renaming; ⌘R is the renaming, not a reload. */
function appMenu() {
  const toWindow = (channel) => () => {
    if (win && !win.isDestroyed()) return send(channel);
    createWindow();
    win.webContents.once('did-finish-load', () => send(channel));
  };
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
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
    }] : []),
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
  ]));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(here, '..', 'assets', 'icon.png'));
  appMenu();
  loadSettings();
  nativeTheme.themeSource = settings.config.theme;
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
