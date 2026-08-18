/* NEXUS Command Deck — frontend client */
let AGENT_ORDER = []; // derived from the server's configured agent roster
const state = {
  agents: {},          // id -> {name,color,desc,state,task,lastLatencyMs,session}
  target: 'broadcast',
  live: {},            // agentId -> {deltaId, el}
  feedCount: 0,
  pending: [],         // uploaded attachments awaiting send
  settings: null,      // {agents:{id:{model,extraArgs}}, ui:{theme,focusOpacity}}
};

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

/* ── build terminals ── */
function buildDeck(agents) {
  state.agents = agents;
  AGENT_ORDER = Object.keys(agents);
  const quad = $('#quad');
  quad.innerHTML = '';
  const n = AGENT_ORDER.length;
  quad.style.gridTemplateColumns = n === 1 ? '1fr' : '1fr 1fr';
  for (const id of AGENT_ORDER) {
    const a = agents[id];
    if (!a) continue;
    const term = document.createElement('div');
    term.className = 'term';
    term.id = `term-${id}`;
    term.style.setProperty('--ac', a.color);
    term.innerHTML = `
      <div class="term-head" data-agent="${id}" title="点击设定为指挥目标">
        <span class="a-dot idle" id="dot-${id}"></span>
        <span class="a-name">${a.name}</span>
        <span class="a-desc">${a.desc}</span>
        <span class="a-meta">
          <span class="a-latency" id="lat-${id}"></span>
          <button class="a-stop" id="stop-${id}" data-agent="${id}" title="停止当前任务并清空队列">⏹</button>
          ${a.stateless ? '' : `<button class="a-reset" data-agent="${id}" title="清除该 agent 的会话上下文并清空窗口显示">RESET</button>`}
        </span>
      </div>
      <div class="a-task" id="task-${id}"></div>
      <div class="term-body" id="body-${id}"><div class="empty-hint">STANDBY — 等待指令</div></div>`;
    quad.appendChild(term);
  }
  // top LEDs
  $('#top-leds').innerHTML = AGENT_ORDER.map((id) =>
    `<span class="top-led" id="tled-${id}" style="${state.agents[id] ? `background:${state.agents[id].color}22` : ''}" title="${id}"></span>`).join('');

  document.querySelectorAll('.term-head').forEach((h) =>
    h.addEventListener('click', (e) => {
      if (e.target.classList.contains('a-reset')) return;
      setTarget(h.dataset.agent);
    }));
  document.querySelectorAll('.a-reset').forEach((b) =>
    b.addEventListener('click', () => fetch('/api/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: b.dataset.agent }),
    })));
  document.querySelectorAll('.a-stop').forEach((b) =>
    b.addEventListener('click', () => fetch('/api/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: b.dataset.agent }),
    })));
}

/* ── command bar chips ── */
function buildChips() {
  const chips = $('#chips');
  const defs = [['broadcast', 'ALL', 'var(--brand)'], ...AGENT_ORDER.map((id) => [id, state.agents[id]?.name || id.toUpperCase(), state.agents[id]?.color || '#888'])];
  chips.innerHTML = '';
  for (const [id, label, color] of defs) {
    const c = document.createElement('button');
    c.className = 'chip' + (state.target === id ? ' active' : '');
    c.style.setProperty('--cc', color);
    c.textContent = label;
    c.addEventListener('click', () => setTarget(id));
    chips.appendChild(c);
  }
}

function setTarget(id) {
  // clicking the already-focused agent again exits focus back to broadcast
  if (id !== 'broadcast' && state.target === id) id = 'broadcast';
  state.target = id;
  buildChips();
  applyFocus();
  $('#cmd-input').focus();
}

/* ── focus mode: single agent pops up to full window ── */
function applyFocus() {
  const quad = $('#quad');
  const focusing = state.target !== 'broadcast' && state.agents[state.target];
  quad.classList.toggle('focus', !!focusing);
  for (const el of quad.querySelectorAll('.term')) {
    el.classList.toggle('focused', focusing && el.id === `term-${state.target}`);
  }
}

/* ── settings / skins ── */
const THEME_SW = {
  cyber: '#9be7d8',
  light: '#7ccfc0',
  dark: '#b8a9e8',
};
const THEME_LABEL = { cyber: 'CYBER', light: '明亮', dark: '暗黑' };

function applyUI(ui) {
  document.body.dataset.theme = ui.theme === 'cyber' ? '' : ui.theme;
  document.documentElement.style.setProperty('--focus-op', ui.focusOpacity);
  $('#op-val').textContent = `${Math.round(ui.focusOpacity * 100)}%`;
  $('#set-opacity').value = Math.round(ui.focusOpacity * 100);
  document.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('active', s.dataset.theme === ui.theme));
}

function currentUiDraft() {
  return {
    theme: document.querySelector('.swatch.active')?.dataset.theme || state.settings?.ui.theme || 'cyber',
    focusOpacity: Number($('#set-opacity').value) / 100,
  };
}

function buildSettings() {
  const s = state.settings;
  if (!s) return;
  $('#set-agents').innerHTML = AGENT_ORDER.map((id) => {
    const a = state.agents[id];
    const cfg = s.agents[id] || {};
    const extra = (s.fields?.[id] || []).map((f) => {
      const val = cfg[f.key] ?? '';
      const input = f.options
        ? `<select id="sx-${id}-${f.key}" title="${esc(f.label)}">${f.options.map((o) => `<option value="${o.value}"${o.value === val ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : `<input id="sx-${id}-${f.key}" value="${esc(val)}" placeholder="${esc(f.label)}" spellcheck="false">`;
      return input;
    }).join('');
    const rows = 3 + (s.fields?.[id]?.length || 0);
    return `<div class="set-agent" style="--ac:${a?.color || '#888'}">
      <span class="sa-name" style="grid-row: span ${rows}">${a?.name || id.toUpperCase()}</span>
      <input id="sm-${id}" value="${esc(cfg.model || '')}" placeholder="${esc(a?.modelHint || '') || '模型（留空=默认）'}" spellcheck="false">
      <input id="sa-${id}" value="${esc(cfg.extraArgs || '')}" placeholder='附加参数，如 --flag value（原样追加到 CLI）' spellcheck="false">
      <input id="sc-${id}" type="number" min="0" max="4000" step="100" value="${cfg.ctxChars ?? ''}" placeholder="上下文预算字符数（0=关闭注入）" title="注入到该 agent prompt 的共享记忆/上下文预算（字符）">
      ${extra}
    </div>`;
  }).join('');
  $('#set-themes').innerHTML = Object.entries(THEME_SW).map(([t, c]) =>
    `<button class="swatch" data-theme="${t}" style="--sc:${c}">
      <span class="sw-dot" style="background:radial-gradient(circle at 35% 35%, ${c}, ${c}33 70%)"></span>${THEME_LABEL[t] || t.toUpperCase()}
    </button>`).join('');
  document.querySelectorAll('.swatch').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      applyUI(currentUiDraft()); // live preview
    }));
  applyUI(s.ui);
}

async function loadSettings() {
  try {
    state.settings = await (await fetch('/api/settings')).json();
  } catch {
    state.settings = { agents: {}, ui: { theme: 'cyber', focusOpacity: 0.7 } };
  }
  buildSettings();
}

$('#settings-btn').addEventListener('click', () => {
  buildSettings();
  $('#set-status').textContent = '';
  $('#settings-overlay').hidden = false;
});
$('#feed-btn').addEventListener('click', () => {
  const p = $('#feed-panel');
  p.classList.toggle('open');
  $('#feed-btn').classList.toggle('on', p.classList.contains('open'));
});
$('#clear-btn').addEventListener('click', async () => {
  if (!confirm('清除全部窗口的显示内容？\n共享记忆与事件日志（蒸馏源）不受影响。')) return;
  await fetch('/api/display/clear', { method: 'POST' });
});
const closeSettings = (revert) => {
  $('#settings-overlay').hidden = true;
  if (revert && state.settings) applyUI(state.settings.ui); // discard live preview
};
$('#set-close').addEventListener('click', () => closeSettings(true));
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'settings-overlay') closeSettings(true);
});
$('#set-opacity').addEventListener('input', () => applyUI(currentUiDraft()));
$('#set-save').addEventListener('click', async () => {
  const agents = {};
  for (const id of AGENT_ORDER) {
    const ctx = $(`#sc-${id}`).value.trim();
    agents[id] = {
      model: $(`#sm-${id}`).value.trim(),
      extraArgs: $(`#sa-${id}`).value.trim(),
      // empty field keeps the previously saved budget instead of zeroing it
      ctxChars: ctx === '' ? (state.settings?.agents[id]?.ctxChars ?? 900) : Number(ctx),
    };
    for (const f of state.settings?.fields?.[id] || []) {
      const el = $(`#sx-${id}-${f.key}`);
      if (el) agents[id][f.key] = el.value.trim();
    }
  }
  const res = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents, ui: currentUiDraft() }),
  });
  state.settings = await res.json();
  applyUI(state.settings.ui);
  $('#set-status').textContent = 'SAVED ✓（模型/参数对该 agent 的下一条消息生效）';
});

/* ── rendering ── */
function termBody(id) { return $(`#body-${id}`); }

function clearHint(id) {
  const hint = termBody(id)?.querySelector('.empty-hint');
  if (hint) hint.remove();
}

function scrollDown(id) {
  const b = termBody(id);
  if (b) b.scrollTop = b.scrollHeight;
}

// Which terminals display a message?
function terminalsFor(msg) {
  const ids = new Set();
  if (msg.from === 'user') {
    if (msg.to === 'broadcast') AGENT_ORDER.forEach((a) => ids.add(a));
    else ids.add(msg.to);
  } else if (msg.from === 'system') {
    // targeted system notice (reset, per-agent error) → only that terminal;
    // global notice (to 'user') → all terminals
    if (msg.to && state.agents[msg.to]) ids.add(msg.to);
    else AGENT_ORDER.forEach((a) => ids.add(a));
  } else {
    ids.add(msg.from);
    if (msg.kind === 'dispatch' && msg.to && state.agents[msg.to]) ids.add(msg.to);
  }
  return [...ids].filter((a) => state.agents[a]);
}

function attHtml(atts) {
  if (!atts || !atts.length) return '';
  const items = atts.map((a) => {
    if (a.mime.startsWith('image/')) return `<a href="${a.url}" target="_blank"><img class="att-img" src="${a.url}" alt="${esc(a.name)}"></a>`;
    if (a.mime.startsWith('audio/')) return `<audio class="att-media" controls src="${a.url}"></audio>`;
    if (a.mime.startsWith('video/')) return `<video class="att-media" controls src="${a.url}"></video>`;
    return `<a class="att-file" href="${a.url}" download="${esc(a.name)}">⬇ ${esc(a.name)} <span style="opacity:.6">${(a.size / 1024).toFixed(0)}KB</span></a>`;
  }).join('');
  return `<div class="att-row">${items}</div>`;
}

function msgHtml(msg) {
  const a = state.agents[msg.from];
  const color = a ? a.color : msg.from === 'user' ? 'var(--user)' : 'var(--danger)';
  const name = a ? a.name : msg.from.toUpperCase();
  let tag, cls;
  if (msg.kind === 'user') { tag = `YOU → ${msg.to === 'broadcast' ? 'ALL' : (state.agents[msg.to]?.name || msg.to)}`; cls = 'user'; }
  else if (msg.kind === 'dispatch') { tag = `⚡ ${name} → ${state.agents[msg.to]?.name || msg.to}`; cls = 'dispatch'; }
  else if (msg.kind === 'error') { tag = 'SYSTEM'; cls = 'error'; }
  else { tag = name; cls = 'agent'; }
  let meta = fmtTime(msg.ts);
  if (msg.latencyMs) meta += ` · ${(msg.latencyMs / 1000).toFixed(1)}s`;
  if (msg.usage?.costUsd != null) meta += ` · $${msg.usage.costUsd.toFixed(4)}`;
  if (msg.usage?.model) meta += ` · ${msg.usage.model.split('/').pop()}`;
  return `<div class="msg ${cls}" style="--ac:${color}"><span class="m-tag">${esc(tag)}</span>${esc(msg.text)}${attHtml(msg.attachments)}<span class="m-meta">${meta}</span></div>`;
}

function renderMsg(msg) {
  for (const id of terminalsFor(msg)) {
    clearHint(id);
    termBody(id).insertAdjacentHTML('beforeend', msgHtml(msg));
    scrollDown(id);
  }
  addFeed(msg);
}

function addFeed(msg) {
  const feed = $('#feed');
  const a = state.agents[msg.from];
  const name = a ? a.name : msg.from.toUpperCase();
  const color = a ? a.color : msg.from === 'user' ? 'var(--user)' : 'var(--danger)';
  const toName = msg.to === 'broadcast' ? 'ALL' : (state.agents[msg.to]?.name || msg.to || '');
  const preview = msg.text.length > 140 ? msg.text.slice(0, 140) + '…' : msg.text;
  const attMark = msg.attachments?.length ? ` 📎×${msg.attachments.length}` : '';
  feed.insertAdjacentHTML('afterbegin',
    `<div class="f-item ${msg.kind}"><b style="color:${color}">${esc(name)}</b>${toName ? ` → ${esc(toName)}` : ''}${attMark}: ${esc(preview)}<span class="f-time">${fmtTime(msg.ts)}</span></div>`);
  while (feed.children.length > 120) feed.lastChild.remove();
  $('#feed-count').textContent = ++state.feedCount;
  if (msg.kind === 'memo') loadMemories(); // shared memory changed
}

/* ── memory panel ── */
let memTab = 'feed';
function setMemTab(tab) {
  memTab = tab;
  $('#tab-feed').classList.toggle('active', tab === 'feed');
  $('#tab-mem').classList.toggle('active', tab === 'mem');
  $('#feed').hidden = tab !== 'feed';
  $('#mem-panel').hidden = tab !== 'mem';
  if (tab === 'mem') loadMemories();
}
$('#tab-feed').addEventListener('click', () => setMemTab('feed'));
$('#tab-mem').addEventListener('click', () => setMemTab('mem'));

async function loadMemories(q = $('#mem-q').value.trim()) {
  const res = await fetch('/api/memories' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  const { memories, staged = [] } = await res.json();
  if (!q) $('#mem-count').textContent = memories.length
    ? ` ${memories.length}${staged.length ? ` +${staged.length}` : ''}`
    : (staged.length ? ` +${staged.length}` : '');
  const list = $('#mem-list');
  const memItem = (m, stagedMode) => `
    <div class="mem-item${stagedMode ? ' staged' : ''}">
      <div class="m-head">
        <span class="m-kind">${stagedMode ? '🧪 ' : ''}#${m.id} ${esc(m.kind)}</span>
        <span class="m-src">${m.trust === 'user' ? '你' : esc(m.source || 'agent')} · ${fmtTime(m.ts)}</span>
        ${stagedMode ? `<button class="m-ok" data-id="${m.id}" title="批准生效">✓</button>` : ''}
        <button class="m-x" data-id="${m.id}" title="停用（可溯源，不物理删除）">✕</button>
      </div>
      ${esc(m.text)}
    </div>`;
  let html = '';
  if (staged.length && !q) {
    html += `<div class="mem-sec">待审批（蒸馏产物）</div>` + staged.map((m) => memItem(m, true)).join('');
  }
  if (memories.length) html += memories.map((m) => memItem(m, false)).join('');
  if (!html) {
    list.innerHTML = `<div class="mem-empty">${q ? '没有匹配的记忆' : '共享记忆为空<br>用 /remember 或下方输入框写入'}</div>`;
    return;
  }
  list.innerHTML = html;
  list.querySelectorAll('.m-x').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch('/api/memories/retire', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(b.dataset.id) }),
      });
      loadMemories();
    }));
  list.querySelectorAll('.m-ok').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch('/api/memories/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(b.dataset.id) }),
      });
      loadMemories();
    }));
}

let memQTimer = null;
$('#mem-q').addEventListener('input', () => {
  clearTimeout(memQTimer);
  memQTimer = setTimeout(() => loadMemories(), 250);
});

async function addMemoryFromPanel() {
  const text = $('#mem-text').value.trim();
  if (!text) return;
  await fetch('/api/memories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: $('#mem-kind').value, text }),
  });
  $('#mem-text').value = '';
  loadMemories();
}
$('#mem-add-btn').addEventListener('click', addMemoryFromPanel);
$('#mem-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemoryFromPanel(); });

/* ── streaming deltas ── */
function deltaStart({ agent, deltaId, from }) {
  const body = termBody(agent);
  if (!body) return;
  clearHint(agent);
  const el = document.createElement('div');
  el.className = 'msg live';
  el.style.setProperty('--ac', state.agents[agent]?.color || '#fff');
  el.innerHTML = `<span class="m-tag">${esc(state.agents[agent]?.name || agent)}${from !== 'user' ? ' ⚡' : ''}</span><span class="live-text"></span>`;
  body.appendChild(el);
  state.live[agent] = { deltaId, el: el.querySelector('.live-text') };
  scrollDown(agent);
}

function delta({ agent, text }) {
  const l = state.live[agent];
  if (!l) return;
  l.el.textContent = text;
  scrollDown(agent);
}

function deltaEnd({ agent }) {
  const l = state.live[agent];
  if (l) {
    l.el.closest('.msg').remove();
    delete state.live[agent];
  }
}

/* ── status ── */
function renderStatus({ agent, state: st, task, lastLatencyMs }) {
  const dot = $(`#dot-${agent}`);
  if (dot) dot.className = `a-dot ${st}`;
  const term = $(`#term-${agent}`);
  if (term) term.classList.toggle('running', st === 'running' || st === 'queued');
  const taskEl = $(`#task-${agent}`);
  if (taskEl) {
    taskEl.textContent = task ? `▶ ${task}` : '';
    taskEl.classList.toggle('show', !!task);
  }
  const lat = $(`#lat-${agent}`);
  if (lat && lastLatencyMs) lat.textContent = `${(lastLatencyMs / 1000).toFixed(1)}s`;
  const stopBtn = $(`#stop-${agent}`);
  if (stopBtn) stopBtn.classList.toggle('show', st === 'running' || st === 'queued');
  const tled = $(`#tled-${agent}`);
  if (tled) {
    tled.className = `top-led ${st === 'running' ? 'running' : ''}`;
    tled.style.background = st === 'idle' || st === 'running' ? state.agents[agent]?.color : st === 'error' ? 'var(--danger)' : 'var(--line)';
    tled.style.boxShadow = st === 'idle' || st === 'running' ? `0 0 8px ${state.agents[agent]?.color}` : 'none';
  }
}

/* ── SSE ── */
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('init', (e) => {
    const snap = JSON.parse(e.data);
    buildDeck(snap.agents);
    buildChips();
    for (const [id, a] of Object.entries(snap.agents)) renderStatus({ agent: id, ...a });
    $('#feed').innerHTML = '';
    state.feedCount = 0;
    for (const m of snap.messages) renderMsg(m);
    setConn(true);
  });
  es.addEventListener('msg', (e) => renderMsg(JSON.parse(e.data)));
  es.addEventListener('display-clear', (e) => {
    const { agent } = JSON.parse(e.data);
    const clearBody = (id) => {
      const b = termBody(id);
      if (b) b.innerHTML = '<div class="empty-hint">STANDBY — 等待指令</div>';
    };
    if (agent) {
      clearBody(agent);
    } else {
      AGENT_ORDER.forEach(clearBody);
      $('#feed').innerHTML = '';
      state.feedCount = 0;
      $('#feed-count').textContent = '0';
    }
  });
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener('delta-start', (e) => deltaStart(JSON.parse(e.data)));
  es.addEventListener('delta', (e) => delta(JSON.parse(e.data)));
  es.addEventListener('delta-end', (e) => deltaEnd(JSON.parse(e.data)));
  es.onerror = () => setConn(false);
  es.onopen = () => setConn(true);
}

function setConn(on) {
  $('#conn').classList.toggle('on', on);
  $('#conn-text').textContent = on ? 'LINK' : 'DOWN';
}

/* ── attachments ── */
function renderPending() {
  const box = $('#pending-atts');
  box.innerHTML = state.pending.map((a, i) => `
    <span class="pend ${a.uploading ? 'uploading' : ''}">
      ${a.mime?.startsWith('image/') && a.url ? `<img src="${a.url}">` : ''}
      <span class="p-name">${esc(a.name)}</span>
      ${a.uploading ? '<span>…</span>' : `<button class="p-x" data-i="${i}">✕</button>`}
    </span>`).join('');
  box.querySelectorAll('.p-x').forEach((b) =>
    b.addEventListener('click', () => { state.pending.splice(Number(b.dataset.i), 1); renderPending(); }));
}

async function uploadFiles(files) {
  for (const file of files) {
    const placeholder = { name: file.name, mime: file.type || 'application/octet-stream', uploading: true };
    state.pending.push(placeholder);
    renderPending();
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await fetch('/api/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, type: file.type, data }),
      });
      const meta = await res.json();
      if (!res.ok) throw new Error(meta.error || res.statusText);
      Object.assign(placeholder, meta, { uploading: false });
    } catch (err) {
      state.pending = state.pending.filter((p) => p !== placeholder);
      alert(`上传失败: ${file.name} — ${err.message}`);
    }
    renderPending();
  }
}

$('#attach-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = '';
});
const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});
// paste images straight from clipboard
$('#cmd-input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});

/* ── input ── */
function send() {
  const input = $('#cmd-input');
  const text = input.value.trim();
  if (!text && !state.pending.length) return;
  if (state.pending.some((p) => p.uploading)) return; // wait for uploads
  const payload = state.target === 'broadcast' ? text : `@${state.target} ${text}`;
  fetch('/api/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: payload, attachments: state.pending.map((p) => ({ id: p.id })) }),
  });
  state.pending = [];
  renderPending();
  input.value = '';
  autoGrow();
}

function autoGrow() {
  const input = $('#cmd-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

/* shorter placeholder on phones so it doesn't clip in the single-row textarea */
const PHONE_MQ = matchMedia('(max-width: 700px)');
const applyPlaceholder = () => {
  $('#cmd-input').placeholder = PHONE_MQ.matches
    ? '广播到全部；@名 定向；📎 附件…'
    : '广播到全部 agent；@agent名 定向；📎 或拖拽添加附件；Shift+Enter 发送…';
};
PHONE_MQ.addEventListener('change', applyPlaceholder);
applyPlaceholder();

$('#cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); send(); }
});
$('#cmd-input').addEventListener('input', autoGrow);
$('#send-btn').addEventListener('click', send);

/* ── clock ── */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#memmgr-overlay').hidden) $('#memmgr-overlay').hidden = true;
  else if (!$('#settings-overlay').hidden) closeSettings(true);
  else if ($('#feed-panel').classList.contains('open')) {
    $('#feed-panel').classList.remove('open');
    $('#feed-btn').classList.remove('on');
  }
  else if (state.target !== 'broadcast') setTarget('broadcast');
});

/* ── memory manager overlay ── */
let mmFilter = 'all';
async function loadMemMgr() {
  const res = await fetch('/api/memories/all');
  const { memories } = await res.json();
  const shown = mmFilter === 'all' ? memories : memories.filter((m) => m.status === mmFilter);
  $('#mm-count').textContent = `${shown.length} / ${memories.length} 条`;
  const list = $('#mm-list');
  if (!shown.length) { list.innerHTML = '<div class="mm-empty">该分类下没有记忆</div>'; return; }
  list.innerHTML = shown.map((m) => `
    <div class="mm-item ${m.status}" data-id="${m.id}">
      <div class="mm-head">
        <span class="mm-id">#${m.id}</span>
        <span class="mm-status ${m.status}">${m.status}</span>
        <span>${m.trust === 'user' ? '你' : esc(m.source || 'agent')} · ${fmtTime(m.ts)}</span>
        <select class="mm-kind-sel">
          ${['fact', 'decision', 'preference', 'task'].map((k) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${k}</option>`).join('')}
        </select>
      </div>
      <textarea class="mm-text" rows="2" spellcheck="false">${esc(m.text)}</textarea>
      <div class="mm-actions">
        <button class="mm-btn save" data-act="save">保存修改</button>
        ${m.status === 'staged' ? '<button class="mm-btn" data-act="approve">✓ 批准</button>' : ''}
        ${m.status === 'retired' ? '<button class="mm-btn" data-act="restore">♻ 恢复</button>' : ''}
        ${m.status !== 'retired' ? '<button class="mm-btn danger" data-act="retire">✕ 停用</button>' : ''}
      </div>
    </div>`).join('');
  list.querySelectorAll('.mm-item').forEach((item) => {
    const id = Number(item.dataset.id);
    item.querySelectorAll('.mm-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const url = { save: '/api/memories/update', approve: '/api/memories/approve', restore: '/api/memories/restore', retire: '/api/memories/retire' }[act];
        const body = act === 'save'
          ? { id, text: item.querySelector('.mm-text').value, kind: item.querySelector('.mm-kind-sel').value }
          : { id };
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        loadMemMgr();
        loadMemories();
      }));
  });
}
$('#mem-mgr-btn').addEventListener('click', () => { $('#memmgr-overlay').hidden = false; loadMemMgr(); });
$('#mm-close').addEventListener('click', () => { $('#memmgr-overlay').hidden = true; });
$('#memmgr-overlay').addEventListener('click', (e) => { if (e.target.id === 'memmgr-overlay') $('#memmgr-overlay').hidden = true; });
document.querySelectorAll('.mm-chip').forEach((c) =>
  c.addEventListener('click', () => {
    mmFilter = c.dataset.f;
    document.querySelectorAll('.mm-chip').forEach((x) => x.classList.toggle('active', x === c));
    loadMemMgr();
  }));

loadSettings();
loadMemories();
connect();
