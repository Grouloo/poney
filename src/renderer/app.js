import { parseActions, splitThinking } from '../agent/protocol.js';

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
  $('status').textContent = v ? 'L’agent travaille…' : '';
}

// ---------- settings ----------
function shortPath(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : 'Choisir un dossier…';
}

function renderSettings() {
  $('workspaceLabel').textContent = shortPath(settings.workspace);
  $('workspaceBtn').title = settings.workspace || 'Choisir un dossier';
  $('autoApprove').checked = settings.config.approval === 'auto';
  for (const el of form.elements) {
    if (el.name && settings.config[el.name] !== undefined) el.value = settings.config[el.name];
  }
  const recent = $('recent');
  if (recent) {
    recent.innerHTML = '';
    for (const dir of settings.recent || []) {
      const b = document.createElement('button');
      b.textContent = `📁 ${shortPath(dir)}`;
      b.onclick = async () => { settings = await window.api.setWorkspace(dir); renderSettings(); };
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
$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('closeSettings').onclick = () => $('settings').classList.add('hidden');
$('workspaceBtn').onclick = async () => {
  if (running) return;
  const before = settings.workspace;
  settings = await window.api.chooseWorkspace();
  renderSettings();
  if (settings.workspace !== before) clearTranscript();
};
$('newBtn').onclick = async () => {
  if (running) await window.api.stop();
  await window.api.reset();
  clearTranscript();
};

function clearTranscript() {
  transcript.innerHTML = '';
  bubbles.clear();
  cards.clear();
  transcript.appendChild(div('msg notice', `Nouvelle conversation dans ${esc(shortPath(settings.workspace))}`));
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
  const m = div('msg user');
  m.appendChild(div('bubble')).textContent = text;
  add(m);
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
}
input.addEventListener('input', autosize);

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
      card.querySelector('.summary').textContent = summarize(ev.tool, ev.args);
      card.querySelector('.card-head').onclick = () => card.classList.toggle('open');
      if (ev.tool === 'run') card.classList.add('open');
      card.dataset.tool = ev.tool;
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
      if (!ev.ok) card.classList.add('open');
      scrollDown();
      break;
    }
    case 'notice':
      add(div('notice', esc(ev.text)));
      break;
    case 'error':
      add(div('error', esc(ev.message)));
      break;
    case 'turn_end':
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
window.api.onApproval(onApproval);

// ---------- init ----------
settings = await window.api.getSettings();
renderSettings();
refreshModels();
input.focus();
