# NEXUS // Command Deck

**一个浏览器标签页，指挥你整支本地 CLI agent 小队。**

NEXUS 是一个本机指挥台：把任意组合的 CLI agent——Claude Code、Codex、DeepSeek Harness、OpenClaw、Hermes 或你自己的——统一塞进一个赛博风 WebUI。广播或 @ 定向指令、每个 agent 独立的实时窗口、agent 之间互相调度、全队共享记忆，一应俱全。

![stack](https://img.shields.io/badge/stack-Node%20ESM%20%2B%20node--pty-00f0ff) ![platform](https://img.shields.io/badge/platform-macOS-888) ![license](https://img.shields.io/badge/license-MIT-9be7d8)

[English](README.md) | 中文

![NEXUS Command Deck](assets/screenshot-deck.png)

## 功能

- **Agent 矩阵** — 每个 agent 一个实时窗口，带状态灯、延迟、停止/重置按钮；阵容就是一个由你掌控的 JSON 文件（1 个到多个均可）
- **真终端模式** — 标记 `terminal: true` 的 agent 通过 node-pty + xterm.js 嵌入完整交互式 TUI（比如一个可以直接打字操作的完整 Claude Code 会话）；支持显式 `cmd`/`args`（如 `openclaw tui`）
- **实时过程流** — 无头 adapter 也能流式输出工作过程（不只是最终回复）：dsh adapter 跟踪 session 日志，实时渲染 CoT transcript（推理 + 工具调用），回复落地后冻结为可折叠块
- **广播与定向** — 默认发送给全部 agent；`@claude review this diff` 定向发送；底部 chip 一键切换目标
- **Agent 互调** — agent 在回复里写独立行 `@<agent>: <任务>` 即可调度另一个 agent，也可用 `nexus ask` CLI 或 `POST /api/agent/ask`（深度上限 4，防循环）
- **共享记忆** — `node:sqlite` 事件溯源存储；`/remember`、agent 回复里的 `MEMO[kind]:` 行自动入库、按相关度召回注入 prompt、`/distill` 蒸馏候选记忆 + 审批流、完整的管理界面
- **会话管理** — 恢复历史会话（`@claude /sessions`、`/resume <前缀>`），per-agent 会话跨重启续接
- **附件** — 拖拽 / 粘贴 / 📎 上传文件、图片、音频、视频（≤50MB）；Codex 以真视觉输入接收图片
- **三套马卡龙主题** — CYBER / LIGHT / DARK，Ghostty 式聚焦窗口半透明，可安装为 PWA / Mac Dock 应用
- **iPad 与手机适配** — 终端纵向堆叠，UPLINK FEED 变为滑出抽屉

## 要求

- **macOS**（launchd 常驻服务用；其他系统直接前台运行即可）
- **Node.js ≥ 22.5** — 共享记忆使用 `node:sqlite`（推荐 ≥ 23.4；安装程序会自动检测）
- **一次 `npm install`** — node-pty、ws、xterm。node-pty 需要原生编译，请先装 Xcode Command Line Tools（`xcode-select --install`）
- 按需安装各 agent 的 CLI——缺哪个只是对应终端不可用，不影响其他：

| Agent | CLI | 说明 |
|---|---|---|
| Claude Code | `claude` | 官方 CLI；配合 cc-switch 切换渠道亦可 |
| Codex | `codex` | 也会自动探测 Codex.app 内置 CLI |
| DeepSeek Harness | `dsh` | 需要内建 `headless` profile |
| OpenClaw | `openclaw` | 通过本地 gateway 的 `agent` 子命令调用；**不会触碰任何外部 IM 通道** |
| Hermes | `hermes` | 第三方 CLI agent；deck 会话用 `--source tool` 标记，不混入你自己的会话列表 |

## 快速开始

```bash
git clone https://github.com/JMOKSZ/agent-nexus.git
cd agent-nexus
npm run setup        # = node bin/install.mjs
```

交互式安装向导一次完成所有设置：

1. **环境检查** — Node 版本 + `node:sqlite` 支持
2. **依赖安装** — `npm install`，node-pty 编译失败时给出 Xcode CLT 指引
3. **组建你的团队** — 自动探测已安装的 agent CLI，逐个确认是否纳入，可追加同类型第二实例（如 `claude2`），生成 `~/.agent-nexus/agents.json`（已存在的文件先备份，绝不覆盖丢失）
4. **后台服务** — macOS 上一键安装 launchd 服务（自动适配本机 node 与仓库路径，开机自启、崩溃拉起）
5. **健康检查** — 确认 deck 真正上线后才宣告完成

然后打开 **http://127.0.0.1:7700**。

脚本化 / 非交互用法：

```bash
node bin/install.mjs --yes                 # 全部接受默认值
node bin/install.mjs --no-launchd          # 不装后台服务
node bin/install.mjs --skip-deps           # 跳过 npm install
printf 'y\nn\ny\n' | node bin/install.mjs  # 管道输入也支持
```

### 手动安装（不用向导）

```bash
npm install
node server/index.mjs          # 前台运行
```

不写 `~/.agent-nexus/agents.json` 时，deck 会使用仓库自带的 `agents.example.json` 作为阵容。

手动配置 launchd（即安装程序自动完成的事）：

```bash
sed "s|__HOME__|$HOME|g" launchd/com.agent-nexus.plist > ~/Library/LaunchAgents/com.agent-nexus.plist
# 若 node 不在 /opt/homebrew/opt/node/bin/node，编辑 plist 里的 ProgramArguments
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-nexus.plist
```

日常控制：`bin/nexus start | stop | restart | logs`——日志在 `~/.agent-nexus/nexus.log`。

## 配置你的团队

`~/.agent-nexus/agents.json` 是一个数组——每项一个窗口：

```json
[
  {
    "id": "claude",
    "name": "CLAUDE",
    "color": "#00f0ff",
    "desc": "Claude Code CLI",
    "adapter": "claude",
    "modelHint": "claude-sonnet-4-6 (empty = default)",
    "ctxChars": 900,
    "cwd": "~",
    "terminal": true
  }
]
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | ✓ | 唯一，小写 `[a-z0-9-_]`——@ 定向和调度都用它 |
| `name` | ✓ | 窗口标题 |
| `color` | ✓ | 主题色（hex） |
| `adapter` | ✓ | `claude` \| `codex` \| `dsh` \| `openclaw` \| `hermes` |
| `desc` | | 副标题 |
| `modelHint` | | 设置面板里模型输入框的提示语 |
| `ctxChars` | | 共享记忆注入预算字符数（0 = 关闭，默认 900） |
| `cwd` | | agent 进程的工作目录 |
| `terminal` | | 嵌入真实交互式 TUI，而不是无头单次运行 |
| `cmd` / `args` | | 仅终端模式：要启动的命令/参数（默认用 agent id + 设置面板的 `--model`/`extraArgs`）。显式 `args` 会取代 `--model` 约定——例如 `["tui", "--session", "nexus"]` 对应 `openclaw tui` |
| `distiller` | | 指定该 agent 执行 `/distill` 蒸馏（默认选第一个无会话 adapter） |

- 想少放几个：删掉对应数组项即可。想加同类型第二个实例：加一个不同 `id` 的条目。
- 非法 id、未知 adapter 类型的条目会被跳过并在日志里告警。
- 环境变量 `NEXUS_AGENTS_FILE` 可指定其他路径的阵容文件。
- 修改后 `bin/nexus restart` 生效。

其他所有配置——每个 agent 的模型与附加 CLI 参数、主题、聚焦透明度——都在右上角 **⚙ 设置** 面板里实时调整（存于 `~/.agent-nexus/settings.json`）。

## 使用速查

| 操作 | 方式 |
|---|---|
| 发送 | `Shift+Enter` 或发送按钮（`Enter` 换行） |
| 定向单个 agent | 点底部 chip，或消息开头写 `@codex …` |
| 聚焦模式 | 点窗口标题栏，或单选 chip；`Esc` 退出 |
| 停止任务 | 窗口右上角 ⏹，或 `@agent /stop` |
| 重置会话 | 窗口右上角 RESET，或 `@agent /clear` |
| 附件 | 📎 按钮 / 拖拽 / 粘贴 |

斜杠命令——hub 层（随处可用）：`/remember` `/forget` `/memories` `/distill` `/clearall`。
agent 层（需 `@agent` 前缀）：claude 与 codex 支持 `/sessions` `/resume <前缀>` `/fork` `/status` `/clear` `/stop`；dsh 与 openclaw 支持 `/status` `/clear` `/stop`；hermes 支持 `/sessions` `/resume <前缀>` `/status` `/clear` `/stop`。真终端窗口里斜杠命令会直接打进 TUI。

## Agent 互调

agent 之间互相调度有三种方式：

- **回复中**：独立一行 `@<agent>: <任务>` 会被自动转发（fire-and-forget，深度上限 4）
- **CLI**：`nexus ask <agent> "<任务>"`——阻塞等待并打印回复（`NEXUS_ASK_FROM=<id>` 指定发起方）
- **HTTP**：`curl -X POST 127.0.0.1:7700/api/agent/ask -H 'Content-Type: application/json' -d '{"from":"codex","to":"dsh","text":"…"}'`

真终端 agent（如运行中的 Claude Code TUI）以键盘输入方式接收任务——它们是真正交互式的，回复无法同步捕获。

## 数据位置

| 路径 | 内容 |
|---|---|
| `~/.agent-nexus/agents.json` | 团队阵容 |
| `~/.agent-nexus/settings.json` | 模型、参数、主题、透明度 |
| `~/.agent-nexus/state.json` | 消息历史与会话 |
| `~/.agent-nexus/nexus.db` | 共享记忆（SQLite） |
| `~/.agent-nexus/uploads/` | 上传的附件 |
| `~/.agent-nexus/nexus.log` | 服务日志 |

## 安全说明

服务**只绑定 `127.0.0.1`，没有任何鉴权**——请勿用反向代理或端口转发把它暴露到局域网或公网。OpenClaw 适配器不会向 Telegram 等外部通道投递消息；DSH 适配器使用独立的 headless profile，不影响其他 profile。

### Tailscale / 局域网访问

默认只绑定 `127.0.0.1`。需要从 Tailscale 网络内的其他设备（如 iPad / iPhone）访问时，在 launchd plist 或启动环境里设置 `NEXUS_HOST=0.0.0.0`（或具体的 Tailscale IP，如 `100.x.y.z`），然后从设备打开 `http://<Tailscale IP>:7700`。注意 deck 没有鉴权，绑定 `0.0.0.0` 后同网段设备都能访问。

多台机器区分 PWA 图标：设 `NEXUS_ICON_THEME=light` 会使用浅色底图标（清单与 apple-touch-icon 同步切换），默认深色。

## 目录结构

```
server/
  index.mjs            # HTTP + SSE + WS 服务（127.0.0.1:7700）
  hub.mjs              # 消息路由、per-agent 队列、调度解析、斜杠命令、蒸馏作业
  terminal.mjs         # node-pty 真终端（bracketed paste、cc-switch 模型环境注入）
  agents-config.mjs    # 阵容加载（~/.agent-nexus/agents.json）
  memory.mjs           # 共享记忆（node:sqlite，事件溯源）
  runner.mjs           # CLI spawn 封装（超时/逐行回调）
  settings.mjs         # 设置持久化
  adapters/            # claude / codex / dsh / openclaw / hermes 适配器 + 注册表
web/                   # 零构建 vanilla JS + 手写 CSS，PWA
bin/install.mjs        # 交互式安装程序
bin/nexus              # 服务控制 + agent 调度 CLI
launchd/               # plist 模板
```

## License

MIT
