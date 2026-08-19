# NEXUS // Command Deck

**One browser tab to command your whole team of local CLI agents.**

NEXUS is a local command deck that puts any mix of CLI agents — Claude Code, Codex, DeepSeek Harness, OpenClaw, or your own — behind a single cyberpunk WebUI: broadcast or @-target instructions, watch every agent in its own live window, let agents dispatch each other, and share a collective memory across the team.

![stack](https://img.shields.io/badge/stack-Node%20ESM%20%2B%20node--pty-00f0ff) ![platform](https://img.shields.io/badge/platform-macOS-888) ![license](https://img.shields.io/badge/license-MIT-9be7d8)

English | [中文](README.zh-CN.md)

![NEXUS Command Deck](assets/screenshot-deck.png)

## Features

- **Agent matrix** — every agent gets a live window with status LED, latency, stop/reset controls; the roster is just a JSON file you control (1 agent or many)
- **Real terminal mode** — agents marked `terminal: true` embed a real interactive TUI via node-pty + xterm.js (e.g. a full Claude Code session you can also type into directly); explicit `cmd`/`args` supported (e.g. `openclaw tui`)
- **Live process streaming** — headless adapters can stream their working (not just the final reply): the dsh adapter tails the session log and renders a live CoT transcript (reasoning + tool calls), frozen into a collapsible block when the reply lands
- **Broadcast & targeting** — send to everyone, or `@claude review this diff` to one; bottom chips make targeting one tap
- **Agent-to-agent dispatch** — an agent can task another by writing `@<agent>: <task>` on its own line, via the `nexus ask` CLI, or `POST /api/agent/ask` (depth-capped to prevent loops)
- **Shared memory** — event-sourced `node:sqlite` store; `/remember`, `MEMO[kind]:` capture from agent replies, relevance-based recall injected into prompts, `/distill` staged candidates with an approval flow, full management UI
- **Sessions** — resume past conversations (`@claude /sessions`, `/resume <prefix>`), per-agent session continuity across restarts
- **Attachments** — drag / paste / 📎 files, images, audio, video up to 50 MB; Codex receives images as real vision input
- **Three macaron themes** — CYBER / LIGHT / DARK, Ghostty-style focus-mode translucency, installable as a PWA / Mac dock app
- **iPad & phone ready** — terminals stack, the uplink feed becomes a slide-in drawer

## Requirements

- **macOS** (for the launchd background service; anywhere else, just run it in the foreground)
- **Node.js ≥ 22.5** — shared memory uses `node:sqlite` (≥ 23.4 recommended; the installer checks for you)
- **One `npm install`** — node-pty, ws, xterm. node-pty compiles natively, so have Xcode Command Line Tools (`xcode-select --install`)
- Whichever agent CLIs you actually want to drive — missing ones are simply skipped:

| Agent | CLI | Notes |
|---|---|---|
| Claude Code | `claude` | Official CLI; works with cc-switch channel switching |
| Codex | `codex` | Also auto-detected inside Codex.app |
| DeepSeek Harness | `dsh` | Needs the built-in `headless` profile |
| OpenClaw | `openclaw` | Called through the local gateway `agent` subcommand; **never touches external IM channels** |

## Quick start

```bash
git clone https://github.com/JMOKSZ/agent-nexus.git
cd agent-nexus
npm run setup        # = node bin/install.mjs
```

The interactive installer walks you through everything:

1. **Runtime check** — Node version + `node:sqlite` support
2. **Dependencies** — `npm install`, with Xcode CLT guidance if node-pty fails to build
3. **Assemble your team** — auto-detects installed agent CLIs, lets you opt each one in/out, add extra instances (e.g. a second `claude2`), then writes `~/.agent-nexus/agents.json` (existing file is backed up, never clobbered)
4. **Background service** — on macOS, installs a launchd service with your real node and repo paths (auto-start on login, restart on crash)
5. **Health check** — verifies the deck is actually serving before saying done

Then open **http://127.0.0.1:7700**.

Scriptable / CI-friendly:

```bash
node bin/install.mjs --yes                 # accept all defaults
node bin/install.mjs --no-launchd          # skip the background service
node bin/install.mjs --skip-deps           # skip npm install
printf 'y\nn\ny\n' | node bin/install.mjs  # piped answers work too
```

### Manual install (no wizard)

```bash
npm install
node server/index.mjs          # foreground
```

No `~/.agent-nexus/agents.json`? The deck falls back to the bundled `agents.example.json`.

Manual launchd setup (what the installer does for you):

```bash
sed "s|__HOME__|$HOME|g" launchd/com.agent-nexus.plist > ~/Library/LaunchAgents/com.agent-nexus.plist
# edit ProgramArguments if your node isn't /opt/homebrew/opt/node/bin/node
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-nexus.plist
```

Day-to-day control: `bin/nexus start | stop | restart | logs` — logs live at `~/.agent-nexus/nexus.log`.

## Configure your team

`~/.agent-nexus/agents.json` is an array — one entry per window:

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

| Field | Required | Meaning |
|---|---|---|
| `id` | ✓ | Unique, lowercase `[a-z0-9-_]` — used for @-targeting and dispatch |
| `name` | ✓ | Window title |
| `color` | ✓ | Accent color (hex) |
| `adapter` | ✓ | `claude` \| `codex` \| `dsh` \| `openclaw` |
| `desc` | | Subtitle |
| `modelHint` | | Placeholder for the model field in Settings |
| `ctxChars` | | Shared-memory injection budget (0 = off, default 900) |
| `cwd` | | Working directory for the agent process |
| `terminal` | | Embed a real interactive TUI instead of headless runs |
| `cmd` / `args` | | Terminal mode only: command/args to spawn (default: agent id + `--model`/`extraArgs` from Settings). Explicit `args` replace the `--model` convention — e.g. `["tui", "--session", "nexus"]` for `openclaw tui` |
| `distiller` | | This agent runs `/distill` jobs (default: first non-session adapter) |

- Fewer agents: delete entries. More of the same type: add an entry with a new `id`.
- Invalid ids or unknown adapters are skipped with a log warning.
- `NEXUS_AGENTS_FILE` points at a different roster file.
- Apply changes with `bin/nexus restart`.

Everything else — per-agent model & extra CLI args, theme, focus opacity — is set live from the **⚙ Settings** panel (stored in `~/.agent-nexus/settings.json`).

## Using the deck

| Action | How |
|---|---|
| Send | `Shift+Enter` or the send button (`Enter` = newline) |
| Target one agent | Click its chip, or start the message with `@codex …` |
| Focus mode | Click a window's title bar or single-select a chip; `Esc` to exit |
| Stop a running task | ⏹ in the window header, or `@agent /stop` |
| Reset a session | RESET in the window header, or `@agent /clear` |
| Attach files | 📎 button, drag & drop, or paste |

Slash commands — hub-level (work anywhere): `/remember` `/forget` `/memories` `/distill` `/clearall`.
Agent-level (prefix with `@agent`): claude & codex support `/sessions` `/resume <prefix>` `/fork` `/status` `/clear` `/stop`; dsh & openclaw support `/status` `/clear` `/stop`. In terminal windows, slash commands are typed straight into the TUI.

## Agent-to-agent dispatch

Agents can task each other three ways:

- **In a reply**: a line reading `@<agent>: <task>` is forwarded automatically (fire-and-forget, depth limit 4)
- **CLI**: `nexus ask <agent> "<task>"` — blocks and prints the reply (`NEXUS_ASK_FROM=<id>` sets the sender)
- **HTTP**: `curl -X POST 127.0.0.1:7700/api/agent/ask -H 'Content-Type: application/json' -d '{"from":"codex","to":"dsh","text":"…"}'`

Terminal agents (e.g. a live Claude Code TUI) receive tasks as typed input — they're truly interactive, so replies can't be captured synchronously.

## Data locations

| Path | Contents |
|---|---|
| `~/.agent-nexus/agents.json` | Your team roster |
| `~/.agent-nexus/settings.json` | Models, args, theme, opacity |
| `~/.agent-nexus/state.json` | Message history & sessions |
| `~/.agent-nexus/nexus.db` | Shared memory (SQLite) |
| `~/.agent-nexus/uploads/` | Uploaded attachments |
| `~/.agent-nexus/nexus.log` | Service logs |

## Security

The server binds to **127.0.0.1 only and has no authentication**. Do not expose it through a reverse proxy or port forward. The OpenClaw adapter never delivers to Telegram or any external channel; the DSH adapter uses an isolated headless profile.

## Project structure

```
server/
  index.mjs            # HTTP + SSE + WS service (127.0.0.1:7700)
  hub.mjs              # routing, per-agent queues, dispatch, slash commands, distill jobs
  terminal.mjs         # node-pty real terminals (bracketed paste, cc-switch model env)
  agents-config.mjs    # roster loading (~/.agent-nexus/agents.json)
  memory.mjs           # shared memory (node:sqlite, event-sourced)
  runner.mjs           # CLI spawn wrapper (timeout / line callbacks)
  settings.mjs         # settings persistence
  adapters/            # claude / codex / dsh / openclaw + registry
web/                   # zero-build vanilla JS + hand-written CSS, PWA
bin/install.mjs        # interactive installer
bin/nexus              # service control + agent dispatch CLI
launchd/               # plist template
```

## License

MIT
