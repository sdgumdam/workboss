<div align="center">

# 🏗️ workboss

**tmux-integrated supervisor for fleets of LLM coding agents**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-≥22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Ink](https://img.shields.io/badge/TUI-Ink_(React)-FF6B6B)](https://github.com/vadimdemedes/ink)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

*One dashboard. One orchestrator. All your coding agents.*

[Install](#-install) · [Quickstart](#-quickstart) · [Features](#-features) · [CLI Reference](#-cli-reference) · [Architecture](#-architecture)

</div>

---

## 🖥️ What it does

```
┌──────────────────────────┬─────────────────────────────┐
│                          │  🏗️ workboss    active(4)   │
│  🤖 orchestrator         │                             │
│  (opencode / claude)     │  ● ⬡ refactor      up      │
│                          │  ● ⬡ test-suite    up      │
│  Talk to this in         │  ● ◈ code-review   up      │
│  natural language —      │  ● ◈ docs          up      │
│  it runs workboss        │  ○ ⬡ cleanup       idle    │
│  commands for you.       │  ○ ◈ migration     idle    │
│                          │                             │
│                          │  ✓ no pending approvals    │
│                          │         ⏻ shutdown          │
│                          │  14:30 | 6w | Tab · ↑↓ · s │
└──────────────────────────┴─────────────────────────────┘
       ← 70% orchestrator →          ← 30% dashboard →
```

**workboss** gives you a single tmux session to manage all your OpenCode and Claude Code workers:

| | |
|---|---|
| 📊 **Dashboard** | Real-time TUI showing all workers with liveness status, filterable by active/idle |
| 🤖 **Orchestrator** | One LLM session that patrols the fleet, triages approvals, nudges workers |
| ✅ **Approval Queue** | Every permission prompt from every worker → one queue → approve/reject once |
| 🔄 **Session-first Lifecycle** | The session is the asset; processes are replaceable |

---

## ✨ Features

### 🖱️ Interactive Dashboard (Ink + React)

Built with [Ink](https://github.com/vadimdemedes/ink) — React for terminals:

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate workers |
| `Enter` | Jump to worker's TUI |
| `Tab` | Cycle filter: all → active → idle |
| `s` | Shutdown everything |
| `Ctrl+C` | Quit dashboard |
| Click | Select worker / double-click to enter |

**Liveness detection** scans `ps` + `lsof` every 2 seconds, matches workers by session ID.
**Orphan cleanup** automatically reaps zombie TUI processes (ppid=1, no TCP connection).

### 🧩 tmux Integration

`workboss boss` creates a tmux session with a horizontal split:

- **Left pane (70%)** — the orchestrator LLM session
- **Right pane (30%)** — the real-time dashboard
- **Divider is draggable** — tmux mouse mode enabled
- Workers get their own tmux windows — switch with `Ctrl+B n`/`p`, or select from dashboard

### 🔐 Permission Model

Every worker gets a curated permission ruleset:

| Category | Policy | Examples |
|----------|--------|---------|
| `read` / `webfetch` | ✅ Auto-allow | `cat`, `ls`, `grep` |
| `edit` | 🔒 Ask supervisor | File writes |
| `bash` | 🟡 Allow-list + 🚫 Deny-list | Safe commands pass, dangerous blocked, rest asks |

**Hard-deny** patterns enforced **server-side** — cannot be bypassed even by the orchestrator:

> `rm -rf` · `sudo` · `git push --force` · `curl | sh` · `git reset --hard`

### 🔄 Session-First Lifecycle

A workboss worker is a **pointer to an agent session**. The session data (jsonl for Claude, sqlite for OpenCode) is the durable artifact. Processes are transient:

```
spawn → use → detach → (laptop crashes) → attach → continue → remove
  │                │                        │                  │
  └─ creates       └─ kills process         └─ new process     └─ forgets entry
     session           keeps session           same session       session on disk stays
```

---

## 📦 Install

```bash
git clone https://github.com/sdgumdam/workboss.git
cd workboss
npm install
npm run build
alias workboss="node $(pwd)/bin/workboss.js"
```

**Prerequisites:** Node ≥ 22 · `tmux` 3.x · `opencode` on PATH (for opencode workers) · `claude` on PATH (for claude workers)

---

## 🚀 Quickstart

```bash
# 1. Start the daemon
workboss server start

# 2. Launch the boss — creates tmux session with orchestrator + dashboard
workboss boss

# 3. From the orchestrator pane, spawn workers in natural language:
#    "spawn a worker named refactor to rewrite the auth module in ~/code/myapp"

# 4. Or from any terminal:
workboss spawn refactor \
  --task "Rewrite the auth module to use JWT" \
  --cwd ~/code/myapp \
  --agent opencode

# 5. Manage from the dashboard (right pane):
#    ↑↓ navigate · Enter jump to TUI · Tab filter · s shutdown

# 6. When done:
workboss shutdown    # detach all workers → stop daemon → kill tmux
```

---

## 📋 CLI Reference

### Server & Session

```bash
workboss server start | stop | restart | status
workboss boss [--agent opencode|claude]     # tmux split layout
workboss dashboard                          # standalone dashboard
workboss shutdown                           # full teardown
```

### Worker Lifecycle

```bash
workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
workboss spawn <name> --mission <file> --cwd <path>
workboss register <name> --agent <kind> --cwd <path> --session-id <sid>
workboss attach <name>          # resume in new process
workboss detach <name>          # stop process, keep session
workboss remove <name>          # forget worker entry
```

### Inspection & Communication

```bash
workboss list [--history]
workboss show <name>
workboss message <name> "text"              # write to worker's inbox
workboss tail <name> [-n N]                 # recent session activity
workboss discover [--all] [--register-alive] # scan for unmanaged sessions
```

### Approvals

```bash
workboss approvals list
workboss approve <id> [--always]
workboss reject <id> --reason "..."
```

---

## 🏛️ Architecture

```
┌─ 🤖 orchestrator (one LLM session, role = workboss) ──────────┐
│   You talk in natural language; it runs `workboss …` for you  │
└───────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
┌─ ⚙️ workboss CLI ─────────────────────────────────────────────┐
│   boss / spawn / register / attach / detach / remove          │
│   list / show / message / tail / approvals / dashboard        │
└───────────────────────────┬────────────────────────────────────┘
                            │  HTTP /rpc on 127.0.0.1
                            ▼
┌─ 🔧 workboss server (daemon) ────────────────────────────────┐
│   OpenCode workers: subscribes to /event SSE                  │
│   Claude workers:   exposes POST /claude-hook/:worker         │
│   permission.asked → ~/.workboss/approvals/<id>.json          │
│   approve / reject → forwarded back to the worker             │
│   enforces hard-deny regex regardless of caller               │
└───────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
┌─ 💻 workers (each is one agent session bound to one cwd) ────┐
│   OpenCode: opencode serve --port <P> → session in opencode.db│
│   Claude:   claude (or claude --resume <sid>) in cwd          │
└───────────────────────────────────────────────────────────────┘
```

### Layered Codebase

```
src/
  domain/           →  pure interfaces & types (WorkerMeta, TmuxClient, ApprovalRepository)
  infrastructure/   →  implementations (CliTmuxClient, FsWorkerRepository, HTTP adapters)
  application/      →  orchestration logic (commands, agents, session-scanner, daemon)
  presentation/     →  CLI entry point, ink-based dashboard
```

**Dependency inversion**: domain defines interfaces; infrastructure implements them. No import from infrastructure → domain.

### Filesystem Layout

```
~/.workboss/
  server.pid               daemon PID
  server.port              daemon HTTP port
  server.log               daemon log
  workers/<name>/
    meta.json              identity + process info
    opencode.json          OPENCODE_CONFIG (opencode workers)
    mission.md             task brief
    inbox.md               coordinator → worker messages
    serve.log              opencode serve output
  approvals/
    <id>.json              pending approval snapshot
```

---

## 🛠️ Tech Stack

| | |
|---|---|
| **Runtime** | Node.js ≥ 22, TypeScript |
| **TUI** | [Ink](https://github.com/vadimdemedes/ink) (React for terminals) + mouse support |
| **Terminal** | tmux 3.x with split layout + mouse mode |
| **Agents** | [OpenCode](https://github.com/opencode-ai/opencode) (serve + attach), [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (--resume) |

---

## 📌 Status

MVP. Both OpenCode and Claude Code paths are end-to-end verified:

- ✅ Spawn → use → detach → attach → remove
- ✅ Approval queue with hard-deny enforcement
- ✅ Dashboard with liveness detection + orphan cleanup
- ✅ Full shutdown (detach all → stop daemon → kill tmux)

---

<div align="center">

*Built with 🏗️ by [sdgumdam](https://github.com/sdgumdam)*

</div>
