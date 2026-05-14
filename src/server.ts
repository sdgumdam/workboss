/**
 * The workboss aggregator daemon.
 *
 * One Node HTTP server, two surfaces:
 *
 *   POST /rpc                       control-plane requests from the workboss
 *                                   CLI (the orchestrator's Bash tool).
 *
 *   POST /claude-hook/:worker       PreToolUse HTTP hook callback from a
 *                                   Claude Code worker. The request is held
 *                                   open while the approval sits in the
 *                                   queue; whoever replies (orchestrator or
 *                                   human) writes the response body.
 *
 * Per-worker behaviour (how to subscribe, how to deliver replies, etc.) is
 * delegated to an AgentAdapter under `lib/agents/`. This file is just the
 * generic orchestrator: it routes events through the right adapter without
 * branching on agent type.
 */

import http from 'http';
import type {AddressInfo} from 'net';
import path from 'path';
import {
	clearServerInfo,
	deleteApproval,
	listPendingApprovals,
	listWorkers,
	updateWorkerMeta,
	writeApproval,
	writeServerInfo,
	writeWorkerMeta,
} from './lib/storage.js';
import {matchHardDeny} from './lib/deny-patterns.js';
import type {PendingApproval, WorkerMeta} from './lib/types.js';
import type {RpcRequest, RpcResponse} from './lib/server-rpc.js';
import {
	classifyToolName,
	extractPatterns,
	type ClaudePreToolUseRequest,
} from './lib/claude-config.js';
import {claudeAdapter, getAdapter} from './lib/agents/index.js';
import {discoverAll, type DiscoveredSession} from './lib/discovery.js';
import {pickUniqueName} from './lib/format.js';

// ---------- worker registry ----------

interface Registration {
	meta: WorkerMeta;
	abort: AbortController;
}

const registry = new Map<string, Registration>();

function log(...args: unknown[]): void {
	const ts = new Date().toISOString();
	console.log(`[${ts}]`, ...args);
}

async function registerForEvents(meta: WorkerMeta): Promise<void> {
	if (registry.has(meta.name)) return;
	const abort = new AbortController();
	registry.set(meta.name, {meta, abort});
	const adapter = getAdapter(meta.agent);
	adapter.subscribe?.({
		meta,
		abort: abort.signal,
		onApproval: writeApproval,
		onResolved: deleteApproval,
		onSessionIdLearned: async sid => {
			await updateWorkerMeta(meta.name, m => ({...m, sessionId: sid}));
			const r = registry.get(meta.name);
			if (r) r.meta.sessionId = sid;
		},
		log,
	});
}

function unregister(name: string): void {
	const r = registry.get(name);
	if (!r) return;
	r.abort.abort();
	registry.delete(name);
	log(`worker ${name}: unregistered`);
}

// ---------- reply forwarding ----------

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

	// Server-side hard-deny enforcement: no caller (orchestrator or human)
	// can approve operations on this list. Force-reject and short-circuit.
	if (req.reply !== 'reject') {
		const hit = matchHardDeny(target.permission, target.patterns);
		if (hit) {
			log(
				`HARD DENY ${target.worker}/${target.id}: ${hit.reason} (${JSON.stringify(target.patterns)})`,
			);
			await deliverThrough(target, 'reject', `workboss policy: ${hit.reason}`);
			return {ok: false, error: `forbidden by workboss policy: ${hit.reason}`};
		}
	}

	try {
		await deliverThrough(target, req.reply, req.message);
		log(`replied ${target.worker}/${target.id} ${req.reply}`);
		return {ok: true};
	} catch (err) {
		return {ok: false, error: `forward reply failed: ${String(err)}`};
	}
}

async function deliverThrough(
	target: PendingApproval,
	reply: 'once' | 'always' | 'reject',
	message: string | undefined,
): Promise<void> {
	const reg = registry.get(target.worker);
	if (!reg) throw new Error(`worker ${target.worker} not registered`);
	await getAdapter(reg.meta.agent).deliverReply({
		meta: reg.meta,
		approval: target,
		reply,
		message,
	});
	await deleteApproval(target.id);
}

// ---------- RPC handlers ----------

async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
	switch (req.kind) {
		case 'ping':
			return {ok: true, data: {pid: process.pid, workers: registry.size}};
		case 'approvals.list':
			return {ok: true, data: await listPendingApprovals()};
		case 'approvals.reply':
			return forwardReply(req);
		case 'workers.attach': {
			const all = await listWorkers();
			const meta = all.find(w => w.name === req.name);
			if (!meta) return {ok: false, error: `worker ${req.name} not found`};
			await registerForEvents(meta);
			return {ok: true};
		}
		case 'workers.detach':
			unregister(req.name);
			return {ok: true};
	}
}

// ---------- HTTP plumbing ----------

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

function sendClaudeHookDecision(
	res: http.ServerResponse,
	decision: 'allow' | 'deny' | 'ask',
	reason: string,
): void {
	sendJson(res, 200, {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: decision,
			...(reason ? {permissionDecisionReason: reason} : {}),
		},
	});
}

async function handleClaudeHook(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	workerName: string,
): Promise<void> {
	const reg = registry.get(workerName);
	if (!reg) {
		log(`claude hook from unknown worker "${workerName}", returning ask`);
		sendClaudeHookDecision(res, 'ask', `workboss does not know worker "${workerName}"`);
		return;
	}
	if (reg.meta.agent !== 'claude') {
		sendClaudeHookDecision(
			res,
			'ask',
			`worker "${workerName}" is not registered as a claude worker`,
		);
		return;
	}

	let body: ClaudePreToolUseRequest;
	try {
		body = await readJson<ClaudePreToolUseRequest>(req);
	} catch (err) {
		sendJson(res, 400, {error: `bad json: ${String(err)}`});
		return;
	}

	// First sighting of session_id for this worker — bind it to the meta.
	if (body.session_id && !reg.meta.sessionId) {
		await updateWorkerMeta(workerName, m => ({...m, sessionId: body.session_id}));
		reg.meta.sessionId = body.session_id;
		log(`${workerName}: learned session_id=${body.session_id}`);
	}

	const permission = classifyToolName(body.tool_name);
	const patterns = extractPatterns(body.tool_name, body.tool_input);

	// Hard-deny check up front: skip the queue entirely.
	const hit = matchHardDeny(permission, patterns);
	if (hit) {
		log(
			`HARD DENY (inline) ${workerName} ${body.tool_name}: ${hit.reason} (${JSON.stringify(patterns)})`,
		);
		sendClaudeHookDecision(res, 'deny', `workboss policy: ${hit.reason}`);
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

	// Hold the request open until someone replies; the adapter owns the
	// callback state.
	let settled = false;
	claudeAdapter.registerHookResponder(approvalId, response => {
		if (settled) return;
		settled = true;
		sendJson(res, 200, response);
	});

	res.on('close', () => {
		if (!settled) {
			settled = true;
			claudeAdapter.dropHookResponder(approvalId);
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
						sendJson(res, 200, await handleRpc(body));
					} catch (err) {
						sendJson(res, 500, {ok: false, error: String(err)});
					}
					return;
				}
				if (req.method === 'POST' && url.startsWith('/claude-hook/')) {
					await handleClaudeHook(
						req,
						res,
						decodeURIComponent(url.slice('/claude-hook/'.length)),
					);
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

// ---------- auto adoption of any live worker on this machine ----------

/**
 * Suggest a friendly worker name from a discovered session. Stable across
 * polls so a worker that survives a sweep doesn't get renamed.
 */
function nameForDiscovered(d: DiscoveredSession): string {
	if (d.sessionId) return `auto-${d.sessionId.replace(/^ses_/, '').slice(0, 8)}`;
	if (d.cwd) return `auto-${path.basename(d.cwd).slice(0, 12)}`;
	return `auto-${d.agent}-${d.pid ?? Date.now()}`;
}

async function adoptDiscoveredWorker(
	d: DiscoveredSession,
	workbossUrl: string,
	takenNames: Set<string>,
): Promise<void> {
	if (!d.cwd) return;
	if (!d.sessionId) {
		// We need a session id to make the meta uniquely resumable. claude
		// processes started without --resume don't yet expose theirs; we'll
		// pick them up later when the first PreToolUse hook fires (the hook
		// payload has session_id and the handler updates the meta).
		return;
	}

	const name = pickUniqueName(nameForDiscovered(d), takenNames);
	takenNames.add(name);
	const adapter = getAdapter(d.agent);

	try {
		await adapter.prepareCwd({
			workerName: name,
			cwdAbs: d.cwd,
			workbossServerUrl: workbossUrl,
		});
	} catch (err) {
		log(`adopt ${name}: prepareCwd failed: ${String(err)}`);
		return;
	}

	const startedAt = new Date().toISOString();
	const meta: WorkerMeta = {
		name,
		agent: d.agent,
		cwd: d.cwd,
		createdAt: startedAt,
		sessionId: d.sessionId,
		process: d.serverUrl
			? {pid: d.pid, serverUrl: d.serverUrl, startedAt}
			: d.pid
				? {pid: d.pid, startedAt}
				: undefined,
		notes: 'auto-adopted',
	};
	await writeWorkerMeta(meta);
	await registerForEvents(meta);
	log(`adopted ${name}  ${d.agent}  ${d.sessionId}  ${d.cwd}`);
}

async function sweepForNewWorkers(workbossUrl: string): Promise<void> {
	const known = await listWorkers();
	const knownSids = new Set(
		known.map(w => w.sessionId).filter((s): s is string => !!s),
	);
	const knownUrls = new Set(
		known.map(w => w.process?.serverUrl).filter((u): u is string => !!u),
	);
	const takenNames = new Set(known.map(w => w.name));

	const discovered = await discoverAll();
	for (const d of discovered.filter(x => x.alive)) {
		if (d.sessionId && knownSids.has(d.sessionId)) continue;
		if (d.serverUrl && knownUrls.has(d.serverUrl)) continue;
		await adoptDiscoveredWorker(d, workbossUrl, takenNames);
	}
}

export async function runServer(): Promise<void> {
	const port = await startHttpServer();
	await writeServerInfo(process.pid, port);
	const workbossUrl = `http://127.0.0.1:${port}`;
	log(`workboss server up on ${workbossUrl}, pid=${process.pid}`);

	for (const meta of await listWorkers()) {
		await registerForEvents(meta).catch(err =>
			log(`attach ${meta.name} failed: ${String(err)}`),
		);
	}

	// Sweep once immediately so the very first `workboss list` after start
	// reflects everything alive on this machine, then keep sweeping so newly
	// started workers get adopted without the user having to ask.
	await sweepForNewWorkers(workbossUrl).catch(err =>
		log(`initial sweep failed: ${String(err)}`),
	);
	const sweepInterval = setInterval(() => {
		void sweepForNewWorkers(workbossUrl).catch(err =>
			log(`sweep failed: ${String(err)}`),
		);
	}, 60_000);
	sweepInterval.unref();

	const shutdown = async (sig: string) => {
		log(`received ${sig}, shutting down`);
		for (const r of registry.values()) r.abort.abort();
		claudeAdapter.respondToAllPending({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				permissionDecisionReason: 'workboss server is shutting down',
			},
		});
		await clearServerInfo();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));

	await new Promise<void>(() => {});
}
