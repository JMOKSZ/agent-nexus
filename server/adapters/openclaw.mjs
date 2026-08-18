import { randomUUID } from 'node:crypto';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCli, stripAnsi, attachmentNote } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

const CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');
// openclaw's file tools live in its workspace, so uploads are mirrored there.
const INBOX_DIR = join(homedir(), '.openclaw', 'workspace', 'nexus-inbox');

function mirrorToInbox(atts) {
  mkdirSync(INBOX_DIR, { recursive: true });
  return atts.map((a) => {
    const dest = join(INBOX_DIR, a.stored);
    try { copyFileSync(a.path, dest); } catch { return a; }
    return { ...a, path: dest };
  });
}

// OpenClaw: one agent turn via the local gateway CLI. No --deliver/--channel, so the
// Telegram channel is never touched. Session continuity via a stable --session-id.
export const openclawAdapter = {
  id: 'openclaw',
  slashCommands: ['status'],
  settingFields: [
    {
      key: 'thinking', label: '思考级别 (--thinking)',
      options: [
        { value: '', label: '默认' },
        { value: 'off', label: 'off 关闭' },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' },
        { value: 'adaptive', label: 'adaptive 自适应' },
        { value: 'max', label: 'max' },
      ],
    },
  ],
  async run({ text, session, attachments = [], onDelta, onSpawn = () => {} }) {
    const sid = session || `nexus-${randomUUID().slice(0, 8)}`;
    const prompt = attachments.length
      ? text + attachmentNote(mirrorToInbox(attachments))
      : text;
    const cfg = getAgentCfg('openclaw');
    const args = ['agent', '--agent', 'main', '--session-id', sid, '-m', prompt, '--json'];
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.thinking) args.push('--thinking', cfg.thinking);
    args.push(...splitArgs(cfg.extraArgs));
    const { code, stdout, stderr } = await runCli('openclaw', args, { timeoutMs: 600_000, onSpawn });
    const clean = stripAnsi(stdout);
    const start = clean.indexOf('{');
    let payload = null;
    if (start >= 0) {
      try { payload = JSON.parse(clean.slice(start)); } catch { payload = null; }
    }
    const reply = payload?.finalAssistantVisibleText
      ?? payload?.finalAssistantRawText
      ?? payload?.payloads?.map((p) => p?.text).filter(Boolean).join('\n')
      ?? '';
    const model = payload?.executionTrace?.winnerModel || payload?.meta?.agentMeta?.model || null;
    if (!reply) throw new Error(`openclaw exited ${code}: ${stripAnsi(stderr).slice(-300) || clean.slice(-300)}`);
    onDelta(reply);
    return {
      text: reply,
      session: payload?.sessionId || payload?.meta?.agentMeta?.sessionId || sid,
      usage: model ? { model } : null,
    };
  },

  async handleCommand(cmd, _args, currentSession) {
    if (cmd !== 'status') return null;
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* unreadable */ }
    const port = cfg.gateway?.port || 18789;
    const token = cfg.gateway?.auth?.token;
    let gw = 'DOWN';
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) gw = 'LIVE';
    } catch { /* down */ }
    const primary = cfg.agents?.defaults?.model?.primary || '';
    const alias = cfg.agents?.defaults?.models?.[primary]?.alias;
    const model = alias || primary.split('/').pop() || '?';
    const fallbacks = (cfg.agents?.defaults?.model?.fallbacks || []).map((f) => f.split('/').pop());
    const channels = Object.entries(cfg.channels || {}).filter(([, v]) => v?.enabled).map(([k]) => k);
    return {
      text: [
        'OPENCLAW 状态:',
        `• gateway :${port}: ${gw}`,
        `• 主模型: ${model}${fallbacks.length ? `（fallback: ${fallbacks.join(', ')}）` : ''}`,
        `• 通道: ${channels.length ? channels.join(' + ') : '无'}`,
        `• nexus 会话: ${currentSession ? String(currentSession) : '无（下条消息开启新会话）'}`,
        `• nexus 思考级别: ${getAgentCfg('openclaw').thinking || '默认'}`,
      ].join('\n'),
    };
  },
};
