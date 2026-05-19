# workboss

A tmux-integrated supervisor for fleets of LLM coding agents (OpenCode & Claude Code).

Workboss gives you **one dashboard** to monitor, approve, and manage all your coding agent sessions — no more tab-switching between terminal windows.

## What it does

```
┌──────────────────────┬──────────────────────┐
│                      │  workboss dashboard  │
│  orchestrator        │                      │
│  (opencode/claude)   │  ● refactor    up    │
│                      │  ● test-suite  up    │
│  Talk to this in     │  ○ docs        idle  │
│  natural language.   │  ○ cleanup     idle  │
│                      │                      │
│                      │  ✓ no pending apps   │
│                      │      ⏻ shutdown      │
└──────────────────────┴──────────────────────┘
```

- **Dashboard** — real-time TUI showing all workers with liveness status, filterable by active/idle
- **Orchestrator** — one LLM session that patrols the fleet, triages approvals, nudges workers
- **Approval queue** — every permission prompt from every worker flows into one queue; you approve/reject once
- **Session-first lifecycle** — the session is the asset; processes are replaceable

## Architecture

```
┌─ orchestrator (one LLM session, role = workboss) ─────────────┐
│   You talk in natural language; it runs `workboss …` for you  │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
┌─ workboss CLI ─────────────────────────────────────────────────┐
│   boss / spawn / register / attach / detach / remove          │
│   list / show / message / tail                                │
│   approvals list / approve / reject                           │
│   dashboard / shutdown                                        │
└──────────────────────────┬─────────────────────────────────────┘
                           │  HTTP /rpc on 127.0.0.1
                           ▼
┌─ workboss server (daemon) ────────────────────────────────────┐
│   OpenCode workers: subscribes to /event SSE                  │
│   Claude workers:   exposes POST /claude-hook/:worker         │
│   permission.asked → ~/.workboss/approvals/<id>.json          │
│   approve / reject → forwarded back to the worker             │
│   enforces hard-deny regex regardless of caller               │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
┌─ workers (each is one agent session bound to one cwd) ────────┐
│   OpenCode: opencode serve --port <P> → session in opencode.db│
│   Claude:   claude (or claude --resume <sid>) in cwd          │
└───────────────────────────────────────────────────────────────┘
```

### Layered codebase

```
src/
  domain/           — pure interfaces & types (WorkerMeta, TmuxClient, ApprovalRepository)
  infrastructure/   — implementations (CliTmuxClient, FsWorkerRepository, HTTP adapters)
  application/      — orchestration logic (commands, agents, session-scanner, daemon)
  presentation/     — CLI entry point, ink-based dashboard
```

Dependency inversion: domain defines interfaces; infrastructure implements them. No import from infrastructure → domain.

## Key features

### tmux integration

`workboss boss` creates a tmux session with a horizontal split:
- **Left pane (70%)**: the orchestrator LLM session
- **Right pane (30%)**: the real-time dashboard

The divider is draggable (tmux mouse mode). Workers get their own tmux windows — switch with `Ctrl+B n`/`Ctrl+B p`, or select from the dashboard.

### Dashboard

Built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals):

- **Liveness detection** — scans running processes via `ps` + `lsof`, matches by session ID
- **Orphan cleanup** — detects zombie TUI processes (ppid=1, no TCP connection) and reaps them
- **Filter** — press `Tab` to cycle: all → active (up/degraded) → idle (idle/dead)
- **Mouse support** — click to select a worker, click again to jump to its TUI
- **Keyboard** — ↑↓ navigate, Enter select, `s` shutdown, Ctrl+C quit

### Session-first lifecycle

A workboss worker is a pointer to an agent session. The session data (jsonl for Claude, sqlite for OpenCode) is the durable artifact. Processes are transient:

- `workboss spawn` — creates a session and starts a process
- `workboss detach` — kills the process, preserves the session
- `workboss attach` — resumes the session in a new process
- `workboss remove` — forgets the worker entry; session data on disk is untouched

### Permission model

Every worker gets a permission ruleset:
- `read`, `webfetch` → auto-allow
- `edit` → ask the supervisor
- `bash` → curated allow-list for safe commands, deny-list for dangerous ones, everything else asks

Hard-deny patterns (`rm -rf`, `sudo`, `git push --force`, `curl | sh`) are enforced server-side — cannot be bypassed even by the orchestrator.

## Install

```bash
git clone https://github.com/<you>/workboss.git
cd workboss
npm install
npm run build
alias workboss="node $(pwd)/bin/workboss.js"
```

Requires Node ≥ 22, `tmux`, `opencode` on PATH (for opencode workers), `claude` on PATH (for claude workers).

## Quickstart

```bash
# 1. Start the daemon
workboss server start

# 2. Launch the boss (creates tmux session with orchestrator + dashboard)
workboss boss

# 3. From the orchestrator pane, spawn workers:
#    "spawn a worker named refactor to rewrite the auth module in ~/code/myapp"

# 4. Or from any terminal:
workboss spawn refactor \
  --task "Rewrite the auth module to use JWT" \
  --cwd ~/code/myapp \
  --agent opencode

# 5. In the dashboard (right pane):
#    - ↑↓ to navigate, Enter to jump to a worker's TUI
#    - Tab to filter active/idle
#    - s to shutdown everything
#    - Ctrl+C to quit dashboard

# 6. When done:
workboss shutdown          # detach all workers, stop daemon, kill tmux
```

## CLI reference

```
workboss server start | stop | restart | status

workboss boss [--agent opencode|claude]     # launch tmux split layout
workboss dashboard                          # standalone dashboard (ink TUI)
workboss shutdown                           # full teardown

workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
workboss spawn <name> --mission <file> --cwd <path>
workboss register <name> --agent <kind> --cwd <path> --session-id <sid>

workboss list [--history]                   # list workers
workboss show <name>                        # detailed worker info
workboss attach <name>                      # resume worker in new process
workboss detach <name>                      # stop process, keep session
workboss remove <name>                      # forget worker entry
workboss message <name> "text"              # send message to worker's inbox
workboss tail <name> [-n N]                 # recent session activity

workboss discover [--all] [--register-alive]  # scan for unmanaged sessions
workboss approvals list
workboss approve <id> [--always]
workboss reject <id> --reason "..."
```

## Filesystem layout

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

## Tech stack

- **Runtime**: Node.js ≥ 22, TypeScript
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) (React for terminals) with mouse support
- **Terminal**: tmux 3.x with split layout + mouse mode
- **Agents**: OpenCode (serve + attach), Claude Code (--resume)

## Status

MVP. Both OpenCode and Claude Code paths are end-to-end verified: spawn → use → detach → attach → remove, approval queue, hard-deny enforcement, dashboard with liveness detection, orphan cleanup, and full shutdown.
