export type AgentKind = 'opencode' | 'claude';

/**
 * A workboss worker is fundamentally a *session pointer*. The agent's session
 * (Claude jsonl or OpenCode sqlite row) is the durable artifact; the process
 * running on top of it is transient, can crash or be killed, and can be
 * resumed later with the same session id.
 *
 * sessionId is therefore the only piece that defines identity. The `process`
 * sub-record describes the *currently attached* runtime instance, if any —
 * empty after a `detach`, populated again after a fresh spawn / resume.
 */
export interface WorkerMeta {
	name: string;
	agent: AgentKind;
	cwd: string;
	createdAt: string; // ISO timestamp

	/**
	 * The agent-native session id we are bound to. Opaque to workboss.
	 * - opencode: looks like "ses_..."
	 * - claude: a UUID
	 * May be undefined briefly after spawn for opencode (until we POST /session),
	 * and undefined for a freshly registered claude worker until the first
	 * PreToolUse hook arrives (the hook payload contains it).
	 */
	sessionId?: string;

	/**
	 * Transient runtime info for the currently attached process. Absent when
	 * the worker is registered but not currently running.
	 */
	process?: {
		pid?: number;
		serverUrl?: string; // opencode-only: http://127.0.0.1:<port>
		serverPort?: number;
		startedAt: string;
	};

	notes?: string;
}

/**
 * A snapshot of a pending permission request that workboss has captured from
 * a worker. For OpenCode the id is the PermissionID from the SSE event; for
 * Claude it is a synthetic id we make up when the HTTP hook fires.
 */
export interface PendingApproval {
	id: string;
	worker: string;
	sessionID: string;
	permission: string; // e.g. "bash", "edit"
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: {messageID: string; callID: string};
	capturedAt: string;
}

export type ReplyKind = 'once' | 'always' | 'reject';

export interface ReplyDecision {
	reply: ReplyKind;
	message?: string;
}
