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
        snippet = text.replace(/\s+/g, ' ').slice(0, 60);
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
  `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)}${isLive(s) ? ' · ⚡活跃中' : ''} · ${s.snippet}`;

export const codexAdapter = {
  id: 'codex',
  slashCommands: ['sessions', 'resume', 'fork', 'status'],
  settingFields: [
    {
      key: 'sandbox', label: '沙箱模式 (-s)',
      options: [
        { value: '', label: '默认（config.toml）' },
        { value: 'read-only', label: 'read-only 只读' },
        { value: 'workspace-write', label: 'workspace-write 工作区可写' },
        { value: 'danger-full-access', label: 'danger-full-access 完全放行（危险）' },
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
    if (cfg.model) args.push('-m', cfg.model);
    if (cfg.sandbox) args.push('-s', cfg.sandbox);
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
          ? `CODEX 状态:\n• 线程: ${String(sid).slice(0, 13)}…\n• 模型: ${cfg.model || 'deepseek-v4-flash (DeepSeek API)'}\n• 沙箱: ${cfg.sandbox || '默认'}\n• 续接模式: exec resume 生效中\n• 清空: /clear · 分叉: /fork`
          : `CODEX 状态:\n• 线程: 无（下条消息开启新线程）\n• 模型: ${cfg.model || 'deepseek-v4-flash (DeepSeek API)'}`,
      };
    }
    if (cmd === 'fork') {
      const sid = typeof currentSession === 'string' ? currentSession : currentSession?.id;
      if (!sid) return { text: '当前没有活动线程，无法分叉。先正常对话建立线程。' };
      return {
        session: { id: sid, fork: true },
        text: `⑂ 下条消息将从线程 ${String(sid).slice(0, 8)} 分叉出新线程（原线程保持不变）。`,
      };
    }
    if (cmd === 'sessions') {
      const list = listSessions(10);
      if (!list.length) return { text: '没有找到任何 codex 会话。' };
      return { text: `最近的 codex 会话（⚡=10 分钟内有写入，可能正在别处使用）:\n${list.map(listLine).join('\n')}` };
    }
    if (cmd === 'resume') {
      const all = listSessions(100);
      if (!all.length) return { text: '没有找到任何 codex 会话。' };
      const arg = args.trim();
      if (!arg) {
        // No arg → show the picker list instead of guessing a session.
        return { text: `最近的 codex 会话（⚡=10 分钟内有写入，可能正在别处使用）:\n${all.slice(0, 10).map(listLine).join('\n')}\n\n用 /resume <前缀> 恢复（以分叉方式接续，原会话不会被修改）。` };
      }
      let pick;
      {
        const matches = all.filter((s) => s.id.startsWith(arg));
        if (matches.length === 0) return { text: `没有匹配 "${arg}" 的会话。用 /sessions 查看列表。` };
        if (matches.length > 1) {
          return { text: `"${arg}" 匹配到多个会话，请加长前缀:\n${matches.slice(0, 8).map(listLine).join('\n')}` };
        }
        pick = matches[0];
      }
      // Always fork into a new thread so the original thread is never appended to.
      return {
        session: { id: pick.id, fork: true },
        text: `✓ 已恢复 codex 线程 ${pick.id.slice(0, 8)}（项目 ${projectOf(pick.cwd)} · ${fmtAge(pick.mtime)}）\n"${pick.snippet}"\n后续消息将以分叉方式接续该线程上下文，原线程不会被修改。`,
      };
    }
    return null;
  },
};
