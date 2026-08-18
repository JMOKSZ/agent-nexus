import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Hub } from './hub.mjs';
import { UPLOAD_DIR } from './runner.mjs';
import { loadSettings, saveSettings } from './settings.mjs';
import { listMemories, recallMemories, addMemory, retireMemory, approveMemory, restoreMemory, updateMemory, listAllMemories, listStaged, normalizeKind } from './memory.mjs';
import { ADAPTER_TYPES } from './adapters/index.mjs';
import { loadAgentsConfig } from './agents-config.mjs';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    hub.pushMessage({ from: 'system', to: 'user', text: `🧠 已记住 #${id}（${normalizeKind(body.kind)}）: ${String(body.text).slice(0, 120)}`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  if (url.pathname === '/api/memories/retire' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = retireMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `记忆 #${body.id} 已停用`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/memories/approve' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = approveMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `✓ 记忆 #${body.id} 已批准生效`, kind: 'memo' });
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
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `✎ 记忆 #${body.id} 已手动修改`, kind: 'memo' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (url.pathname === '/api/memories/restore' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const ok = restoreMemory(body.id);
    if (ok) hub.pushMessage({ from: 'system', to: 'user', text: `♻ 记忆 #${body.id} 已恢复生效`, kind: 'memo' });
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
      res.end(JSON.stringify({ error: '文件为空或超过 50MB 限制' }));
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
          ? `↺ ${name} 是无状态 agent（每条消息独立，无会话可清），窗口显示已清空`
          : hadSession
            ? `↺ ${name} 会话已重置，窗口显示已清空`
            : `↺ ${name} 当前没有活动会话，窗口显示已清空`,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (url.pathname === '/api/display/clear' && req.method === 'POST') {
    hub.clearDisplay();
    hub.pushMessage({ from: 'system', to: 'user', text: '🧹 全部窗口显示已清空（共享记忆与事件日志保留，不受影响）', kind: 'memo' });
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
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-nexus] command deck online → http://${HOST}:${PORT}`);
});
