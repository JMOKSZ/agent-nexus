import { execFileSync } from 'node:child_process';
import { runCli, stripAnsi, attachmentNote } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

// Hermes Agent CLI: one-shot via `hermes chat -q <prompt> -Q`, quiet mode
// prints `session_id: <id>` followed by the final reply. Runs are tagged
// `--source tool` so deck sessions don't clutter the user's own hermes
// session list; /sessions and /resume manage those tool-sourced sessions.

const SESSION_RE = /^session_id:\s*([A-Za-z0-9_]+)\s*$/;

// hermes writes the `session_id:` marker to stderr and the final reply to
// stdout, and -Q can still emit a reasoning block before the marker — so the
// authoritative reply is everything after the LAST `session_id:` line in the
// real-time-merged stream (same order a terminal `2>&1` would show).
function parseReply(lines) {
  let last = -1;
  let sid = null;
  lines.forEach((line, i) => {
    const m = line.trim().match(SESSION_RE);
    if (m) { last = i; sid = m[1]; }
  });
  if (!sid) return { session: null, text: '' };
  return {
    session: sid,
    text: lines.slice(last + 1).filter(Boolean).join('\n').trim(),
  };
}

const ID_RE = /^[A-Za-z0-9_]{10,}$/;

function listToolSessions(limit = 12) {
  try {
    return execFileSync('hermes', ['sessions', 'list', '--source', 'tool', '--limit', String(limit)], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  } catch {
    return null;
  }
}

function idsFromTable(text) {
  const ids = [];
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t || /─/.test(t)) continue;
    const last = t.split(/\s+/).pop();
    if (ID_RE.test(last)) ids.push(last);
  }
  return ids;
}

export const hermesAdapter = {
  id: 'hermes',
  slashCommands: ['sessions', 'resume', 'status'],
  settingFields: [
    {
      key: 'reasoning',
      label: 'Reasoning effort (--reasoning)',
      options: [
        { value: '', label: 'default' },
        { value: 'none', label: 'none' },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' },
        { value: 'max', label: 'max' },
        { value: 'ultra', label: 'ultra' },
      ],
    },
  ],

  async run({ text, session, attachments = [], onDelta, onSpawn = () => {}, workdir }) {
    // `hermes chat` only accepts one --image (repeated flags override each
    // other), so attach the first image natively and list every attachment
    // path in the prompt for its file tools to open.
    const images = attachments.filter((a) => a.mime.startsWith('image/'));
    const prompt = text + (attachments.length ? attachmentNote(attachments) : '');
    const args = ['chat', '-q', prompt, '-Q', '--source', 'tool'];
    if (session) args.push('--resume', session);
    const cfg = getAgentCfg('hermes');
    if (cfg.model) args.push('-m', cfg.model);
    if (cfg.reasoning) args.push('--reasoning', cfg.reasoning);
    args.push(...splitArgs(cfg.extraArgs));
    if (images[0]) args.push('--image', images[0].path);

    let sawSession = false;
    const merged = [];
    const { code, stdout, stderr } = await runCli('hermes', args, {
      timeoutMs: 600_000,
      cwd: workdir,
      onSpawn,
      onLine(line) {
        const t = stripAnsi(line).trim();
        if (!t) return;
        merged.push(t);
        if (SESSION_RE.test(t)) { sawSession = true; return; }
        if (sawSession) onDelta(t);
      },
    });
    const parsed = parseReply(merged);
    if (code !== 0 && !parsed.text) {
      throw new Error(`hermes exited ${code}: ${stripAnsi(stderr).slice(-300)}`);
    }
    return { text: parsed.text || '(empty reply)', session: parsed.session || session || null, usage: null };
  },

  async handleCommand(cmd, args, currentSession) {
    if (cmd === 'status') {
      const cfg = getAgentCfg('hermes');
      return {
        text: currentSession
          ? `HERMES status:\n• Session: ${String(currentSession).slice(0, 16)}…\n• Model: ${cfg.model || 'default'}\n• Reasoning: ${cfg.reasoning || 'default'}\n• Resume mode: chat -q --resume active\n• Clear: /clear`
          : `HERMES status:\n• Session: none (next message starts a new session)\n• Model: ${cfg.model || 'default'}\n• Reasoning: ${cfg.reasoning || 'default'}`,
      };
    }
    if (cmd === 'sessions') {
      const out = listToolSessions(12);
      if (!out) return { text: 'No hermes sessions found (deck runs are tagged --source tool).' };
      return { text: `Recent hermes sessions (deck · --source tool):\n${out.trim()}` };
    }
    if (cmd === 'resume') {
      const out = listToolSessions(50);
      const ids = idsFromTable(out);
      if (!ids.length) return { text: 'No hermes sessions found (deck runs are tagged --source tool).' };
      const arg = args.trim();
      if (!arg) {
        return { text: `Recent hermes sessions:\n${(out || '').trim()}\n\nUse /resume <session-id-prefix> to continue one.` };
      }
      const matches = ids.filter((id) => id.startsWith(arg));
      if (!matches.length) return { text: `No hermes session matches "${arg}". Use /sessions to see the list.` };
      if (matches.length > 1) {
        return { text: `"${arg}" matches multiple sessions — use a longer prefix:\n${matches.join('\n')}` };
      }
      return { session: matches[0], text: `✓ Next message continues hermes session ${matches[0].slice(0, 16)}…` };
    }
    return null;
  },
};
