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
// Linkify already-escaped text: after esc() there are no raw <>"' left, so
// matching [^\s]+ is XSS-safe; trailing punctuation/entities are excluded.
const linkify = (s) => s.replace(/https?:\/\/[^\s]+/g, (m) => {
  const t = m.match(/(&quot;|&#39;|[).,;:!?\]"'])+$/);
  const url = t ? m.slice(0, -t[0].length) : m;
  const trail = t ? t[0] : '';
  return `<a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
});
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

/* ── build terminals ── */
// Effective model label: settings override (snapshot's `model`) wins; empty
// means the CLI default — fall back to the config's modelHint base text.
const modelLabel = (a) => a.model || (a.modelHint || '').replace(/\s*\(.*$/, '').trim();

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
      <div class="term-head" data-agent="${id}" title="Click to set as command target">
        <span class="a-dot idle" id="dot-${id}"></span>
        <span class="a-name">${a.name}</span>
        <span class="a-desc">${a.desc}</span>
        <span class="a-meta">
          <span class="a-latency" id="lat-${id}"></span>
          <button class="a-stop" id="stop-${id}" data-agent="${id}" title="Stop current task and clear the queue"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
          <span class="a-model" id="model-${id}">${esc(modelLabel(a))}</span>
        </span>
      </div>
      <div class="a-task" id="task-${id}"></div>
      <div class="term-body${a.terminal ? ' xterm-host' : ''}" id="body-${id}">${a.terminal ? '' : '<div class="empty-hint">STANDBY — awaiting orders</div>'}</div>`;
    quad.appendChild(term);
  }
  for (const id of AGENT_ORDER) if (state.agents[id]?.terminal) initXterm(id);
  if (kbState.focused) kbSetFocused(kbState.focused); // hosts were rebuilt — restore highlight
  // top LEDs
  $('#top-leds').innerHTML = AGENT_ORDER.map((id) =>
    `<span class="top-led" id="tled-${id}" style="${state.agents[id] ? `background:${state.agents[id].color}22` : ''}" title="${id}"></span>`).join('');

  document.querySelectorAll('.term-head').forEach((h) =>
    h.addEventListener('click', () => setTarget(h.dataset.agent)));
  document.querySelectorAll('.a-stop').forEach((b) =>
    b.addEventListener('click', () => fetch('/api/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: b.dataset.agent }),
    })));
}

/* ── embedded real terminals (agents with terminal:true) ── */
const xterms = {}; // id -> { term, fit, ws }

// Terminal text follows the deck's --text so light theme stays readable;
// background stays transparent so the .term panel gradient shows through.
function xtermFg() {
  return getComputedStyle(document.body).getPropertyValue('--text').trim() || '#dbe7ff';
}

function doFit(id) {
  const x = xterms[id];
  if (!x) return;
  try { x.fit.fit(); } catch { return; }
  if (x.ws && x.ws.readyState === 1) {
    x.ws.send(JSON.stringify({ type: 'resize', cols: x.term.cols, rows: x.term.rows }));
  }
}

function initXterm(id) {
  const host = $(`#body-${id}`);
  if (!host || typeof Terminal === 'undefined') return;
  // Deck rebuilds (e.g. SSE reconnect) destroy the host element — dispose the
  // stale instance; the ws reconnect replays server-side scrollback.
  if (xterms[id]) {
    try { xterms[id].ws?.close(); xterms[id].term.dispose(); } catch { /* already gone */ }
    delete xterms[id];
  }
  const accent = state.agents[id]?.color || '#00f0ff';
  const term = new Terminal({
    fontFamily: '"SF Mono", "Menlo", "JetBrains Mono", monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
    theme: {
      background: '#00000000',
      foreground: xtermFg(),
      cursor: accent,
      selectionBackground: '#3b4a6b88',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  if (typeof WebLinksAddon !== 'undefined') term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(host);
  xterms[id] = { term, fit, ws: null };

  const connectWs = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/term/${id}`);
    xterms[id].ws = ws;
    ws.onopen = () => doFit(id);
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string' && d[0] === '{') {
        try { if (JSON.parse(d).type === 'hello') return; } catch { /* raw output */ }
      }
      term.write(d);
    };
    ws.onclose = () => setTimeout(connectWs, 2000);
  };
  term.onData((d) => {
    const ws = xterms[id].ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'in', data: d }));
  });
  attachTouchScroll(id, term, host);
  // soft keybar integration: track which terminal owns the bar's keystrokes,
  // and let the Ctrl latch rewrite the next key event into a control sequence
  term.textarea?.addEventListener('focus', () => kbSetFocused(id));
  host.addEventListener('pointerdown', () => kbSetFocused(id));
  term.attachCustomKeyEventHandler((ev) => kbKeyEvent(term, ev));
  connectWs();
  new ResizeObserver(() => doFit(id)).observe(host);
}

/* ── touch scrolling for embedded terminals (iPad/iPhone) ── */
// xterm.js only scrolls its viewport on wheel events; touch drags do nothing.
// Single-finger vertical drag on a terminal translates to:
//   - SGR mouse-wheel sequences sent to the PTY when the app reports mouse
//     tracking (Claude Code TUI does — this scrolls its conversation view);
//   - term.scrollLines() otherwise (normal buffer with scrollback).
// A long-press that stays put (>450ms, <10px) is left alone so xterm's own
// touch text-selection still works.
function attachTouchScroll(id, term, host) {
  let active = false, selecting = false, lastY = 0, acc = 0, moved = 0, t0 = 0;
  const sendWheel = (dir, col, row) => {
    const ws = xterms[id]?.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'in', data: `\x1b[<${dir};${col};${row}M` }));
  };
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { active = false; return; }
    active = true; selecting = false;
    lastY = e.touches[0].clientY; acc = 0; moved = 0; t0 = Date.now();
  }, { passive: true });
  host.addEventListener('touchmove', (e) => {
    if (!active || selecting || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dy = lastY - touch.clientY;
    lastY = touch.clientY;
    moved += Math.abs(dy);
    if (moved < 10 && Date.now() - t0 > 450) { selecting = true; return; } // long-press selection
    if (moved < 8) return; // tap jitter
    e.preventDefault(); // host has touch-action:none; stop xterm selection too
    const rect = host.getBoundingClientRect();
    const cellH = rect.height / Math.max(term.rows, 1);
    acc += dy;
    const col = Math.max(1, Math.min(term.cols, Math.floor((touch.clientX - rect.left) / (rect.width / Math.max(term.cols, 1))) + 1));
    const row = Math.max(1, Math.min(term.rows, Math.floor((touch.clientY - rect.top) / cellH) + 1));
    const mouseOn = term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none';
    while (Math.abs(acc) >= cellH) {
      const notch = acc > 0 ? 1 : -1; // drag up → scroll down
      acc -= notch * cellH;
      if (mouseOn) sendWheel(notch > 0 ? 65 : 64, col, row);
      else term.scrollLines(notch);
    }
  }, { passive: false });
  host.addEventListener('touchend', () => { active = false; }, { passive: true });
  host.addEventListener('touchcancel', () => { active = false; }, { passive: true });
}

/* ── soft keybar (touch devices: ESC / Ctrl / arrows for real terminals) ── */
// One global bar docked above the command bar; it targets the terminal that
// last had focus. CTRL is a sticky latch: tap it, then the next key (bar key
// or software/hardware keyboard) is sent as a control sequence. Buttons use
// pointerdown + preventDefault so tapping them never steals terminal focus
// (which would collapse the iPad software keyboard).
const kbState = { ctrl: false, shift: false, focused: null };

const KB_ROWS = [
  [
    { label: 'ESC', seq: '\x1b' },
    { label: 'TAB', seq: '\t', sseq: '\x1b[Z' },
    { label: 'CTRL', latch: 'ctrl' },
    { label: 'SHIFT', latch: 'shift' },
    { label: '←', seq: '\x1b[D', cseq: '\x1b[1;5D', sseq: '\x1b[1;2D', csseq: '\x1b[1;6D' },
    { label: '↑', seq: '\x1b[A', cseq: '\x1b[1;5A', sseq: '\x1b[1;2A', csseq: '\x1b[1;6A' },
    { label: '↓', seq: '\x1b[B', cseq: '\x1b[1;5B', sseq: '\x1b[1;2B', csseq: '\x1b[1;6B' },
    { label: '→', seq: '\x1b[C', cseq: '\x1b[1;5C', sseq: '\x1b[1;2C', csseq: '\x1b[1;6C' },
  ],
  [
    { label: '^C', seq: '\x03', title: 'Ctrl+C — interrupt' },
    { label: '^D', seq: '\x04', title: 'Ctrl+D — EOF' },
    { label: '^Z', seq: '\x1a', title: 'Ctrl+Z — suspend' },
    { label: '^V', seq: '\x16', title: 'Ctrl+V — paste' },
    { label: '⇧TAB', seq: '\x1b[Z', title: 'Shift+Tab — cycle Claude Code modes' },
    { label: 'HOME', seq: '\x1b[H', sseq: '\x1b[1;2H' },
    { label: 'END', seq: '\x1b[F', sseq: '\x1b[1;2F' },
    { label: 'PG↑', seq: '\x1b[5~', sseq: '\x1b[5;2~' },
    { label: 'PG↓', seq: '\x1b[6~', sseq: '\x1b[6;2~' },
  ],
];

const KB_ARROWS = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

function kbTarget() {
  if (kbState.focused && xterms[kbState.focused]) return kbState.focused;
  if (xterms[state.target]) return state.target;
  return Object.keys(xterms)[0] || null;
}

function kbSetFocused(id) {
  if (!xterms[id]) return;
  kbState.focused = id;
  document.querySelectorAll('.term.kb-focus').forEach((el) => el.classList.remove('kb-focus'));
  $(`#term-${id}`)?.classList.add('kb-focus');
}

function kbSetCtrl(on) {
  kbState.ctrl = on;
  $('#keybar .kb-latch[data-latch="ctrl"]')?.classList.toggle('active', on);
}

function kbSetShift(on) {
  kbState.shift = on;
  $('#keybar .kb-latch[data-latch="shift"]')?.classList.toggle('active', on);
}

function kbInput(seq) {
  const id = kbTarget();
  if (!id) return;
  xterms[id].term.input(seq); // fires onData → ws, same path as real typing
}

// Custom key event handler installed on every xterm: when a latch (Ctrl /
// Shift) is armed, rewrite the next real key into its modified form and
// swallow it. Ctrl+Shift+arrow combines (modifier param 6).
function kbKeyEvent(term, ev) {
  if ((!kbState.ctrl && !kbState.shift) || ev.type !== 'keydown') return true;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return true; // real modifiers win
  let seq = null;
  const arrow = KB_ARROWS[ev.key];
  if (arrow) {
    const m = kbState.ctrl && kbState.shift ? 6 : kbState.ctrl ? 5 : 2;
    seq = `\x1b[1;${m}${arrow}`;
  } else if (kbState.ctrl && ev.key.length === 1) {
    const code = ev.key.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) seq = String.fromCharCode(code & 0x1f);
  } else if (kbState.shift && ev.key.length === 1 && /^[a-z]$/i.test(ev.key)) {
    seq = ev.key.toUpperCase();
  }
  if (!seq) return true; // unmappable key (a modifier itself etc.) — keep latches armed
  term.input(seq);
  kbSetCtrl(false);
  kbSetShift(false);
  return false;
}

function buildKeybar() {
  const bar = $('#keybar');
  bar.innerHTML = KB_ROWS.map((row) =>
    `<div class="kb-row">${row.map((k) =>
      `<button class="kb-key${k.latch ? ' kb-latch' : ''}"${k.latch ? ` data-latch="${k.latch}"` : ''} tabindex="-1"${k.title ? ` title="${k.title}"` : ''}>${k.label}</button>`
    ).join('')}</div>`
  ).join('') + '<button class="kb-key kb-hide" tabindex="-1" title="Hide soft keyboard">✕</button>';

  bar.querySelectorAll('.kb-row').forEach((rowEl, r) => {
    rowEl.querySelectorAll('.kb-key').forEach((btn, c) => {
      const key = KB_ROWS[r][c];
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep terminal focus / software keyboard open
        if (key.latch === 'ctrl') { kbSetCtrl(!kbState.ctrl); return; }
        if (key.latch === 'shift') { kbSetShift(!kbState.shift); return; }
        const seq = kbState.ctrl && kbState.shift && key.csseq ? key.csseq
          : kbState.ctrl && key.cseq ? key.cseq
          : kbState.shift && key.sseq ? key.sseq
          : key.seq;
        kbInput(seq);
        if (kbState.ctrl) kbSetCtrl(false);
        if (kbState.shift) kbSetShift(false);
      });
    });
  });
  bar.querySelector('.kb-hide').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    kbSetCtrl(false);
    kbSetShift(false);
    kbShow(false);
  });

  $('#kb-pill').addEventListener('click', () => kbShow(true));

  // Default: visible on touch-primary devices, hidden elsewhere;
  // a manual toggle persists and overrides the default.
  const pref = localStorage.getItem('nexus.keybar');
  const coarse = matchMedia('(pointer: coarse)').matches;
  kbShow(pref ? pref === 'show' : coarse, true);

  // Dock the strip below the topbar, aligned with the deck's top edge.
  const setTop = () => { bar.style.top = `${$('#topbar').offsetHeight + 12}px`; };
  setTop();
  addEventListener('resize', setTop);

  // Keep the bar above the iPad software keyboard (visualViewport shrinks).
  const vv = window.visualViewport;
  if (vv) {
    const lift = () => {
      const off = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      bar.style.transform = off ? `translateY(${-off}px)` : '';
      $('#kb-pill').style.transform = off ? `translateY(${-off}px)` : '';
    };
    vv.addEventListener('resize', lift);
    vv.addEventListener('scroll', lift);
  }
}

function kbShow(on, init) {
  $('#keybar').hidden = !on;
  $('#kb-pill').hidden = on;
  document.body.classList.toggle('kb-open', on);
  if (!init) localStorage.setItem('nexus.keybar', on ? 'show' : 'hide');
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
  document.body.classList.toggle('focus-mode', !!focusing);
  for (const el of quad.querySelectorAll('.term')) {
    el.classList.toggle('focused', focusing && el.id === `term-${state.target}`);
  }
  // xterm needs a refit after the layout change
  setTimeout(() => AGENT_ORDER.forEach((id) => { if (xterms[id]) doFit(id); }), 80);
}

/* ── settings / skins ── */
const THEME_SW = {
  cyber: '#9be7d8',
  light: '#5b84d6',
  dark: '#b8a9e8',
};
const THEME_LABEL = { cyber: 'CYBER', light: 'LIGHT', dark: 'DARK' };

function applyUI(ui) {
  document.body.dataset.theme = ui.theme === 'cyber' ? '' : ui.theme;
  document.documentElement.style.setProperty('--focus-op', ui.focusOpacity);
  $('#op-val').textContent = `${Math.round(ui.focusOpacity * 100)}%`;
  $('#set-opacity').value = Math.round(ui.focusOpacity * 100);
  document.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('active', s.dataset.theme === ui.theme));
  const fg = xtermFg();
  for (const id in xterms) xterms[id].term.options.theme = { ...xterms[id].term.options.theme, foreground: fg };
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
      <input id="sm-${id}" value="${esc(cfg.model || '')}" placeholder="${esc(a?.modelHint || '') || 'model (empty = default)'}" spellcheck="false">
      <input id="sa-${id}" value="${esc(cfg.extraArgs || '')}" placeholder='extra args, e.g. --flag value (appended to CLI as-is)' spellcheck="false">
      <input id="sc-${id}" type="number" min="0" max="4000" step="100" value="${cfg.ctxChars ?? ''}" placeholder="context budget in chars (0 = disable injection)" title="Shared-memory/context budget (chars) injected into this agent's prompt">
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
/* ── feed panel toggle ── */
// Mobile/tablet (≤1100px): the panel is an overlay drawer — hidden by default,
// .open slides it in. Desktop: the panel sits in-flow — visible by default,
// .closed collapses it so the terminals take the space. Desktop state persists.
const feedDrawerMQ = matchMedia('(max-width: 1100px)');
const feedPanelEl = $('#feed-panel');
try {
  if (localStorage.getItem('nexus.feed') === 'closed') feedPanelEl.classList.add('closed');
} catch { /* storage unavailable */ }
const feedVisible = () => feedDrawerMQ.matches
  ? feedPanelEl.classList.contains('open')
  : !feedPanelEl.classList.contains('closed');
$('#feed-btn').classList.toggle('on', feedVisible());
$('#feed-btn').addEventListener('click', () => {
  if (feedDrawerMQ.matches) {
    feedPanelEl.classList.toggle('open');
  } else {
    feedPanelEl.classList.toggle('closed');
    try { localStorage.setItem('nexus.feed', feedPanelEl.classList.contains('closed') ? 'closed' : 'open'); } catch { /* non-fatal */ }
  }
  $('#feed-btn').classList.toggle('on', feedVisible());
});
$('#refresh-btn').addEventListener('click', () => location.reload());
$('#clear-btn').addEventListener('click', async () => {
  if (!confirm('Clear all window displays?\nShared memory and the event log (distill source) are not affected.')) return;
  await fetch('/api/display/clear', { method: 'POST' });
});

/* ── completion notifications ── */
// Browser Notification for agent task completion. Toggle persisted in
// localStorage; fires only when the deck is hidden/unfocused. Terminal-mode
// agents (real PTYs) never emit reply events, so only headless agents notify.
let notifOn = localStorage.getItem('nexusNotify') === '1';
const notifSupported = 'Notification' in window;
function syncNotifBtn() {
  const b = $('#notif-btn');
  const live = notifOn && notifSupported && Notification.permission === 'granted';
  b.classList.toggle('on', live);
  b.title = !notifSupported ? 'Notifications not supported in this browser'
    : Notification.permission === 'denied' ? 'Notifications blocked by the browser (check site settings)'
    : `Notify when an agent finishes (${live ? 'on' : 'off'})`;
}
$('#notif-btn').addEventListener('click', async () => {
  if (!notifSupported) return;
  if (!notifOn) {
    if (Notification.permission === 'default') await Notification.requestPermission();
    notifOn = Notification.permission === 'granted';
  } else {
    notifOn = false;
  }
  localStorage.setItem('nexusNotify', notifOn ? '1' : '0');
  syncNotifBtn();
});
function maybeNotify(msg) {
  if (!notifOn || !notifSupported || Notification.permission !== 'granted') return;
  if (msg.kind !== 'reply' && msg.kind !== 'error') return;
  if (!document.hidden && document.hasFocus()) return; // you're already looking at it
  const a = state.agents[msg.from];
  const title = a ? `${a.name} ✓ task done` : '⚠ NEXUS system';
  const meta = msg.latencyMs ? ` (${(msg.latencyMs / 1000).toFixed(1)}s)` : '';
  const n = new Notification(title + meta, { body: msg.text.replace(/\s+/g, ' ').slice(0, 140) });
  n.onclick = () => { window.focus(); n.close(); };
}
syncNotifBtn();
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
  // refresh model labels in the term heads without waiting for an SSE re-init
  for (const id of AGENT_ORDER) {
    if (state.agents[id]) {
      state.agents[id].model = state.settings.agents[id]?.model || state.settings.models?.[id] || '';
      const el = $(`#model-${id}`);
      if (el) el.textContent = modelLabel(state.agents[id]);
    }
  }
  $('#set-status').textContent = "SAVED ✓ (model/args apply to this agent's next message)";
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
  return [...ids].filter((a) => state.agents[a] && !state.agents[a].terminal);
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
  return `<div class="msg ${cls}" style="--ac:${color}"><span class="m-tag">${esc(tag)}</span>${linkify(esc(msg.text))}${attHtml(msg.attachments)}<span class="m-meta">${meta}</span></div>`;
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
    `<div class="f-item ${msg.kind}"><b style="color:${color}">${esc(name)}</b>${toName ? ` → ${esc(toName)}` : ''}${attMark}: ${linkify(esc(preview))}<span class="f-time">${fmtTime(msg.ts)}</span></div>`);
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
        <span class="m-src">${m.trust === 'user' ? 'you' : esc(m.source || 'agent')} · ${fmtTime(m.ts)}</span>
        ${stagedMode ? `<button class="m-ok" data-id="${m.id}" title="Approve">✓</button>` : ''}
        <button class="m-x" data-id="${m.id}" title="Retire (kept for audit, not deleted)">✕</button>
      </div>
      ${esc(m.text)}
    </div>`;
  let html = '';
  if (staged.length && !q) {
    html += `<div class="mem-sec">Pending approval (distilled)</div>` + staged.map((m) => memItem(m, true)).join('');
  }
  if (memories.length) html += memories.map((m) => memItem(m, false)).join('');
  if (!html) {
    list.innerHTML = `<div class="mem-empty">${q ? 'No matching memories' : 'Shared memory is empty<br>Add one with /remember or the input below'}</div>`;
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

function deltaEnd({ agent, keep }) {
  const l = state.live[agent];
  if (l) {
    const msgEl = l.el.closest('.msg');
    const text = l.el.textContent || '';
    if (keep && text.trim()) {
      // process transcript (e.g. dsh CoT): freeze as a collapsed block
      // instead of dropping it when the final reply lands
      const det = document.createElement('details');
      det.className = 'process-log';
      const sum = document.createElement('summary');
      sum.textContent = `💭 思考过程（${text.length} 字）`;
      const pre = document.createElement('pre');
      pre.textContent = text;
      det.appendChild(sum);
      det.appendChild(pre);
      l.el.replaceWith(det);
      msgEl.classList.remove('live');
      msgEl.classList.add('process');
    } else {
      msgEl.remove();
    }
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
    // Return focus to command input after terminal initialization
    setTimeout(() => $('#cmd-input').focus(), 100);
  });
  es.addEventListener('msg', (e) => { const m = JSON.parse(e.data); renderMsg(m); maybeNotify(m); });
  es.addEventListener('display-clear', (e) => {
    const { agent } = JSON.parse(e.data);
    const clearBody = (id) => {
      if (state.agents[id]?.terminal) return; // live PTY content, not message history
      const b = termBody(id);
      if (b) b.innerHTML = '<div class="empty-hint">STANDBY — awaiting orders</div>';
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
      alert(`Upload failed: ${file.name} — ${err.message}`);
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
    ? 'Broadcast to all; @name to target; 📎 attach…'
    : 'Broadcast to all agents; @name to target; 📎 or drop attachments; Shift+Enter to send…';
};
PHONE_MQ.addEventListener('change', applyPlaceholder);
applyPlaceholder();

$('#cmd-input').addEventListener('focus', () => {
  // Blur any xterm terminal textarea so keyboard input goes to cmd-input
  document.querySelectorAll('.xterm-helper-textarea').forEach((ta) => ta.blur());
});
$('#cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); send(); }
});
$('#cmd-input').addEventListener('input', autoGrow);
$('#send-btn').addEventListener('click', send);

/* ── clock ── */
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);

/* ── host machine label (shown under // COMMAND DECK) ── */
fetch('/api/host').then((r) => r.json()).then(({ label }) => {
  if (label) $('#brand-host').textContent = label.toUpperCase();
}).catch(() => {});

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
  $('#mm-count').textContent = `${shown.length} / ${memories.length} items`;
  const list = $('#mm-list');
  if (!shown.length) { list.innerHTML = '<div class="mm-empty">No memories in this category</div>'; return; }
  list.innerHTML = shown.map((m) => `
    <div class="mm-item ${m.status}" data-id="${m.id}">
      <div class="mm-head">
        <span class="mm-id">#${m.id}</span>
        <span class="mm-status ${m.status}">${m.status}</span>
        <span>${m.trust === 'user' ? 'you' : esc(m.source || 'agent')} · ${fmtTime(m.ts)}</span>
        <select class="mm-kind-sel">
          ${['fact', 'decision', 'preference', 'task'].map((k) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${k}</option>`).join('')}
        </select>
      </div>
      <textarea class="mm-text" rows="2" spellcheck="false">${esc(m.text)}</textarea>
      <div class="mm-actions">
        <button class="mm-btn save" data-act="save">Save</button>
        ${m.status === 'staged' ? '<button class="mm-btn" data-act="approve">✓ Approve</button>' : ''}
        ${m.status === 'retired' ? '<button class="mm-btn" data-act="restore">♻ Restore</button>' : ''}
        ${m.status !== 'retired' ? '<button class="mm-btn danger" data-act="retire">✕ Retire</button>' : ''}
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
buildKeybar();
connect();
