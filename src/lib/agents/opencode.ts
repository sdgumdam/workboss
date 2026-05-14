import {spawn as spawnChild, spawnSync} from 'child_process';
import {promises as fs} from 'fs';
import net from 'net';
import path from 'path';
import {
	createSession,
	listPermissions,
	replyPermission,
	subscribeEvents,
} from '../opencode-client.js';
import {
	workerDir,
	workerOpenCodeConfigPath,
} from '../paths.js';
import {defaultOpenCodePermissionConfig} from '../templates.js';
import type {PendingApproval, WorkerMeta} from '../types.js';
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

	async prepareCwd(args: PrepareCwdArgs): Promise<void> {
		const cfg = workerOpenCodeConfigPath(args.workerName);
		// Mirror the same config into the worker's runtime dir; opencode reads
		// it via OPENCODE_CONFIG when we spawn the server.
		await fs.writeFile(cfg, defaultOpenCodePermissionConfig(), 'utf8');
		await injectBootstrapDoc(args.cwdAbs, args.workerName, 'AGENTS.md');
	}

	async prepareCwdMinimal(_args: PrepareCwdArgs): Promise<void> {
		// OpenCode hands us permission events over SSE on /event with no
		// per-worker setup required — we just need the URL, which we already
		// have from discovery. So this is a deliberate no-op.
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
			// Server is up but we couldn't bind a session. Surface it as a
			// warning via postSpawnHint — the worker is still usable.
			return {
				process: {pid: child.pid, serverUrl: url, serverPort: port, startedAt},
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
		const url = meta.process?.serverUrl;
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
		const url = args.meta.process?.serverUrl;
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
		const url = args.meta.process?.serverUrl;
		if (!url) {
			args.log(
				`worker ${args.meta.name}: registered (opencode, no live server)`,
			);
			return;
		}

		void (async () => {
			// Import current pending list once so we don't miss anything that
			// queued before we connected.
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
