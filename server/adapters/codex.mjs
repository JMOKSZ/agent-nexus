import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { runCli, attachmentNote } from '../runner.mjs';
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

export const codexAdapter = {
  id: 'codex',
  slashCommands: ['sessions', 'resume', 'status'],

  async run({ text, session, attachments = [], onDelta, onSpawn = () => {} }) {
    const images = attachments.filter((a) => a.mime.startsWith('image/'));
    const others = attachments.filter((a) => !a.mime.startsWith('image/'));
    const prompt = text + (others.length ? attachmentNote(others) : '');
    const args = session
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', session, prompt]
      : ['exec', '--json', '--skip-git-repo-check', prompt];
    const cfg = getAgentCfg('codex');
    if (cfg.model) args.push('-c', `model="${cfg.model}"`);
    args.push(...splitArgs(cfg.extraArgs));
    // images are real vision input, not just path references
    for (const img of images) args.push('--image', img.path);
    let threadId = session || null;
    let finalText = '';
    let usage = null;
    const { code, stderr } = await runCli(CODEX_BIN, args, {
      timeoutMs: 600_000,
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
      return {
        text: currentSession
          ? `CODEX 状态:\n• 线程: ${String(currentSession).slice(0, 13)}…\n• 模型: deepseek-v4-flash (DeepSeek API)\n• 续接模式: exec resume 生效中\n• 清空: /clear`
          : 'CODEX 状态:\n• 线程: 无（下条消息开启新线程）\n• 模型: deepseek-v4-flash (DeepSeek API)',
      };
    }
    if (cmd === 'sessions') {
      const list = listSessions(10);
      if (!list.length) return { text: '没有找到任何 codex 会话。' };
      const lines = list.map((s) =>
        `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)} · ${s.snippet}`);
      return { text: `最近的 codex 会话（用 /resume <前缀> 恢复）:\n${lines.join('\n')}` };
    }
    if (cmd === 'resume') {
      const all = listSessions(100);
      if (!all.length) return { text: '没有找到任何 codex 会话。' };
      const arg = args.trim();
      let pick;
      if (!arg) {
        pick = all[0];
      } else {
        const matches = all.filter((s) => s.id.startsWith(arg));
        if (matches.length === 0) return { text: `没有匹配 "${arg}" 的会话。用 /sessions 查看列表。` };
        if (matches.length > 1) {
          const lines = matches.slice(0, 8).map((s) =>
            `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)} · ${s.snippet}`);
          return { text: `"${arg}" 匹配到多个会话，请加长前缀:\n${lines.join('\n')}` };
        }
        pick = matches[0];
      }
      return {
        session: pick.id,
        text: `✓ 已恢复 codex 线程 ${pick.id.slice(0, 8)}（项目 ${projectOf(pick.cwd)} · ${fmtAge(pick.mtime)}）\n"${pick.snippet}"\n后续消息将接续该线程上下文。`,
      };
    }
    return null;
  },
};
