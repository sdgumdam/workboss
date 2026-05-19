import {existsSync} from 'fs';
import path from 'path';

import type {AgentKind, WorkerMeta} from '../../../domain/worker.js';
import {createWorkerMeta} from '../../../domain/worker.js';
import {ensureRoot, FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {isProcessAlive} from '../../../infrastructure/process/process.js';
import {workbossSessionExists, killWorkerWindow, selectWindow, createWorkerWindow} from '../../../infrastructure/tmux/tmux.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';
import {getAdapter} from '../agents/index.js';

import {ok, fail, loadWorker, ensureServerUp, createWorkerScaffold, notifyAggregator} from './utils.js';

const workerRepo = new FsWorkerRepository();

export interface RegisterArgs {
	name: string;
	agent: AgentKind;
	cwd: string;
	sessionId: string;
	serverUrl?: string;
}

function processFromUrl(url: string): WorkerMeta['process'] | undefined {
	if (!url) return undefined;
	const startedAt = new Date().toISOString();
	try {
		const u = new URL(url);
		const port = parseInt(u.port, 10);
		return {
			serve: {
				serverUrl: url,
				serverPort: Number.isFinite(port) ? port : undefined,
				startedAt,
			},
		};
	} catch {
		return {serve: {serverUrl: url, startedAt}};
	}
}

async function gracefulKill(pid: number, graceMs = 2000): Promise<void> {
	if (!isProcessAlive(pid)) return;
	try {
		process.kill(pid, 'SIGTERM');
		ok(`sent SIGTERM to pid=${pid}`);
	} catch {
		return;
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && isProcessAlive(pid)) {
		await new Promise(r => setTimeout(r, 100));
	}
	if (isProcessAlive(pid)) {
		try {
			process.kill(pid, 'SIGKILL');
			ok(`escalated to SIGKILL`);
		} catch {
			/* ignore */
		}
	}
}

async function respawnOpenCodeServe(
	name: string,
	meta: WorkerMeta,
): Promise<string | undefined> {
	if (!meta.sessionId) return undefined;
	const adapter = getAdapter('opencode');
	const result = await adapter.spawnNew({
		workerName: name,
		cwdAbs: meta.cwd,
		missionBody: '',
		workbossServerUrl: (await ensureServerUp()),
	});
	await workerRepo.update(name, (m: WorkerMeta) => ({...m, process: {serve: result.process}}));
	await notifyAggregator(name);
	if (result.process?.serverUrl && meta.sessionId) {
		return `opencode attach ${result.process.serverUrl} --session ${meta.sessionId}`;
	}
	return undefined;
}

export async function registerWorker(args: RegisterArgs): Promise<void> {
	ensureRoot();
	const adapter = getAdapter(args.agent);
	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);
	const workbossServerUrl = await ensureServerUp();

	await createWorkerScaffold(
		args.name,
		`Registered from existing ${args.agent} session ${args.sessionId} at ${cwdAbs}.`,
	);
	await adapter.prepareCwd({
		workerName: args.name,
		cwdAbs,
		workbossServerUrl,
	});

	await workerRepo.write(createWorkerMeta({
		name: args.name,
		agent: args.agent,
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		sessionId: args.sessionId,
		process: args.serverUrl ? processFromUrl(args.serverUrl) : undefined,
		notes: 'registered',
	}));
	await notifyAggregator(args.name);

	ok(`registered "${args.name}"`);
	ok(`  agent      : ${args.agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  session id : ${args.sessionId}`);
	if (args.serverUrl) ok(`  server     : ${args.serverUrl}`);
}

export async function attachWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	if (await workbossSessionExists()) {
		try {
			await selectWindow(name);
			ok(`switched to window "${name}"`);
			return;
		} catch {
			// Window was killed by detach — recreate it.
		}

		let tuiCmd: string | undefined;
		if (meta.agent === 'opencode') {
			const url = meta.process?.serve?.serverUrl;
			if (url && meta.sessionId) {
				tuiCmd = `opencode attach ${url} --session ${meta.sessionId}`;
			}
			if (!tuiCmd) {
				tuiCmd = await respawnOpenCodeServe(name, meta);
			}
		} else if (meta.agent === 'claude') {
			tuiCmd = meta.sessionId
				? `claude --resume ${meta.sessionId}`
				: 'claude';
		}

		if (tuiCmd) {
			await createWorkerWindow(name, tuiCmd, meta.cwd);
			await workerRepo.update(name, (m: WorkerMeta) => ({
				...m,
				process: {
					...m.process,
					tui: {tmuxWindow: name, startedAt: new Date().toISOString()},
				},
			}));
			ok(`restored tmux window "${name}" with TUI`);
			return;
		}
	}
	for (const line of getAdapter(meta.agent).attachHint(meta)) ok(line);
}

export async function detachWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	await rpcCall({kind: 'workers.detach', name});
	if (await workbossSessionExists()) {
		await killWorkerWindow(name);
	}
	if (meta.process?.serve?.pid) await gracefulKill(meta.process.serve.pid);
	await workerRepo.update(name, (m: WorkerMeta) => {
		const {process: _omit, ...rest} = m;
		return rest;
	});
	ok(
		`detached "${name}" (session ${meta.sessionId ?? '?'} preserved; resume with \`workboss attach ${name}\`)`,
	);
}

export async function removeWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	if (meta.process?.serve?.pid && isProcessAlive(meta.process.serve.pid)) {
		await detachWorker(name);
	} else {
		await rpcCall({kind: 'workers.detach', name});
	}
	await workerRepo.delete(name);
	ok(`removed worker "${name}" (session data on disk is untouched)`);
}
