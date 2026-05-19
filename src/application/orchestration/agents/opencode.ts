import {spawn as spawnChild, spawnSync} from 'child_process';
import {promises as fs} from 'fs';
import net from 'net';
import path from 'path';
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
import {isProcessAlive, isProcessStillOurs} from '../../../infrastructure/process/process.js';
import {injectBootstrapDoc} from './shared.js';
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

		if (!(await isProcessStillOurs(serve.pid, 'opencode'))) {
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
}

export const openCodeAdapter = new OpenCodeAdapter();
