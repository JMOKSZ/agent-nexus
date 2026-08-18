import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logEvent, addMemory, retireMemory, listMemories, buildContextBlock, normalizeKind } from './memory.mjs';

const STATE_DIR = join(homedir(), '.agent-nexus');
const STATE_FILE = join(STATE_DIR, 'state.json');
const MAX_HISTORY = 300;
const MAX_DISPATCH_DEPTH = 4;
const HUB_COMMANDS = new Set(['remember', 'forget', 'memories']);

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
    logEvent(full);
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
      // Memory/context injection:
      // - stateless agents (dsh): full block (memories + recent events)
      // - sessioned agents: memories only — their session covers history,
      //   but not what other agents/users wrote to shared memory
      const prompt = adapter.stateless
        ? buildContextBlock(agentId, { maxChars: 1800 }) + text
        : buildContextBlock(agentId, { maxChars: 900, includeEvents: false }) + text;
      const result = await adapter.run({
        text: prompt,
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
      this.scanMemo(agentId, result.text || '');
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
  // Each match forwards the task to that agent with attribution, plus the
  // originating agent's recent context so the target isn't working blind.
  scanDispatch(fromAgent, text, depth) {
    const seen = new Set();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*@(claude|codex|dsh|openclaw)\b\s*[:：,，]?\s*(.+)$/i);
      if (!m) continue;
      const target = m[1].toLowerCase();
      const task = m[2].trim();
      if (target === fromAgent || !task || seen.has(target) || !this.adapters[target]) continue;
      seen.add(target);
      const context = buildContextBlock(fromAgent, { maxChars: 1200, eventLimit: 6 });
      const forwarded = `${context}[from ${AGENTS[fromAgent].name}] ${task}`;
      this.pushMessage({ from: fromAgent, to: target, text: task, kind: 'dispatch', depth: depth + 1 });
      this.enqueue(target, forwarded, { from: fromAgent, depth: depth + 1 });
    }
  }

  // Agents persist facts into shared memory with a standalone line:
  //   MEMO: the deploy port is 7700
  //   MEMO[decision]: use sqlite for storage
  scanMemo(fromAgent, text) {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*MEMO(?:\[(\w+)\])?\s*[:：]\s*(.+)$/i);
      if (!m) continue;
      const id = addMemory({ kind: normalizeKind(m[1]), text: m[2], trust: 'agent', source: fromAgent });
      if (id != null) {
        this.pushMessage({ from: 'system', to: 'user', text: `🧠 共享记忆 #${id}（${AGENTS[fromAgent].name} · ${normalizeKind(m[1])}）: ${m[2].trim().slice(0, 120)}`, kind: 'memo' });
      }
    }
  }

  // Hub-global commands: shared memory is hub-level, so these work from any
  // target including broadcast. Replies go to the feed, not one terminal.
  handleHubCommand(cmdline) {
    const sp = cmdline.indexOf(' ');
    const cmd = (sp < 0 ? cmdline.slice(1) : cmdline.slice(1, sp)).toLowerCase();
    const args = sp < 0 ? '' : cmdline.slice(sp + 1).trim();
    const say = (text) => this.pushMessage({ from: 'system', to: 'user', text, kind: 'memo' });

    if (cmd === 'remember') {
      const km = args.match(/^(\w+)\s*[:：]\s*([\s\S]+)$/);
      const kind = km ? normalizeKind(km[1]) : 'fact';
      const text = km ? km[2].trim() : args;
      if (!text) { say('用法: /remember [kind:] 内容 （kind = fact|decision|preference|task）'); return; }
      const id = addMemory({ kind, text, trust: 'user', source: 'user' });
      say(`🧠 已记住 #${id}（${kind}）: ${text.slice(0, 160)}`);
      return;
    }
    if (cmd === 'forget') {
      const id = Number(args);
      if (!id) { say('用法: /forget <id>（id 见 /memories）'); return; }
      say(retireMemory(id) ? `✓ 记忆 #${id} 已停用（可溯源，未物理删除）` : `记忆 #${id} 不存在或已停用`);
      return;
    }
    if (cmd === 'memories') {
      const n = Number(args) || 15;
      const mems = listMemories(n);
      if (!mems.length) { say('共享记忆为空。用 /remember 写入，或等 agent 用 MEMO: 行自行记录。'); return; }
      const lines = mems.map((m) => `#${m.id} [${m.kind}${m.trust === 'user' ? ' · 你' : ` · ${m.source || 'agent'}`}] ${m.text}`);
      say(`共享记忆（最新 ${mems.length} 条）:\n${lines.join('\n')}`);
      return;
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
      const cmdName = text.slice(1).split(/\s/, 1)[0].toLowerCase();
      if (HUB_COMMANDS.has(cmdName)) {
        this.handleHubCommand(text);
        return;
      }
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
