/**
 * The workboss aggregator daemon.
 *
 * One Node HTTP server, two surfaces:
 *
 *   POST /rpc                             control-plane requests from the
 *                                         workboss CLI (the orchestrator
 *                                         calls these via Bash)
 *
 *   POST /claude-hook/:worker             PreToolUse HTTP hook callback from
 *                                         Claude Code workers. The request
 *                                         is held open while the approval
 *                                         sits in the queue; whoever replies
 *                                         (orchestrator or human) causes the
 *                                         response body to be written.
 *
 * Additionally, for every OpenCode worker registered in ~/.workboss/workers/
 * the daemon maintains an outbound SSE subscription to its /event stream so
 * `permission.asked` from the worker shows up in the same queue.
 *
 * Lifecycle: started detached by `workboss server start`. Writes its PID and
 * listening port into ~/.workboss/server.{pid,port}.
 */

import http from 'http';
import type {AddressInfo} from 'net';
import {
	clearServerInfo,
	deleteApproval,
	listPendingApprovals,
	listWorkers,
	updateWorkerMeta,
	writeApproval,
	writeServerInfo,
} from './lib/storage.js';
import {
	listPermissions,
	replyPermission,
	subscribeEvents,
} from './lib/opencode-client.js';
import {matchHardDeny} from './lib/deny-patterns.js';
import type {PendingApproval, WorkerMeta} from './lib/types.js';
import type {RpcRequest, RpcResponse} from './lib/server-rpc.js';
import {
	classifyToolName,
	extractPatterns,
	type ClaudeHookResponse,
	type ClaudePreToolUseRequest,
} from './lib/claude-config.js';

// ---------------- worker subscriptions ----------------

interface WorkerSubscription {
	meta: WorkerMeta;
	abort: AbortController;
}

const subscriptions = new Map<string, WorkerSubscription>();

// Pending Claude hook requests waiting for a reply. Key = approval id.
type ClaudeHookCallback = (response: ClaudeHookResponse) => void;
const pendingClaudeHooks = new Map<string, ClaudeHookCallback>();

function log(...args: unknown[]): void {
	const ts = new Date().toISOString();
	console.log(`[${ts}]`, ...args);
}

// ---------------- OpenCode SSE subscription ----------------

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

async function attachOpencodeWorker(meta: WorkerMeta): Promise<void> {
	const serverUrl = meta.process?.serverUrl;
	if (!serverUrl) {
		// Worker has no live server right now; nothing to subscribe to. Still
		// keep it registered in `subscriptions` so reply routing knows the
		// agent type, and so the user can later bring up a process and call
		// `workers.attach` again.
		if (!subscriptions.has(meta.name)) {
			subscriptions.set(meta.name, {meta, abort: new AbortController()});
			log(`worker ${meta.name}: registered (opencode, no live server)`);
		}
		return;
	}
	if (subscriptions.has(meta.name)) return;

	try {
		const initial = await listPermissions({baseUrl: serverUrl});
		for (const pr of initial) {
			await writeApproval(approvalFromOpencode(meta.name, pr));
		}
		log(`worker ${meta.name}: imported ${initial.length} initial pending`);
	} catch (err) {
		log(`worker ${meta.name}: initial list failed: ${String(err)}`);
	}

	const abort = new AbortController();
	void (async () => {
		while (!abort.signal.aborted) {
			try {
				for await (const ev of subscribeEvents(
					{baseUrl: serverUrl},
					abort.signal,
				)) {
					if (ev.type === 'permission.asked') {
						const pr = ev.properties as unknown as Parameters<
							typeof approvalFromOpencode
						>[1];
						await writeApproval(approvalFromOpencode(meta.name, pr));
						log(
							`${meta.name}: opencode permission.asked id=${pr.id} perm=${pr.permission}`,
						);
					} else if (ev.type === 'permission.replied') {
						const rid = ev.properties['requestID'] as string;
						if (rid) await deleteApproval(rid);
					}
				}
			} catch (err) {
				if (abort.signal.aborted) break;
				log(
					`worker ${meta.name}: SSE error, reconnecting in 3s: ${String(err)}`,
				);
				await new Promise(r => setTimeout(r, 3000));
			}
		}
	})();
	subscriptions.set(meta.name, {meta, abort});
	log(`worker ${meta.name}: attached to ${serverUrl}`);
}

function attachClaudeWorker(meta: WorkerMeta): void {
	// Claude workers are passive — they reach out to us when a hook fires.
	// We just remember they exist so list / hard-deny work, and rely on the
	// HTTP listener to receive their permission asks.
	if (subscriptions.has(meta.name)) return;
	subscriptions.set(meta.name, {meta, abort: new AbortController()});
	log(`worker ${meta.name}: registered (claude, passive)`);
}

async function attachWorker(meta: WorkerMeta): Promise<void> {
	if (meta.agent === 'opencode') return attachOpencodeWorker(meta);
	if (meta.agent === 'claude') return attachClaudeWorker(meta);
}

function detachWorker(name: string): void {
	const sub = subscriptions.get(name);
	if (!sub) return;
	sub.abort.abort();
	subscriptions.delete(name);
	log(`worker ${name}: detached`);
}

// ---------------- reply forwarding ----------------

async function forwardReply(req: {
	id: string;
	reply: 'once' | 'always' | 'reject';
	message?: string;
}): Promise<RpcResponse> {
	const approvals = await listPendingApprovals();
	const target = approvals.find(a => a.id === req.id);
	if (!target) {
		return {ok: false, error: `approval ${req.id} not found or already handled`};
	}

	// Hard-deny: server-side regex check that no caller can bypass.
	if (req.reply !== 'reject') {
		const hit = matchHardDeny(target.permission, target.patterns);
		if (hit) {
			log(
				`HARD DENY ${target.worker}/${target.id}: ${hit.reason} (patterns=${JSON.stringify(target.patterns)})`,
			);
			await deliverReply(target, 'reject', `workboss policy: ${hit.reason}`);
			return {
				ok: false,
				error: `forbidden by workboss policy: ${hit.reason}`,
			};
		}
	}

	try {
		await deliverReply(target, req.reply, req.message);
		log(`replied ${target.worker}/${target.id} ${req.reply}`);
		return {ok: true};
	} catch (err) {
		return {ok: false, error: `forward reply failed: ${String(err)}`};
	}
}

async function deliverReply(
	target: PendingApproval,
	reply: 'once' | 'always' | 'reject',
	message: string | undefined,
): Promise<void> {
	const sub = subscriptions.get(target.worker);
	if (!sub) throw new Error(`worker ${target.worker} not registered`);

	if (sub.meta.agent === 'opencode') {
		const url = sub.meta.process?.serverUrl;
		if (!url) {
			throw new Error(
				`worker ${target.worker} has no live opencode server; cannot forward reply`,
			);
		}
		await replyPermission({baseUrl: url}, target.id, reply, message);
		await deleteApproval(target.id);
		return;
	}

	if (sub.meta.agent === 'claude') {
		const cb = pendingClaudeHooks.get(target.id);
		if (!cb) {
			// Hook already timed out on Claude's side; drop the queue entry.
			await deleteApproval(target.id);
			throw new Error(
				`claude hook for ${target.id} is no longer waiting (timed out?)`,
			);
		}
		const decision: 'allow' | 'deny' =
			reply === 'reject' ? 'deny' : 'allow';
		cb({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: decision,
				...(message ? {permissionDecisionReason: message} : {}),
			},
		});
		pendingClaudeHooks.delete(target.id);
		await deleteApproval(target.id);
		return;
	}
}

// ---------------- RPC handlers ----------------

async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
	switch (req.kind) {
		case 'ping':
			return {
				ok: true,
				data: {pid: process.pid, workers: subscriptions.size},
			};
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

// ---------------- HTTP server ----------------

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(body));
}

async function handleClaudeHook(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	workerName: string,
): Promise<void> {
	const sub = subscriptions.get(workerName);
	if (!sub) {
		// We don't know this worker. Default to "ask" so Claude falls back to
		// its built-in prompt — safer than allowing silently.
		log(`claude hook from unknown worker "${workerName}", returning ask`);
		sendJson(res, 200, {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				permissionDecisionReason: `workboss does not know worker "${workerName}"`,
			},
		});
		return;
	}
	if (sub.meta.agent !== 'claude') {
		sendJson(res, 200, {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				permissionDecisionReason: `worker "${workerName}" is not registered as a claude worker`,
			},
		});
		return;
	}

	let body: ClaudePreToolUseRequest;
	try {
		body = await readJson<ClaudePreToolUseRequest>(req);
	} catch (err) {
		sendJson(res, 400, {error: `bad json: ${String(err)}`});
		return;
	}

	// First time we see a session_id from this worker, record it. The session
	// is the durable identity of the worker; the Claude process running on
	// top of it is replaceable.
	if (body.session_id && !sub.meta.sessionId) {
		await updateWorkerMeta(workerName, m => ({...m, sessionId: body.session_id}));
		sub.meta.sessionId = body.session_id;
		log(`${workerName}: learned session_id=${body.session_id}`);
	}

	const permission = classifyToolName(body.tool_name);
	const patterns = extractPatterns(body.tool_name, body.tool_input);

	// Hard-deny check up front: if the request matches, don't even queue it.
	const hit = matchHardDeny(permission, patterns);
	if (hit) {
		log(
			`HARD DENY (inline) ${workerName} ${body.tool_name}: ${hit.reason} (${JSON.stringify(patterns)})`,
		);
		sendJson(res, 200, {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason: `workboss policy: ${hit.reason}`,
			},
		});
		return;
	}

	const approvalId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const approval: PendingApproval = {
		id: approvalId,
		worker: workerName,
		sessionID: body.session_id ?? '',
		permission,
		patterns,
		metadata: {tool_name: body.tool_name, tool_input: body.tool_input},
		always: [],
		capturedAt: new Date().toISOString(),
	};
	await writeApproval(approval);
	log(
		`${workerName}: claude hook captured id=${approvalId} ${body.tool_name} ${JSON.stringify(patterns)}`,
	);

	// Register the callback that will resolve the request body later.
	let settled = false;
	pendingClaudeHooks.set(approvalId, response => {
		if (settled) return;
		settled = true;
		sendJson(res, 200, response);
	});

	// If the HTTP connection is dropped before we reply, clean up.
	res.on('close', () => {
		if (!settled) {
			settled = true;
			pendingClaudeHooks.delete(approvalId);
			void deleteApproval(approvalId);
			log(`claude hook ${approvalId} dropped by client before reply`);
		}
	});
}

async function startHttpServer(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			(async () => {
				const url = req.url ?? '/';
				if (req.method === 'POST' && url === '/rpc') {
					try {
						const body = await readJson<RpcRequest>(req);
						const out = await handleRpc(body);
						sendJson(res, 200, out);
					} catch (err) {
						sendJson(res, 500, {ok: false, error: String(err)});
					}
					return;
				}
				if (req.method === 'POST' && url.startsWith('/claude-hook/')) {
					const workerName = decodeURIComponent(url.slice('/claude-hook/'.length));
					await handleClaudeHook(req, res, workerName);
					return;
				}
				sendJson(res, 404, {error: `not found: ${req.method} ${url}`});
			})().catch(err => {
				if (!res.headersSent) sendJson(res, 500, {error: String(err)});
			});
		});
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as AddressInfo | null;
			if (!addr || typeof addr !== 'object') {
				reject(new Error('bad listen'));
				return;
			}
			resolve(addr.port);
		});
	});
}

export async function runServer(): Promise<void> {
	const port = await startHttpServer();
	await writeServerInfo(process.pid, port);
	log(`workboss server up on http://127.0.0.1:${port}, pid=${process.pid}`);

	const workers = await listWorkers();
	for (const w of workers) {
		await attachWorker(w).catch(err =>
			log(`attach ${w.name} failed: ${String(err)}`),
		);
	}

	const shutdown = async (sig: string) => {
		log(`received ${sig}, shutting down`);
		for (const sub of subscriptions.values()) sub.abort.abort();
		for (const cb of pendingClaudeHooks.values()) {
			cb({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'ask',
					permissionDecisionReason: 'workboss server is shutting down',
				},
			});
		}
		pendingClaudeHooks.clear();
		await clearServerInfo();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	await new Promise<void>(() => {});
}
