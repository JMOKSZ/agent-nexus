import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Shared memory store: append-only event log + structured memory entries.
// Zero-dependency via node:sqlite. Phase 1 retrieval is recency-based; FTS5
// recall lands in phase 2 behind the same buildContextBlock entry point.
const DB_FILE = join(homedir(), '.agent-nexus', 'nexus.db');

const MEMORY_KINDS = new Set(['fact', 'decision', 'preference', 'task']);

const EVENT_TEXT_CAP = 4000; // stored events are trimmed; display caps are smaller

let db = null;

function getDb() {
  if (db) return db;
  mkdirSync(join(homedir(), '.agent-nexus'), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT,
      kind TEXT NOT NULL,
      text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      text TEXT NOT NULL,
      trust TEXT NOT NULL DEFAULT 'agent',
      source TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, ts);
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  return db;
}

export function getMeta(k) {
  return getDb().prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
}

export function setMeta(k, v) {
  getDb().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, String(v));
}

export function logEvent({ from, to, kind, text }) {
  try {
    getDb().prepare('INSERT INTO events (ts, from_id, to_id, kind, text) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), String(from || '?'), to ? String(to) : null, String(kind || 'msg'),
        String(text || '').slice(0, EVENT_TEXT_CAP));
  } catch { /* memory store is best-effort, never block the hub */ }
}

export function normalizeKind(k) {
  const v = String(k || '').trim().toLowerCase();
  return MEMORY_KINDS.has(v) ? v : 'fact';
}

export function addMemory({ kind = 'fact', text, trust = 'agent', source = null, status = 'active' }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return null;
  const r = getDb().prepare('INSERT INTO memories (ts, kind, text, trust, source, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), normalizeKind(kind), clean, trust === 'user' ? 'user' : 'agent', source,
      status === 'staged' ? 'staged' : 'active');
  return Number(r.lastInsertRowid);
}

export function retireMemory(id) {
  const r = getDb().prepare("UPDATE memories SET status = 'retired' WHERE id = ? AND status != 'retired'").run(Number(id));
  return r.changes > 0;
}

export function approveMemory(id) {
  const r = getDb().prepare("UPDATE memories SET status = 'active' WHERE id = ? AND status = 'staged'").run(Number(id));
  return r.changes > 0;
}

export function listStaged() {
  return getDb().prepare(
    "SELECT id, ts, kind, text, trust, source FROM memories WHERE status = 'staged' ORDER BY id ASC",
  ).all();
}

// Events after the given id (distillation watermark), excluding memo notices
// to keep distill output from feeding back into the next distill run.
export function eventsSince(afterId = 0, { limit = 120, maxChars = 12000 } = {}) {
  const rows = getDb().prepare(`
    SELECT id, ts, from_id, to_id, kind, text FROM events
    WHERE id > ? AND kind != 'memo'
    ORDER BY id ASC LIMIT ?
  `).all(Number(afterId) || 0, limit);
  const out = [];
  let chars = 0;
  for (const r of rows) {
    const line = `${hhmm(r.ts)} ${r.from_id}→${r.to_id || '?'}: ${clip(r.text, 300)}`;
    if (chars + line.length > maxChars) break;
    out.push({ id: r.id, line });
    chars += line.length;
  }
  return out;
}

export function listMemories(limit = 15) {
  return getDb().prepare(
    "SELECT id, ts, kind, text, trust, source FROM memories WHERE status = 'active' ORDER BY id DESC LIMIT ?",
  ).all(Number(limit) || 15);
}

// Recent events involving a given agent (either direction, or user broadcasts).
function recentEvents(agentId, limit = 8) {
  return getDb().prepare(`
    SELECT ts, from_id, to_id, kind, text FROM events
    WHERE from_id = ? OR to_id = ? OR (from_id = 'user' AND to_id = 'broadcast')
    ORDER BY id DESC LIMIT ?
  `).all(agentId, agentId, limit).reverse();
}

const clip = (s, n) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

/* ── relevance recall ──
 * JS-side scoring instead of FTS5: FTS5's trigram tokenizer cannot match CJK
 * terms shorter than 3 chars (verified: 记忆/端口/赛博 return zero rows), and
 * short Chinese terms are the common case here. N is small (hundreds), so
 * scanning active memories and scoring by latin-word + CJK-bigram overlap is
 * both fast and strictly better for mixed zh/en content. */

const CJK_RUN = /[一-鿿䀀-䶿]+/g;
const LATIN_WORD = /[a-z0-9_.:/-]{2,}/g;

function queryTerms(q) {
  const lower = String(q || '').toLowerCase();
  const terms = [];
  for (const m of lower.matchAll(LATIN_WORD)) terms.push({ t: m[0], w: 3 });
  for (const m of lower.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) terms.push({ t: run, w: 0.5 });
    else {
      // whole-run term: an exact 2-char query must clear the noise floor by itself
      terms.push({ t: run, w: Math.min(run.length, 4) });
      if (run.length > 2) for (let i = 0; i < run.length - 1; i++) terms.push({ t: run.slice(i, i + 2), w: 1 });
    }
  }
  return terms;
}

export function recallMemories(query, limit = 6) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const now = Date.now();
  const all = getDb().prepare(
    "SELECT id, ts, kind, text, trust, source FROM memories WHERE status = 'active'",
  ).all();
  const scored = [];
  for (const m of all) {
    const text = m.text.toLowerCase();
    let score = 0;
    for (const { t, w } of terms) if (text.includes(t)) score += w;
    if (score < 2) continue; // noise floor: a single bigram hit isn't relevance
    if (m.trust === 'user') score *= 1.6;
    const ageDays = (now - m.ts) / 86400000;
    score *= 1 + Math.max(0, 0.3 - ageDays * 0.01); // mild recency boost
    scored.push({ ...m, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

// Prompt prefix giving an agent the shared memories + its recent context.
// Memory selection = latest 3 ∪ top-K recalled by the current query.
// Stateless agents (dsh) and inter-agent dispatches consume the full block;
// sessioned agents get memories only (their session already covers history).
export function buildContextBlock(agentId, { maxChars = 1600, memLimit = 8, eventLimit = 8, includeEvents = true, query = '' } = {}) {
  const sections = [];
  try {
    const byId = new Map();
    for (const m of listMemories(3)) byId.set(m.id, m); // recency floor
    if (query) for (const m of recallMemories(query, memLimit)) byId.set(m.id, m);
    const mems = [...byId.values()].sort((a, b) => a.id - b.id).slice(0, memLimit + 3);
    if (mems.length) {
      sections.push('[共享记忆]\n' + mems.map((m) => `- (#${m.id} ${m.kind}${m.trust === 'user' ? '' : ` · by ${m.source || 'agent'}`}) ${clip(m.text, 160)}`).join('\n'));
    }
    if (includeEvents) {
      const evs = recentEvents(agentId, eventLimit);
      if (evs.length) {
        sections.push('[最近相关上下文]\n' + evs.map((e) => `- ${hhmm(e.ts)} ${e.from_id}→${e.to_id || '?'}: ${clip(e.text, 200)}`).join('\n'));
      }
    }
  } catch { /* best-effort */ }
  if (!sections.length) return '';
  let block = sections.join('\n\n');
  if (block.length > maxChars) block = block.slice(0, maxChars) + '\n…(上下文截断)';
  return block + '\n\n';
}
