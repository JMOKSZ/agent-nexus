import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent roster is user configuration, not code:
//   ~/.agent-nexus/agents.json  (user's own setup, gitignored by location)
//   <repo>/agents.example.json  (fallback + reference, committed)
// Each entry: { id, name, color, desc, adapter, modelHint?, ctxChars? }
// `adapter` must be a key of ADAPTER_TYPES in server/adapters/index.mjs;
// multiple entries may share one adapter type (e.g. two claude instances).

const USER_FILE = process.env.NEXUS_AGENTS_FILE || join(homedir(), '.agent-nexus', 'agents.json');
const EXAMPLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents.example.json');

export function loadAgentsConfig() {
  const file = existsSync(USER_FILE) ? USER_FILE : EXAMPLE_FILE;
  let list;
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const id = String(a?.id || '').trim().toLowerCase();
    if (!/^[\w-]{1,24}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(a.name || id.toUpperCase()).slice(0, 24),
      color: /^#[0-9a-f]{3,8}$/i.test(a.color) ? a.color : '#888888',
      desc: String(a.desc || '').slice(0, 80),
      adapter: String(a.adapter || id),
      modelHint: String(a.modelHint || ''),
      distiller: a.distiller === true,
      ctxChars: Number.isFinite(Number(a.ctxChars)) ? Math.min(4000, Math.max(0, Math.round(Number(a.ctxChars)))) : undefined,
    });
  }
  return out;
}
