/**
 * The workboss aggregator daemon.
 *
 * Responsibilities:
 *  - Maintain SSE subscriptions to every registered worker's /event stream.
 *  - When `permission.asked` fires, capture it into ~/.workboss/approvals/.
 *  - When `permission.replied` fires, remove the corresponding approval.
 *  - Accept RPC from the workboss CLI to list approvals and forward replies.
 *  - Enforce server-side hard deny before forwarding any reply.
 *
 * Lifecycle: started by `workboss server start`, runs detached, writes its
 * PID and listening port into ~/.workboss/server.{pid,port}.
 */

import net from 'net';
import {listWorkers, listPendingApprovals, writeApproval, deleteApproval, writeServerInfo, clearServerInfo} from './lib/storage.js';
import {listPermissions, replyPermission, subscribeEvents} from './lib/opencode-client.js';
import {matchHardDeny} from './lib/deny-patterns.js';
import type {PendingApproval, WorkerMeta} from './lib/types.js';
import type {RpcRequest, RpcResponse} from './lib/server-rpc.js';

interface WorkerSubscription {
	meta: WorkerMeta;
	abort: AbortController;
	loop: Promise<void>;
}

const subscriptions = new Map<string, WorkerSubscription>();

function log(...args: unknown[]): void {
	const ts = new Date().toISOString();
	console.log(`[${ts}]`, ...args);
}

function approvalFromOpencode(
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

async function attachWorker(meta: WorkerMeta): Promise<void> {
	if (meta.agent !== 'opencode' || !meta.serverUrl) {
		log(`skip worker ${meta.name}: not an opencode worker`);
		return;
	}
	if (subscriptions.has(meta.name)) {
		log(`worker ${meta.name} already attached`);
		return;
	}

	// First, pull the current pending list so we don't miss anything that
	// already accumulated before we connected.
	try {
		const initial = await listPermissions({baseUrl: meta.serverUrl});
		for (const pr of initial) {
			await writeApproval(approvalFromOpencode(meta.name, pr));
		}
		log(`worker ${meta.name}: imported ${initial.length} existing pending requests`);
	} catch (err) {
		log(`worker ${meta.name}: initial /permission list failed: ${String(err)}`);
	}

	const abort = new AbortController();
	const loop = (async () => {
		while (!abort.signal.aborted) {
			try {
				for await (const event of subscribeEvents(
					{baseUrl: meta.serverUrl!},
					abort.signal,
				)) {
					if (event.type === 'permission.asked') {
						const pr = event.properties as unknown as Parameters<
							typeof approvalFromOpencode
						>[1];
						await writeApproval(approvalFromOpencode(meta.name, pr));
						log(`worker ${meta.name}: captured ${pr.permission} request ${pr.id}`);
					} else if (event.type === 'permission.replied') {
						const requestID = event.properties['requestID'] as string;
						if (requestID) {
							await deleteApproval(requestID);
							log(`worker ${meta.name}: cleared approval ${requestID}`);
						}
					}
				}
			} catch (err) {
				if (abort.signal.aborted) break;
				log(`worker ${meta.name}: SSE error, reconnecting in 3s: ${String(err)}`);
				await new Promise(r => setTimeout(r, 3000));
			}
		}
		log(`worker ${meta.name}: subscription loop ended`);
	})();
	subscriptions.set(meta.name, {meta, abort, loop});
	log(`worker ${meta.name}: attached to ${meta.serverUrl}`);
}

function detachWorker(name: string): void {
	const sub = subscriptions.get(name);
	if (!sub) return;
	sub.abort.abort();
	subscriptions.delete(name);
	log(`worker ${name}: detached`);
}

async function forwardReply(req: {
	id: string;
	reply: 'once' | 'always' | 'reject';
	message?: string;
}): Promise<RpcResponse> {
	// Find which worker this approval belongs to.
	const approvals = await listPendingApprovals();
	const target = approvals.find(a => a.id === req.id);
	if (!target) {
		return {ok: false, error: `approval ${req.id} not found or already handled`};
	}

	// Hard-deny enforcement: even if the caller asks to "allow", check the
	// server-side regex list and force a reject when matched. This is the
	// final-mile guard against an orchestrator (or a confused user) green-
	// lighting irreversible operations.
	if (req.reply !== 'reject') {
		const hit = matchHardDeny(target.permission, target.patterns);
		if (hit) {
			log(
				`HARD DENY ${target.worker}/${target.id}: ${hit.reason} (patterns=${JSON.stringify(target.patterns)})`,
			);
			const sub = subscriptions.get(target.worker);
			if (sub?.meta.serverUrl) {
				try {
					await replyPermission(
						{baseUrl: sub.meta.serverUrl},
						target.id,
						'reject',
						`workboss policy: ${hit.reason}`,
					);
					await deleteApproval(target.id);
				} catch (err) {
					return {ok: false, error: `forward reject failed: ${String(err)}`};
				}
			}
			return {
				ok: false,
				error: `forbidden by workboss policy: ${hit.reason}`,
			};
		}
	}

	const sub = subscriptions.get(target.worker);
	if (!sub?.meta.serverUrl) {
		return {
			ok: false,
			error: `worker ${target.worker} has no active subscription`,
		};
	}
	try {
		await replyPermission(
			{baseUrl: sub.meta.serverUrl},
			target.id,
			req.reply,
			req.message,
		);
		// Best-effort cleanup; the permission.replied SSE event will also remove it.
		await deleteApproval(target.id);
		log(`replied ${target.worker}/${target.id} ${req.reply}`);
		return {ok: true};
	} catch (err) {
		return {ok: false, error: `forward reply failed: ${String(err)}`};
	}
}

async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
	switch (req.kind) {
		case 'ping':
			return {ok: true, data: {pid: process.pid, workers: subscriptions.size}};
		case 'approvals.list':
			return {ok: true, data: await listPendingApprovals()};
		case 'approvals.reply':
			return forwardReply(req);
		case 'workers.attach': {
			const all = await listWorkers();
			const meta = all.find(w => w.name === req.name);
			if (!meta) return {ok: false, error: `worker ${req.name} not found`};
			await attachWorker(meta);
			return {ok: true};
		}
		case 'workers.detach':
			detachWorker(req.name);
			return {ok: true};
	}
}

async function startRpcServer(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer(socket => {
			let buf = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl === -1) return;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				(async () => {
					let req: RpcRequest;
					try {
						req = JSON.parse(line) as RpcRequest;
					} catch {
						socket.write(JSON.stringify({ok: false, error: 'bad json'}) + '\n');
						socket.end();
						return;
					}
					try {
						const res = await handleRpc(req);
						socket.write(JSON.stringify(res) + '\n');
					} catch (err) {
						socket.write(
							JSON.stringify({ok: false, error: String(err)}) + '\n',
						);
					} finally {
						socket.end();
					}
				})();
			});
			socket.on('error', () => {/* ignore */});
		});
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') resolve(addr.port);
			else reject(new Error('failed to bind rpc server'));
		});
	});
}

export async function runServer(): Promise<void> {
	const port = await startRpcServer();
	await writeServerInfo(process.pid, port);
	log(`workboss server up on 127.0.0.1:${port}, pid=${process.pid}`);

	// Auto-attach to every worker that's already registered.
	const workers = await listWorkers();
	for (const w of workers) {
		await attachWorker(w).catch(err =>
			log(`attach ${w.name} failed: ${String(err)}`),
		);
	}

	const shutdown = async (sig: string) => {
		log(`received ${sig}, shutting down`);
		for (const sub of subscriptions.values()) sub.abort.abort();
		await clearServerInfo();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	// Keep the process alive forever.
	await new Promise<void>(() => {});
}
