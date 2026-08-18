// Shared spawn helper: runs a CLI, streams stdout/stderr lines, resolves final output.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WORKDIR = join(homedir(), '.agent-nexus', 'workdir');
export const UPLOAD_DIR = join(homedir(), '.agent-nexus', 'uploads');

const ANSI = /\[[0-9;?]*[a-zA-Z]/g;
export const stripAnsi = (s) => s.replace(ANSI, '');

// Prompt appendix describing uploaded files so CLI agents can open them with their tools.
export const attachmentNote = (atts) =>
  '\n\n[用户上传的附件，请用文件工具打开查看：]\n' +
  atts.map((a, i) => `${i + 1}. ${a.path} (${a.mime}, ${(a.size / 1024).toFixed(0)}KB)`).join('\n');

export function runCli(cmd, args, { timeoutMs = 300_000, cwd = WORKDIR, onLine = () => {}, onSpawn = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    onSpawn(child);
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);

    const feed = (buf, acc) => {
      acc.buf += buf.toString('utf8');
      let idx;
      while ((idx = acc.buf.indexOf('\n')) >= 0) {
        const line = acc.buf.slice(0, idx);
        acc.buf = acc.buf.slice(idx + 1);
        onLine(line);
      }
    };
    const outAcc = { buf: '' };
    const errAcc = { buf: '' };
    child.stdout.on('data', (d) => { const s = d.toString('utf8'); out += s; feed(s, outAcc); });
    child.stderr.on('data', (d) => { const s = d.toString('utf8'); err += s; feed(s, errAcc); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outAcc.buf) onLine(outAcc.buf);
      if (killed) reject(new Error(`timeout after ${timeoutMs}ms`));
      else resolve({ code, stdout: out, stderr: err });
    });
  });
}
