/**
 * AgentAdapter — the single seam between workboss's generic worker
 * orchestration and the specifics of one agent runtime (Claude Code,
 * OpenCode, in the future maybe others).
 *
 * Every command that varies per agent (`spawn`, `attach`, `tail`,
 * `deliverReply`, the inbound subscription path) goes through here, so
 * commands.ts / server.ts can stay polymorphic and don't grow new branches
 * each time we support a new runtime.
 */

import type {IncomingMessage, ServerResponse} from 'http';
import type {AgentKind, LivenessResult, WorkerMeta} from '../../../domain/worker.js';
import type {PendingApproval, ReplyKind} from '../../../domain/approval.js';

// ---------- classified process ----------

export interface ClassifiedProcess {
	pid: number;
	agent: AgentKind;
	port?: number;
	sessionId?: string;
	isAttachClient?: boolean;
}

// ---------- discovered session (re-exported from scanner) ----------

export interface DiscoveredSession {
	agent: AgentKind;
	cwd?: string;
	sessionId?: string;
	serverUrl?: string;
	pid?: number;
	alive: boolean;
	lastActivity?: Date;
	title?: string;
	messageCount?: number;
}

// ---------- spawn ----------

export interface SpawnNewArgs {
	workerName: string;
	cwdAbs: string;
	missionBody: string;
	workbossServerUrl: string;
	preferredPort?: number;
}

export interface SpawnNewResult {
	/** Set on the new WorkerMeta. */
	sessionId?: string;
	process?: {
		pid?: number;
		serverUrl?: string;
		serverPort?: number;
		startedAt: string;
	};
	/**
	 * The command that launches the worker's interactive TUI.
	 * When workboss is inside its tmux session, commands.ts opens a new
	 * tmux window and runs this command there so the user can see the
	 * agent working.  When tmux is not available the string is printed
	 * as a hint instead.
	 */
	tuiCommand?: string;
	/** Lines workboss prints after `spawn` completes. */
	postSpawnHint: string[];
}

// ---------- register ----------

export interface PrepareCwdArgs {
	workerName: string;
	cwdAbs: string;
	workbossServerUrl: string;
}

// ---------- attach (read-only print) ----------

export type AttachHint = string[];

// ---------- tail ----------

export interface TailArgs {
	meta: WorkerMeta;
	n: number;
}

// ---------- deliver reply ----------

export interface DeliverReplyArgs {
	meta: WorkerMeta;
	approval: PendingApproval;
	reply: ReplyKind;
	message?: string;
}

// ---------- subscribe (inbound approvals) ----------

export interface SubscribeArgs {
	meta: WorkerMeta;
	abort: AbortSignal;
	onApproval: (a: PendingApproval) => Promise<void> | void;
	onResolved: (approvalId: string) => Promise<void> | void;
	onSessionIdLearned?: (sessionId: string) => Promise<void> | void;
	log: (msg: string) => void;
}

// ---------- liveness (status codes defined in lib/types.ts) ----------

// ---------- resume serve ----------

export interface ResumeServeResult {
	pid: number;
	serverUrl: string;
	serverPort: number;
}

// ---------- hook context ----------

export interface HookContext {
	workerRepo: {
		update: (name: string, patch: (m: WorkerMeta) => WorkerMeta | Promise<WorkerMeta>) => Promise<WorkerMeta | null>;
	};
	approvalRepo: {
		write: (a: PendingApproval) => Promise<void>;
		delete: (id: string) => Promise<void>;
	};
}

// ---------- activity summary (worker briefing) ----------

export interface RecentAction {
	tool: string;
	summary: string;
	timestamp: Date;
}

export interface ActivitySummary {
	title: string;
	lastActiveAt: Date | null;
	activeMinutes: number;
	additions: number;
	deletions: number;
	filesChanged: number;
	recentActions: RecentAction[];
	recentUserMessages: string[];
}

// ---------- adapter ----------

export interface AgentAdapter {
	readonly kind: AgentKind;

	/**
	 * Spawn a brand new process bound to a new session.
	 * For agents that workboss does not launch directly (e.g. Claude), this
	 * may only prepare the cwd and return an empty `process` — the user
	 * starts the binary themselves.
	 */
	spawnNew(args: SpawnNewArgs): Promise<SpawnNewResult>;

	/**
	 * Check whether this worker's runtime is alive, degraded, or dead.
	 *
	 * - up:       all processes healthy, user can see the TUI
	 * - degraded: backend (serve) is up but TUI window is missing or unreachable
	 * - idle:     no process running (session data preserved on disk)
	 * - dead:     PID exists but is not our process (reused by OS), or serve
	 *             is unreachable
	 */
	checkLiveness(meta: WorkerMeta): Promise<LivenessResult>;

	/**
	 * Idempotently set up <cwd> so that any future agent session started in
	 * it routes through workboss (mission/inbox docs, settings.local.json,
	 * etc.). Called by `register` and `spawn` — i.e. when the user is
	 * explicitly committing to this worker.
	 */
	prepareCwd(args: PrepareCwdArgs): Promise<void>;

	/**
	 * Lightest-possible setup for daemon auto-adoption: write only what is
	 * strictly required to wire permission requests through workboss, and
	 * skip anything that visibly modifies the user's working tree (e.g.
	 * AGENTS.md / CLAUDE.md additions). Used when the daemon notices a
	 * worker on its own and the user hasn't asked for it explicitly yet.
	 *
	 * `prepareCwd` remains the heavier path; it's invoked later on demand
	 * (e.g. the first `workboss message`) to install the inbox protocol.
	 */
	prepareCwdMinimal(args: PrepareCwdArgs): Promise<void>;

	/**
	 * Lines `workboss attach <name>` should print to tell the user how to
	 * resume this worker in a fresh process.
	 */
	attachHint(meta: WorkerMeta): AttachHint;

	/**
	 * Recent session activity as plain text (printed verbatim by `tail`).
	 */
	tail(args: TailArgs): Promise<string>;

	/**
	 * Send an approve/reject reply back to the agent runtime so the blocked
	 * tool call either proceeds or is denied. Throws if the agent cannot
	 * currently accept replies (e.g. its process is gone).
	 */
	deliverReply(args: DeliverReplyArgs): Promise<void>;

	/**
	 * Optional: start a long-running subscription that pushes inbound
	 * permission requests into the workboss queue. Returns immediately; the
	 * loop runs until `abort` fires.
	 *
	 * Agents whose runtime calls workboss (Claude's HTTP hook) do not need
	 * this — those arrive on the workboss HTTP server instead.
	 */
	subscribe?(args: SubscribeArgs): void;

	// ---------- identity ----------

	getIcon(): string;
	getDisplayName(): string;
	getBinaryName(): string;
	getBootstrapDocName(): 'AGENTS.md' | 'CLAUDE.md';

	// ---------- command construction ----------

	getLaunchCommand(opts: {prompt?: string}): string;
	getPostLaunchHint(): string[];
	isBareTUICommand(cmd: string): boolean;
	isOurProcess(cmd: string): boolean;
	buildAttachCommand(meta: WorkerMeta): string | undefined;
	resumeAndAttach(meta: WorkerMeta, serverUrl: string): Promise<string | undefined>;
	getRestartInstructions(meta: WorkerMeta): string[];

	// ---------- daemon integration ----------

	refreshDaemonSettings(meta: WorkerMeta, serverUrl: string): Promise<void>;
	handleHookRequest?(req: IncomingMessage, res: ServerResponse, workerName: string): Promise<void>;
	shutdown(): Promise<void>;
	setHookContext?(ctx: HookContext): void;

	// ---------- session discovery ----------

	classifyPsLine(line: string): ClassifiedProcess | null;
	findSessionIdByCwd(cwd: string): Promise<string | undefined>;
	findHistoricalSessions(): Promise<DiscoveredSession[]>;
	enrichAliveSession(hit: ClassifiedProcess, cwd: string): Promise<DiscoveredSession>;

	// ---------- worker briefing ----------

	getActivitySummary(meta: WorkerMeta, sinceHours: number): Promise<ActivitySummary | null>;
}
