import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { runCli, attachmentNote, WORKDIR } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

// Codex: use the CLI bundled inside Codex.app (0.148) — the homebrew 0.136 CLI
// cannot parse the app's models.json. Session continuity via `exec resume <threadId>`.
const CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

function readHead(file, bytes = 262144) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}

// Hub prompts start with an injected [共享记忆]/[最近相关上下文] block —
// strip those sections so session previews show the actual user text.
function realSnippet(text) {
  const parts = text.split('\n\n').filter((p) =>
    !p.startsWith('[共享记忆]') && !p.startsWith('[最近相关上下文]'));
  return (parts.join('\n\n').trim() || text).replace(/\s+/g, ' ').slice(0, 60);
}

function sessionInfo(file) {
  const head = readHead(file);
  let id = null;
  let cwd = null;
  let snippet = null;
  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'session_meta') {
      id = ev.payload?.id || id;
      cwd = ev.payload?.cwd || cwd;
    }
    if (!cwd && ev.type === 'turn_context' && ev.payload?.cwd) cwd = ev.payload.cwd;
    if (!snippet && ev.type === 'event_msg' && ev.payload?.type === 'user_message') {
      const text = ev.payload.message;
      if (typeof text === 'string' && text.trim() && !text.startsWith('<')) {
        snippet = realSnippet(text);
      }
    }
    if (id && cwd && snippet) break;
  }
  if (!id) {
    const m = basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    id = m ? m[1] : basename(file, '.jsonl');
  }
  let mtime = 0;
  try { mtime = statSync(file).mtimeMs; } catch { /* gone */ }
  return { id, cwd, snippet: snippet || '(no preview)', mtime };
}

function listSessions(limit = 12) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(sessionInfo(p));
    }
  };
  walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

const fmtAge = (mtime) => {
  const mins = Math.round((Date.now() - mtime) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const projectOf = (cwd) => (cwd ? basename(cwd) : '?');

// Sessions written within the last 10 min are likely live elsewhere — flagged
// in listings and never auto-picked.
const LIVE_MS = 10 * 60 * 1000;
const isLive = (s) => Date.now() - s.mtime < LIVE_MS;
const listLine = (s) =>
  `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)}${isLive(s) ? ' · ⚡live' : ''} · ${s.snippet}`;

export const codexAdapter = {
  id: 'codex',
  slashCommands: ['sessions', 'resume', 'fork', 'status'],
  settingFields: [
    {
      key: 'sandbox', label: 'Sandbox mode (-s)',
      options: [
        { value: '', label: 'default (config.toml)' },
        { value: 'read-only', label: 'read-only' },
        { value: 'workspace-write', label: 'workspace-write' },
        { value: 'danger-full-access', label: 'danger-full-access (unsafe)' },
      ],
    },
  ],

  async run({ text, session, attachments = [], onDelta, onSpawn = () => {}, workdir }) {
    // session state: plain thread id, or {id, fork:true} after /fork
    const sid = typeof session === 'string' ? session : session?.id;
    const forking = typeof session === 'object' && session?.fork;
    const images = attachments.filter((a) => a.mime.startsWith('image/'));
    const others = attachments.filter((a) => !a.mime.startsWith('image/'));
    const prompt = text + (others.length ? attachmentNote(others) : '');
    const args = forking
      ? ['exec', 'fork', '--json', '--skip-git-repo-check', sid, prompt]
      : sid
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', sid, prompt]
        : ['exec', '--json', '--skip-git-repo-check', prompt];
    const cfg = getAgentCfg('codex');
    if (sid) {
      // `exec resume`/`exec fork` reject -m/-s; config overrides work on both
      if (cfg.model) args.push('-c', `model="${cfg.model}"`);
      if (cfg.sandbox) args.push('-c', `sandbox_mode="${cfg.sandbox}"`);
    } else {
      if (cfg.model) args.push('-m', cfg.model);
      if (cfg.sandbox) args.push('-s', cfg.sandbox);
    }
    args.push(...splitArgs(cfg.extraArgs));
    // images are real vision input, not just path references
    for (const img of images) args.push('--image', img.path);
    let threadId = sid || null;
    let finalText = '';
    let usage = null;
    const { code, stderr } = await runCli(CODEX_BIN, args, {
      timeoutMs: 600_000,
      cwd: workdir || WORKDIR,
      onSpawn,
      onLine(line) {
        if (!line.trim().startsWith('{')) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'thread.started') threadId = ev.thread_id || threadId;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
          finalText = ev.item.text;
          onDelta(ev.item.text);
        }
        if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
      },
    });
    if (code !== 0 && !finalText) throw new Error(`codex exited ${code}: ${stderr.slice(-300)}`);
    return { text: finalText, session: threadId, usage };
  },

  async handleCommand(cmd, args, currentSession) {
    if (cmd === 'status') {
      const sid = typeof currentSession === 'string' ? currentSession : currentSession?.id;
      const cfg = getAgentCfg('codex');
      return {
        text: sid
          ? `CODEX status:\n• Thread: ${String(sid).slice(0, 13)}…\n• Model: ${cfg.model || 'deepseek-v4-flash (DeepSeek API)'}\n• Sandbox: ${cfg.sandbox || 'default'}\n• Resume mode: exec resume active\n• Clear: /clear · Fork: /fork`
          : `CODEX status:\n• Thread: none (next message starts a new thread)\n• Model: ${cfg.model || 'deepseek-v4-flash (DeepSeek API)'}`,
      };
    }
    if (cmd === 'fork') {
      const sid = typeof currentSession === 'string' ? currentSession : currentSession?.id;
      if (!sid) return { text: 'No active thread to fork. Chat normally first to establish a thread.' };
      return {
        session: { id: sid, fork: true },
        text: `⑂ Next message will fork a new thread from ${String(sid).slice(0, 8)} (the original stays untouched).`,
      };
    }
    if (cmd === 'sessions') {
      const list = listSessions(10);
      if (!list.length) return { text: 'No codex sessions found.' };
      return { text: `Recent codex sessions (⚡=written within 10 min, may be in use elsewhere):\n${list.map(listLine).join('\n')}` };
    }
    if (cmd === 'resume') {
      const all = listSessions(100);
      if (!all.length) return { text: 'No codex sessions found.' };
      const arg = args.trim();
      if (!arg) {
        // No arg → show the picker list instead of guessing a session.
        return { text: `Recent codex sessions (⚡=written within 10 min, may be in use elsewhere):\n${all.slice(0, 10).map(listLine).join('\n')}\n\nUse /resume <prefix> to resume (continues as a fork — the original session is never modified).` };
      }
      let pick;
      {
        const matches = all.filter((s) => s.id.startsWith(arg));
        if (matches.length === 0) return { text: `No session matches "${arg}". Use /sessions to see the list.` };
        if (matches.length > 1) {
          return { text: `"${arg}" matches multiple sessions — use a longer prefix:\n${matches.slice(0, 8).map(listLine).join('\n')}` };
        }
        pick = matches[0];
      }
      // Always fork into a new thread so the original thread is never appended to.
      return {
        session: { id: pick.id, fork: true },
        text: `✓ Resumed codex thread ${pick.id.slice(0, 8)} (project ${projectOf(pick.cwd)} · ${fmtAge(pick.mtime)})\n"${pick.snippet}"\nNext messages continue this thread's context as a fork — the original thread is never modified.`,
      };
    }
    return null;
  },
};
