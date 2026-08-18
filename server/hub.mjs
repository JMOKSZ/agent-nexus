import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logEvent, addMemory, retireMemory, listMemories, buildContextBlock, normalizeKind, eventsSince, getMeta, setMeta } from './memory.mjs';
import { getAgentCfg } from './settings.mjs';

const STATE_DIR = join(homedir(), '.agent-nexus');
const STATE_FILE = join(STATE_DIR, 'state.json');
const MAX_HISTORY = 300;
const MAX_DISPATCH_DEPTH = 4;
const HUB_COMMANDS = new Set(['remember', 'forget', 'memories', 'distill', 'clearall']);

const DISTILL_PROMPT = `你是 NEXUS 多 agent 系统的记忆蒸馏器。下面是系统近期的事件日志（用户与各 agent 的交互记录）。
请提炼出值得长期记住的信息，每条一行，严格使用以下格式（除此以外不要输出任何内容）：
MEMO[fact]: 客观事实（端口、路径、配置、凭据位置等）
MEMO[decision]: 技术/方案决策及其原因
MEMO[preference]: 用户偏好、习惯
MEMO[task]: 进行中的任务状态或结论
规则：
- 只提炼有长期价值的信息；寒暄、一次性问答、报错过程不要
- 每条 ≤120 字，自包含（脱离日志上下文也能读懂）
- 互相重复的内容合并成一条
- 最多 10 条
- 如果日志里没有值得提炼的内容，只输出一行：NONE

事件日志：`;

export class Hub {
  constructor(adapters, agentsList) {
    this.adapters = adapters;
    this.agents = Object.fromEntries(agentsList.map((a) => [a.id, { name: a.name, color: a.color, desc: a.desc, modelHint: a.modelHint }]));
    this.agentIds = agentsList.map((a) => a.id);
    const idAlt = this.agentIds.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || 'a^';
    this.mentionRe = new RegExp(`^@(${idAlt}|all)\\b\\s*[:：,，]?\\s*([\\s\\S]+)$`, 'i');
    this.dispatchRe = new RegExp(`^\\s*@(${idAlt})\\b\\s*[:：,，]?\\s*(.+)$`, 'i');
    this.messages = [];
    this.sessions = {}; // agentId -> sessionId
    this.status = {}; // agentId -> {state:'idle'|'running'|'queued'|'error', task?, lastLatencyMs?, lastError?}
    this.queues = {}; // agentId -> Promise chain
    this.listeners = new Set();
    this.procs = {}; // agentId -> active child process
    this.gen = {}; // agentId -> queue generation; bump to cancel queued runs
    this.stopped = {}; // agentId -> true when current run was user-stopped
    // distiller for /distill: config may pin one ("distiller": true);
    // otherwise prefer a stateless adapter (cheap, no session pollution)
    this.distillerId = agentsList.find((a) => a.distiller)?.id
      || agentsList.find((a) => adapters[a.id]?.stateless)?.id
      || this.agentIds[0];
    for (const id of this.agentIds) this.status[id] = { state: 'idle' };
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

  // Reset one agent: drop its session and purge its messages from display
  // history (the sqlite event log and shared memories are untouched).
  resetAgent(agentId) {
    const hadSession = !!this.sessions[agentId];
    delete this.sessions[agentId];
    this.messages = this.messages.filter((m) => m.from !== agentId && m.to !== agentId);
    this.save();
    this.emit('display-clear', { agent: agentId });
    return hadSession;
  }

  // Wipe display history in every terminal + feed. Display only — the sqlite
  // event log (distill source) and memories survive.
  clearDisplay() {
    this.messages = [];
    this.save();
    this.emit('display-clear', {});
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
      this.pushMessage({ from: 'system', to: agentId, text: `⏹ ${this.agents[agentId].name} 队列已清空（无运行中的任务）`, kind: 'error' });
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
      // Memory/context injection (budget per agent, 0 disables):
      // - stateless agents (dsh): full block (memories + recent events)
      // - sessioned agents: memories only — their session covers history,
      //   but not what other agents/users wrote to shared memory
      const budget = getAgentCfg(agentId).ctxChars ?? (adapter.stateless ? 1800 : 900);
      const prompt = budget > 0
        ? (adapter.stateless
          ? buildContextBlock(agentId, { maxChars: budget, query: text })
          : buildContextBlock(agentId, { maxChars: budget, includeEvents: false, query: text })) + text
        : text;
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
        this.pushMessage({ from: 'system', to: agentId, text: `⏹ ${this.agents[agentId].name} 已被手动停止`, kind: 'error' });
        return;
      }
      this.setStatus(agentId, { state: 'error', task: null, lastError: String(err.message || err) });
      this.pushMessage({ from: 'system', to: agentId, text: `⚠ ${this.agents[agentId].name} error: ${err.message || err}`, kind: 'error' });
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
      const m = line.match(this.dispatchRe);
      if (!m) continue;
      const target = m[1].toLowerCase();
      const task = m[2].trim();
      if (target === fromAgent || !task || seen.has(target) || !this.adapters[target]) continue;
      seen.add(target);
      const context = buildContextBlock(fromAgent, { maxChars: 1200, eventLimit: 6, query: task });
      const forwarded = `${context}[from ${this.agents[fromAgent].name}] ${task}`;
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
        this.pushMessage({ from: 'system', to: 'user', text: `🧠 共享记忆 #${id}（${this.agents[fromAgent].name} · ${normalizeKind(m[1])}）: ${m[2].trim().slice(0, 120)}`, kind: 'memo' });
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
    if (cmd === 'distill') {
      this.runDistill();
      return;
    }
    if (cmd === 'clearall') {
      this.clearDisplay();
      say('🧹 全部窗口显示已清空（共享记忆与事件日志保留，不受影响）');
      return;
    }
  }

  // Distillation job: the distiller agent (config "distiller": true, else the
  // first stateless adapter) compresses new events since the last watermark
  // into candidate memories, which land in the staged area awaiting user
  // approval in the MEMORY panel.
  async runDistill() {
    const did = this.distillerId;
    const adapter = this.adapters[did];
    const say = (text) => this.pushMessage({ from: 'system', to: 'user', text, kind: 'memo' });
    if (!adapter) { say('蒸馏器不可用（agents 配置里没有可运行的 agent）。'); return; }
    const watermark = Number(getMeta('last_distill_event_id') || 0);
    const evs = eventsSince(watermark);
    if (!evs.length) { say('没有新事件需要蒸馏。'); return; }
    const prev = this.queues[did] || Promise.resolve();
    const job = prev.then(async () => {
      this.setStatus(did, { state: 'running', task: '🧪 蒸馏共享记忆…' });
      try {
        const { text } = await adapter.run({
          text: DISTILL_PROMPT + evs.map((e) => e.line).join('\n'),
          attachments: [],
          onDelta: () => {},
          onSpawn: (c) => { this.procs[did] = c; },
        });
        delete this.procs[did];
        let count = 0;
        for (const line of (text || '').split('\n')) {
          const m = line.match(/^\s*MEMO(?:\[(\w+)\])?\s*[:：]\s*(.+)$/i);
          if (!m) continue;
          if (addMemory({ kind: normalizeKind(m[1]), text: m[2], trust: 'agent', source: `distill:${did}`, status: 'staged' }) != null) count++;
        }
        setMeta('last_distill_event_id', evs[evs.length - 1].id);
        this.setStatus(did, { state: 'idle', task: null });
        say(count
          ? `🧪 蒸馏完成：${count} 条候选记忆进入待审批区（MEMORY 面板里 ✓ 批准 / ✕ 停用）`
          : '🧪 蒸馏完成：这段日志没有提炼出新的长期记忆。');
      } catch (err) {
        delete this.procs[did];
        this.setStatus(did, { state: 'idle', task: null });
        say(`⚠ 蒸馏失败: ${err.message || err}`);
      }
    });
    this.queues[did] = job.catch(() => {});
    say(`🧪 蒸馏作业已排队：${evs.length} 条新事件，由 ${this.agents[did].name} 提炼…`);
    return job;
  }

  handleUserInput(raw, attachments = []) {
    let to = 'broadcast';
    let text = raw.trim();
    const m = text.match(this.mentionRe);
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
    const targets = to === 'broadcast' ? this.agentIds : [to];
    for (const t of targets) this.enqueue(t, text, { from: 'user', attachments });
  }

  // Slash commands run immediately (outside the agent queue) and never reach
  // the headless CLI, which would only reject them.
  async handleCommand(agentId, cmdline) {
    const name = this.agents[agentId].name;
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
      agents: Object.fromEntries(Object.entries(this.agents).map(([id, a]) => [id, { ...a, stateless: !!this.adapters[id]?.stateless, ...this.status[id], session: this.sessions[id] || null }])),
      messages: this.messages.slice(-MAX_HISTORY),
    };
  }
}
