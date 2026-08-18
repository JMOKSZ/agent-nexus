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
      if (text && !text.startsWith('<')) snippet = text.replace(/\s+/g, ' ').slice(0, 60);
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
  `• ${s.id.slice(0, 8)} · ${projectOf(s.cwd)} · ${fmtAge(s.mtime)}${isLive(s) ? ' · ⚡活跃中' : ''} · ${s.snippet}`;

// Normalize legacy string session state.
const asSession = (s) => (s ? (typeof s === 'string' ? { id: s, cwd: null } : s) : null);

export const claudeAdapter = {
  id: 'claude',
  slashCommands: ['sessions', 'resume', 'fork', 'status'],
  settingFields: [
    {
      key: 'effort', label: '推理强度 (--effort)',
      options: [
        { value: '', label: '默认' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' },
        { value: 'max', label: 'max' },
      ],
    },
    {
      key: 'fallbackModel', label: '备用模型 (--fallback-model，过载时自动切换)',
      options: null, // free text
    },
  ],

  async run({ text, session, attachments = [], onDelta, onSpawn = () => {} }) {
    const s = asSession(session);
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
      cwd: s?.cwd || WORKDIR,
      onSpawn,
      onLine(line) {
        if (!line.trim().startsWith('{')) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          newSession = { id: ev.session_id, cwd: ev.cwd || s?.cwd || WORKDIR };
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) onDelta(block.text);
          }
        }
        if (ev.type === 'result') {
          if (ev.session_id) newSession = { id: ev.session_id, cwd: s?.cwd || WORKDIR };
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
          ? `CLAUDE 状态:\n• 会话: ${s.id.slice(0, 8)}（项目 ${projectOf(s.cwd)}）\n• 续接模式: --resume 生效中\n• 推理强度: ${cfg.effort || '默认'}\n• 清空: /clear · 分叉: /fork`
          : 'CLAUDE 状态:\n• 会话: 无（下条消息开启新会话）',
      };
    }
    if (cmd === 'fork') {
      const s = asSession(currentSession);
      if (!s) return { text: '当前没有活动会话，无法分叉。先正常对话建立会话。' };
      return {
        session: { ...s, fork: true },
        text: `⑂ 下条消息将从会话 ${s.id.slice(0, 8)} 分叉出新会话（原会话保持不变）。`,
      };
    }
    if (cmd === 'sessions') {
      const list = listSessions(10);
      if (!list.length) return { text: '没有找到任何 claude 会话。' };
      return { text: `最近的 claude 会话（⚡=10 分钟内有写入，可能正在别处使用）:\n${list.map(listLine).join('\n')}` };
    }
    if (cmd === 'resume') {
      const all = listSessions(100);
      if (!all.length) return { text: '没有找到任何 claude 会话。' };
      const arg = args.trim();
      if (!arg) {
        // No arg → show the picker list instead of guessing a session.
        return { text: `最近的 claude 会话（⚡=10 分钟内有写入，可能正在别处使用）:\n${all.slice(0, 10).map(listLine).join('\n')}\n\n用 /resume <前缀> 恢复（以分叉方式接续，原会话不会被修改）。` };
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
      if (!pick.cwd) return { text: `会话 ${pick.id.slice(0, 8)} 缺少 cwd 信息，无法恢复。` };
      // Always fork: harness continues the context in a NEW session id, so the
      // original transcript is never appended to (it may be live elsewhere).
      return {
        session: { id: pick.id, cwd: pick.cwd, fork: true },
        text: `✓ 已恢复会话 ${pick.id.slice(0, 8)}（项目 ${projectOf(pick.cwd)} · ${fmtAge(pick.mtime)}）\n"${pick.snippet}"\n后续消息将以分叉方式接续该会话上下文，原会话文件不会被修改。`,
      };
    }
    return null; // not handled → hub falls back
  },
};
