import { execFileSync } from 'node:child_process';
import { runCli, stripAnsi, attachmentNote } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

// DeepSeek Harness headless profile: one-shot per message, plain-text answer on stdout.
// Does NOT touch the separate `dsh --profile lark` process (Feishu link stays intact).
export const dshAdapter = {
  id: 'dsh',
  stateless: true, // no session continuity — hub prepends shared context each run
  slashCommands: ['status'],
  async run({ text, attachments = [], onDelta, onSpawn = () => {} }) {
    const prompt = text + (attachments.length ? attachmentNote(attachments) : '');
    const cfg = getAgentCfg('dsh');
    const { code, stdout, stderr } = await runCli('dsh', ['--profile', 'headless', prompt, ...splitArgs(cfg.extraArgs)], {
      timeoutMs: 600_000,
      onSpawn,
    });
    const clean = stripAnsi(stdout).trim();
    if (code !== 0 && !clean) throw new Error(`dsh exited ${code}: ${stripAnsi(stderr).slice(-300)}`);
    onDelta(clean);
    return { text: clean, session: null, usage: null };
  },

  async handleCommand(cmd) {
    if (cmd !== 'status') return null;
    let lark = 'not running';
    try { execFileSync('pgrep', ['-f', 'dsh --profile lark'], { stdio: 'pipe' }); lark = 'running ✓'; } catch { /* down */ }
    let web = 'DOWN';
    try {
      const r = await fetch('http://127.0.0.1:3080/', { signal: AbortSignal.timeout(2000) });
      if (r.ok) web = 'LIVE';
    } catch { /* down */ }
    return {
      text: [
        'DEEPSEEK (DSH) 状态:',
        '• 模式: headless 一次性（无会话连续性）',
        `• 飞书链路 (dsh --profile lark): ${lark}`,
        `• dsh web :3080: ${web}`,
      ].join('\n'),
    };
  },
};
