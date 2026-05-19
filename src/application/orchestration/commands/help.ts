import {WORKBOSS_ROOT} from '../../../infrastructure/filesystem/paths.js';

import {ok} from './utils.js';

export function printHelp(): void {
	ok(`workboss — LLM-supervised worker fleet manager

USAGE
  workboss <command> [options]

ORCHESTRATOR
  workboss boss [--agent opencode|claude]
      Start the supervisor daemon, launch an orchestrator agent session
      in a tmux split layout (left pane = orchestrator, right pane = dashboard),
      and attach your terminal to it.

  This is the only command you run yourself.  Everything below is for
  the orchestrator (or for power users).

DASHBOARD (auto-launched by boss in the right pane)
  workboss dashboard
      Run the interactive dashboard.  Shows workers, liveness status,
      pending approvals, and a shutdown button.  Click a worker to
      view its live TUI; exit the TUI to return to the dashboard.

  workboss shutdown
      Detach all workers, stop the daemon, kill the tmux session.

WORKER LIFECYCLE
  workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
      Create a new worker.  --task is required (or use --mission <file>).
      --cwd is required.  --agent defaults to opencode.
      Inside a workboss tmux session, this also opens a tmux window
      showing the worker's live TUI.

  workboss register <name> --agent <opencode|claude> --cwd <path> --session-id <sid> [--server-url <url>]
      Adopt an existing agent session into the workboss fleet.

  workboss detach <name>
      Stop the worker's processes (serve + TUI window).  The session
      data on disk is preserved and can be resumed with attach.

  workboss attach <name>
      Resume a detached worker.  Restarts the serve process (opencode)
      and opens a new tmux window with the TUI.  If the window still
      exists, just switches to it.

  workboss remove <name>
      Detach + delete the workboss metadata.  The agent's own session
      data on disk is NOT deleted.

INSPECTION
  workboss list [--history]
      Show all workers.  --history includes idle on-disk sessions.

  workboss show <name>
      Print full JSON metadata for one worker.

  workboss tail <name> [-n N]
      Show recent session activity (default 20 lines).

  workboss discover [--all] [--register-alive] [--json]
      Scan the machine for agent sessions not yet known to workboss.

COMMUNICATION
  workboss message <name> "text"
      Append a note to the worker's inbox.  The worker reads it on its
      next turn (guided by AGENTS.md / CLAUDE.md).

APPROVALS
  workboss approvals list
      Show all pending permission requests from every worker.

  workboss approve <id> [--always]
      Allow a pending request.  --always persists the pattern so
      similar future requests auto-pass.

  workboss reject <id> --reason "..."
      Block a pending request.  The reason is fed back to the worker.

DAEMON (auto-started by boss; rarely needed directly)
  workboss server start | stop | status | restart

DATA DIRECTORY
  ${WORKBOSS_ROOT}
`);
}
