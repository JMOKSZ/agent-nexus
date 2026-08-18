import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const FILE = join(homedir(), '.agent-nexus', 'settings.json');

const DEFAULTS = {
  agents: {
    claude: { model: '', extraArgs: '' },
    codex: { model: '', extraArgs: '' },
    dsh: { model: '', extraArgs: '' },
    openclaw: { model: '', extraArgs: '' },
  },
  ui: { theme: 'cyberpunk', focusOpacity: 0.7 },
};

export const THEMES = ['cyberpunk', 'matrix', 'synthwave', 'amber', 'arctic'];

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = {
      agents: { ...structuredClone(DEFAULTS.agents), ...d.agents },
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
      cur.agents[k] = {
        model: String(v.model || '').slice(0, 160),
        extraArgs: String(v.extraArgs || '').slice(0, 300),
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
