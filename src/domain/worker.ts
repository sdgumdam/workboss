export type AgentKind = 'opencode' | 'claude';

export type LivenessStatus = 'up' | 'degraded' | 'idle' | 'dead';

export interface LivenessResult {
	status: LivenessStatus;
	detail?: string;
}

export interface ProcessInfo {
	serve?: {
		pid?: number;
		serverUrl?: string;
		serverPort?: number;
		startedAt: string;
	};
	tui?: {
		tmuxWindow?: string;
		startedAt?: string;
	};
}

export interface WorkerMeta {
	name: string;
	agent: AgentKind;
	cwd: string;
	createdAt: string;
	sessionId?: string;
	process?: ProcessInfo;
	liveness: LivenessStatus;
	notes?: string;
}

export function createWorkerMeta(data: Omit<WorkerMeta, 'liveness'>): WorkerMeta {
	return { ...data, liveness: 'idle' };
}

export function updateWorkerLiveness(meta: WorkerMeta, status: LivenessStatus): WorkerMeta {
	return { ...meta, liveness: status };
}

export interface WorkerRepository {
	list(): Promise<WorkerMeta[]>;
	read(name: string): Promise<WorkerMeta>;
	write(meta: WorkerMeta): Promise<void>;
	update(name: string, patch: (meta: WorkerMeta) => WorkerMeta | Promise<WorkerMeta>): Promise<WorkerMeta | null>;
	delete(name: string): Promise<void>;
}
