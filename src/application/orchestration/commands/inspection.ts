import type {WorkerMeta} from '../../../domain/worker.js';
import {FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {getAdapter} from '../agents/index.js';
import type {DiscoveredSession} from '../session-scanner.js';
import {discoverAll} from '../session-scanner.js';
import {shortSid, shortCwd, fmtAge} from '../../../presentation/format.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';

import {ok, fail, loadWorker} from './utils.js';

const workerRepo = new FsWorkerRepository();

async function workerStatusLabel(w: WorkerMeta): Promise<string> {
	const result = await getAdapter(w.agent).checkLiveness(w);
	switch (result.status) {
		case 'up':
			return 'up   ';
		case 'degraded':
			return 'degrad';
		case 'dead':
			return 'dead ';
		case 'idle':
			return 'idle ';
	}
}

export interface ListOptions {
	includeHistory?: boolean;
}

function partitionUnknown(
	all: DiscoveredSession[],
	known: {sids: Set<string>; urls: Set<string>; names: Set<string>},
): {alive: DiscoveredSession[]; history: DiscoveredSession[]} {
	const unknown = all.filter(d => {
		if (d.sessionId && known.sids.has(d.sessionId)) return false;
		if (d.serverUrl && known.urls.has(d.serverUrl)) return false;
		return true;
	});
	return {
		alive: unknown.filter(d => d.alive),
		history: unknown.filter(d => !d.alive),
	};
}

export async function listWorkersCmd(opts: ListOptions = {}): Promise<void> {
	const workers = await workerRepo.list();
	let history: DiscoveredSession[] = [];
	if (opts.includeHistory) {
		const known = {
			sids: new Set<string>(
				workers.map((w: WorkerMeta) => w.sessionId).filter((s): s is string => !!s),
			),
			urls: new Set<string>(
				workers
					.map((w: WorkerMeta) => w.process?.serve?.serverUrl)
					.filter((u): u is string => !!u),
			),
			names: new Set<string>(),
		};
		history = partitionUnknown(await discoverAll(), known).history;
	}

	if (workers.length === 0 && history.length === 0) {
		ok('(no workers on this machine)');
		return;
	}

	for (const w of workers) {
		const label = await workerStatusLabel(w);
		const sid = shortSid(w.sessionId).padEnd(15);
		const where = w.process?.serve?.serverUrl ?? w.cwd;
		ok(
			`${label}  ${w.name.padEnd(20)}  ${w.agent.padEnd(8)}  ${sid}  ${where}`,
		);
	}
	if (opts.includeHistory) {
		for (const d of history.slice(0, 50)) {
			const title = d.title ? ` "${d.title.slice(0, 30)}"` : '';
			ok(
				`${fmtAge(d.lastActivity).padEnd(8)}  ${'(history)'.padEnd(20)}  ${d.agent.padEnd(8)}  ${shortSid(d.sessionId).padEnd(15)}  ${shortCwd(d.cwd, 35)}${title}`,
			);
		}
		if (history.length > 50) {
			ok(`... 还有 ${history.length - 50} 条`);
		}
	}

	if (!(await rpcCall({kind: 'ping'})).ok) {
		ok('');
		ok('(workboss server 没在跑；新 worker 不会被自动收编)');
	}
}

export async function showWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	ok(JSON.stringify(meta, null, 2));
}

export async function tailWorker(name: string, n: number): Promise<void> {
	const meta = await loadWorker(name);
	try {
		ok(await getAdapter(meta.agent).tail({meta, n}));
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}
