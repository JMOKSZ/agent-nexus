import WebSocket from 'ws';
import { homedir } from 'node:os';
import { attachmentNote } from '../runner.mjs';

// DeepSeek Harness via `dsh web`: this adapter talks to the running browser
// surface (127.0.0.1:3080) over its RPC + events.mux protocol instead of
// spawning `dsh --profile headless` one-shots. The web GUI session is the
// conversation: messages sent from NEXUS appear in the dsh web browser UI,
// and the model's live CoT is streamed back through the mux event stream.
//
// dsh web itself is kept running by launchd (com.agent-nexus.dsh-web) — no
// manual terminal needed.

const WEB_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
const WS_URL = `${WEB_BASE.replace(/^http/, 'ws')}/api/events.mux`;
const TIMEOUT_MS = 600_000;
const POLL_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, payload, rpcId = crypto.randomUUID()) {
  const res = await fetch(`${WEB_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload,
    }),
  });
  if (!res.ok) throw new Error(`dsh web RPC ${method} → HTTP ${res.status}`);
  const body = await res.json();
  if (!body.result?.ok) {
    const err = body.result?.error || {};
    const e = new Error(`${method} failed: ${err.code || 'error'}: ${err.message || ''}`);
    e.code = err.code;
    e.details = err.details;
    throw e;
  }
  return body.result.value;
}

async function ensureSession(sessionId, workdir) {
  if (sessionId) {
    try {
      await rpc('session.history', { sessionId, maxMessages: 1 });
      return sessionId;
    } catch (err) {
      if (err.code !== 'session-not-found') throw err;
    }
  }
  const created = await rpc('session.create', { cwd: workdir || homedir() });
  try {
    await rpc('session.rename', { sessionId: created.sessionId, title: 'NEXUS · DSH' });
  } catch { /* non-fatal */ }
  return created.sessionId;
}

function shortArgs(name, argsJson) {
  try {
    const a = JSON.parse(argsJson);
    const v = a.command ?? a.file_path ?? a.path ?? a.query ?? a.url ?? Object.values(a)[0];
    return String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return String(argsJson || '').replace(/\s+/g, ' ').slice(0, 160);
  }
}

// Rebuild the live transcript from a (possibly partial) session event list.
// Idempotent: same blocks/tools keyed by turn:step:index / callId.
function renderTranscript(events) {
  const blocks = new Map();
  const tools = new Map();
  let order = 0;
  const blockAt = (turn, step, index, kind) => {
    const key = `${turn}:${step}:${index}`;
    if (!blocks.has(key)) blocks.set(key, { kind, text: '', order: order++ });
    return blocks.get(key);
  };
  for (const ev of events) {
    const d = ev.data || {};
    if (ev.type === 'assistant/chunk') {
      const c = d.chunk || {};
      if (c.type === 'block-start') {
        blockAt(d.turn, d.step, c.index, c.blockType === 'reasoning' ? 'reasoning' : 'text');
      } else if (c.type === 'reasoning-delta' || c.type === 'text-delta') {
        blockAt(d.turn, d.step, c.index, c.type === 'reasoning-delta' ? 'reasoning' : 'text').text += c.text || '';
      } else if (c.type === 'block-end' && c.block) {
        const b = blockAt(d.turn, d.step, c.index, c.block.type === 'reasoning' ? 'reasoning' : 'text');
        if (c.block.text) b.text = c.block.text;
      }
    } else if (ev.type === 'tool/call') {
      if (d.callId && !tools.has(d.callId)) {
        tools.set(d.callId, `🔧 ${d.name || 'tool'}: ${shortArgs(d.name, d.arguments)}`);
      }
    } else if (ev.type === 'assistant/message') {
      (d.message?.content || []).forEach((blk, i) => {
        if ((blk.type === 'reasoning' || blk.type === 'text') && blk.text) {
          blockAt(d.turn, d.step, i, blk.type).text = blk.text;
        }
      });
    } else if (ev.type === 'reasoning-chunks' || ev.type === 'text-chunks') {
      const kind = ev.type === 'reasoning-chunks' ? 'reasoning' : 'text';
      blockAt(d.turn, d.step, d.index, kind).text += (d.texts || []).join('');
    }
  }
  const lines = [];
  for (const b of [...blocks.values()].sort((a, z) => a.order - z.order)) {
    if (!b.text.trim()) continue;
    lines.push(b.kind === 'reasoning' ? '💭 ' + b.text.trim() : b.text.trim());
  }
  lines.push(...tools.values());
  return lines.join('\n\n');
}

function finalReply(events) {
  let text = '';
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue;
    const content = ev.data?.message?.content || [];
    const t = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (t) text = t;
  }
  return text;
}

async function runPrompt({ sessionId, text, onDelta }) {
  const promptRpcId = crypto.randomUUID();
  const seenSeqs = new Set();
  const events = [];
  let started = false;
  let startTurn = null;
  let runError = null;
  let pendingQuestions = [];
  let settled = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const settle = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveDone(reason);
  };
  const timer = setTimeout(() => settle('timeout'), TIMEOUT_MS);

  const ingest = (ev) => {
    if (!ev || typeof ev.seq !== 'number' || seenSeqs.has(ev.seq)) return;
    seenSeqs.add(ev.seq);
    events.push(ev);
    events.sort((a, b) => a.seq - b.seq);
    for (const e of events) {
      const d = e.data || {};
      if (!started && e.type === 'user/message' && d.source?.rpcId === promptRpcId) {
        started = true;
        startTurn = d.turn ?? null;
      }
      if (started && e.type === 'turn/end' && (startTurn === null || d.turn === startTurn)) settle('done');
      if (e.type === 'turn/end' && d.reason?.kind === 'error' && !runError) {
        runError = d.reason.error?.message || d.reason.failure?.message || 'turn failed';
      }
    }
    const rendered = renderTranscript(events);
    if (rendered) onDelta(rendered);
  };

  // Live stream (best effort — history polling below covers gaps).
  let ws = null;
  try {
    ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    ws.on('message', (raw) => {
      try {
        const p = JSON.parse(String(raw)).payload;
        if (!p || p.sessionId !== sessionId) return;
        if (p.type === 'session/event') ingest(p.event);
        else if (p.type === 'host/agent-error' && !runError) runError = p.message;
        else if (p.type === 'question/requested') {
          pendingQuestions.push(...(p.questions || []).map((q) => q.question || '').filter(Boolean));
        }
      } catch { /* malformed frame */ }
    });
  } catch {
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
  }

  const startedAt = Date.now();
  try {
    // mode "queue" appends behind whatever the GUI session is already doing.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rpc('session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, promptRpcId);
        break;
      } catch (err) {
        if (err.code !== 'agent-busy' || attempt === 9) throw err;
        await sleep(1000);
      }
    }
  } catch (err) {
    try { ws?.close(); } catch { /* already closed */ }
    throw err;
  }

  while (!settled && Date.now() - startedAt < TIMEOUT_MS) {
    await Promise.race([done, sleep(POLL_MS)]);
    if (settled) break;
    try {
      const hist = await rpc('session.history', { sessionId, maxMessages: 100 });
      for (const h of hist.events || []) ingest(h.event);
    } catch { /* transient */ }
  }
  try { ws?.close(); } catch { /* already closed */ }

  let reply = finalReply(events) || renderTranscript(events) || '';
  if (!reply && runError) reply = `⚠ 任务出错：${runError}`;
  if (!reply) reply = '(empty reply)';
  let note = '';
  if (settled === 'timeout') {
    note = '\n\n⚠ 任务超时未完成';
    if (pendingQuestions.length) {
      note += `，模型正在 dsh web 界面等你回答：${pendingQuestions.join(' / ')}`;
    }
  }
  return { text: reply + note, session: sessionId, usage: null };
}

export const dshAdapter = {
  id: 'dsh',
  // The web session keeps its own history; NEXUS still prepends shared context
  // each run and treats every message as a standalone dispatch.
  stateless: true,
  streamIsProcess: true, // live deltas are CoT, not the reply — hub keeps them collapsed
  slashCommands: ['status'],

  async run({ text, session, attachments = [], onDelta = () => {}, workdir }) {
    try {
      await rpc('session.list', {});
    } catch (err) {
      throw new Error(
        `dsh web 未运行（${WEB_BASE}）：${err.message}。` +
        '请确认后台服务已启动：launchctl list | grep dsh-web（或运行 dsh web --host 127.0.0.1 --port 3080）。',
      );
    }
    const prompt = text + (attachments.length ? attachmentNote(attachments) : '');
    const sessionId = await ensureSession(session, workdir);
    return runPrompt({ sessionId, text: prompt, onDelta });
  },

  async handleCommand(cmd, args, session) {
    if (cmd !== 'status') return null;
    let web = 'DOWN';
    let detail = 'not reachable';
    let state = '?';
    try {
      const list = await rpc('session.list', {});
      web = 'LIVE';
      detail = `${list.items.length} sessions`;
      if (session) {
        const row = list.items.find((x) => x.sessionId === session);
        state = row ? (row.running ? 'running' : 'idle') : 'not found';
      }
    } catch (err) {
      detail = err.message;
    }
    return {
      text: [
        'DEEPSEEK (DSH · web) status:',
        `• dsh web :3080: ${web} (${detail})`,
        `• Session: ${session || 'none'}`,
        `• State: ${state}`,
        '• Mode: persistent dsh web session (no headless one-shot)',
      ].join('\n'),
    };
  },
};
