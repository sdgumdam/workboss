export type AgentKind = 'opencode' | 'claude';

export interface WorkerMeta {
	name: string;
	agent: AgentKind;
	cwd: string;
	createdAt: string; // ISO timestamp
	// OpenCode-specific:
	serverUrl?: string; // e.g. http://127.0.0.1:4096
	serverPort?: number;
	pid?: number; // PID of the spawned `opencode serve` process (managed mode)
	// Common metadata
	notes?: string;
}

/**
 * A snapshot of a pending permission request that workboss has captured from
 * a worker's SSE event stream. The full opencode Request shape includes more
 * fields; we keep what's useful for display + replying.
 */
export interface PendingApproval {
	id: string; // OpenCode PermissionID
	worker: string; // workboss worker name
	sessionID: string;
	permission: string; // e.g. "bash", "edit"
	patterns: string[]; // what's being requested, e.g. ["npm install lodash"]
	metadata: Record<string, unknown>;
	always: string[]; // pattern set that "always" would persist
	tool?: { messageID: string; callID: string };
	capturedAt: string; // when workboss saw it
}

export type ReplyKind = 'once' | 'always' | 'reject';

export interface ReplyDecision {
	reply: ReplyKind;
	message?: string;
}
