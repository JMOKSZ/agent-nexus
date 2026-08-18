import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join, extname, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Hub } from './hub.mjs';
import { UPLOAD_DIR } from './runner.mjs';
import { loadSettings, saveSettings, getAgentCfg, splitArgs } from './settings.mjs';
import { listMemories, recallMemories, addMemory, retireMemory, approveMemory, restoreMemory, updateMemory, listAllMemories, listStaged, normalizeKind } from './memory.mjs';
import { ADAPTER_TYPES } from './adapters/index.mjs';
import { loadAgentsConfig } from './agents-config.mjs';
import { termManager } from './terminal.mjs';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.NEXUS_PORT || 7700);
const HOST = '127.0.0.1';
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MANIFEST_PATH = join(UPLOAD_DIR, 'manifest.json');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

mkdirSync(UPLOAD_DIR, { recursive: true });
let manifest = {};
try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch { /* fresh */ }
const saveManifest = () => {
  try { writeFileSync(MANIFEST_PATH, JSON.stringify(manifest)); } catch { /* non-fatal */ }
};

const agentsList = loadAgentsConfig().filter((a) => {
  if (ADAPTER_TYPES[a.adapter]) return true;
  console.warn(`[agent-nexus] skipping agent "${a.id}": unknown adapter type "${a.adapter}"`);
  return false;
});
const adapters = Object.fromEntries(agentsList.map((a) => [a.id, ADAPTER_TYPES[a.adapter]]));
const hub = new Hub(adapters, agentsList);

// Terminal agents run as persistent interactive PTYs (real CLI, not headless).
termManager.configure(agentsList.filter((a) => a.terminal).map((a) => {
  const cfg = getAgentCfg(a.id);
  const args = [];
  if (cfg.model) args.push('--model', cfg.model);
  args.push(...splitArgs(cfg.extraArgs));
  return { id: a.id, cmd: a.cmd || a.id, args, cwd: a.cwd };
}));

const wss = new WebSocketServer({ noServer: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.icns': 'image/icns', '.webmanifest': 'application/manifest+json' };

// Static serving tuned for slow links (tailnet from phone/iPad): gzip text
// assets, ETag so no-cache revalidations are cheap 304s, and long caching for
// the content-stable vendor/icons dirs. Bodies are cached in memory keyed by
// path+mtime — WEB_DIR holds only a few MB of first-party files.
const TEXTUAL = new Set(['.html', '.js', '.css', '.svg', '.webmanifest']);
const staticCache = new Map();

function serveStatic(req, res, file) {
  const st = statSync(file);
  let entry = staticCache.get(file);
  if (!entry || entry.mtimeMs !== st.mtimeMs) {
    const raw = readFileSync(file);
    const ext = extname(file);
    entry = {
      mtimeMs: st.mtimeMs,
      raw,
      gz: TEXTUAL.has(ext) && raw.length > 1024 ? gzipSync(raw) : null,
      etag: `"${Math.round(st.mtimeMs)}-${raw.length}"`,
      type: MIME[ext] || 'application/octet-stream',
    };
    staticCache.set(file, entry);
  }
  const longCache = file.includes(`${sep}vendor${sep}`) || file.includes(`${sep}icons${sep}`);
  const headers = {
    'Content-Type': entry.type,
    ETag: entry.etag,
    'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = entry.gz.length;
    res.writeHead(200, headers);
    res.end(entry.gz);
    return;
  }
  headers['Content-Length'] = entry.raw.length;
  res.writeHead(200, headers);
  res.end(entry.raw);
}

function readBody(req, limit = 8e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const sanitizeName = (name) => String(name || 'file').replace(/[^\w.一-鿿-]+/g, '_').slice(-80);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: init\ndata: ${JSON.stringify(hub.snapshot())}\n\n`);
    const unsubscribe = hub.subscribe((line) => res.write(line));
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepalive); unsubscribe(); });
    return;
  }

  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hub.snapshot().agents));
    return;
  }

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.text || typeof body.text !== 'string') {
      res.writeHead(400).end('bad request');
      return;
    }
    const atts = Array.isArray(body.attachments)
      ? body.attachments.filter((a) => a && manifest[a.id]).map((a) => manifest[a.id])
      : [];
    hub.handleUserInput(body.text.slice(0, 32_000), atts);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Agent-to-agent synchronous ask: any local process (the agents themselves
  // via curl, or bin/nexus ask) queues a task and gets the reply back.
  if (url.pathname === '/api/agent/ask' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const from = typeof body.from === 'string' ? body.from.toLowerCase() : 'cli';
    const to = typeof body.to === 'string' ? body.to.toLowerCase() : '';
    const text = typeof body.text === 'string' ? body.text.slice(0, 32_000) : '';
    if (!to || !text.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'need {from?, to, text}' }));
      return;
    }
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 600_000, 1000), 600_000);
    const result = await hub.ask(from, to, text, timeoutMs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const fields = Object.fromEntries(agentsList.map((a) =>
      [a.id, ADAPTER_TYPES[a.adapter].settingFields || []]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...loadSettings(), fields }));
    return;
  }

  if (url.pathname === '/api/memories' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      memories: q ? recallMemories(q, 30) : listMemories(50),
      staged: listStaged(),
    }));
    return;
  }

  if (url.pathname === '/api/memories' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const id = addMemory({ kind: normalizeKind(body.kind), text: body.text, trust: 'user', source: 'user' });
    if (id == null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"empty text"}');
      return;
    }
    hub.pushMessage({ from: 'system', to: 'user', text: `🧠 remembered #${id} (${normalizeKind(body.kind)}): ${String(body.text).slice(0, 120)}`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  if (url.pathname === '/api/memories/retire' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = retireMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `memory #${body.id} retired`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/memories/approve' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = approveMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `✓ memory #${body.id} approved`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/memories/all' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memories: listAllMemories(300) }));
    return;
  }

  if (url.pathname === '/api/memories/update' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = updateMemory(body.id, { text: body.text, kind: body.kind });
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `✎ memory #${body.id} edited`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/memories/restore' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = restoreMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `♻ memory #${body.id} restored`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const extraAllowed = Object.fromEntries(agentsList.map((a) =>
      [a.id, (ADAPTER_TYPES[a.adapter].settingFields || []).map((f) => f.key)]));
    const saved = saveSettings(body, extraAllowed);
    const fields = Object.fromEntries(agentsList.map((a) =>
      [a.id, ADAPTER_TYPES[a.adapter].settingFields || []]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...saved, fields }));
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.agent && hub.adapters[body.agent]) hub.stop(body.agent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 80e6)); } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (!buf.length || buf.length > MAX_UPLOAD_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file is empty or exceeds the 50MB limit' }));
      return;
    }
    const id = randomBytes(6).toString('hex');
    const name = sanitizeName(body.name);
    const stored = `${id}-${name}`;
    const mime = String(body.type || 'application/octet-stream').slice(0, 100);
    writeFileSync(join(UPLOAD_DIR, stored), buf);
    manifest[id] = { id, name, stored, mime, size: buf.length, path: join(UPLOAD_DIR, stored), url: `/files/${id}`, ts: Date.now() };
    saveManifest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest[id]));
    return;
  }

  if (url.pathname.startsWith('/files/')) {
    const id = url.pathname.slice(7);
    const meta = /^[0-9a-f]{12}$/.test(id) ? manifest[id] : null;
    const file = meta && join(UPLOAD_DIR, meta.stored);
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': meta.mime, 'Cache-Control': 'max-age=86400' });
    res.end(readFileSync(file));
    return;
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const id = body.agent;
    if (id && hub.adapters[id]) {
      const stateless = !!hub.adapters[id].stateless;
      const hadSession = hub.resetAgent(id);
      const name = hub.agents[id].name;
      hub.pushMessage({
        from: 'system', to: id, kind: 'error',
        text: stateless
          ? `↺ ${name} is stateless (every message is independent, no session to clear); display cleared`
          : hadSession
            ? `↺ ${name} session reset; display cleared`
            : `↺ ${name} has no active session; display cleared`,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (url.pathname === '/api/display/clear' && req.method === 'POST') {
    hub.clearDisplay();
    hub.pushMessage({ from: 'system', to: 'user', text: '🧹 All window displays cleared (shared memory & event log are kept)', kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Static files
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  file = join(WEB_DIR, file);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  serveStatic(req, res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-nexus] command deck online → http://${HOST}:${PORT}`);
});

// WebSocket bridge for terminal agents: /ws/term/<agentId>
// client→server frames are JSON: {type:'in',data} | {type:'resize',cols,rows}
// server→client frames: one JSON hello, then raw PTY output strings.
server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/^\/ws\/term\/([\w-]{1,24})$/);
  if (!m || !termManager.has(m[1])) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const term = termManager.get(m[1]);
    term.attach(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'in' && typeof msg.data === 'string') term.write(msg.data.slice(0, 64_000));
      else if (msg.type === 'resize') term.resize(Number(msg.cols), Number(msg.rows));
    });
    ws.on('close', () => term.detach(ws));
  });
});
