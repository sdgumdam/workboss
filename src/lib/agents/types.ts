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

import type {AgentKind, PendingApproval, ReplyKind, WorkerMeta} from '../types.js';

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
	 * Idempotently set up <cwd> so that any future agent session started in
	 * it routes through workboss (mission/inbox docs, settings.local.json,
	 * etc.). Called by `register` and `spawn` alike.
	 */
	prepareCwd(args: PrepareCwdArgs): Promise<void>;

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
}
