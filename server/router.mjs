// Jev (TypeSafe System One) intent router.
// When the user sends a message without an @mention, ask Jev which agent
// should handle it instead of broadcasting to everyone. Low confidence,
// an explicit "broadcast" pick, or any failure falls back to broadcasting.
//
// Config: ~/.agent-nexus/router.json
//   { "enabled": true, "apiKey": "...", "model": "jev-latest",
//     "threshold": 0.55, "proxy": "http://127.0.0.1:7897" }
// apiKey falls back to env TYPESAFE_API_KEY, then ~/.config/typesafe/api_key.
// Runtime toggle: /router on|off (persisted in the hub meta table).

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getMeta, setMeta } from './memory.mjs';

const CONF_FILE = join(homedir(), '.agent-nexus', 'router.json');
const KEY_FILE = join(homedir(), '.config', 'typesafe', 'api_key');
const API_URL = 'https://api.typesafe.ai/v1/systemone';

let conf = null;
export function routerConf() {
  if (conf) return conf;
  try { conf = JSON.parse(readFileSync(CONF_FILE, 'utf8')); } catch { conf = {}; }
  if (!conf.apiKey) {
    conf.apiKey = process.env.TYPESAFE_API_KEY
      || (() => { try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } })();
  }
  return conf;
}

export function routerStatus() {
  const c = routerConf();
  const meta = getMeta('router_enabled');
  const enabled = !!c.apiKey && (meta === null || meta === undefined ? c.enabled !== false : meta === '1');
  return { enabled, configured: !!c.apiKey, threshold: c.threshold ?? 0.55, model: c.model || 'jev-latest' };
}

export function setRouterEnabled(on) {
  setMeta('router_enabled', on ? '1' : '0');
}

// Ask Jev to pick a target. agents: [{id, name, desc}].
// Returns { to, confidence, probabilities } or null on failure.
export async function routeTask(text, agents) {
  const c = routerConf();
  if (!c.apiKey) return null;
  const criteria = Object.fromEntries(agents.map((a) => [a.id, a.routeDesc || `${a.name} — ${a.desc || a.id}`]));
  criteria.broadcast = '面向所有人的闲聊/公告，或需要多个 agent 协作，或不属于任何单个 agent 的职责';
  const body = JSON.stringify({
    state: String(text).slice(0, 8000),
    model: c.model || 'jev-latest',
    questions: {
      route: { type: 'choice', instructions: '这条用户消息应该交给哪个 agent 处理？选出职责最匹配的一个', criteria },
    },
  });
  const out = await new Promise((resolve, reject) => {
    const child = execFile('curl', [
      '-sS', '--max-time', '10', '-x', c.proxy || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897',
      '-X', 'POST', API_URL,
      '-H', `Authorization: Bearer ${c.apiKey}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', '@-',
    ], { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
    child.stdin.end(body);
  });
  const d = JSON.parse(out);
  const r = d?.answers?.route;
  if (!r || typeof r.choice !== 'string') return null;
  return { to: r.choice, confidence: r.confidence ?? 0, probabilities: r.probabilities || {} };
}
