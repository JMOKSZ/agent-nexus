import { spawn } from 'node-pty';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

// Real interactive terminal sessions for agents configured with "terminal": true.
// One persistent PTY per agent; web clients attach over WebSocket.
// A server-side headless terminal emulator mirrors all PTY output, so a client
// attaching gets a *serialized snapshot* (current screen + a little scrollback)
// instead of a replay of the raw byte history. TUI agents like Claude Code
// repaint the whole screen every frame — replaying raw bytes meant parsing
// hundreds of KB of stale frames on every page open; the snapshot is ~10KB
// and always reflects the live screen exactly.
// The hub talks to these agents by typing into the PTY (bracketed paste + Enter).

const EMU_SCROLLBACK = 2000;      // lines the server-side emulator keeps
const SNAPSHOT_SCROLLBACK = 100;  // lines of real history included in an attach snapshot

// Claude Code's status line shows the *requested* model; under cc-switch proxy
// mode the client has none configured, so it displays its built-in default
// while the proxy routes elsewhere. Read the current provider's model env from
// cc-switch so the terminal shows the real backend model. Resolved per spawn,
// so a provider switch applies on the next PTY restart.
export function ccSwitchModelEnv() {
  try {
    const dir = join(homedir(), '.cc-switch');
    const { currentProviderClaude } = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    if (!currentProviderClaude) return {};
    const db = new DatabaseSync(join(dir, 'cc-switch.db'), { readOnly: true });
    const row = db.prepare('SELECT settings_config FROM providers WHERE id = ?').get(currentProviderClaude);
    db.close();
    const env = JSON.parse(row?.settings_config || '{}').env || {};
    return Object.fromEntries(Object.entries(env).filter(([k]) => /^ANTHROPIC_.*MODEL/.test(k)));
  } catch { return {}; }
}

class TermSession {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts; // { cmd, args, cwd }
    this.clients = new Set();
    this.holds = new Map(); // ws -> buffered chunks while its attach snapshot is built
    this.cols = 120;
    this.rows = 32;
    this.emu = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: EMU_SCROLLBACK,
      allowProposedApi: true,
    });
    this.ser = new SerializeAddon();
    this.emu.loadAddon(this.ser);
    this.pty = null;
  }

  ensure() {
    if (this.pty) return;
    this.pty = spawn(this.opts.cmd, this.opts.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.opts.cwd || homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...(this.opts.cmd === 'claude' ? ccSwitchModelEnv() : {}),
      },
    });
    this.pty.onData((d) => {
      this.emu.write(d);
      for (const c of this.clients) this.safeSend(c, d);
    });
    this.pty.onExit(({ exitCode }) => {
      this.pty = null;
      const msg = `\r\n\x1b[33m[process exited (code ${exitCode}) — type anything to restart]\x1b[0m\r\n`;
      this.emu.write(msg);
      for (const c of this.clients) this.safeSend(c, msg);
    });
  }

  safeSend(ws, data) {
    const held = this.holds.get(ws);
    if (held) { held.push(data); return; }
    try { ws.send(data); } catch { this.clients.delete(ws); }
  }

  attach(ws) {
    this.ensure();
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', id: this.id }));
    // Hold live chunks for this client while the emulator flush + serialize is
    // pending, so the snapshot and any concurrent output stay in order.
    const held = [];
    this.holds.set(ws, held);
    // The write callback fires after all queued emulator writes are parsed,
    // so the snapshot reflects every byte the PTY has produced so far.
    this.emu.write('', () => {
      this.holds.delete(ws);
      let snap = '';
      try { snap = this.ser.serialize({ scrollback: SNAPSHOT_SCROLLBACK }); } catch { /* serialize best-effort */ }
      this.safeSend(ws, snap);
      for (const h of held) this.safeSend(ws, h);
    });
    ws.on('close', () => { this.clients.delete(ws); this.holds.delete(ws); });
  }

  detach(ws) { this.clients.delete(ws); this.holds.delete(ws); }

  write(data) {
    this.ensure();
    this.pty.write(data);
  }

  // Type a full message as bracketed paste (multiline-safe) followed by Enter.
  typeText(text) {
    this.ensure();
    this.pty.write(`\x1b[200~${text}\x1b[201~\r`);
  }

  resize(cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return;
    this.cols = Math.min(cols, 500);
    this.rows = Math.min(rows, 200);
    try { this.emu.resize(this.cols, this.rows); } catch { /* bad geometry */ }
    if (this.pty) { try { this.pty.resize(this.cols, this.rows); } catch { /* resizing dead pty */ } }
  }

  interrupt() { if (this.pty) this.pty.write('\x03'); }
}

class TerminalManager {
  constructor() { this.sessions = new Map(); }

  configure(defs) {
    for (const d of defs) {
      if (!this.sessions.has(d.id)) {
        this.sessions.set(d.id, new TermSession(d.id, { cmd: d.cmd, args: d.args || [], cwd: d.cwd }));
      }
    }
  }

  has(id) { return this.sessions.has(id); }
  get(id) { return this.sessions.get(id); }
  typeText(id, text) { this.sessions.get(id)?.typeText(text); }
}

export const termManager = new TerminalManager();
