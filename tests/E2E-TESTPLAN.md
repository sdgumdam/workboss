# E2E Test Plan — tmux Integration

> 端到端验证 workboss 的 tmux 集成。所有操作在后台完成，不需要 attach 到 tmux。
> 验证手段：`tmux has-session`、`tmux list-windows`、`tmux capture-pane -p`、`workboss list/show/approvals`。

## Prerequisites

```bash
tmux -V                    # tmux available
which opencode             # opencode available (optional: which claude)
npm run build              # TypeScript compiles
```

## Phase 1: tmux utility functions

Verify raw tmux commands work as workboss uses them.

```bash
# Create workboss session
tmux new-session -d -s workboss -n boss -c ~/.workboss/supervisor

# Verify session exists
tmux has-session -t workboss
# expected: exit code 0

# Verify window list
tmux list-windows -t workboss
# expected: contains "boss"

# Create a worker window
tmux new-window -t workboss -n test-alpha -c /tmp
tmux send-keys -t workboss:test-alpha 'echo hello-from-alpha' Enter
sleep 1
tmux capture-pane -t workboss:test-alpha -p
# expected: contains "hello-from-alpha"

# Kill the worker window
tmux kill-window -t workboss:test-alpha
tmux list-windows -t workboss
# expected: no "test-alpha"

# Cleanup
tmux kill-session -t workboss
```

## Phase 2: workboss boss creates tmux session

```bash
# Start daemon
workboss server start
workboss server status
# expected: "running"

# boss creates tmux session in background (do not attach)
# We test this by running boss non-interactively and checking the session
workboss boss &
BOSS_PID=$!
sleep 5

# Verify tmux session was created
tmux has-session -t workboss
# expected: exit code 0

tmux list-windows -t workboss
# expected: contains "boss"

# Verify orchestrator is running in the boss window
tmux capture-pane -t workboss:boss -p | head -20
# expected: opencode or claude TUI output visible (not a blank shell)

# Cleanup (don't kill session yet, needed for Phase 3)
kill $BOSS_PID 2>/dev/null
```

## Phase 3: spawn worker creates tmux window with TUI

```bash
# Prepare a test project directory
mkdir -p /tmp/test-worker
cd /tmp/test-worker && git init

# Spawn an opencode worker
workboss spawn e2e-alpha \
  --task "List all files in the current directory and report what you see." \
  --cwd /tmp/test-worker \
  --agent opencode

sleep 5

# Verify worker window exists in tmux
tmux list-windows -t workboss
# expected: contains "e2e-alpha"

# Verify worker TUI is running — pane should have content
tmux capture-pane -t workboss:e2e-alpha -p | head -20
# expected: opencode TUI output (not a blank shell prompt)

# Verify workboss tracks the worker
workboss list
# expected: shows e2e-alpha with status "up"

workboss show e2e-alpha
# expected: has sessionId, has process with serverUrl
```

## Phase 4: worker TUI visibility and dual-path approval

```bash
# Check if there are pending approvals from the worker
workboss approvals list

# If worker is waiting for approval, approve from orchestrator side:
# workboss approve <id>

# Verify the worker continues after approval
sleep 3
tmux capture-pane -t workboss:e2e-alpha -p
# expected: worker activity continued past the approval point

# Verify approval queue is clean
workboss approvals list
# expected: "(no pending approvals)" or fewer items
```

## Phase 5: detach and attach

```bash
# Detach the worker (kill tmux window + serve process, keep session)
workboss detach e2e-alpha

# Verify tmux window is gone
tmux list-windows -t workboss
# expected: no "e2e-alpha"

# Verify workboss shows worker as idle
workboss list
# expected: e2e-alpha shows "idle" or "dead"

# Attach — should recreate the tmux window
workboss attach e2e-alpha

# Verify tmux window is back
tmux list-windows -t workboss
# expected: contains "e2e-alpha" again

# Verify TUI is running in the restored window
sleep 3
tmux capture-pane -t workboss:e2e-alpha -p | head -20
# expected: opencode TUI output visible
```

## Phase 6: claude worker (if claude is available)

```bash
if command -v claude &>/dev/null; then
  workboss spawn e2e-beta \
    --task "List files in the current directory." \
    --cwd /tmp/test-worker \
    --agent claude

  sleep 3

  tmux list-windows -t workboss
  # expected: contains "e2e-beta"

  tmux capture-pane -t workboss:e2e-beta -p | head -20
  # expected: claude TUI output visible
fi
```

## Phase 7: claude hook timeout (30s fallback to TUI)

```bash
# This phase requires manual timing observation.
# When a claude worker hits a permission prompt:
# 1. The hook is held for up to 30 seconds
# 2. If orchestrator approves within 30s → allow is returned, worker continues
# 3. If 30s passes → workboss returns "ask" → claude TUI shows native prompt
#
# To verify:
# - Run a command in the claude worker that triggers a permission prompt
# - Do NOT approve from orchestrator for 30 seconds
# - After 30s, capture the pane:
tmux capture-pane -t workboss:e2e-beta -p
# expected: claude's native permission prompt is visible
```

## Phase 8: cleanup

```bash
workboss remove e2e-alpha
if command -v claude &>/dev/null; then
  workboss remove e2e-beta
fi
tmux kill-session -t workboss
workboss server stop
rm -rf /tmp/test-worker
```

## What each phase proves

| Phase | Verifies |
|-------|----------|
| 1 | Raw tmux commands work on this machine |
| 2 | `workboss boss` creates a tmux session with orchestrator TUI |
| 3 | `workboss spawn` creates a worker tmux window with live TUI |
| 4 | Dual-path approval: orchestrator approves → worker TUI continues |
| 5 | `detach` kills window, `attach` restores it with TUI |
| 6 | Claude workers also get tmux windows |
| 7 | Hook timeout returns `ask` → claude TUI shows native prompt |
| 8 | Full cleanup, no orphan processes |
