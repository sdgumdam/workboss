import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {
	writeClaudeSettings,
	type ClaudeHookResponse,
} from '../../../infrastructure/agent-config/claude-config.js';
import {injectBootstrapDoc} from './shared.js';
import type {WorkerMeta, LivenessResult} from '../../../domain/worker.js';
import {isProcessAlive, isProcessStillOurs} from '../../../infrastructure/process/process.js';
import type {
	AgentAdapter,
	AttachHint,
	DeliverReplyArgs,
	PrepareCwdArgs,
	SpawnNewArgs,
	SpawnNewResult,
	SubscribeArgs,
	TailArgs,
} from './types.js';

class ClaudeAdapter implements AgentAdapter {
	readonly kind = 'claude' as const;

	async checkLiveness(meta: WorkerMeta): Promise<LivenessResult> {
		const serve = meta.process?.serve;
		if (!serve?.pid) return {status: 'idle', detail: 'no process'};

		if (!isProcessAlive(serve.pid)) {
			return {status: 'idle', detail: `pid ${serve.pid} is gone`};
		}

		if (!(await isProcessStillOurs(serve.pid, 'claude'))) {
			return {status: 'dead', detail: `pid ${serve.pid} reused by another process`};
		}

		return {status: 'up'};
	}

	private readonly pendingHookResponders = new Map<
		string,
		(response: ClaudeHookResponse) => void
	>();

	registerHookResponder(
		approvalId: string,
		responder: (response: ClaudeHookResponse) => void,
	): void {
		this.pendingHookResponders.set(approvalId, responder);
	}

	dropHookResponder(approvalId: string): void {
		this.pendingHookResponders.delete(approvalId);
	}

	hasHookResponder(approvalId: string): boolean {
		return this.pendingHookResponders.has(approvalId);
	}

	respondToAllPending(response: ClaudeHookResponse): void {
		for (const cb of this.pendingHookResponders.values()) cb(response);
		this.pendingHookResponders.clear();
	}

	async prepareCwd(args: PrepareCwdArgs): Promise<void> {
		await writeClaudeSettings(args.cwdAbs, {
			workerName: args.workerName,
			workbossServerUrl: args.workbossServerUrl,
		});
		await injectBootstrapDoc(args.cwdAbs, args.workerName, 'CLAUDE.md');
	}

	async prepareCwdMinimal(args: PrepareCwdArgs): Promise<void> {
		await writeClaudeSettings(args.cwdAbs, {
			workerName: args.workerName,
			workbossServerUrl: args.workbossServerUrl,
		});
	}

	async spawnNew(args: SpawnNewArgs): Promise<SpawnNewResult> {
		await this.prepareCwd({
			workerName: args.workerName,
			cwdAbs: args.cwdAbs,
			workbossServerUrl: args.workbossServerUrl,
		});

		const settingsPath = path.join(
			args.cwdAbs,
			'.claude',
			'settings.local.json',
		);
		return {
			tuiCommand: `claude`,
			postSpawnHint: [
				`  settings   : ${settingsPath}`,
				`  session id : (will be learned from first hook call)`,
				'',
				`Start the worker:`,
				`  cd ${args.cwdAbs} && claude`,
				'',
				`The next PreToolUse from this Claude session will register through workboss.`,
			],
		};
	}

	attachHint(meta: WorkerMeta): AttachHint {
		if (meta.sessionId) {
			return [`cd ${meta.cwd} && claude --resume ${meta.sessionId}`];
		}
		return [
			`cd ${meta.cwd} && claude`,
			`# session id will be learned on the first PreToolUse hook`,
		];
	}

	async tail(args: TailArgs): Promise<string> {
		if (!args.meta.sessionId) {
			return '(no session id yet; nothing to tail)';
		}
		const encoded = args.meta.cwd.replace(/[\\/.]/g, '-');
		const jsonl = path.join(
			os.homedir(),
			'.claude',
			'projects',
			encoded,
			`${args.meta.sessionId}.jsonl`,
		);
		const text = await fs.readFile(jsonl, 'utf8');
		const lines = text.split('\n').filter(Boolean);
		return lines.slice(-args.n).join('\n');
	}

	async deliverReply(args: DeliverReplyArgs): Promise<void> {
		const cb = this.pendingHookResponders.get(args.approval.id);
		if (!cb) {
			throw new Error(
				`claude hook for ${args.approval.id} is no longer waiting (timed out?)`,
			);
		}
		const decision: 'allow' | 'deny' =
			args.reply === 'reject' ? 'deny' : 'allow';
		cb({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: decision,
				...(args.message ? {permissionDecisionReason: args.message} : {}),
			},
		});
		this.pendingHookResponders.delete(args.approval.id);
	}

	subscribe(args: SubscribeArgs): void {
		args.log(`worker ${args.meta.name}: registered (claude, passive)`);
	}
}

export const claudeAdapter = new ClaudeAdapter();
