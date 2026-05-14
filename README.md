# workboss

An LLM-supervised manager for a fleet of long-lived OpenCode coding agent sessions.

You talk to **one** orchestrator (an OpenCode session pre-loaded with the
workboss role). It can:

- **Patrol** the fleet: list workers, summarise what each is doing, flag the
  stuck or idle ones.
- **Triage** approvals: every permission prompt from every worker is captured
  into a single queue. You decide once / always / reject — in the orchestrator
  window, not by tab-switching to each worker's TUI.
- **Nudge** workers via natural language: it writes to each worker's inbox so
  the worker picks it up at the start of its next turn.
- **Spawn** new workers on tasks, or **adopt** OpenCode servers you already
  started by hand.

You can still attach to any worker directly with `opencode attach <url>` when
you want to drive it yourself — the orchestrator is convenience, not control.

## Architecture

```
┌─ orchestrator (one OpenCode session, role = workboss) ──────────┐
│   you talk to this. it runs `workboss …` for you.               │
└─────────────────────────┬───────────────────────────────────────┘
                          │  CLI / Unix-style commands
                          ▼
┌─ workboss CLI ──────────────────────────────────────────────────┐
│   spawn / adopt / list / message / tail / kill                  │
│   approvals list / approve / reject                             │
└─────────────────────────┬───────────────────────────────────────┘
                          │  JSON-over-TCP RPC (127.0.0.1)
                          ▼
┌─ workboss server (daemon) ──────────────────────────────────────┐
│   subscribes to every worker's /event SSE stream                │
│   permission.asked → queue file in ~/.workboss/approvals/       │
│   reply → POST to worker's /permission/:id/reply                │
│   enforces hard-deny patterns regardless of caller              │
└─────────────────────────┬───────────────────────────────────────┘
                          │  HTTP + SSE
                          ▼
┌─ workers (each one is `opencode serve` in its own cwd) ─────────┐
│   own port, own DB, own session history                         │
│   permissions ruleset injected via OPENCODE_CONFIG              │
│   workboss adds AGENTS.md so the agent reads its inbox.md       │
└─────────────────────────────────────────────────────────────────┘
```

## Install (local dev)

```bash
cd workboss
npm install
npm run build
# Use directly:
node bin/workboss.js help
# Or alias it:
alias workboss="node $(pwd)/bin/workboss.js"
```

Requires Node ≥ 22, `opencode` on `PATH` (workboss spawns `opencode serve`).

## Quickstart

```bash
# 1. Start the supervisor daemon (background; logs at ~/.workboss/server.log)
workboss server start

# 2. Spawn a worker on a task. The worker is just `opencode serve` in --cwd
#    with workboss policies and an AGENTS.md primer.
workboss spawn alpha \
  --task "Read this codebase and propose a refactor for the session module" \
  --cwd ~/code/myrepo

# 3. Workboss prints something like:
#    serve : http://127.0.0.1:54321
#    Attach a TUI client to start working with it:
#      opencode attach http://127.0.0.1:54321
#
#    Open that in another terminal to talk to the worker.

# 4. Talk to the orchestrator (a separate OpenCode session, see "Orchestrator"
#    below). Say things like:
#       "巡视一下"
#       "approve alpha's request"
#       "nudge alpha to also check the tests"
#
#    The orchestrator runs `workboss …` under the hood and synthesises the
#    output for you.
```

## Orchestrator

`templates/ORCHESTRATOR.md` is the system prompt to feed into a dedicated
OpenCode session that supervises everything else. Recommended setup:

```bash
# Make a tiny "supervisor" workspace
mkdir -p ~/workboss-supervisor
cp templates/ORCHESTRATOR.md ~/workboss-supervisor/AGENTS.md

# Run OpenCode there. AGENTS.md is auto-loaded by opencode.
cd ~/workboss-supervisor
opencode
```

Then talk to that OpenCode session in natural language. It will call workboss
commands as needed.

## Permission model

Every worker gets a permission ruleset (`OPENCODE_CONFIG`) at spawn time:

- **`read`** auto-allow
- **`webfetch`** auto-allow
- **`edit`** asks the supervisor
- **`bash`**: a curated allow list for read-only / test-runner commands, a
  curated deny list for irreversible operations, everything else asks the
  supervisor

When OpenCode `asks`, the request flows up through SSE to the workboss server,
into the approvals queue, and out to the orchestrator (or you, via
`workboss approvals list / approve / reject`).

### Hard deny

`src/lib/deny-patterns.ts` lists patterns that workboss **always rejects**,
even if the caller (you or the orchestrator) tries to approve them:

- `rm -rf …`, `sudo …`
- `git push --force` / `-f`, `git reset --hard`, `git checkout -- …`
- `curl … | sh` / `wget … | bash` (remote-payload-into-shell)

You can edit a worker's `~/.workboss/workers/<name>/opencode.json` to loosen
its allow list, but the workboss server runs these regex checks server-side
before forwarding any reply — so changing the worker's local config can't
defeat them. To bypass, the user has to perform the action outside workboss.

## CLI reference

```
workboss server start | stop | status

workboss spawn <name> --task "..." --cwd <path> [--port <P>]
workboss spawn <name> --mission <file> --cwd <path>
workboss adopt <name> --url http://localhost:<port> [--cwd <path>]
workboss list
workboss show <name>
workboss message <name> "text"
workboss tail <name> [-n N]
workboss kill <name>

workboss approvals list
workboss approve <id> [--always]
workboss reject <id> --reason "..."
```

## Filesystem layout

```
~/.workboss/
  server.pid                 PID of the running aggregator
  server.port                127.0.0.1 port the RPC listens on
  server.log                 aggregator stdout
  workers/<name>/
    meta.json                agent type, cwd, server URL, pid
    opencode.json            OPENCODE_CONFIG injected at spawn
    mission.md               task brief (user-authored)
    inbox.md                 coordinator notes the worker reads each turn
    serve.log                stdout/stderr of `opencode serve`
  approvals/
    <permission-id>.json     pending approval snapshot
```

## Status

MVP. OpenCode worker path is end-to-end functional and smoke-verified
against a real LLM round trip. Claude Code worker path is not yet
implemented; it needs a separate adapter because Claude Code does not have
the same HTTP/SSE permission API and would have to go through PreToolUse
HTTP hooks instead.
