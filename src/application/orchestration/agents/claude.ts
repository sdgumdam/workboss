import {execFile} from 'child_process';
import type {IncomingMessage, ServerResponse} from 'http';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {promisify} from 'util';
import {
	classifyToolName,
	extractPatterns,
	writeClaudeSettings,
	type ClaudeHookResponse,
	type ClaudePreToolUseRequest,
} from '../../../infrastructure/agent-config/claude-config.js';
import {matchHardDeny} from '../../../infrastructure/agent-config/deny-patterns.js';
import {createLogger} from '../../../infrastructure/logging/logger.js';
import {injectBootstrapDoc} from './shared.js';
import type {WorkerMeta, LivenessResult} from '../../../domain/worker.js';
import type {PendingApproval} from '../../../domain/approval.js';
import {isProcessAlive} from '../../../infrastructure/process/process.js';
import type {
	AgentAdapter,
	AttachHint,
	ClassifiedProcess,
	DeliverReplyArgs,
	DiscoveredSession,
	HookContext,
	PrepareCwdArgs,
	SpawnNewArgs,
	SpawnNewResult,
	SubscribeArgs,
	TailArgs,
} from './types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('claude-adapter');

async function readProcessCommand(pid: number): Promise<string | undefined> {
	try {
		const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

class ClaudeAdapter implements AgentAdapter {
	readonly kind = 'claude' as const;

	async checkLiveness(meta: WorkerMeta): Promise<LivenessResult> {
		const serve = meta.process?.serve;
		if (!serve?.pid) return {status: 'idle', detail: 'no process'};

		if (!isProcessAlive(serve.pid)) {
			return {status: 'idle', detail: `pid ${serve.pid} is gone`};
		}

		const cmd = await readProcessCommand(serve.pid);
		if (cmd !== undefined && !this.isOurProcess(cmd)) {
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

	getIcon(): string {
		return '◈';
	}

	getDisplayName(): string {
		return 'Claude';
	}

	getBinaryName(): string {
		return 'claude';
	}

	getBootstrapDocName(): 'CLAUDE.md' {
		return 'CLAUDE.md';
	}

	getLaunchCommand(_opts: {prompt?: string}): string {
		return 'claude';
	}

	getPostLaunchHint(): string[] {
		return ['(提示：claude 启动后第一句对它说"扫一遍"它就会自动跑 list+discover 汇报)'];
	}

	isBareTUICommand(_cmd: string): boolean {
		return false;
	}

	isOurProcess(cmd: string): boolean {
		return /\bclaude\b/.test(cmd);
	}

	buildAttachCommand(meta: WorkerMeta): string | undefined {
		return meta.sessionId ? `claude --resume ${meta.sessionId}` : 'claude';
	}

	async resumeAndAttach(meta: WorkerMeta, _serverUrl: string): Promise<string | undefined> {
		return this.buildAttachCommand(meta);
	}

	getRestartInstructions(meta: WorkerMeta): string[] {
		return [
			`cd ${meta.cwd} && claude --resume ${meta.sessionId ?? '<session-id>'}`,
		];
	}

	async refreshDaemonSettings(meta: WorkerMeta, serverUrl: string): Promise<void> {
		await writeClaudeSettings(meta.cwd, {
			workerName: meta.name,
			workbossServerUrl: serverUrl,
		}).catch(err =>
			logger.info(`update claude settings ${meta.name} failed: ${String(err)}`),
		);
	}

	private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', c => chunks.push(c));
			req.on('end', () => {
				try {
					const raw = Buffer.concat(chunks).toString('utf8');
					resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
				} catch (err) {
					reject(err);
				}
			});
			req.on('error', reject);
		});
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		res.statusCode = status;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	}

	private sendHookDecision(
		res: ServerResponse,
		decision: 'allow' | 'deny' | 'ask',
		reason: string,
	): void {
		this.sendJson(res, 200, {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: decision,
				...(reason ? {permissionDecisionReason: reason} : {}),
			},
		});
	}

	private hookCtx: HookContext | null = null;

	setHookContext(ctx: HookContext): void {
		this.hookCtx = ctx;
	}

	async handleHookRequest(
		req: IncomingMessage,
		res: ServerResponse,
		workerName: string,
	): Promise<void> {
		if (!this.hookCtx) {
			this.sendHookDecision(res, 'ask', 'workboss hook context not initialized');
			return;
		}

		const body: ClaudePreToolUseRequest = await this.readJsonBody(req);

		if (body.session_id) {
			await this.hookCtx.workerRepo.update(workerName, m => ({...m, sessionId: body.session_id}));
		}

		const permission = classifyToolName(body.tool_name);
		const patterns = extractPatterns(body.tool_name, body.tool_input);

		const hit = matchHardDeny(permission, patterns);
		if (!hit) {
			this.sendHookDecision(res, 'allow', '');
			return;
		}

		logger.info(
			`QUEUE APPROVAL ${workerName} ${body.tool_name}: ${hit.reason} (${JSON.stringify(patterns)})`,
		);

		const approvalId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		const approval: PendingApproval = {
			id: approvalId,
			worker: workerName,
			sessionID: body.session_id ?? '',
			permission,
			patterns,
			metadata: { tool_name: body.tool_name, tool_input: body.tool_input },
			always: [],
			capturedAt: new Date().toISOString(),
		};
		await this.hookCtx.approvalRepo.write(approval);

		const HOOK_TIMEOUT_MS = 60_000;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			this.dropHookResponder(approvalId);
			void this.hookCtx?.approvalRepo.delete(approvalId);
			logger.info(`claude hook ${approvalId} timed out, returning ask`);
			this.sendHookDecision(res, 'ask', 'workboss: no orchestrator response within 60s');
		}, HOOK_TIMEOUT_MS);

		this.registerHookResponder(approvalId, (response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.sendJson(res, 200, response);
		});

		res.on('close', () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				this.dropHookResponder(approvalId);
				logger.info(`claude hook ${approvalId} dropped by client before reply — keeping approval for orchestrator`);
			}
		});
	}

	async shutdown(): Promise<void> {
		this.respondToAllPending({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				permissionDecisionReason: 'workboss server is shutting down',
			},
		});
	}

	classifyPsLine(line: string): ClassifiedProcess | null {
		const trimmed = line.trimStart();
		if (!trimmed) return null;
		const spaceAt = trimmed.indexOf(' ');
		if (spaceAt === -1) return null;
		const pid = Number.parseInt(trimmed.slice(0, spaceAt), 10);
		if (!Number.isFinite(pid)) return null;
		const args = trimmed.slice(spaceAt + 1);

		const claudeBin = /(?:^|\s|\/)claude(?:\s|$)/.test(args);
		if (claudeBin && !args.includes('--output-format')) {
			const resume = args.match(/--resume\s+(\S+)/);
			const sessionId =
				resume && UUID_RE.test(resume[1] ?? '') ? resume[1] : undefined;
			return {pid, agent: 'claude', sessionId};
		}

		return null;
	}

	async findSessionIdByCwd(cwd: string): Promise<string | undefined> {
		const encoded = cwd.replace(/[/_.]/g, '-');
		const dir = path.join(
			process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
			'projects',
			encoded,
		);
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			return undefined;
		}
		let best: {sid: string; mtimeMs: number} | null = null;
		for (const f of entries) {
			if (!f.endsWith('.jsonl')) continue;
			try {
				const st = await fs.stat(path.join(dir, f));
				if (!best || st.mtimeMs > best.mtimeMs) {
					best = {sid: f.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs};
				}
			} catch {}
		}
		if (!best) return undefined;
		const STALE_MS = 24 * 60 * 60 * 1000;
		if (Date.now() - best.mtimeMs > STALE_MS) return undefined;
		return best.sid;
	}

	async findHistoricalSessions(): Promise<DiscoveredSession[]> {
		const root = path.join(
			process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
			'projects',
		);
		let dirs: string[];
		try {
			dirs = await fs.readdir(root);
		} catch {
			return [];
		}

		const out: DiscoveredSession[] = [];
		await Promise.all(
			dirs.map(async dir => {
				const dirPath = path.join(root, dir);
				let entries: string[];
				try {
					const st = await fs.stat(dirPath);
					if (!st.isDirectory()) return;
					entries = await fs.readdir(dirPath);
				} catch {
					return;
				}
				for (const entry of entries) {
					if (!entry.endsWith('.jsonl')) continue;
					const sid = entry.slice(0, -'.jsonl'.length);
					const file = path.join(dirPath, entry);

					let cwd: string | undefined;
					let title: string | undefined;
					try {
						const records = await readJsonlHead(file);
						for (const rec of records) {
							const c = rec['cwd'];
							if (!cwd && typeof c === 'string') cwd = c;
							if (!title && typeof rec['summary'] === 'string') {
								title = rec['summary'] as string;
							}
							if (cwd && title) break;
						}
					} catch {}

					if (!cwd) {
						const guess = dir.replace(/^-/, '/').replace(/-/g, '/');
						try {
							const st = await fs.stat(guess);
							if (st.isDirectory()) cwd = guess;
						} catch {}
					}
					if (!cwd) continue;

					let lastActivity: Date | undefined;
					try {
						const st = await fs.stat(file);
						lastActivity = st.mtime;
					} catch {}

					let messageCount: number | undefined;
					try {
						messageCount = await countLines(file);
					} catch {}

					out.push({
						agent: 'claude',
						sessionId: sid,
						cwd,
						title,
						lastActivity,
						messageCount,
						alive: false,
					});
				}
			}),
		);
		return out;
	}

	async enrichAliveSession(hit: ClassifiedProcess, cwd: string): Promise<DiscoveredSession> {
		let sessionId = hit.sessionId;
		if (!sessionId && cwd) {
			sessionId = await this.findSessionIdByCwd(cwd);
		}
		return {
			agent: 'claude',
			pid: hit.pid,
			cwd,
			sessionId,
			alive: true,
		};
	}
}

async function readJsonlHead(
	file: string,
	maxBytes = 65536,
): Promise<Record<string, unknown>[]> {
	const handle = await fs.open(file, 'r');
	try {
		const buf = Buffer.alloc(maxBytes);
		const {bytesRead} = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead === 0) return [];
		const text = buf.slice(0, bytesRead).toString('utf8');
		const lines = text.split('\n');
		if (bytesRead === maxBytes) lines.pop();
		const out: Record<string, unknown>[] = [];
		for (const line of lines) {
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as Record<string, unknown>);
			} catch {}
		}
		return out;
	} finally {
		await handle.close();
	}
}

async function countLines(file: string): Promise<number> {
	const data = await fs.readFile(file, 'utf8');
	let n = 0;
	for (let i = 0; i < data.length; i++) {
		if (data.charCodeAt(i) === 10) n++;
	}
	return n;
}

export const claudeAdapter = new ClaudeAdapter();
