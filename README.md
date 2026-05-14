# workboss

An LLM-supervised manager for a fleet of long-lived coding agent **sessions**,
across both **OpenCode** and **Claude Code**.

You talk to **one** orchestrator (an OpenCode or Claude Code session pre-loaded
with the workboss role). It can:

- **Patrol** the fleet: list workers, summarise what each is doing, flag the
  stuck or idle ones.
- **Triage** approvals: every permission prompt from every worker is captured
  into a single queue. You decide once / always / reject — in the orchestrator
  window, not by tab-switching to each worker's TUI.
- **Nudge** workers via natural language: it writes to each worker's inbox so
  the worker picks it up at the start of its next turn.
- **Spawn** new workers on tasks, **register** sessions you already started by
  hand, **detach** processes without losing state, and **attach** later by
  resuming the same session id.

You can still join any worker directly (`opencode attach …` or `claude --resume
…`) when you want to drive it yourself — the orchestrator is convenience, not
control.

## Core idea: the session is the asset

A workboss worker is fundamentally a *pointer to an agent session* — the jsonl
file on disk for Claude Code, or the sqlite row for OpenCode. **That history is
the durable artifact.** The process running on top of it is replaceable: you
can kill it, the laptop can crash, you can switch machines — as long as you
remember the session id, a new process can be bound to it and pick up where it
left off.

This shapes the tool:

- `workboss spawn` creates a session and remembers its id.
- `workboss register` adopts an existing session by id (no spawn needed).
- `workboss detach` kills the current process; the session is preserved.
- `workboss attach <name>` prints the exact command to resume the session in a
  new process.
- `workboss remove` forgets the workboss-level entry; the underlying session
  data is untouched.

Because both Claude Code and OpenCode store sessions on disk and support
resume, the two agent backends share the same lifecycle and the same UX.

## Architecture

```
┌─ orchestrator (one OpenCode / Claude Code session, role = workboss) ─┐
│   you talk to this in natural language; it runs `workboss …` for you │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌─ workboss CLI ───────────────────────────────────────────────────────┐
│   spawn / register / attach / detach / remove                        │
│   list / show / message / tail                                       │
│   approvals list / approve / reject                                  │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  HTTP /rpc on 127.0.0.1
                             ▼
┌─ workboss server (daemon) ───────────────────────────────────────────┐
│   For OpenCode workers: subscribes to /event SSE                     │
│   For Claude workers:   exposes POST /claude-hook/:worker            │
│                         (Claude's PreToolUse HTTP hook target)       │
│   permission.asked → ~/.workboss/approvals/<id>.json                 │
│   approve / reject → forwarded back to the worker                    │
│   enforces hard-deny regex regardless of caller                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌─ workers (each one is one agent session bound to one cwd) ───────────┐
│   OpenCode: `opencode serve` in cwd → session in opencode.db         │
│   Claude:   `claude` (or `claude --resume <sid>`) in cwd             │
│                 with .claude/settings.local.json from workboss       │
└──────────────────────────────────────────────────────────────────────┘
```

## Install (local dev)

```bash
cd workboss
npm install
npm run build
alias workboss="node $(pwd)/bin/workboss.js"
```

Requires Node ≥ 22, `opencode` on `PATH` for opencode workers, `claude` on
`PATH` for claude workers.

## Quickstart

```bash
# 1. Start the supervisor daemon
workboss server start

# 2A. Create an opencode worker (workboss spawns the server + a session)
workboss spawn alpha \
  --task "Read this codebase and propose a refactor for the session module" \
  --cwd ~/code/myrepo \
  --agent opencode

# 2B. Create a claude worker (workboss prepares files; you start claude yourself)
workboss spawn beta \
  --task "Investigate a flaky test in tests/api" \
  --cwd ~/code/myrepo \
  --agent claude

# 3. Workboss prints how to join the worker:
#    opencode → opencode attach http://127.0.0.1:<P> --session ses_...
#    claude   → cd ~/code/myrepo && claude

# 4. In another terminal, run the orchestrator (any agent of your choice).
#    Tell it things like:
#       "patrol"
#       "approve alpha's request"
#       "nudge beta to also check the logs"
#       "kill alpha but keep the session"
```

## Permission model

Every worker gets a permission ruleset at registration time, picked up by the
agent on its own. The categories are deliberately the same across both
agents:

- `read` auto-allow
- `webfetch` auto-allow
- `edit` asks the supervisor
- `bash`: a curated allow-list for read-only / test-runner commands, a curated
  deny-list for irreversible operations, everything else asks the supervisor

When the worker hits "ask", the request flows into the workboss approvals
queue. The orchestrator (or you) decides:

- **once** — allow this single request
- **always** — allow + persist the pattern so similar requests auto-pass
- **reject** — block (with an optional reason fed back to the LLM)

### Hard deny

`src/lib/deny-patterns.ts` lists patterns that workboss **always rejects**,
even if the caller (you or the orchestrator) tries to approve them:

- `rm -rf …`, `sudo …`
- `git push --force` / `-f`, `git reset --hard`, `git checkout -- …`
- `curl … | sh` / `wget … | bash`

These are checked **server-side** in workboss before any reply is forwarded.
You can edit a worker's settings to loosen its allow-list, but you cannot
bypass these regexes by relaxing the worker's own config — the daemon enforces
them on every approve attempt.

## CLI reference

```
workboss server start | stop | status

# Create a new worker (spawns or sets up a fresh session)
workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
workboss spawn <name> --mission <file> --cwd <path>

# Adopt an existing session you already created elsewhere
workboss register <name> --agent opencode|claude --cwd <path> \
                         --session-id <sid> [--server-url <url>]

# Operate on a worker
workboss list
workboss show <name>
workboss attach <name>            # prints the command to resume in a new process
workboss message <name> "text"
workboss tail <name> [-n N]

# Lifecycle
workboss detach <name>            # stop the current process, keep the session
workboss remove <name>            # forget the worker entry (session on disk stays)

# Approvals (called by the orchestrator)
workboss approvals list
workboss approve <id> [--always]
workboss reject <id> --reason "..."
```

## Filesystem layout

```
~/.workboss/
  server.pid                 PID of the running aggregator
  server.port                127.0.0.1 port the HTTP listener is on
  server.log                 aggregator stdout
  workers/<name>/
    meta.json                identity (name, agent, cwd, sessionId) + optional process info
    opencode.json            OPENCODE_CONFIG (opencode workers only)
    mission.md               task brief
    inbox.md                 coordinator notes the worker reads each turn
    serve.log                stdout/stderr of `opencode serve` (opencode workers only)
  approvals/
    <approval-id>.json       pending approval snapshot
```

A worker's `meta.json` looks like:

```jsonc
{
  "name": "alpha",
  "agent": "opencode",
  "cwd": "/home/me/code/myrepo",
  "createdAt": "2026-05-14T08:24:39.993Z",
  "sessionId": "ses_1da6972daffeBusyfkS8aSKAHZ",  // the asset
  "process": {                                     // transient — gone after detach
    "pid": 43604,
    "serverUrl": "http://127.0.0.1:60238",
    "serverPort": 60238,
    "startedAt": "2026-05-14T08:24:39.993Z"
  }
}
```

## Status

MVP. Both OpenCode and Claude Code worker paths are end-to-end smoke-verified
on this machine, including the session-first lifecycle (spawn → use → detach →
resume → remove), the approvals queue, and hard-deny enforcement.
