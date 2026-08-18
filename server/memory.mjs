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
  `);
  return db;
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

export function addMemory({ kind = 'fact', text, trust = 'agent', source = null }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return null;
  const r = getDb().prepare('INSERT INTO memories (ts, kind, text, trust, source) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), normalizeKind(kind), clean, trust === 'user' ? 'user' : 'agent', source);
  return Number(r.lastInsertRowid);
}

export function retireMemory(id) {
  const r = getDb().prepare("UPDATE memories SET status = 'retired' WHERE id = ? AND status = 'active'").run(Number(id));
  return r.changes > 0;
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

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

// Prompt prefix giving an agent the shared memories + its recent context.
// Stateless agents (dsh) and inter-agent dispatches consume the full block;
// sessioned agents get memories only (their session already covers history).
export function buildContextBlock(agentId, { maxChars = 1600, memLimit = 8, eventLimit = 8, includeEvents = true } = {}) {
  const sections = [];
  try {
    const mems = listMemories(memLimit).reverse();
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
