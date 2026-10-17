import { parseActions, splitThinking } from '../agent/protocol.js';
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';
import { fmtNum, fmtDuration } from './format.js';

const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const input = $('input');
const sendBtn = $('sendBtn');
const modelSelect = $('modelSelect');
const form = $('settingsForm');

let settings = null;
let running = false;
const bubbles = new Map(); // assistant id -> {el, raw, thinking}
const cards = new Map(); // action id -> card element

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function markdown(src) {
  const blocks = [];
  let s = src.replace(/```[\w.+-]*\n?([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6} (.*)$/gm, '<h3>$1</h3>')
    .replace(/(?:^|\n)((?:[-*] .*(?:\n|$))+)/g, (_, list) =>
      `\n<ul>${list.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')}</ul>\n`);
  const html = s.split(/\n{2,}/).map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (/^(<ul>|<h3>|\u0000\d+\u0000$)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

function scrollDown(force) {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 160;
  if (force || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function add(el) {
  $('empty')?.remove();
  transcript.appendChild(el);
  scrollDown(true);
  return el;
}

function div(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

function setRunning(v) {
  running = v;
  sendBtn.textContent = v ? 'Arrêter' : 'Envoyer';
  sendBtn.classList.toggle('stop', v);
  if (v) startRunTimer();
  else {
    stopRunTimer();
    $('status').textContent = '';
  }
}

// ---------- settings ----------
function shortPath(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : 'Choisir un dossier…';
}

function renderSettings() {
  $('workspaceLabel').textContent = shortPath(settings.workspace);
  $('workspaceBtn').title = settings.workspace || 'Choisir un dossier';
  const shellOn = settings.config.shellEnabled !== false;
  $('webEnabled').checked = settings.config.webEnabled !== false;
  $('shellEnabled').checked = shellOn;
  $('autoApprove').checked = settings.config.approval === 'auto';
  $('autoApprove').disabled = !shellOn;
  $('autoApproveLabel').classList.toggle('disabled', !shellOn);
  for (const el of form.elements) {
    if (el.name && settings.config[el.name] !== undefined) el.value = settings.config[el.name];
  }
  const recent = $('recent');
  if (recent) {
    recent.innerHTML = '';
    for (const dir of settings.recent || []) {
      const b = document.createElement('button');
      b.textContent = `📁 ${shortPath(dir)}`;
      b.onclick = async () => { settings = await window.api.setWorkspace(dir); renderSettings(); onWorkspaceChanged(); };
      recent.appendChild(b);
    }
  }
}

async function refreshModels() {
  let models = [];
  try {
    models = await window.api.listModels({});
  } catch (e) {
    $('status').textContent = `Serveur de modèles injoignable (${settings.config.baseUrl})`;
  }
  const current = settings.config.model;
  if (current && !models.includes(current)) models.unshift(current);
  modelSelect.innerHTML = models.length
    ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
    : '<option value="">aucun modèle</option>';
  modelSelect.value = current || models[0] || '';
  $('modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
  if (!current && models[0]) {
    settings = await window.api.setConfig({ model: models[0] });
    renderSettings();
  }
}

form.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.name) return;
  let value = el.type === 'number' ? Number(el.value) : el.value;
  const patch = { [el.name]: value };
  if (el.name === 'provider') {
    patch.baseUrl = value === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1';
    patch.model = '';
  }
  settings = await window.api.setConfig(patch);
  renderSettings();
  refreshGauge();
  if (['provider', 'baseUrl', 'apiKey'].includes(el.name)) refreshModels();
  if (el.name === 'model') refreshModels();
});

modelSelect.addEventListener('change', async () => {
  settings = await window.api.setConfig({ model: modelSelect.value });
  renderSettings();
});
$('refreshModels').onclick = refreshModels;
$('autoApprove').onchange = async (e) => {
  settings = await window.api.setConfig({ approval: e.target.checked ? 'auto' : 'ask' });
  renderSettings();
};
for (const flag of ['webEnabled', 'shellEnabled']) {
  $(flag).onchange = async (e) => {
    settings = await window.api.setConfig({ [flag]: e.target.checked });
    renderSettings();
  };
}
$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('closeSettings').onclick = () => $('settings').classList.add('hidden');
$('workspaceBtn').onclick = async () => {
  if (running) return;
  const before = settings.workspace;
  settings = await window.api.chooseWorkspace();
  renderSettings();
  if (settings.workspace !== before) onWorkspaceChanged();
};
$('newBtn').onclick = async () => {
  if (running) await window.api.stop();
  await window.api.reset();
  clearTranscript();
  refreshConversations();
  refreshPromptBadge();
  refreshGauge();
};

function onWorkspaceChanged() {
  clearTranscript();
  closeViewer();
  expanded.clear();
  refreshConversations();
  refreshTree();
  refreshPromptBadge();
  refreshGauge();
}

function clearTranscript() {
  transcript.innerHTML = '';
  bubbles.clear();
  cards.clear();
  transcript.appendChild(div('msg notice', `Nouvelle conversation dans ${esc(shortPath(settings.workspace))}`));
}

function addUserMessage(text) {
  const m = div('msg user');
  m.appendChild(div('bubble')).textContent = text;
  add(m);
}

// ---------- sending ----------
async function submit() {
  if (running) {
    await window.api.stop();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  if (!settings.workspace) {
    settings = await window.api.chooseWorkspace();
    renderSettings();
    if (!settings.workspace) return;
  }
  if (!settings.config.model) {
    $('settings').classList.remove('hidden');
    $('status').textContent = 'Choisissez un modèle dans les réglages.';
    return;
  }
  input.value = '';
  autosize();
  addUserMessage(text);
  setRunning(true);
  try {
    await window.api.send(text);
  } catch (e) {
    add(div('error', esc(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    setRunning(false);
  }
}

sendBtn.onclick = submit;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
}
input.addEventListener('input', autosize);

// ---------- generation timing ----------

function formatStats(s) {
  return [fmtDuration(s.totalMs), `${s.exact ? '' : '≈'}${s.tokens} tokens`, `${fmtNum(s.tps)} tok/s`].join(' · ');
}

function statsDetails(s) {
  return [
    `Durée totale de la réponse : ${fmtDuration(s.totalMs)} (${s.steps} appel${s.steps > 1 ? 's' : ''} au modèle, outils compris)`,
    `Génération : ${fmtDuration(s.genMs)} pour ${s.tokens} tokens${s.exact ? '' : ' (en partie estimés : le flux est arrêté après chaque action)'}`,
    `Vitesse moyenne de génération : ${fmtNum(s.tps)} tokens/s`,
    `Lecture du prompt : ${fmtDuration(s.promptMs)}`,
  ].join('\n');
}

// Live timer for the whole answer, in the status line.
let runTimer = null;
function startRunTimer() {
  const t0 = performance.now();
  clearInterval(runTimer);
  const tick = () => { $('status').textContent = `L’agent travaille… ${fmtDuration(performance.now() - t0)}`; };
  tick();
  runTimer = setInterval(tick, 100);
}
function stopRunTimer() {
  clearInterval(runTimer);
  runTimer = null;
}

// ---------- rendering agent events ----------
function summarize(tool, args) {
  switch (tool) {
    case 'run': return args.command || '';
    case 'web_search': return args.query || '';
    case 'fetch': return args.url || '';
    case 'search': return `${args.pattern || ''}  ${args.path ? `in ${args.path}` : ''}`;
    case 'read': return `${args.path || ''}${args.start ? `:${args.start}-${args.end || ''}` : ''}`;
    default: return args.path || '.';
  }
}

const TOOL_LABEL = { list: 'Lister', read: 'Lire', search: 'Chercher', write: 'Écrire', edit: 'Modifier', run: 'Exécuter', web_search: 'Web', fetch: 'Page web' };

function renderDiff(diff) {
  return `<pre class="diff">${diff.split('\n').map((l) => {
    const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('')}</pre>`;
}

function streamingDisplay(raw) {
  // Hide tool tags while streaming; show only the prose.
  const visible = splitThinking(raw).text;
  const { text, actions } = parseActions(visible, { final: false });
  const pending = actions.some((a) => !a.complete);
  return { text: text.replace(/<[a-z_]*$/, ''), pending };
}

function onEvent(ev) {
  switch (ev.type) {
    case 'assistant_start': {
      const el = div('msg assistant');
      const bubble = div('bubble cursor');
      el.appendChild(bubble);
      add(el);
      bubbles.set(ev.id, { el, bubble, raw: '', thinking: '', thinkingEl: null });
      break;
    }
    case 'delta': {
      const b = bubbles.get(ev.id);
      if (!b) break;
      if (ev.kind === 'thinking') {
        b.thinking += ev.text;
        if (!b.thinkingEl) {
          b.thinkingEl = document.createElement('details');
          b.thinkingEl.className = 'thinking';
          b.thinkingEl.innerHTML = '<summary>Réflexion…</summary><div></div>';
          b.el.insertBefore(b.thinkingEl, b.bubble);
        }
        b.thinkingEl.querySelector('div').textContent = b.thinking;
      } else {
        b.raw += ev.text;
        const { text, pending } = streamingDisplay(b.raw);
        b.bubble.innerHTML = markdown(text) + (pending ? '<p class="muted"><span class="spin">◌</span> prépare une action…</p>' : '');
      }
      scrollDown();
      break;
    }
    case 'assistant_end': {
      const b = bubbles.get(ev.id);
      if (!b) break;
      b.bubble.classList.remove('cursor');
      const thinking = (b.thinking + (ev.thinking && !b.thinking ? ev.thinking : '')).trim();
      if (thinking && !b.thinkingEl) {
        b.thinkingEl = document.createElement('details');
        b.thinkingEl.className = 'thinking';
        b.thinkingEl.innerHTML = '<summary>Réflexion</summary><div></div>';
        b.thinkingEl.querySelector('div').textContent = thinking;
        b.el.insertBefore(b.thinkingEl, b.bubble);
      } else if (b.thinkingEl) {
        b.thinkingEl.querySelector('summary').textContent = 'Réflexion';
      }
      if (ev.text) b.bubble.innerHTML = markdown(ev.text);
      else if (!thinking) b.el.remove();
      else b.bubble.remove();
      break;
    }
    case 'action_start': {
      const card = div('card running');
      card.innerHTML = `<div class="card-head"><span class="status"><span class="spin">◌</span></span><span class="tool">${esc(TOOL_LABEL[ev.tool] || ev.tool)}</span><span class="summary"></span>${ev.auto ? '<span class="tag">vérification auto</span>' : ''}</div><div class="card-body"><pre class="out"></pre></div>`;
      const summaryEl = card.querySelector('.summary');
      summaryEl.textContent = summarize(ev.tool, ev.args);
      if (['read', 'write', 'edit'].includes(ev.tool) && ev.args.path) {
        summaryEl.classList.add('link');
        summaryEl.title = 'Ouvrir dans le visualiseur';
        summaryEl.onclick = (e) => { e.stopPropagation(); openFile(ev.args.path.trim()); };
      }
      card.querySelector('.card-head').onclick = () => card.classList.toggle('open');
      if (ev.tool === 'run') card.classList.add('open');
      card.dataset.tool = ev.tool;
      card.dataset.path = ev.args.path || '';
      cards.set(ev.id, card);
      add(card);
      break;
    }
    case 'action_output': {
      const card = cards.get(ev.id);
      if (!card) break;
      const pre = card.querySelector('.out');
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
      card.querySelector('.status').textContent = ev.ok ? '✓' : '✗';
      card.querySelector('.approval')?.remove();
      const body = card.querySelector('.card-body');
      if (ev.diff) {
        body.innerHTML = renderDiff(ev.diff) + (ev.ok ? '' : `<pre class="out">${esc(ev.output)}</pre>`);
        const added = (ev.diff.match(/^\+(?!\+\+)/gm) || []).length;
        const removed = (ev.diff.match(/^-(?!--)/gm) || []).length;
        card.querySelector('.card-head').insertAdjacentHTML('beforeend', `<span class="tag">+${added} −${removed}</span>`);
      } else {
        body.innerHTML = `<pre class="out">${esc(ev.output)}</pre>`;
      }
      if (ev.meta?.exit !== undefined) {
        card.querySelector('.card-head').insertAdjacentHTML('beforeend', `<span class="tag">exit ${ev.meta.exit}</span>`);
      }
      if (card.dataset.tool === 'run' && ev.ok) card.classList.remove('open');
      if (!replaying && ['write', 'edit', 'run'].includes(card.dataset.tool)) {
        onFilesChanged(ev.meta?.path || (card.dataset.tool !== 'run' ? card.dataset.path : null));
      }
      if (!ev.ok) card.classList.add('open');
      scrollDown();
      break;
    }
    case 'notice':
      add(div('notice', esc(ev.text)));
      break;
    case 'context':
      if (!replaying) renderGauge(ev);
      break;
    case 'compaction_start':
      document.querySelector('.compaction.pending')?.remove();
      add(div('compaction pending', '<span class="spin">◌</span> Compactage du contexte : résumé des anciens messages…'));
      break;
    case 'compaction': {
      document.querySelector('.compaction.pending')?.remove();
      const d = document.createElement('details');
      d.className = 'compaction';
      d.innerHTML = `<summary>🗜 Contexte compacté : ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)} tokens (${ev.removed} messages résumés)</summary><pre></pre>`;
      d.querySelector('pre').textContent = ev.summary;
      add(d);
      break;
    }
    case 'error':
      add(div('error', esc(ev.message)));
      break;
    case 'user_message':
      addUserMessage(ev.text);
      break;
    case 'turn_end':
      // One timing line for the whole answer, not one per tool call.
      if (ev.stats) {
        const meta = div('gen-meta', esc(formatStats(ev.stats) + (ev.reason === 'stopped' ? ' · interrompu' : '')));
        meta.title = statsDetails(ev.stats);
        add(meta);
      }
      if (replaying) break;
      setRunning(false);
      for (const b of bubbles.values()) b.bubble.classList.remove('cursor');
      input.focus();
      break;
  }
}

function onApproval(req) {
  const card = cards.get(req.id);
  if (!card) return;
  card.classList.add('open');
  const bar = div('approval');
  bar.innerHTML = '<span>Exécuter cette commande ?</span><button class="no">Refuser</button><button class="always">Toujours autoriser</button><button class="yes">Exécuter</button>';
  bar.querySelector('.yes').onclick = () => { bar.remove(); window.api.approve(req.id, true, false); };
  bar.querySelector('.no').onclick = () => { bar.remove(); window.api.approve(req.id, false, false); };
  bar.querySelector('.always').onclick = async () => {
    bar.remove();
    settings = await window.api.approve(req.id, true, true);
    renderSettings();
  };
  card.appendChild(bar);
  bar.querySelector('.yes').focus();
  scrollDown(true);
}

window.api.onEvent(onEvent);
window.api.onConversationsChanged(() => refreshConversations());
window.api.onApproval(onApproval);

// ---------- sidebar ----------
let replaying = false;
let currentConversation = null;

$('sidebarBtn').onclick = () => document.body.classList.toggle('no-sidebar');
for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tabs button')) {
      t.classList.toggle('active', t === tab);
      $(t.dataset.tab).classList.toggle('hidden', t !== tab);
    }
  };
}

function relativeTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'hier';
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

let renaming = false; // a title is being edited: don't rebuild the list under the cursor

async function refreshConversations() {
  if (renaming) return;
  const { current, items } = await window.api.listConversations();
  currentConversation = current;
  const list = $('convList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<li class="empty-note">${settings.workspace ? 'Aucune conversation dans ce dossier.' : 'Choisissez un dossier.'}</li>`;
    return;
  }
  for (const c of items) {
    const li = document.createElement('li');
    li.classList.toggle('active', c.id === current);
    li.innerHTML = '<span class="title"></span><span class="when"></span><button class="ren" title="Renommer">✎</button><button class="del" title="Supprimer">✕</button>';
    li.querySelector('.title').textContent = c.title;
    li.querySelector('.title').title = c.title;
    li.querySelector('.when').textContent = relativeTime(c.updatedAt);
    li.onclick = () => openConversation(c.id);
    li.querySelector('.ren').onclick = (e) => { e.stopPropagation(); startRename(li, c); };
    li.querySelector('.title').ondblclick = (e) => { e.stopPropagation(); startRename(li, c); };
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Supprimer la conversation « ${c.title} » ?`)) return;
      try {
        await window.api.deleteConversation(c.id);
      } catch (err) {
        alert(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        return;
      }
      if (c.id === current) clearTranscript();
      refreshConversations();
    };
    list.appendChild(li);
  }
}

function startRename(li, c) {
  if (renaming) return;
  renaming = true;
  const span = li.querySelector('.title');
  const inp = document.createElement('input');
  inp.className = 'rename';
  inp.value = c.title;
  inp.maxLength = 80;
  span.replaceWith(inp);
  li.classList.add('editing');
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
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

async function openConversation(id) {
  if (running || id === currentConversation) return;
  const { events, settings: s } = await window.api.openConversation(id);
  if (s.workspace !== settings.workspace) {
    settings = s;
    renderSettings();
    expanded.clear();
    refreshTree();
    closeViewer();
  }
  transcript.innerHTML = '';
  bubbles.clear();
  cards.clear();
  replaying = true;
  try {
    for (const ev of events) onEvent(ev);
  } finally {
    replaying = false;
  }
  transcript.scrollTop = transcript.scrollHeight;
  refreshConversations();
  refreshPromptBadge();
  refreshGauge();
  input.focus();
}

// ---------- file tree ----------
const expanded = new Set(); // expanded directory paths
let openPath = null;

async function renderDir(rel, ul) {
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
    const node = div(`node${e.ignored ? ' ignored' : ''}${e.path === openPath ? ' active' : ''}`);
    node.dataset.path = e.path;
    node.innerHTML = `<span class="caret">${e.dir ? (expanded.has(e.path) ? '▾' : '▸') : ''}</span><span>${e.dir ? '📁' : fileIcon(e.name)}</span><span class="name"></span>`;
    node.querySelector('.name').textContent = e.name;
    node.title = e.path;
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
        node.querySelector('.caret').textContent = expanded.has(e.path) ? '▾' : '▸';
      };
    } else {
      node.onclick = () => openFile(e.path);
    }
    ul.appendChild(li);
  }
  if (!entries.length && rel === '.') ul.innerHTML = '<li class="node muted">Dossier vide</li>';
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return '🖼';
  if (['md', 'txt', 'rst'].includes(ext)) return '📝';
  return '📄';
}

let treeRefresh = null;
async function refreshTree() {
  $('filesRoot').textContent = shortPath(settings.workspace);
  if (!settings.workspace) {
    $('fileTree').innerHTML = '';
    return;
  }
  await renderDir('.', $('fileTree'));
}
$('refreshFiles').onclick = refreshTree;

/** Called after the agent writes/edits/runs: refresh the tree and the open file. */
function onFilesChanged(changedPath) {
  if (changedPath) {
    // Reveal the changed file in the tree.
    const parts = changedPath.split('/');
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  }
  clearTimeout(treeRefresh);
  treeRefresh = setTimeout(async () => {
    await refreshTree();
    if (changedPath) document.querySelector(`.tree .node[data-path="${CSS.escape(changedPath)}"]`)?.classList.add('flash');
  }, 150);
  if (openPath && (!changedPath || changedPath === openPath)) openFile(openPath, { keepScroll: true });
}

// ---------- viewer ----------
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', json: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sql: 'sql', lua: 'lua', r: 'r', dockerfile: 'dockerfile', makefile: 'makefile',
};

function formatSize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function closeViewer() {
  openPath = null;
  $('viewer').classList.add('hidden');
  document.querySelectorAll('.tree .node.active').forEach((n) => n.classList.remove('active'));
}

async function openFile(rel, { keepScroll = false } = {}) {
  const body = $('viewerBody');
  const scroll = keepScroll && rel === openPath ? body.scrollTop : 0;
  let f;
  try {
    f = await window.api.readFile(rel);
  } catch (e) {
    if (keepScroll) return; // file deleted meanwhile: leave the viewer as is
    f = { path: rel, kind: 'error', message: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  openPath = f.path;
  $('viewer').classList.remove('hidden');
  $('viewerPath').textContent = f.path;
  $('viewerPath').title = f.path;
  document.querySelectorAll('.tree .node').forEach((n) => n.classList.toggle('active', n.dataset.path === f.path));

  if (f.kind === 'text') {
    const lines = f.content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    $('viewerInfo').textContent = `${lines.length} lignes · ${formatSize(f.size)}${f.truncated ? ' · tronqué' : ''}`;
    const name = f.path.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : name;
    const lang = EXT_LANG[ext];
    let html;
    if (f.content.length > 400_000) html = esc(f.content);
    else if (lang && hljs.getLanguage(lang)) html = hljs.highlight(f.content, { language: lang, ignoreIllegals: true }).value;
    else html = hljs.highlightAuto(f.content.slice(0, 100_000)).value + esc(f.content.slice(100_000));
    body.innerHTML = '<div class="code-view"><div class="gutter"></div><pre><code class="hljs"></code></pre></div>';
    body.querySelector('.gutter').textContent = lines.map((_, i) => i + 1).join('\n');
    body.querySelector('code').innerHTML = html;
  } else if (f.kind === 'image') {
    $('viewerInfo').textContent = formatSize(f.size);
    body.innerHTML = '';
    const img = document.createElement('img');
    img.src = f.src;
    img.alt = f.path;
    body.appendChild(img);
  } else {
    $('viewerInfo').textContent = f.size !== undefined ? formatSize(f.size) : '';
    const msg = { binary: 'Fichier binaire : aperçu indisponible.', large: 'Fichier trop volumineux pour l’aperçu.' }[f.kind] || f.message;
    body.innerHTML = `<div class="center">${esc(msg)}</div>`;
  }
  body.scrollTop = scroll;
}

$('viewerClose').onclick = closeViewer;
$('viewerReload').onclick = () => openPath && openFile(openPath, { keepScroll: true });
$('viewerOpen').onclick = () => openPath && window.api.openFileExternal(openPath);
$('viewerReveal').onclick = () => openPath && window.api.revealFile(openPath);

// ---------- system prompt ----------
const promptDialog = $('promptDialog');
let promptInfo = null;

const errorText = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function refreshPromptBadge() {
  try {
    promptInfo = await window.api.getSystemPrompt();
  } catch {
    promptInfo = null;
  }
  $('promptBadge').classList.toggle('hidden', !promptInfo?.custom);
}

function updatePromptMeta() {
  const text = $('promptText').value;
  const custom = text.trim() !== promptInfo.default.trim();
  $('promptState').textContent = custom ? 'personnalisé' : 'par défaut';
  $('promptState').classList.toggle('custom', custom);
  $('promptTokens').textContent = `≈ ${Math.ceil(text.length / 3.2)} tokens`;
  $('promptReset').disabled = !custom;
}

$('promptBtn').onclick = async () => {
  try {
    promptInfo = await window.api.getSystemPrompt();
  } catch (e) {
    $('status').textContent = errorText(e);
    return;
  }
  $('promptText').value = promptInfo.custom ?? promptInfo.default;
  $('promptNote').textContent = [
    'Ce prompt s’applique uniquement à la conversation en cours et est enregistré avec elle.',
    'Un prompt personnalisé est utilisé tel quel : il ne suit plus les interrupteurs Web / Terminal ni la commande de test (les outils désactivés restent bloqués).',
    promptInfo.running ? 'L’agent travaille : la modification s’appliquera au prochain message.' : '',
  ].filter(Boolean).join(' ');
  updatePromptMeta();
  promptDialog.showModal();
  $('promptText').focus();
  $('promptText').setSelectionRange(0, 0);
  $('promptText').scrollTop = 0;
};
$('promptText').addEventListener('input', updatePromptMeta);
$('promptReset').onclick = () => {
  $('promptText').value = promptInfo.default;
  updatePromptMeta();
};
$('promptCancel').onclick = () => promptDialog.close();
$('promptCloseX').onclick = () => promptDialog.close();
$('promptSave').onclick = async () => {
  try {
    promptInfo = await window.api.setSystemPrompt($('promptText').value);
  } catch (e) {
    $('promptNote').textContent = errorText(e);
    return;
  }
  $('promptBadge').classList.toggle('hidden', !promptInfo.custom);
  promptDialog.close();
  refreshGauge();
};

// ---------- context gauge ----------
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function renderGauge(c) {
  const g = $('ctxGauge');
  if (!c) {
    g.querySelector('.gauge-text').textContent = 'contexte';
    g.querySelector('.gauge-fill').style.width = '0';
    g.title = '';
    return;
  }
  const pct = Math.min(100, (c.used / c.numCtx) * 100);
  g.querySelector('.gauge-fill').style.width = `${pct}%`;
  g.querySelector('.gauge-mark').style.left = `${(c.compactAt / c.numCtx) * 100}%`;
  g.querySelector('.gauge-text').textContent = `${fmtTokens(c.used)} / ${fmtTokens(c.numCtx)}`;
  g.classList.toggle('warn', c.used >= c.compactAt * 0.85);
  g.classList.toggle('full', c.used >= c.limit);
  g.title = [
    `Contexte utilisé (estimé) : ${c.used} tokens sur ${c.numCtx}`,
    `Compactage automatique seulement quand l’appel suivant ne tiendrait plus : vers ${c.compactAt} tokens (trait vertical)`,
    c.calibrated ? 'Estimation calibrée sur les comptes du serveur (marge 4 %)' : 'Estimation pas encore calibrée (marge 8 %)',
    c.measured ? `Dernière mesure du serveur : ${c.measured} tokens` : '',
    'Cliquer pour compacter maintenant',
  ].filter(Boolean).join('\n');
}

async function refreshGauge() {
  try {
    renderGauge(await window.api.getContext());
  } catch {
    renderGauge(null);
  }
}

$('ctxGauge').onclick = async () => {
  if (running) return;
  if (!confirm('Compacter maintenant ? Les anciens messages seront remplacés par un résumé (le fil affiché reste intact).')) return;
  setRunning(true);
  stopRunTimer();
  $('status').textContent = 'Compactage…';
  let message = '';
  try {
    const r = await window.api.compactContext();
    if (!r.compacted) message = r.reason || 'Rien à compacter.';
  } catch (e) {
    document.querySelector('.compaction.pending')?.remove();
    add(div('error', esc(errorText(e))));
  } finally {
    setRunning(false);
    $('status').textContent = message;
    refreshGauge();
  }
};

// ---------- init ----------
settings = await window.api.getSettings();
renderSettings();
refreshModels();
refreshConversations();
refreshTree();
refreshPromptBadge();
refreshGauge();
input.focus();
