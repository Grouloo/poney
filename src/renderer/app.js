import { parseActions, splitThinking, normalizeToolCalls } from '../agent/protocol.js';
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';
import { fmtNum, fmtDuration } from './format.js';
import { markdown, esc } from './markdown.js';
import { documentHtml } from './document.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

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
function scrollDown(force) {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 160;
  if (force || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

// Where new elements go: the transcript, or a sub-agent's card while its events are drawn.
let target = null;

function add(el) {
  $('empty')?.remove();
  (target || transcript).appendChild(el);
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
  document.body.classList.toggle('running', v); // hides the "edit message" buttons
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

// Outside any project, the agent works in a folder of the conversation's own.
const offMode = () => Boolean(settings.active?.offProject);
const activeDir = () => settings.active?.cwd || '';

function renderSettings() {
  $('workspaceLabel').textContent = offMode() ? 'Hors projet' : shortPath(settings.workspace);
  $('workspaceBtn').querySelector('.chip-icon').textContent = offMode() ? '💬' : '📁';
  $('workspaceBtn').title = offMode() ? 'Conversation hors projet (cliquer pour choisir un dossier de projet)' : settings.workspace || 'Choisir un dossier';
  const shellOn = settings.config.shellEnabled !== false;
  $('webEnabled').checked = settings.config.webEnabled !== false;
  $('shellEnabled').checked = shellOn;
  $('autoApprove').checked = settings.config.approval === 'auto';
  $('autoApprove').disabled = !shellOn;
  $('autoApproveLabel').classList.toggle('disabled', !shellOn);
  for (const el of form.elements) {
    if (!el.name || settings.config[el.name] === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings.config[el.name]);
    else el.value = settings.config[el.name];
  }
  $('torEnabled').checked = Boolean(settings.config.torEnabled);
  $('subagentsEnabled').checked = settings.config.subagentsEnabled !== false;
  if (Boolean(torTimer) !== Boolean(settings.config.torEnabled)) scheduleTorStatus();
  const recent = $('recent');
  if (recent) {
    recent.innerHTML = '';
    for (const dir of settings.recent || []) {
      const b = document.createElement('button');
      b.textContent = `📁 ${dir.split(/[\\/]/).filter(Boolean).pop() || dir}`;
      b.title = dir;
      b.onclick = async () => { settings = await window.api.setWorkspace(dir); renderSettings(); onWorkspaceChanged(); };
      recent.appendChild(b);
    }
    const off = document.createElement('button');
    off.textContent = '💬 Hors projet';
    off.title = 'Conversation sans dossier de projet : les fichiers restent dans la conversation';
    off.onclick = () => newConversationIn(null);
    recent.appendChild(off);
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
  let value = el.type === 'number' ? (el.value.trim() === '' ? null : Number(el.value)) : el.type === 'checkbox' ? el.checked : el.value;
  const patch = { [el.name]: value };
  if (el.name === 'provider') {
    patch.baseUrl = value === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1';
    patch.model = '';
  }
  settings = await window.api.setConfig(patch);
  renderSettings();
  refreshGauge();
  if (el.name === 'torProxy') scheduleTorStatus();
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
for (const flag of ['webEnabled', 'shellEnabled', 'torEnabled', 'subagentsEnabled']) {
  $(flag).onchange = async (e) => {
    settings = await window.api.setConfig({ [flag]: e.target.checked });
    renderSettings();
  };
}
// ---------- Tor connection status ----------
let torTimer = null;

function renderTorStatus(s) {
  for (const id of ['torState', 'torStateBig']) $(id).className = `tor-state ${s.state}`;
  $('torState').textContent = s.state === 'bootstrapping' || s.state === 'stuck' ? ` ${s.progress} %`
    : s.state === 'reconnecting' ? ' reconnexion' : s.state === 'degraded' ? ' lent' : '';
  $('torToggleLabel').title = s.state === 'disabled'
    ? 'Recherche web et lecture de pages via Tor (réglages : ⚙︎ › Confidentialité)'
    : `${s.detail}${s.proxy ? ` — ${s.proxy.replace('socks5h://', '')}` : ''}`;
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
  torTimer = null;
  if (!settings.config.torEnabled) {
    renderTorStatus({ state: 'disabled', detail: 'Tor désactivé' });
    return;
  }
  refreshTorStatus();
  torTimer = setInterval(refreshTorStatus, 3000);
}

$('torNewnym').onclick = async () => {
  $('torResult').textContent = 'Demande de nouveaux circuits…';
  const r = await window.api.torNewCircuits();
  $('torResult').textContent = r.ok
    ? 'Nouveaux circuits demandés : les prochaines requêtes les utiliseront.'
    : '✗ Impossible : le port de contrôle de Tor n’est pas accessible.';
  refreshTorStatus();
};
$('torTest').onclick = async () => {
  const out = $('torResult');
  out.textContent = 'Test en cours…';
  const r = await window.api.checkTor();
  out.textContent = r.ok
    ? (r.isTor ? `✓ Connecté via Tor (${r.proxy.replace('socks5h://', '')}), IP de sortie ${r.ip}` : `⚠ Le proxy répond mais le trafic ne sort pas par Tor (IP ${r.ip})`)
    : `✗ ${r.error}`;
};
$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('closeSettings').onclick = () => $('settings').classList.add('hidden');
$('workspaceBtn').onclick = async () => {
  if (running) return;
  const before = activeDir();
  settings = await window.api.chooseWorkspace();
  renderSettings();
  if (activeDir() !== before) onWorkspaceChanged();
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

/** The agent's task list, pinned above the input (hidden when there is none). */
const PLAN_ICON = { pending: '○', running: '<span class="spin">◌</span>', done: '✓', failed: '✕' };
function renderPlan(tasks = []) {
  const panel = $('planPanel');
  panel.classList.toggle('hidden', !tasks.length);
  if (!tasks.length) return;
  const done = tasks.filter((t) => t.status === 'done').length;
  panel.querySelector('.plan-count').textContent = `${done}/${tasks.length}`;
  panel.querySelector('.plan-list').innerHTML = tasks.map((t) =>
    `<li class="${t.status}"><span class="plan-box">${PLAN_ICON[t.status] || '○'}</span><span class="plan-text">${esc(t.text)}</span>${t.agent ? '<span class="tag">sous-agent</span>' : ''}</li>`).join('');
  panel.classList.toggle('all-done', done === tasks.length);
}
$('planPanel').querySelector('.plan-head').onclick = () => $('planPanel').classList.toggle('collapsed');

// ---------- the conversation's memory (notes kept with <remember>) ----------
let memoryNotes = [];
function renderMemory(notes = memoryNotes) {
  memoryNotes = notes;
  $('memoryCount').textContent = String(notes.length);
  $('memoryBtn').classList.toggle('has-notes', notes.length > 0);
  const list = $('memoryList');
  list.innerHTML = notes.length ? '' : '<li class="empty-note">Aucune note pour l’instant.</li>';
  notes.forEach((n, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="memory-text"></span><button class="ghost icon" type="button" title="Retirer cette note">✕</button>';
    li.querySelector('.memory-text').textContent = n;
    li.querySelector('button').onclick = () => saveMemory(memoryNotes.filter((_, k) => k !== i));
    list.appendChild(li);
  });
}
async function saveMemory(notes) {
  try {
    renderMemory(await window.api.setMemory(notes));
  } catch (e) {
    $('status').textContent = errorText(e);
  }
}
$('memoryBtn').onclick = () => $('memoryPanel').classList.toggle('hidden');
$('memoryClose').onclick = () => $('memoryPanel').classList.add('hidden');
$('memoryForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('memoryInput').value.trim();
  if (!v) return;
  $('memoryInput').value = '';
  saveMemory([...memoryNotes, v]);
};

function clearTranscript() {
  renderMemory([]);
  renderPlan([]);
  transcript.innerHTML = '';
  bubbles.clear();
  cards.clear();
  transcript.appendChild(div('msg notice', offMode()
    ? 'Nouvelle conversation hors projet : les fichiers de l’agent restent dans un dossier propre à cette conversation.'
    : `Nouvelle conversation dans ${esc(shortPath(settings.workspace))}`));
}

/** A user message: plain text, with the quoted lines ("> …") shown as quotes. */
function fillUserBubble(bubble, text) {
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

function addUserMessage(text, turnId) {
  if (!target) renderPlan([]); // a plan is the plan of one request
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
function startEditMessage(m, turnId, text) {
  if (running || m.classList.contains('editing')) return;
  m.classList.add('editing');
  const editor = div('msg-editor');
  editor.innerHTML = `<textarea rows="3"></textarea>
    <p class="edit-note">Les messages qui suivent seront supprimés de la conversation. Les fichiers déjà modifiés par l’agent ne sont pas restaurés.</p>
    <div class="edit-actions"><button class="ghost cancel">Annuler</button><button class="primary relaunch">Relancer</button></div>`;
  const area = editor.querySelector('textarea');
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
      editor.querySelector('.edit-error')?.remove();
      editor.querySelector('.edit-actions').before(div('edit-error error', esc(errorText(e))));
      return;
    }
    refreshGauge();
    if (!(await sendMessage(newText))) {
      input.value = newText;
      autosize();
    }
  };
  editor.querySelector('.cancel').onclick = close;
  editor.querySelector('.relaunch').onclick = relaunch;
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); relaunch(); }
  });
}

/** "Resume from here" on the agent's own actions (not the app's checks, not inside a sub-agent). */
function addResumeButton(card, ev) {
  if (target || ev.auto) return;
  const btn = document.createElement('button');
  btn.className = 'resume-btn';
  btn.textContent = '↻ Reprendre d’ici';
  btn.title = 'Relancer cette action et reprendre la conversation à partir d’elle (la suite est retirée)';
  btn.onclick = (e) => { e.stopPropagation(); resumeFromAction(ev.id); };
  card.querySelector('.card-head').appendChild(btn);
}

async function resumeFromAction(id) {
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

function replayTranscript(events) {
  renderPlan([]); // the last plan event of the conversation shows it again
  renderMemory([]); // (same for the memory)
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
  }
  if (!settings.config.model) {
    $('settings').classList.remove('hidden');
    $('status').textContent = 'Choisissez un modèle dans les réglages.';
    return;
  }
  input.value = '';
  autosize();
  // Not sent: the text goes back into the box (unless something new was typed).
  if (!(await sendMessage(text)) && !input.value) {
    input.value = text;
    autosize();
  }
}

async function sendMessage(text) {
  const turnId = crypto.randomUUID();
  addUserMessage(text, turnId);
  setRunning(true);
  try {
    await window.api.send(text, turnId);
    return true;
  } catch (e) {
    add(div('error', esc(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    setRunning(false);
    return false;
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

// ---------- quote a passage of the conversation (select it, then "Citer") ----------
const quoteBtn = document.createElement('button');
quoteBtn.className = 'quote-btn hidden';
quoteBtn.type = 'button';
quoteBtn.textContent = '❝ Citer';
quoteBtn.title = 'Citer ce passage dans votre message';
document.body.appendChild(quoteBtn);
let quoteRange = null;

/** The selected text; formulas give back their LaTeX source instead of their rendering. */
function selectionText(range) {
  const box = document.createElement('div');
  box.appendChild(range.cloneContents());
  box.querySelectorAll('.katex').forEach((k) => {
    const src = k.querySelector('annotation')?.textContent;
    const display = Boolean(k.closest('.katex-display'));
    k.replaceWith(src ? (display ? `$$${src}$$` : `$${src}$`) : k.textContent);
  });
  box.querySelectorAll('.edit-msg, .resume-btn, button').forEach((b) => b.remove());
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
quoteBtn.onclick = () => {
  if (!quoteRange) return;
  const text = selectionText(quoteRange);
  hideQuoteBtn();
  window.getSelection()?.removeAllRanges();
  if (!text) return;
  const quote = text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
  const cur = input.value;
  const sep = !cur ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
  input.value = `${cur}${sep}${quote}\n\n`;
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

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

// Progress of the prompt reading (before the first token), when the server reports it.
let promptProgress = null; // { id, value, t0 }

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

function onPromptProgress(ev) {
  if (!promptProgress || promptProgress.id !== ev.id) promptProgress = { id: ev.id, t0: performance.now(), value: 0 };
  promptProgress.value = ev.progress;
  if (ev.progress >= 1) promptProgress = null;
  // Manual compaction has no running timer: show it directly.
  if (!runTimer && running) $('status').textContent = `Compactage… ${promptProgressText()}`;
}

// Generation in progress (after the prompt was read).
let liveGen = null;

function liveGenText() {
  if (!liveGen || promptProgress) return '';
  const secs = (performance.now() - liveGen.firstAt) / 1000;
  const rate = secs > 1 ? ` · ${fmtNum(liveGen.pieces / secs)} tok/s` : '';
  return `génération ${liveGen.pieces} tokens${rate}`;
}

// Live timer for the whole answer, in the status line.
let runTimer = null;
function startRunTimer() {
  const t0 = performance.now();
  clearInterval(runTimer);
  const tick = () => {
    const extra = promptProgressText() || liveGenText();
    $('status').textContent = `L’agent travaille… ${fmtDuration(performance.now() - t0)}${extra ? ` · ${extra}` : ''}`;
  };
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
    case 'recall': return args.query || '';
    case 'remember': return args.note || '';
    case 'forget': return `note ${args.id || ''}`;
    case 'plan': {
      const n = (args.body || '').split('\n').filter((l) => l.trim()).length;
      return `${n} tâche${n > 1 ? 's' : ''}`;
    }
    default: return args.path || '.';
  }
}

const TOOL_LABEL = { list: 'Lister', read: 'Lire', search: 'Chercher', write: 'Écrire', edit: 'Modifier', run: 'Exécuter', web_search: 'Web', fetch: 'Page web', agent: 'Sous-agent', plan: 'Plan', remember: 'Mémoriser', forget: 'Oublier', recall: 'Retrouver' };

function renderDiff(diff) {
  return `<pre class="diff">${diff.split('\n').map((l) => {
    const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+++') || l.startsWith('---') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('')}</pre>`;
}

function streamingDisplay(raw) {
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
const dirty = new Set();
let drawTimer = null;
let drawCost = 0;

function scheduleDraw(b) {
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
    if (b.thinkingEl) {
      b.thinkingEl.querySelector('summary').textContent = `Réflexion… ${b.thinkPieces} tokens`;
      b.thinkingEl.querySelector('div').textContent = b.thinking;
    }
    const { text, pending } = streamingDisplay(b.raw);
    const tool = b.toolPending && b.toolName ? ` (${esc(b.toolName)})` : '';
    b.bubble.innerHTML = markdown(text) + (pending || b.toolPending ? `<p class="muted"><span class="spin">◌</span> prépare une action${tool}…</p>` : '');
  }
  dirty.clear();
  drawCost = performance.now() - t0;
  scrollDown();
}

function onEvent(ev) {
  // A sub-agent's events are drawn inside its card, with the same rendering.
  if (ev.agentId) {
    const card = cards.get(ev.agentId);
    const log = card?.querySelector('.sub-log');
    if (!log || ev.type === 'final' || ev.type === 'plan' || ev.type === 'memory') return; // (a sub-agent's own plan/memory are not shown)
    if (ev.type === 'delta') {
      card.dataset.tokens = Number(card.dataset.tokens || 0) + 1;
      card.querySelector('.sub-tokens').textContent = `${card.dataset.tokens} tokens`;
    }
    const saved = target;
    target = log;
    try {
      onEvent({ ...ev, agentId: undefined });
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
      bubbles.set(ev.id, { el, bubble, raw: '', thinking: '', thinkingEl: null });
      break;
    }
    case 'delta': {
      // Bubble missing: the window was reloaded during this generation.
      if (!bubbles.has(ev.id)) onEvent({ type: 'assistant_start', id: ev.id });
      const b = bubbles.get(ev.id);
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
        b.thinkPieces = (b.thinkPieces || 0) + 1;
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
      b.bubble.classList.remove('cursor');
      const thinking = (b.thinking + (ev.thinking && !b.thinking ? ev.thinking : '')).trim();
      if (thinking && !b.thinkingEl) {
        b.thinkingEl = document.createElement('details');
        b.thinkingEl.className = 'thinking';
        b.thinkingEl.innerHTML = '<summary>Réflexion</summary><div></div>';
        b.thinkingEl.querySelector('div').textContent = thinking;
        b.el.insertBefore(b.thinkingEl, b.bubble);
      } else if (b.thinkingEl) {
        b.thinkingEl.querySelector('summary').textContent = b.thinkPieces ? `Réflexion (${b.thinkPieces} tokens)` : 'Réflexion';
      }
      if (ev.text) b.bubble.innerHTML = markdown(ev.text);
      else if (!thinking) b.el.remove();
      else b.bubble.remove();
      break;
    }
    case 'action_start': {
      if (ev.tool === 'agent') {
        // Sub-agent card: its task, a live log of its work, then its report.
        const card = div('card subagent running open');
        card.innerHTML = `<div class="card-head"><span class="status"><span class="spin">◌</span></span><span class="tool">Sous-agent</span><span class="summary"></span><span class="tag sub-tokens"></span></div>
          <div class="card-body"><details class="sub-task"><summary>Tâche</summary><pre></pre></details>
          <details class="sub-journal" open><summary>Journal</summary><div class="sub-log"></div></details><div class="sub-report"></div></div>`;
        card.querySelector('.summary').textContent = ev.args.title || 'sous-agent';
        card.querySelector('.sub-task pre').textContent = ev.args.task || '';
        card.querySelector('.card-head').onclick = () => card.classList.toggle('open');
        card.dataset.tool = 'agent';
        addResumeButton(card, ev);
        cards.set(ev.id, card);
        add(card);
        break;
      }
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
      addResumeButton(card, ev);
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
      if (card.dataset.tool === 'agent') {
        // Keep the log (folded), show the report and the figures.
        card.querySelector('.sub-journal').open = false;
        card.querySelector('.sub-report').innerHTML = markdown(ev.output || '');
        const m = ev.meta || {};
        const parts = [m.ms ? fmtDuration(m.ms) : '', m.steps ? `${m.steps} étapes` : ''].filter(Boolean);
        if (parts.length) card.querySelector('.sub-tokens').textContent = parts.join(' · ');
        break;
      }
      const body = card.querySelector('.card-body');
      if (ev.diff) {
        body.innerHTML = renderDiff(ev.diff) + (ev.ok ? '' : `<pre class="out">${esc(ev.output)}</pre>`);
        const added = (ev.diff.match(/^\+(?!\+\+)/gm) || []).length;
        const removed = (ev.diff.match(/^-(?!--)/gm) || []).length;
        card.querySelector('.card-head').insertAdjacentHTML('beforeend', `<span class="tag">+${added} −${removed}</span>`);
      } else {
        body.innerHTML = `<pre class="out">${esc(ev.output)}</pre>`;
      }
      if (ev.meta?.tor) card.querySelector('.card-head').insertAdjacentHTML('beforeend', '<span class="tag" title="Requête passée par Tor">🧅 Tor</span>');
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
    case 'plan':
      renderPlan(ev.tasks);
      break;
    case 'memory':
      renderMemory(ev.notes);
      break;
    case 'noted': {
      // Lasting instructions of the user message, noted in the memory by the app.
      const msg = [...(target || transcript).querySelectorAll('.msg.user')].pop();
      if (!msg) break;
      const d = div('noted');
      d.textContent = `🧠 Noté dans la mémoire : ${ev.notes.map((n) => `« ${n} »`).join(', ')}`;
      d.title = 'Gardé pour toute la conversation (malgré le compactage). Retirable via 🧠 sous la zone de saisie.';
      msg.appendChild(d);
      break;
    }
    case 'recalled': {
      // Passages of the older history attached to the last user message.
      const msg = [...(target || transcript).querySelectorAll('.msg.user')].pop();
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
    case 'prompt_progress':
      if (!replaying) onPromptProgress(ev);
      break;
    case 'compaction_start':
      document.querySelector('.compaction.pending')?.remove();
      add(div('compaction pending', '<span class="spin">◌</span> Compactage du contexte : résumé des anciens messages…'));
      break;
    case 'compaction': {
      if (promptProgress?.id === 'compaction') promptProgress = null;
      document.querySelector('.compaction.pending')?.remove();
      const d = document.createElement('details');
      d.className = 'compaction';
      d.innerHTML = `<summary>🗜 Contexte compacté : ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)} tokens (${ev.removed} messages résumés)${ev.fallback ? ' · résumé de secours' : ''}</summary>${ev.fallback ? `<p class="compaction-why">Le modèle n’a pas pu écrire le résumé (${esc(ev.failure || 'raison inconnue')}) : un résumé de secours a été construit à partir des demandes, du résumé précédent et des dernières notes de l’agent.</p>` : ''}<pre></pre>`;
      d.querySelector('pre').textContent = ev.summary;
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
  bar.innerHTML = '<span></span><button class="no">Refuser</button><button class="always">Toujours autoriser</button><button class="yes">Exécuter</button>';
  bar.querySelector('span').textContent = req.agentTitle ? `Sous-agent « ${req.agentTitle} » : exécuter cette commande ?` : 'Exécuter cette commande ?';
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

// ---------- conversations, grouped by project ----------
const OFF_KEY = '@off-project';
let collapsedGroups = new Set();
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]')); } catch {}
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

async function refreshConversations() {
  if (renaming) return;
  const { current, all, recent } = await window.api.listConversations();
  currentConversation = current;
  // One group per project (those with conversations, the recent ones, the open one), then "Hors projet".
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { key, off: key === OFF_KEY, items: [], latest: 0 });
    return groups.get(key);
  };
  if (settings.workspace) group(settings.workspace);
  for (const dir of recent) group(dir);
  for (const c of all) {
    const g = group(c.offProject ? OFF_KEY : c.workspace);
    g.items.push(c);
    g.latest = Math.max(g.latest, c.updatedAt);
  }
  group(OFF_KEY);
  const ordered = [...groups.values()].filter((g) => !g.off).sort((x, y) => y.latest - x.latest);
  ordered.push(groups.get(OFF_KEY));

  const list = $('convList');
  list.innerHTML = '';
  for (const g of ordered) {
    const activeGroup = g.off ? offMode() : !offMode() && g.key === settings.workspace;
    const collapsed = collapsedGroups.has(g.key) && !activeGroup;
    const li = document.createElement('li');
    li.className = `group${activeGroup ? ' current' : ''}${collapsed ? ' collapsed' : ''}`;
    li.innerHTML = '<div class="group-head"><span class="chev">▾</span><span class="name"></span><span class="count"></span><button class="add" type="button">＋</button></div><ul class="list"></ul>';
    const name = li.querySelector('.name');
    name.textContent = g.off ? '💬 Hors projet' : baseName(g.key);
    name.title = g.off ? 'Conversations sans projet : chacune a son propre dossier de fichiers' : g.key;
    li.querySelector('.count').textContent = collapsed && g.items.length ? String(g.items.length) : '';
    li.querySelector('.add').title = g.off ? 'Nouvelle conversation hors projet' : `Nouvelle conversation dans ${baseName(g.key)}`;
    li.querySelector('.group-head').onclick = () => {
      if (activeGroup) return; // the open project stays unfolded
      if (collapsedGroups.has(g.key)) collapsedGroups.delete(g.key); else collapsedGroups.add(g.key);
      try { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups])); } catch {}
      refreshConversations();
    };
    li.querySelector('.add').onclick = (e) => { e.stopPropagation(); newConversationIn(g.off ? null : g.key); };
    const ul = li.querySelector('ul');
    if (!g.items.length) ul.innerHTML = '<li class="empty-note">Aucune conversation.</li>';
    for (const c of g.items) ul.appendChild(conversationItem(c, current));
    list.appendChild(li);
  }
  const add = document.createElement('li');
  add.className = 'add-project';
  add.textContent = '＋ Ajouter un projet…';
  add.onclick = () => $('workspaceBtn').click();
  list.appendChild(add);
}

/** A new conversation in a project folder, or outside any project (dir null). */
async function newConversationIn(dir) {
  if (running) await window.api.stop();
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
  if (activeDir() !== before) onWorkspaceChanged();
  else {
    clearTranscript();
    refreshConversations();
    refreshPromptBadge();
    refreshGauge();
  }
  input.focus();
}

function conversationItem(c, current) {
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
    if (!confirm(c.offProject
      ? `Supprimer la conversation « ${c.title} » et les fichiers de son dossier ?`
      : `Supprimer la conversation « ${c.title} » ?`)) return;
    try {
      await window.api.deleteConversation(c.id);
    } catch (err) {
      alert(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return;
    }
    if (c.id === current) {
      settings = await window.api.getSettings();
      renderSettings();
      clearTranscript();
      refreshTree();
    }
    refreshConversations();
  };
  return li;
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
  const moved = s.active?.cwd !== activeDir();
  settings = s;
  renderSettings();
  if (moved) {
    expanded.clear();
    refreshTree();
    closeViewer();
  }
  replayTranscript(events);
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
  $('filesRoot').textContent = offMode() ? 'Dossier de la conversation' : shortPath(settings.workspace);
  $('filesRoot').title = activeDir();
  if (!activeDir()) {
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

  const markdownFile = f.kind === 'text' && /\.(md|markdown|mdx)$/i.test(f.path);
  $('viewerMode').classList.toggle('hidden', !markdownFile);
  if (markdownFile && mdView === 'preview') {
    $('viewerMode').textContent = 'Code';
    $('viewerInfo').textContent = `${f.content.split('\n').length} lignes · ${formatSize(f.size)}${f.truncated ? ' · tronqué' : ''}`;
    showDocument(body, f);
  } else if (f.kind === 'text') {
    if (markdownFile) $('viewerMode').textContent = 'Aperçu';
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

// ---------- Markdown documents: formatted view by default, code view on demand ----------
let mdView = 'preview';
try { mdView = localStorage.getItem('mdView') || 'preview'; } catch {}
$('viewerMode').onclick = () => {
  mdView = mdView === 'preview' ? 'code' : 'preview';
  try { localStorage.setItem('mdView', mdView); } catch {}
  if (openPath) openFile(openPath);
};

/** A path relative to the folder of `from` (both relative to the project), or null if outside or not a file. */
function resolveLink(from, href) {
  if (!href || /^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const seg of decodeURI(href.split(/[?#]/)[0]).split('/')) {
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/') || null;
}

function showDocument(body, f) {
  body.innerHTML = '';
  const doc = document.createElement('article');
  doc.className = 'md-doc';
  doc.innerHTML = DOMPurify.sanitize(documentHtml(f.content));
  body.appendChild(doc);
  doc.querySelectorAll('pre code').forEach((el) => {
    const lang = (el.className.match(/language-([\w+-]+)/) || [])[1];
    if (lang && hljs.getLanguage(lang)) el.innerHTML = hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
    el.classList.add('hljs');
  });
  // Images of the project: loaded through the app (remote ones are not loaded).
  doc.querySelectorAll('img').forEach(async (img) => {
    const rel = resolveLink(f.path, img.getAttribute('src'));
    if (!rel) return;
    try {
      const r = await window.api.readFile(rel);
      if (r.kind === 'image') img.src = r.src;
    } catch {}
  });
  // Links: web pages in the browser, project files in the viewer, never in this window.
  doc.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) window.open(href);
    else if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      const h = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((x) => x.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') === id);
      h?.scrollIntoView({ block: 'start' });
    } else {
      const rel = resolveLink(f.path, href);
      if (rel) openFile(rel);
    }
  });
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
    c.serverCtx && c.serverCtx < c.settingCtx
      ? `Le serveur a chargé le modèle avec ${c.serverCtx} tokens de contexte : c’est cette limite qui est utilisée (réglage : ${c.settingCtx})`
      : '',
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
if (session.events.length) {
  replayTranscript(session.events);
  if (session.running) setRunning(true);
}
input.focus();
