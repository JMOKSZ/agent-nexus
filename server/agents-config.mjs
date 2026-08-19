import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent roster is user configuration, not code:
//   ~/.agent-nexus/agents.json  (user's own setup, gitignored by location)
//   <repo>/agents.example.json  (fallback + reference, committed)
// Each entry: { id, name, color, desc, adapter, modelHint?, ctxChars?, cwd? }
// `adapter` must be a key of ADAPTER_TYPES in server/adapters/index.mjs;
// multiple entries may share one adapter type (e.g. two claude instances).
// `cwd` sets the working directory new sessions start in (default: the
// shared nexus workdir); resumed sessions keep their own origin cwd.

const USER_FILE = process.env.NEXUS_AGENTS_FILE || join(homedir(), '.agent-nexus', 'agents.json');
const EXAMPLE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents.example.json');

function parseCwd(v) {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const p = resolve(v.trim().replace(/^~(?=$|\/)/, homedir()));
  try { return statSync(p).isDirectory() ? p : undefined; } catch { return undefined; }
}

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
      cwd: parseCwd(a.cwd),
      terminal: a.terminal === true, // run as a persistent interactive PTY instead of headless one-shot
      cmd: typeof a.cmd === 'string' && /^[\w./+-]{1,80}$/.test(a.cmd) ? a.cmd : undefined,
      args: Array.isArray(a.args) ? a.args.filter((s) => typeof s === 'string' && /^[\w./+:=@-]{1,80}$/.test(s)).slice(0, 16) : undefined,
      ctxChars: Number.isFinite(Number(a.ctxChars)) ? Math.min(4000, Math.max(0, Math.round(Number(a.ctxChars)))) : undefined,
    });
  }
  return out;
}
