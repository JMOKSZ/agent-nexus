# NEXUS // Command Deck

本机多 Agent 统一指挥台：在一个赛博风 WebUI 里同时指挥任意数量、任意组合的本地 CLI agent（内置 Claude Code、Codex、DeepSeek Harness、OpenClaw 四种适配器，可自行增删），支持广播/定向指令、agent 间互相调度、共享记忆、会话续接、附件上传、停止/重置、多套皮肤与聚焦模式。

![tech](https://img.shields.io/badge/stack-zero--dependency%20Node%20ESM-00f0ff) ![platform](https://img.shields.io/badge/platform-macOS-888)

## 功能

- **N 路终端同屏**：终端矩阵 + 右侧 UPLINK FEED 全局消息流，SSE 实时推送；agent 数量由配置决定（1 个到多个均可）
- **指挥方式**：默认广播到全部 agent；`@<agent-id>` 定向发送
- **Agent 互调**：某个 agent 的回复里出现独立行 `@<agent>: 任务` 时，hub 会自动转发给目标 agent（深度上限 4，防循环）
- **共享记忆**：`node:sqlite` 事件溯源存储；`/remember` `/forget` `/memories` 命令；agent 回复中的 `MEMO[kind]: …` 行自动入库；按相关度召回注入各 agent prompt；`/distill` 蒸馏候选记忆 + MEMORY 面板待审批流；「管理」页可查看/编辑/恢复全部记忆
- **会话管理**：`/sessions` 列出历史会话、`/resume <前缀>` 恢复上下文（claude/codex）、`/clear` 清空、`/status` 查看各 agent 链路状态、`/stop` 停止当前任务并清空队列
- **附件**：📎 按钮 / 拖拽 / 粘贴上传文件、图片、音频、视频（≤50MB）；codex 图片走真视觉输入，其余以路径引用传给 agent
- **设置面板（⚙）**：每个 agent 的模型与附加 CLI 参数、5 套皮肤（CYBERPUNK / MATRIX / SYNTHWAVE / AMBER / ARCTIC）、聚焦窗口透明度（默认 70%，Ghostty 式背景半透明文字不透明）
- **聚焦模式**：单选一个 agent，其终端弹出为全窗口半透明面板；再点一次 / Esc / 选 ALL 退出

## 要求

- **macOS**（launchd 常驻用；不用 launchd 也可以直接 `node` 前台跑，其他 Unix 同理）
- **Node.js ≥ 18**（用到 `fetch` / `structuredClone`；零 npm 依赖，无需 `npm install`）
- 按需安装各 agent 的 CLI（缺哪个只是对应终端不可用，不影响其他）：

| Agent | CLI | 说明 |
|---|---|---|
| Claude Code | `claude` | 官方 CLI；配合 cc-switch 切换渠道亦可 |
| Codex | Codex.app 内置 CLI | 默认路径 `/Applications/Codex.app/Contents/Resources/codex`，可在 `server/adapters/codex.mjs` 顶部 `CODEX_BIN` 修改 |
| DeepSeek Harness | `dsh` | 需要内建 `headless` profile（`dsh --profile headless`） |
| OpenClaw | `openclaw` | 通过本地 gateway 的 `agent` 子命令调用；**不带 `--deliver`/`--channel`，不会触碰任何外部 IM 通道** |

## 安装

```bash
git clone https://github.com/<your-name>/agent-nexus.git
cd agent-nexus
```

### 方式一：直接运行（最简单）

```bash
node server/index.mjs
# 打开 http://127.0.0.1:7700
```

### 方式二：launchd 常驻（macOS 推荐）

```bash
# 1. 生成适配本机路径的 plist（模板里是 __HOME__ 占位符）
sed "s|__HOME__|$HOME|g" launchd/com.agent-nexus.plist > ~/Library/LaunchAgents/com.agent-nexus.plist

# 2. 确认模板里的 node 路径与你的实际路径一致（默认 /opt/homebrew/opt/node/bin/node）
which node   # 不一致就编辑 ~/Library/LaunchAgents/com.agent-nexus.plist 里的 ProgramArguments

# 3. 加载并启动
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-nexus.plist

# 4. 日常控制
bin/nexus start|stop|restart|logs
```

launchd 配置为 `KeepAlive` 开机自启、崩溃自动拉起；日志在 `~/.agent-nexus/nexus.log`。

## 配置

### Agent 阵容（放几个、放哪些，全由你定）

复制示例配置后按需修改：

```bash
mkdir -p ~/.agent-nexus
cp agents.example.json ~/.agent-nexus/agents.json
```

`~/.agent-nexus/agents.json` 是一个数组，每项一个终端：

```json
[
  {
    "id": "claude",            // 唯一 id，@定向 / 调度都用它（小写字母数字-_）
    "name": "CLAUDE",          // 终端标题显示名
    "color": "#00f0ff",        // 主题色
    "desc": "Claude Code CLI", // 副标题
    "adapter": "claude",       // 适配器类型：claude | codex | dsh | openclaw
    "modelHint": "留空=默认",   // 设置面板里模型输入框的提示语（可选）
    "ctxChars": 900,           // 共享记忆注入预算字符数，0=关闭（可选，默认 900）
    "distiller": true          // 可选：指定该 agent 执行 /distill 蒸馏（默认选第一个无会话 adapter）
  }
]
```

- **想少放几个**：删掉对应数组项即可，重启后该终端消失
- **想加同类型的第二个实例**：再加一项，用不同的 `id`（如 `claude2`），同一个 adapter 类型可以复用
- 不写 `~/.agent-nexus/agents.json` 则使用仓库里的 `agents.example.json`（四个示例 agent）
- 非法 id、未知 adapter 类型的条目会被跳过并在日志里告警
- 环境变量 `NEXUS_AGENTS_FILE` 可指定其他路径的配置文件
- 修改后重启生效：`bin/nexus restart`（或 `launchctl kickstart -k gui/$(id -u)/com.agent-nexus`）

### 其他配置

- 打开 `http://127.0.0.1:7700` → 右上角 **⚙**：设置每个 agent 的模型/附加参数、皮肤、聚焦透明度，保存即生效（模型/参数对该 agent 下一条消息生效）
- 配置文件：`~/.agent-nexus/settings.json`（也可手改）
- 运行状态：`~/.agent-nexus/state.json`（消息历史与会话）；共享记忆：`~/.agent-nexus/nexus.db`；上传文件：`~/.agent-nexus/uploads/`

## 使用速查

| 操作 | 方式 |
|---|---|
| 发送 | `Shift+Enter` 或 SEND 按钮（`Enter` 换行） |
| 定向 | 点底部 chip，或消息开头写 `@codex …` |
| 斜杠命令 | `/status` `/sessions` `/resume <前缀>` `/clear` `/stop`（hub 层拦截，不进无头 CLI） |
| 聚焦 | 单选 agent chip / 点终端标题栏；Esc 退出 |
| 停止任务 | 终端右上角 ⏹，或发 `/stop` |
| 重置会话 | 终端右上角 RESET，或发 `/clear` |

## 安全说明

- 服务**只绑定 `127.0.0.1`，没有任何鉴权** —— 请勿用反向代理/端口转发把它暴露到局域网或公网
- OpenClaw 适配器不会向 Telegram 等通道投递消息；DSH 适配器使用独立的 headless profile，不影响其他 profile 的进程

## 目录结构

```
server/
  index.mjs            # HTTP + SSE 服务（127.0.0.1:7700）
  hub.mjs              # 消息路由、per-agent 队列、调度解析、斜杠命令、蒸馏作业
  agents-config.mjs    # agent 阵容配置加载（~/.agent-nexus/agents.json）
  memory.mjs           # 共享记忆（node:sqlite 事件溯源 + 相关度召回）
  runner.mjs           # CLI spawn 封装（超时/逐行回调/onSpawn）
  settings.mjs         # 设置存取（模型/参数/皮肤/透明度）
  adapters/            # claude / codex / dsh / openclaw 适配器 + 类型注册表
web/                   # 无构建 vanilla JS + 手写 CSS
agents.example.json    # agent 阵容示例配置（4 个内置适配器各一个）
bin/nexus              # launchd 控制脚本
launchd/               # plist 模板
```
