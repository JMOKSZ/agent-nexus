import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { runCli, WORKDIR, UPLOAD_DIR, attachmentNote } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

// Claude Code headless: one process per message, session continuity via --resume.
// Session state is {id, cwd} — cwd matters because claude looks up sessions in the
// project dir of the process cwd, so resuming a foreign session needs its origin cwd.
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function readHead(file, bytes = 8192) {
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
  const id = basename(file, '.jsonl');
  const head = readHead(file);
  let cwd = null;
  let snippet = null;
  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!cwd && ev.cwd) cwd = ev.cwd;
    if (ev.type === 'summary' && ev.summary) { snippet = ev.summary; break; }
    if (!snippet && ev.type === 'user') {
      const c = ev.message?.content;
      const text = typeof c === 'string' ? c : c?.find?.((b) => b.type === 'text')?.text;
      if (text && !text.startsWith('<')) snippet = realSnippet(text);
    }
    if (cwd && snippet) break;
  }
  let mtime = 0;
  try { mtime = statSync(file).mtimeMs; } catch { /* gone */ }
  return { id, cwd, snippet: snippet || '(no preview)', mtime };
}

function listSessions(limit = 12) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = readdirSync(join(PROJECTS_DIR, d)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(sessionInfo(join(PROJECTS_DIR, d, f)));
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

const fmtAge = (mtime) => {
  const mins = Math.round((Date.now() - mtime) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const projectOf = (cwd) => (cwd ? basename(cwd) : '?');

// Sessions written within the last 10 min are likely live elsewhere (e.g. an
// interactive claude) — they get flagged in listings and never auto-picked.
const LIVE_MS = 10 * 60 * 1000;
const isLive = (s) => Date.now() - s.mtime < LIVE_MS;
const listLine = (s) =>
  `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)}${isLive(s) ? ' · ⚡live' : ''} · ${s.snippet}`;

// Normalize legacy string session state.
const asSession = (s) => (s ? (typeof s === 'string' ? { id: s, cwd: null } : s) : null);

export const claudeAdapter = {
  id: 'claude',
  slashCommands: ['sessions', 'resume', 'fork', 'status'],
  settingFields: [
    {
      key: 'effort', label: 'Reasoning effort (--effort)',
      options: [
        { value: '', label: 'default' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' },
        { value: 'max', label: 'max' },
      ],
    },
    {
      key: 'fallbackModel', label: 'Fallback model (--fallback-model, auto-switch on overload)',
      options: null, // free text
    },
  ],

  async run({ text, session, attachments = [], onDelta, onSpawn = () => {}, workdir }) {
    const s = asSession(session);
    const base = workdir || WORKDIR;
    const cfg = getAgentCfg('claude');
    const args = ['-p', text + (attachments.length ? attachmentNote(attachments) : ''), '--output-format', 'stream-json', '--verbose'];
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.effort) args.push('--effort', cfg.effort);
    if (cfg.fallbackModel) args.push('--fallback-model', cfg.fallbackModel);
    args.push(...splitArgs(cfg.extraArgs));
    if (s?.id) args.push('--resume', s.id);
    if (s?.fork) args.push('--fork-session'); // resume into a new session id, original untouched
    if (attachments.length) args.push('--add-dir', UPLOAD_DIR);
    let newSession = s;
    let finalText = '';
    let usage = null;
    const { code, stderr } = await runCli('claude', args, {
      timeoutMs: 600_000,
      cwd: s?.cwd || base,
      onSpawn,
      onLine(line) {
        if (!line.trim().startsWith('{')) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          newSession = { id: ev.session_id, cwd: ev.cwd || s?.cwd || base };
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) onDelta(block.text);
          }
        }
        if (ev.type === 'result') {
          if (ev.session_id) newSession = { id: ev.session_id, cwd: s?.cwd || base };
          finalText = ev.result || '';
          usage = ev.total_cost_usd != null ? { costUsd: ev.total_cost_usd } : null;
        }
      },
    });
    if (code !== 0 && !finalText) throw new Error(`claude exited ${code}: ${stderr.slice(-300)}`);
    return { text: finalText, session: newSession, usage };
  },

  // Slash commands intercepted by the hub before reaching headless claude
  // (which only replies "/resume isn't available in this environment").
  async handleCommand(cmd, args, currentSession) {
    if (cmd === 'status') {
      const s = asSession(currentSession);
      const cfg = getAgentCfg('claude');
      return {
        text: s
          ? `CLAUDE status:\n• Session: ${s.id.slice(0, 8)} (project ${projectOf(s.cwd)})\n• Resume mode: --resume active\n• Effort: ${cfg.effort || 'default'}\n• Clear: /clear · Fork: /fork`
          : 'CLAUDE status:\n• Session: none (next message starts a new session)',
      };
    }
    if (cmd === 'fork') {
      const s = asSession(currentSession);
      if (!s) return { text: 'No active session to fork. Chat normally first to establish a session.' };
      return {
        session: { ...s, fork: true },
        text: `⑂ Next message will fork a new session from ${s.id.slice(0, 8)} (the original stays untouched).`,
      };
    }
    if (cmd === 'sessions') {
      const list = listSessions(10);
      if (!list.length) return { text: 'No claude sessions found.' };
      return { text: `Recent claude sessions (⚡=written within 10 min, may be in use elsewhere):\n${list.map(listLine).join('\n')}` };
    }
    if (cmd === 'resume') {
      const all = listSessions(100);
      if (!all.length) return { text: 'No claude sessions found.' };
      const arg = args.trim();
      if (!arg) {
        // No arg → show the picker list instead of guessing a session.
        return { text: `Recent claude sessions (⚡=written within 10 min, may be in use elsewhere):\n${all.slice(0, 10).map(listLine).join('\n')}\n\nUse /resume <prefix> to resume (continues as a fork — the original session is never modified).` };
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
      if (!pick.cwd) return { text: `Session ${pick.id.slice(0, 8)} has no cwd info — cannot resume.` };
      // Always fork: harness continues the context in a NEW session id, so the
      // original transcript is never appended to (it may be live elsewhere).
      return {
        session: { id: pick.id, cwd: pick.cwd, fork: true },
        text: `✓ Resumed session ${pick.id.slice(0, 8)} (project ${projectOf(pick.cwd)} · ${fmtAge(pick.mtime)})\n"${pick.snippet}"\nNext messages continue this context as a fork — the original transcript is never modified.`,
      };
    }
    return null; // not handled → hub falls back
  },
};
