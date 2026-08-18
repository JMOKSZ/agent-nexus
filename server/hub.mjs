import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.agent-nexus');
const STATE_FILE = join(STATE_DIR, 'state.json');
const MAX_HISTORY = 300;
const MAX_DISPATCH_DEPTH = 4;

export const AGENTS = {
  claude: { name: 'CLAUDE', color: '#00f0ff', desc: 'Claude Code · cc-switch' },
  codex: { name: 'CODEX', color: '#ff2fd6', desc: 'Codex · DeepSeek API' },
  dsh: { name: 'DEEPSEEK', color: '#7cff4f', desc: 'DSH · headless harness' },
  openclaw: { name: 'OPENCLAW', color: '#b78bff', desc: 'OpenClaw · local gateway' },
};

export class Hub {
  constructor(adapters) {
    this.adapters = adapters;
    this.messages = [];
    this.sessions = {}; // agentId -> sessionId
    this.status = {}; // agentId -> {state:'idle'|'running'|'queued'|'error', task?, lastLatencyMs?, lastError?}
    this.queues = {}; // agentId -> Promise chain
    this.listeners = new Set();
    this.procs = {}; // agentId -> active child process
    this.gen = {}; // agentId -> queue generation; bump to cancel queued runs
    this.stopped = {}; // agentId -> true when current run was user-stopped
    for (const id of Object.keys(AGENTS)) this.status[id] = { state: 'idle' };
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      this.messages = d.messages || [];
      this.sessions = d.sessions || {};
    } catch { /* fresh start */ }
  }

  save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify({
        messages: this.messages.slice(-MAX_HISTORY),
        sessions: this.sessions,
      }));
    } catch { /* non-fatal */ }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const fn of this.listeners) fn(line);
  }

  pushMessage(msg) {
    const full = { id: randomUUID().slice(0, 8), ts: Date.now(), ...msg };
    this.messages.push(full);
    if (this.messages.length > MAX_HISTORY * 2) this.messages = this.messages.slice(-MAX_HISTORY);
    this.save();
    this.emit('msg', full);
    return full;
  }

  setStatus(agentId, patch) {
    Object.assign(this.status[agentId], patch);
    this.emit('status', { agent: agentId, ...this.status[agentId] });
  }

  // Enqueue a run for one agent. `depth` guards inter-agent dispatch loops.
  enqueue(agentId, text, { from = 'user', depth = 0, attachments = [] } = {}) {
    const adapter = this.adapters[agentId];
    if (!adapter) return;
    const prev = this.queues[agentId] || Promise.resolve();
    if (this.status[agentId].state === 'running') this.setStatus(agentId, { state: 'queued' });
    const run = prev.then(() => this.execute(agentId, adapter, text, { from, depth, attachments, gen: this.gen[agentId] || 0 }));
    this.queues[agentId] = run.catch(() => {});
    return run;
  }

  // Kill the active run and drop everything still queued for this agent.
  stop(agentId) {
    this.gen[agentId] = (this.gen[agentId] || 0) + 1;
    this.stopped[agentId] = true;
    const child = this.procs[agentId];
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    } else {
      this.stopped[agentId] = false;
      this.setStatus(agentId, { state: 'idle', task: null });
      this.pushMessage({ from: 'system', to: agentId, text: `⏹ ${AGENTS[agentId].name} 队列已清空（无运行中的任务）`, kind: 'error' });
    }
  }

  async execute(agentId, adapter, text, { from, depth, attachments, gen }) {
    if (gen !== (this.gen[agentId] || 0)) return; // cancelled while queued
    const started = Date.now();
    this.setStatus(agentId, { state: 'running', task: text.slice(0, 120), lastError: null });
    const deltaId = randomUUID().slice(0, 8);
    this.emit('delta-start', { agent: agentId, deltaId, from });
    let streamed = '';
    try {
      const result = await adapter.run({
        text,
        session: this.sessions[agentId] || null,
        attachments,
        onSpawn: (child) => { this.procs[agentId] = child; },
        onDelta: (chunk) => {
          streamed = chunk;
          this.emit('delta', { agent: agentId, deltaId, text: chunk });
        },
      });
      if (result.session !== undefined && result.session !== null) {
        this.sessions[agentId] = result.session;
        this.save();
      }
      delete this.procs[agentId];
      this.emit('delta-end', { agent: agentId, deltaId });
      const latency = Date.now() - started;
      this.setStatus(agentId, { state: 'idle', task: null, lastLatencyMs: latency });
      this.pushMessage({
        from: agentId,
        to: from === 'user' ? 'user' : from,
        text: result.text || streamed || '(empty reply)',
        kind: 'reply',
        latencyMs: latency,
        usage: result.usage || null,
      });
      if (depth < MAX_DISPATCH_DEPTH) this.scanDispatch(agentId, result.text || '', depth);
    } catch (err) {
      this.emit('delta-end', { agent: agentId, deltaId });
      delete this.procs[agentId];
      if (this.stopped[agentId]) {
        this.stopped[agentId] = false;
        this.setStatus(agentId, { state: 'idle', task: null });
        this.pushMessage({ from: 'system', to: agentId, text: `⏹ ${AGENTS[agentId].name} 已被手动停止`, kind: 'error' });
        return;
      }
      this.setStatus(agentId, { state: 'error', task: null, lastError: String(err.message || err) });
      this.pushMessage({ from: 'system', to: agentId, text: `⚠ ${AGENTS[agentId].name} error: ${err.message || err}`, kind: 'error' });
      setTimeout(() => this.setStatus(agentId, { state: 'idle' }), 5000);
    }
  }

  // Inter-agent dispatch: an agent reply may contain lines like
  //   @codex: review this function
  //   @openclaw 查一下今天的日程
  // Each match forwards the task to that agent with attribution.
  scanDispatch(fromAgent, text, depth) {
    const seen = new Set();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*@(claude|codex|dsh|openclaw)\b\s*[:：,，]?\s*(.+)$/i);
      if (!m) continue;
      const target = m[1].toLowerCase();
      const task = m[2].trim();
      if (target === fromAgent || !task || seen.has(target) || !this.adapters[target]) continue;
      seen.add(target);
      const forwarded = `[from ${AGENTS[fromAgent].name}] ${task}`;
      this.pushMessage({ from: fromAgent, to: target, text: task, kind: 'dispatch', depth: depth + 1 });
      this.enqueue(target, forwarded, { from: fromAgent, depth: depth + 1 });
    }
  }

  handleUserInput(raw, attachments = []) {
    let to = 'broadcast';
    let text = raw.trim();
    const m = text.match(/^@(claude|codex|dsh|openclaw|all)\b\s*[:：,，]?\s*([\s\S]+)$/i);
    if (m) {
      to = m[1].toLowerCase() === 'all' ? 'broadcast' : m[1].toLowerCase();
      text = m[2].trim();
    }
    if (!text && !attachments.length) return;
    if (!text) text = '(见附件)';
    this.pushMessage({ from: 'user', to, text, kind: 'user', attachments: attachments.length ? attachments : undefined });
    if (text.startsWith('/')) {
      if (to === 'broadcast') {
        this.pushMessage({ from: 'system', to: 'user', text: '斜杠命令需要定向到具体 agent，例如 @claude /sessions', kind: 'error' });
        return;
      }
      this.handleCommand(to, text);
      return;
    }
    const targets = to === 'broadcast' ? Object.keys(this.adapters) : [to];
    for (const t of targets) this.enqueue(t, text, { from: 'user', attachments });
  }

  // Slash commands run immediately (outside the agent queue) and never reach
  // the headless CLI, which would only reject them.
  async handleCommand(agentId, cmdline) {
    const name = AGENTS[agentId].name;
    const sp = cmdline.indexOf(' ');
    const cmd = (sp < 0 ? cmdline.slice(1) : cmdline.slice(1, sp)).toLowerCase();
    const args = sp < 0 ? '' : cmdline.slice(sp + 1);
    const reply = (text) => this.pushMessage({ from: agentId, to: 'user', text, kind: 'reply' });

    if (cmd === 'stop') {
      this.stop(agentId);
      return;
    }
    if (['clear', 'new', 'reset'].includes(cmd)) {
      delete this.sessions[agentId];
      this.save();
      reply(`✓ ${name} 会话已清空，下条消息开启新会话。`);
      return;
    }
    const adapter = this.adapters[agentId];
    if (adapter.handleCommand) {
      try {
        const res = await adapter.handleCommand(cmd, args, this.sessions[agentId] || null);
        if (res) {
          if ('session' in res) {
            if (res.session) this.sessions[agentId] = res.session;
            else delete this.sessions[agentId];
            this.save();
          }
          reply(res.text);
          return;
        }
      } catch (err) {
        reply(`⚠ 命令执行失败: ${err.message || err}`);
        return;
      }
    }
    const cmds = adapter.slashCommands ? [...adapter.slashCommands, 'clear', 'stop'] : ['clear', 'stop'];
    reply(`${name} 不支持 /${cmd}。该 agent 可用命令: ${[...new Set(cmds)].map((c) => '/' + c).join(' ')}`);
  }

  snapshot() {
    return {
      agents: Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [id, { ...a, ...this.status[id], session: this.sessions[id] || null }])),
      messages: this.messages.slice(-MAX_HISTORY),
    };
  }
}
