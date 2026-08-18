import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadAgentsConfig } from './agents-config.mjs';

const FILE = join(homedir(), '.agent-nexus', 'settings.json');

// Agent set comes from agents.json (user) / agents.example.json (repo);
// per-agent ctxChars default may be set in the config entry.
const agentDefaults = () => Object.fromEntries(
  loadAgentsConfig().map((a) => [a.id, { model: '', extraArgs: '', ctxChars: a.ctxChars ?? 900 }]),
);

const DEFAULTS = {
  agents: agentDefaults(),
  ui: { theme: 'cyberpunk', focusOpacity: 0.7 },
};

export const THEMES = ['cyberpunk', 'matrix', 'synthwave', 'amber', 'arctic'];

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = {
      // deep-merge per agent so new keys (e.g. ctxChars) get defaults on old files
      agents: Object.fromEntries(Object.keys(DEFAULTS.agents).map((id) =>
        [id, { ...DEFAULTS.agents[id], ...(d.agents?.[id] || {}) }])),
      ui: { ...DEFAULTS.ui, ...d.ui },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export function saveSettings(patch) {
  const cur = loadSettings();
  if (patch?.agents && typeof patch.agents === 'object') {
    for (const [k, v] of Object.entries(patch.agents)) {
      if (!(k in cur.agents) || !v) continue;
      const ctx = Number(v.ctxChars);
      cur.agents[k] = {
        model: String(v.model || '').slice(0, 160),
        extraArgs: String(v.extraArgs || '').slice(0, 300),
        ctxChars: Number.isFinite(ctx) ? Math.min(4000, Math.max(0, Math.round(ctx))) : (cur.agents[k].ctxChars ?? 900),
      };
    }
  }
  if (patch?.ui) {
    if (THEMES.includes(patch.ui.theme)) cur.ui.theme = patch.ui.theme;
    if (patch.ui.focusOpacity != null) {
      cur.ui.focusOpacity = Math.min(1, Math.max(0.3, Number(patch.ui.focusOpacity) || 0.7));
    }
  }
  cache = cur;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cur, null, 2));
  return cur;
}

export const getAgentCfg = (id) => loadSettings().agents[id] || {};

// Split a free-form args string on whitespace, honoring quotes.
export const splitArgs = (s) =>
  (s?.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
