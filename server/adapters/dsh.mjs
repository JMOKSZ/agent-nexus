import { execFileSync, execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { runCli, stripAnsi, attachmentNote } from '../runner.mjs';
import { getAgentCfg, splitArgs } from '../settings.mjs';

// DeepSeek Harness headless profile: one-shot per message, plain-text answer on stdout.
// Does NOT touch the separate `dsh --profile lark` process (Feishu link stays intact).
//
// Streaming: the headless runner only prints the final message, but every turn is
// persisted to ~/.dsh/sessions/<cwd-slug>/session-*/session.jsonl.zstd as it happens.
// We poll that log (zstd frames are flushed per write, so zstdcat reads partial files)
// and push a growing CoT transcript via onDelta — reasoning blocks, tool calls, text.

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');
const POLL_MS = 800;

function findSessionFile(afterMs) {
  let best = null;
  let dirs = [];
  try { dirs = readdirSync(SESSIONS_ROOT); } catch { return null; }
  for (const cwdSlug of dirs) {
    const parent = join(SESSIONS_ROOT, cwdSlug);
    let sessions = [];
    try { sessions = readdirSync(parent); } catch { continue; }
    for (const s of sessions) {
      if (!s.startsWith('session-')) continue;
      const f = join(parent, s, 'session.jsonl.zstd');
      try {
        const st = statSync(join(parent, s));
        if (st.birthtimeMs >= afterMs - 2000 && (!best || st.birthtimeMs > best.birth)) {
          best = { file: f, birth: st.birthtimeMs };
        }
      } catch { /* gone */ }
    }
  }
  return best?.file || null;
}

function zstdcat(file) {
  return new Promise((resolve) => {
    execFile('zstdcat', [file], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      // truncated tail frame sets err — stdout still holds all complete frames
      resolve(stdout || '');
    });
  });
}

function shortArgs(name, argsJson) {
  try {
    const a = JSON.parse(argsJson);
    const v = a.command ?? a.file_path ?? a.path ?? a.query ?? a.url ?? Object.values(a)[0];
    return String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return String(argsJson || '').replace(/\s+/g, ' ').slice(0, 160);
  }
}

function renderTranscript(jsonl) {
  // Rebuild the live transcript from the full event log each poll (idempotent).
  // Blocks keyed by turn:step:index; block-end / assistant/message carry the
  // authoritative full text, *-delta and compacted *-chunks lines carry pieces.
  const blocks = new Map(); // key -> { kind: 'reasoning'|'text', text, order }
  const tools = new Map();  // callId -> line
  let order = 0;
  const blockAt = (turn, step, index, kind) => {
    const key = `${turn}:${step}:${index}`;
    if (!blocks.has(key)) blocks.set(key, { kind, text: '', order: order++ });
    return blocks.get(key);
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const d = ev.data || {};
    if (ev.type === 'assistant/chunk') {
      const c = d.chunk || {};
      if (c.type === 'block-start') {
        blockAt(d.turn, d.step, c.index, c.blockType === 'reasoning' ? 'reasoning' : 'text');
      } else if (c.type === 'reasoning-delta' || c.type === 'text-delta') {
        blockAt(d.turn, d.step, c.index, c.type === 'reasoning-delta' ? 'reasoning' : 'text').text += c.text || '';
      } else if (c.type === 'block-end' && c.block) {
        const b = blockAt(d.turn, d.step, c.index, c.block.type === 'reasoning' ? 'reasoning' : 'text');
        if (c.block.text) b.text = c.block.text;
      }
    } else if (ev.type === 'tool/call') {
      if (d.callId && !tools.has(d.callId)) {
        tools.set(d.callId, `🔧 ${d.name || 'tool'}: ${shortArgs(d.name, d.arguments)}`);
      }
    } else if (ev.type === 'assistant/message') {
      (d.message?.content || []).forEach((blk, i) => {
        if ((blk.type === 'reasoning' || blk.type === 'text') && blk.text) {
          blockAt(d.turn, d.step, i, blk.type).text = blk.text;
        }
      });
    } else if (ev.type === 'reasoning-chunks' || ev.type === 'text-chunks') {
      // compacted delta batch: { turn, step, index, texts: [...] }
      const kind = ev.type === 'reasoning-chunks' ? 'reasoning' : 'text';
      blockAt(d.turn, d.step, d.index, kind).text += (d.texts || []).join('');
    }
  }
  const lines = [];
  for (const b of [...blocks.values()].sort((a, z) => a.order - z.order)) {
    if (!b.text.trim()) continue;
    lines.push(b.kind === 'reasoning' ? '💭 ' + b.text.trim() : b.text.trim());
  }
  lines.push(...tools.values());
  return lines.join('\n\n');
}

async function streamSessionLog(afterMs, isDone, onDelta) {
  const state = { file: null, lastLen: 0 };
  const pollOnce = async () => {
    const out = await zstdcat(state.file);
    if (out.length > state.lastLen + 16) {
      state.lastLen = out.length;
      const text = renderTranscript(out);
      if (text) onDelta(text);
    }
  };
  // the session dir appears a moment after spawn — wait for it
  for (let i = 0; i < 60 && !isDone(); i++) {
    state.file = findSessionFile(afterMs);
    if (state.file) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.file) {
    // task may have finished before the session dir was discovered — the
    // end-of-run flush guarantees the file exists now, so retry discovery once
    return async () => {
      state.file = findSessionFile(afterMs);
      if (state.file) await pollOnce();
    };
  }
  while (!isDone()) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return pollOnce; // one final read after the process exits (end-of-run flush)
}

export const dshAdapter = {
  id: 'dsh',
  stateless: true, // no session continuity — hub prepends shared context each run
  streamIsProcess: true, // live deltas are CoT, not the reply — hub keeps them as a collapsed block
  slashCommands: ['status'],
  async run({ text, attachments = [], onDelta, onSpawn = () => {} }) {
    const prompt = text + (attachments.length ? attachmentNote(attachments) : '');
    const cfg = getAgentCfg('dsh');
    const started = Date.now();
    let done = false;
    const tail = streamSessionLog(started, () => done, onDelta);
    try {
      const { code, stdout, stderr } = await runCli('dsh', ['--profile', 'headless', prompt, ...splitArgs(cfg.extraArgs)], {
        timeoutMs: 600_000,
        onSpawn,
      });
      const clean = stripAnsi(stdout).trim();
      if (code !== 0 && !clean) throw new Error(`dsh exited ${code}: ${stripAnsi(stderr).slice(-300)}`);
      return { text: clean, session: null, usage: null };
    } finally {
      done = true;
      const finalPoll = await tail;
      if (finalPoll) await finalPoll(); // catch events flushed right before exit
    }
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
        'DEEPSEEK (DSH) status:',
        '• Mode: headless one-shot (no session continuity)',
        '• Streaming: live CoT via session log tail',
        `• Lark link (dsh --profile lark): ${lark}`,
        `• dsh web :3080: ${web}`,
      ].join('\n'),
    };
  },
};
