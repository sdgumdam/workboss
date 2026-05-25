import {spawn as spawnChild, spawnSync} from 'child_process';
import {execFile} from 'child_process';
import {promises as fs} from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {promisify} from 'util';
import {
	createSession,
	listPermissions,
	replyPermission,
	subscribeEvents,
} from '../../../infrastructure/http/opencode-client.js';
import {
	workerDir,
	workerOpenCodeConfigPath,
} from '../../../infrastructure/filesystem/paths.js';
import {defaultOpenCodePermissionConfig} from '../../../presentation/templates/templates.js';
import type {WorkerMeta, LivenessResult} from '../../../domain/worker.js';
import type {PendingApproval} from '../../../domain/approval.js';
import {isProcessAlive} from '../../../infrastructure/process/process.js';
import {injectBootstrapDoc} from './shared.js';
import type {
	ActivitySummary,
	AgentAdapter,
	AttachHint,
	ClassifiedProcess,
	DeliverReplyArgs,
	DiscoveredSession,
	PrepareCwdArgs,
	SpawnNewArgs,
	SpawnNewResult,
	SubscribeArgs,
	TailArgs,
} from './types.js';

const execFileAsync = promisify(execFile);

async function readProcessCommand(pid: number): Promise<string | undefined> {
	try {
		const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error('failed to allocate port'));
			}
		});
		srv.on('error', reject);
	});
}

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/permission`);
			if (res.ok || res.status === 401) return true;
		} catch {
			/* not ready */
		}
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
}

function snapshotPermissionRequest(
	workerName: string,
	pr: {
		id: string;
		sessionID: string;
		permission: string;
		patterns: string[];
		metadata: Record<string, unknown>;
		always: string[];
		tool?: {messageID: string; callID: string};
	},
): PendingApproval {
	return {
		id: pr.id,
		worker: workerName,
		sessionID: pr.sessionID,
		permission: pr.permission,
		patterns: pr.patterns,
		metadata: pr.metadata,
		always: pr.always,
		tool: pr.tool,
		capturedAt: new Date().toISOString(),
	};
}

class OpenCodeAdapter implements AgentAdapter {
	readonly kind = 'opencode' as const;

	async checkLiveness(meta: WorkerMeta): Promise<LivenessResult> {
		const serve = meta.process?.serve;
		if (!serve?.pid) return {status: 'idle', detail: 'no serve process'};

		if (!isProcessAlive(serve.pid)) {
			return {status: 'idle', detail: `serve pid ${serve.pid} is gone`};
		}

		const cmd = await readProcessCommand(serve.pid);
		if (cmd !== undefined && !this.isOurProcess(cmd)) {
			return {status: 'dead', detail: `pid ${serve.pid} reused by another process`};
		}

		if (serve.serverUrl) {
			try {
				const res = await fetch(`${serve.serverUrl}/permission`, {
					signal: AbortSignal.timeout(2000),
				});
				if (!res.ok && res.status !== 401) {
					return {status: 'dead', detail: `serve HTTP returned ${res.status}`};
				}
			} catch {
				return {status: 'dead', detail: 'serve HTTP unreachable'};
			}
		}

		if (meta.process?.tui?.tmuxWindow) {
			const {execFile} = await import('child_process');
			const {promisify} = await import('util');
			try {
				await promisify(execFile)('tmux', [
					'list-windows',
					'-t',
					'workboss',
					'-F',
					'#{window_name}',
				]);
			} catch {
				return {status: 'degraded', detail: 'serve up but workboss tmux session missing'};
			}
		}

		return {status: 'up'};
	}

	async prepareCwd(args: PrepareCwdArgs): Promise<void> {
		const cfg = workerOpenCodeConfigPath(args.workerName);
		await fs.writeFile(cfg, defaultOpenCodePermissionConfig(), 'utf8');
		await injectBootstrapDoc(args.cwdAbs, args.workerName, 'AGENTS.md');
	}

	async prepareCwdMinimal(_args: PrepareCwdArgs): Promise<void> {
	}

	async spawnNew(args: SpawnNewArgs): Promise<SpawnNewResult> {
		await this.prepareCwd({
			workerName: args.workerName,
			cwdAbs: args.cwdAbs,
			workbossServerUrl: args.workbossServerUrl,
		});

		const port = args.preferredPort ?? (await findFreePort());
		const url = `http://127.0.0.1:${port}`;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			OPENCODE_CONFIG: workerOpenCodeConfigPath(args.workerName),
		};
		const logPath = path.join(workerDir(args.workerName), 'serve.log');
		const out = await fs.open(logPath, 'a');
		const child = spawnChild(
			'opencode',
			['serve', '--port', String(port), '--hostname', '127.0.0.1'],
			{
				cwd: args.cwdAbs,
				env,
				detached: true,
				stdio: ['ignore', out.fd, out.fd],
			},
		);
		child.unref();
		out.close().catch(() => {});

		const startedAt = new Date().toISOString();
		const ready = await waitForReady(url, 15000);
		if (!ready) {
			throw new Error(
				`opencode serve did not become ready within 15s. Check ${logPath}`,
			);
		}

		let sessionId: string | undefined;
		try {
			sessionId = await createSession({baseUrl: url}, args.workerName);
		} catch (err) {
			return {
				process: {pid: child.pid, serverUrl: url, serverPort: port, startedAt},
				tuiCommand: `opencode attach ${url}`,
				postSpawnHint: [
					`  server     : ${url}`,
					`  session id : (POST /session failed: ${err instanceof Error ? err.message : String(err)})`,
					`  pid        : ${child.pid}`,
					'',
					`Attach a TUI client:`,
					`  opencode attach ${url}`,
				],
			};
		}

		return {
			sessionId,
			process: {pid: child.pid, serverUrl: url, serverPort: port, startedAt},
			tuiCommand: `opencode attach ${url} --session ${sessionId}`,
			postSpawnHint: [
				`  server     : ${url}`,
				`  session id : ${sessionId}`,
				`  pid        : ${child.pid}`,
				'',
				`Attach a TUI client:`,
				`  opencode attach ${url} --session ${sessionId}`,
			],
		};
	}

	async resumeServe(args: {
		workerName: string;
		cwdAbs: string;
		workbossServerUrl: string;
	}): Promise<{pid: number; serverUrl: string; serverPort: number}> {
		await this.prepareCwd({
			workerName: args.workerName,
			cwdAbs: args.cwdAbs,
			workbossServerUrl: args.workbossServerUrl,
		});

		const port = await findFreePort();
		const url = `http://127.0.0.1:${port}`;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			OPENCODE_CONFIG: workerOpenCodeConfigPath(args.workerName),
		};
		const logPath = path.join(workerDir(args.workerName), 'serve.log');
		const out = await fs.open(logPath, 'a');
		const child = spawnChild(
			'opencode',
			['serve', '--port', String(port), '--hostname', '127.0.0.1'],
			{
				cwd: args.cwdAbs,
				env,
				detached: true,
				stdio: ['ignore', out.fd, out.fd],
			},
		);
		child.unref();
		out.close().catch(() => {});

		const ready = await waitForReady(url, 15000);
		if (!ready) {
			throw new Error(
				`opencode serve did not become ready within 15s. Check ${logPath}`,
			);
		}

		return {pid: child.pid ?? 0, serverUrl: url, serverPort: port};
	}

	attachHint(meta: WorkerMeta): AttachHint {
		const url = meta.process?.serve?.serverUrl;
		if (!url) {
			const lines: string[] = [
				`worker "${meta.name}" has no running opencode server.`,
				`  Resume it with:`,
				`    cd ${meta.cwd} && opencode serve --port <P>`,
			];
			lines.push(
				meta.sessionId
					? `    opencode attach http://127.0.0.1:<P> --session ${meta.sessionId}`
					: `    opencode attach http://127.0.0.1:<P>`,
			);
			return lines;
		}
		return meta.sessionId
			? [`opencode attach ${url} --session ${meta.sessionId}`]
			: [`opencode attach ${url}`];
	}

	async tail(args: TailArgs): Promise<string> {
		const result = spawnSync(
			'opencode',
			['session', 'list', '--max-count', String(args.n), '--format', 'json'],
			{cwd: args.meta.cwd, encoding: 'utf8'},
		);
		if (result.status !== 0) {
			throw new Error(
				`opencode session list failed: ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout.trimEnd();
	}

	async deliverReply(args: DeliverReplyArgs): Promise<void> {
		const url = args.meta.process?.serve?.serverUrl;
		if (!url) {
			throw new Error(
				`worker ${args.meta.name} has no live opencode server; cannot forward reply`,
			);
		}
		await replyPermission(
			{baseUrl: url},
			args.approval.id,
			args.reply,
			args.message,
		);
	}

	subscribe(args: SubscribeArgs): void {
		const url = args.meta.process?.serve?.serverUrl;
		if (!url) {
			args.log(
				`worker ${args.meta.name}: registered (opencode, no live server)`,
			);
			return;
		}

		void (async () => {
			try {
				const initial = await listPermissions({baseUrl: url});
				for (const pr of initial) {
					await args.onApproval(
						snapshotPermissionRequest(args.meta.name, pr),
					);
				}
				args.log(
					`worker ${args.meta.name}: imported ${initial.length} initial pending`,
				);
			} catch (err) {
				args.log(
					`worker ${args.meta.name}: initial /permission list failed: ${String(err)}`,
				);
			}

			while (!args.abort.aborted) {
				try {
					for await (const ev of subscribeEvents(
						{baseUrl: url},
						args.abort,
					)) {
						if (ev.type === 'permission.asked') {
							const pr = ev.properties as unknown as Parameters<
								typeof snapshotPermissionRequest
							>[1];
							await args.onApproval(
								snapshotPermissionRequest(args.meta.name, pr),
							);
							args.log(
								`${args.meta.name}: opencode permission.asked id=${pr.id} perm=${pr.permission}`,
							);
						} else if (ev.type === 'permission.replied') {
							const rid = ev.properties['requestID'] as string;
							if (rid) await args.onResolved(rid);
						}
					}
				} catch (err) {
					if (args.abort.aborted) break;
					args.log(
						`worker ${args.meta.name}: SSE error, reconnecting in 3s: ${String(err)}`,
					);
					await new Promise(r => setTimeout(r, 3000));
				}
			}
		})();
		args.log(`worker ${args.meta.name}: attached to ${url}`);
	}

	getIcon(): string {
		return '⬡';
	}

	getDisplayName(): string {
		return 'OpenCode';
	}

	getBinaryName(): string {
		return 'opencode';
	}

	getBootstrapDocName(): 'AGENTS.md' {
		return 'AGENTS.md';
	}

	getLaunchCommand(opts: {prompt?: string}): string {
		if (opts.prompt) return `opencode --prompt '${opts.prompt}'`;
		return 'opencode';
	}

	getPostLaunchHint(): string[] {
		return [];
	}

	isBareTUICommand(cmd: string): boolean {
		if (cmd.includes('attach')) return false;
		if (cmd.includes('serve')) return false;
		return /^(?:\S+\/)?opencode(?:\s|$)/.test(cmd);
	}

	isOurProcess(cmd: string): boolean {
		return /\bopencode\b/.test(cmd);
	}

	buildAttachCommand(meta: WorkerMeta): string | undefined {
		const url = meta.process?.serve?.serverUrl;
		if (url && meta.sessionId) {
			return `opencode attach ${url} --session ${meta.sessionId}`;
		}
		if (url) {
			return `opencode attach ${url}`;
		}
		return undefined;
	}

	async resumeAndAttach(meta: WorkerMeta, serverUrl: string): Promise<string | undefined> {
		const servePid = meta.process?.serve?.pid;
		if (servePid && isProcessAlive(servePid)) {
			const url = meta.process?.serve?.serverUrl ?? await inferUrlFromPid(servePid);
			if (url && meta.sessionId) {
				return `opencode attach ${url} --session ${meta.sessionId}`;
			}
		}

		if (!meta.sessionId) return undefined;

		const result = await this.resumeServe({
			workerName: meta.name,
			cwdAbs: meta.cwd,
			workbossServerUrl: serverUrl,
		});
		return `opencode attach ${result.serverUrl} --session ${meta.sessionId}`;
	}

	getRestartInstructions(meta: WorkerMeta): string[] {
		if (meta.process?.serve?.serverUrl) {
			return [
				`在新终端: cd ${meta.cwd} && opencode serve --port <P>`,
				`然后:    opencode attach http://127.0.0.1:<P> --session ${meta.sessionId ?? '<session-id>'}`,
				`(旧 server ${meta.process.serve.serverUrl} 可以关掉)`,
			];
		}
		return [
			`退出当前 opencode (Ctrl+D 或 /quit)，然后重启它：`,
			`cd ${meta.cwd} && opencode --session ${meta.sessionId ?? '<session-id>'}`,
		];
	}

	async refreshDaemonSettings(_meta: WorkerMeta, _serverUrl: string): Promise<void> {
	}

	async shutdown(): Promise<void> {
	}

	classifyPsLine(line: string): ClassifiedProcess | null {
		const trimmed = line.trimStart();
		if (!trimmed) return null;
		const spaceAt = trimmed.indexOf(' ');
		if (spaceAt === -1) return null;
		const pid = Number.parseInt(trimmed.slice(0, spaceAt), 10);
		if (!Number.isFinite(pid)) return null;
		const args = trimmed.slice(spaceAt + 1);

		const serve = args.match(/\bopencode\s+serve\b[^|]*?--port\s+(\d+)/);
		if (serve) {
			const servePort = serve[1];
		if (!servePort) return null;
		return {pid, agent: 'opencode', port: Number.parseInt(servePort, 10)};
		}

		if (/\bopencode\s+attach\b/.test(args)) {
			return {pid, agent: 'opencode', isAttachClient: true};
		}

		const sessionFlag = args.match(/\bopencode\b[^|]*?(?:--session|\s-s)\s+(ses_\S+)/);
		if (sessionFlag) {
			return {pid, agent: 'opencode', sessionId: sessionFlag[1]};
		}

		if (/(?:^|\s|\/)opencode(?:\s|$)/.test(args) && !args.includes(' --')) {
			return {pid, agent: 'opencode'};
		}
		if (/^(?:\S+\/)?opencode\s/.test(args.trimStart())) {
			return {pid, agent: 'opencode'};
		}

		return null;
	}

	async findSessionIdByCwd(cwd: string): Promise<string | undefined> {
		const db = path.join(
			os.homedir(),
			'.local',
			'share',
			'opencode',
			'opencode.db',
		);
		try {
			await fs.access(db);
		} catch {
			return undefined;
		}
		const sql =
			`SELECT s.id FROM session s ` +
			`WHERE s.directory = '${cwd.replace(/'/g, "''")}' ` +
			`AND s.time_archived IS NULL ` +
			`AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id) ` +
			`ORDER BY s.time_updated DESC LIMIT 1;`;
		try {
			const {stdout} = await execFileAsync(
				'sqlite3',
				['-readonly', db, sql],
				{maxBuffer: 1024 * 1024},
			);
			const id = stdout.trim();
			return id || undefined;
		} catch {
			return undefined;
		}
	}

	async findHistoricalSessions(): Promise<DiscoveredSession[]> {
		const db = path.join(
			os.homedir(),
			'.local',
			'share',
			'opencode',
			'opencode.db',
		);
		try {
			await fs.access(db);
		} catch {
			return [];
		}
		const query =
			`SELECT id, directory, title, time_updated FROM session ` +
			`WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 500;`;
		let stdout: string;
		try {
			const r = await execFileAsync(
				'sqlite3',
				['-readonly', '-json', db, query],
				{maxBuffer: 16 * 1024 * 1024},
			);
			stdout = r.stdout;
		} catch {
			return [];
		}
		if (!stdout.trim()) return [];
		let rows: Array<{
			id: string;
			directory: string;
			title: string;
			time_updated: number;
		}>;
		try {
			rows = JSON.parse(stdout);
		} catch {
			return [];
		}
		return rows.map(r => ({
			agent: 'opencode' as const,
			sessionId: r.id,
			cwd: r.directory,
			title: r.title,
			lastActivity: new Date(r.time_updated),
			alive: false,
		}));
	}

	async enrichAliveSession(hit: ClassifiedProcess, cwd: string): Promise<DiscoveredSession> {
		let serverUrl: string | undefined;
		let sessionId: string | undefined = hit.sessionId;

		if (hit.port !== undefined) {
			serverUrl = `http://127.0.0.1:${hit.port}`;
			if (!sessionId) {
				sessionId = await fetchOpencodeLatestSession(serverUrl);
			}
		} else if (!sessionId && cwd) {
			sessionId = await this.findSessionIdByCwd(cwd);
		}

		return {
			agent: 'opencode',
			pid: hit.pid,
			cwd,
			serverUrl,
			sessionId,
			alive: true,
		};
	}

	async getActivitySummary(meta: WorkerMeta, sinceHours: number): Promise<ActivitySummary | null> {
		const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
		try {
			await fs.access(dbPath);
		} catch {
			return null;
		}

		let sessionId = meta.sessionId;
		if (!sessionId) {
			sessionId = await this.findSessionIdByCwd(meta.cwd);
		}
		if (!sessionId) return null;

		try {
			const {stdout: sessionRow} = await execFileAsync('sqlite3', [
				dbPath,
				`SELECT s.title, s.summary_additions, s.summary_deletions, s.summary_files,
				        s.time_updated, s.time_created,
				        (SELECT MAX(m.time_created) FROM message m WHERE m.session_id = s.id)
				 FROM session s WHERE s.id = '${sessionId}'`,
			]);

			const cols = sessionRow.trim().split('|');
			if (cols.length < 6) return null;

			const title = cols[0] || '(untitled)';
			const additions = parseInt(cols[1] || '0', 10) || 0;
			const deletions = parseInt(cols[2] || '0', 10) || 0;
			const filesChanged = parseInt(cols[3] || '0', 10) || 0;
			const updatedMs = parseInt(cols[4] || '0', 10) || 0;
			const createdMs = parseInt(cols[5] || '0', 10) || 0;
			const lastMsgMs = parseInt(cols[6] || '0', 10) || 0;
			const lastActiveTs = lastMsgMs || updatedMs;
			const activeMinutes = createdMs > 0 && updatedMs > 0
				? Math.round((updatedMs - createdMs) / 60_000)
				: 0;

			const sinceMs = Date.now() - sinceHours * 3600_000;

			const {stdout: toolRows} = await execFileAsync('sqlite3', [
				dbPath,
				`SELECT p.data FROM part p
				 WHERE p.session_id = '${sessionId}'
				   AND p.time_created > ${sinceMs}
				   AND json_extract(p.data, '$.type') = 'tool'
				   AND json_extract(p.data, '$.state.status') = 'completed'
				 ORDER BY p.time_created DESC LIMIT 10`,
			]);

			const recentActions: ActivitySummary['recentActions'] = [];
			for (const line of toolRows.trim().split('\n')) {
				if (!line) continue;
				try {
					const d = JSON.parse(line) as {
						tool: string;
						state?: {input?: Record<string, unknown>; metadata?: {description?: string}};
					};
					const toolName = d.tool || '?';
					const input = d.state?.input ?? {};
					let summary = '';
					if (toolName === 'bash') {
						summary = (input['command'] as string || '').slice(0, 60);
					} else if (toolName === 'edit') {
						summary = (input['filePath'] as string || '').slice(0, 60);
					} else if (toolName === 'write') {
						summary = (input['filePath'] as string || '').slice(0, 60);
					} else if (toolName === 'read') {
						summary = (input['filePath'] as string || '').slice(0, 60);
					} else {
						const desc = d.state?.metadata?.description;
						summary = desc || JSON.stringify(input).slice(0, 60);
					}
					recentActions.push({tool: toolName, summary, timestamp: new Date()});
				} catch {}
			}

			const {stdout: userRows} = await execFileAsync('sqlite3', [
				dbPath,
				`SELECT substr(p.data, 1, 500) FROM part p
				 WHERE p.session_id = '${sessionId}'
				   AND p.time_created > ${sinceMs}
				   AND json_extract(p.data, '$.type') = 'text'
				   AND EXISTS (
				     SELECT 1 FROM message m
				     WHERE m.id = p.message_id
				       AND json_extract(m.data, '$.role') = 'user'
				   )
				 ORDER BY p.time_created DESC LIMIT 5`,
			]);

			const recentUserMessages: string[] = [];
			for (const line of userRows.trim().split('\n')) {
				if (!line) continue;
				try {
					const d = JSON.parse(line) as {text?: string};
					if (d.text) {
						recentUserMessages.push(d.text.slice(0, 120).replace(/\n/g, ' '));
					}
				} catch {}
			}

			return {
				title,
				lastActiveAt: lastActiveTs > 0 ? new Date(lastActiveTs) : null,
				activeMinutes,
				additions,
				deletions,
				filesChanged,
				recentActions,
				recentUserMessages,
			};
		} catch {
			return null;
		}
	}
}

async function inferUrlFromPid(pid: number): Promise<string | undefined> {
	try {
		const {stdout} = await execFileAsync('lsof', ['-i', 'TCP', '-s', 'TCP:LISTEN', '-P', '-n', '-p', String(pid)]);
		const match = stdout.match(/127\.0\.0\.1:(\d+)/);
		if (match) return `http://127.0.0.1:${match[1]}`;
	} catch {}
	return undefined;
}

async function fetchOpencodeLatestSession(
	serverUrl: string,
): Promise<string | undefined> {
	try {
		const res = await fetch(`${serverUrl}/session?max=1`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as Array<{id?: string}>;
		if (Array.isArray(data) && data[0]?.id) return data[0].id;
	} catch {}
	return undefined;
}

export const openCodeAdapter = new OpenCodeAdapter();
