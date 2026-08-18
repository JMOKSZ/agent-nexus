import { spawn } from 'node-pty';
import { homedir } from 'node:os';

// Real interactive terminal sessions for agents configured with "terminal": true.
// One persistent PTY per agent; web clients attach over WebSocket and get the
// raw scrollback replayed on connect, so reloads/reconnects restore the screen.
// The hub talks to these agents by typing into the PTY (bracketed paste + Enter).

const SCROLLBACK_CAP = 512 * 1024; // bytes of raw PTY output kept for replay

class TermSession {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts; // { cmd, args, cwd }
    this.clients = new Set();
    this.buf = [];
    this.bufLen = 0;
    this.pty = null;
    this.cols = 120;
    this.rows = 32;
  }

  ensure() {
    if (this.pty) return;
    this.pty = spawn(this.opts.cmd, this.opts.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.opts.cwd || homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    this.pty.onData((d) => {
      this.push(d);
      for (const c of this.clients) this.safeSend(c, d);
    });
    this.pty.onExit(({ exitCode }) => {
      this.pty = null;
      this.push(`\r\n\x1b[33m[process exited (code ${exitCode}) — type anything to restart]\x1b[0m\r\n`);
      for (const c of this.clients) this.safeSend(c, `\r\n\x1b[33m[process exited (code ${exitCode}) — type anything to restart]\x1b[0m\r\n`);
    });
  }

  safeSend(ws, data) {
    try { ws.send(data); } catch { this.clients.delete(ws); }
  }

  push(d) {
    this.buf.push(d);
    this.bufLen += d.length;
    while (this.bufLen > SCROLLBACK_CAP && this.buf.length > 1) this.bufLen -= this.buf.shift().length;
  }

  attach(ws) {
    this.ensure();
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', id: this.id }));
    for (const chunk of this.buf) this.safeSend(ws, chunk);
    ws.on('close', () => this.clients.delete(ws));
  }

  detach(ws) { this.clients.delete(ws); }

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
