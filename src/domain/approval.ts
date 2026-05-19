export type ReplyKind = 'once' | 'always' | 'reject';

export interface ReplyDecision {
	reply: ReplyKind;
	message?: string;
}

export interface PendingApproval {
	id: string;
	worker: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: {messageID: string; callID: string};
	capturedAt: string;
}

export interface ApprovalRepository {
	list(): Promise<PendingApproval[]>;
	write(approval: PendingApproval): Promise<void>;
	delete(id: string): Promise<void>;
}
