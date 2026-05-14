import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {
	writeClaudeSettings,
	type ClaudeHookResponse,
} from '../claude-config.js';
import {injectBootstrapDoc} from './shared.js';
import type {WorkerMeta} from '../types.js';
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

	/**
	 * Claude is passive — its runtime calls workboss via the PreToolUse HTTP
	 * hook. When a hook fires, server.ts registers a callback here keyed by
	 * the synthetic approval id; deliverReply() looks the callback up and
	 * uses it to write the HTTP response.
	 *
	 * Stored on the adapter (not the server module) so all Claude-specific
	 * state lives in one place.
	 */
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
		// Claude stores jsonl under ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
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
		// Claude is passive — its hook posts to /claude-hook/:worker on
		// workboss's HTTP server. Nothing to start here.
		args.log(`worker ${args.meta.name}: registered (claude, passive)`);
	}
}

export const claudeAdapter = new ClaudeAdapter();
