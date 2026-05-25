import {execFile} from 'child_process';
import {promisify} from 'util';
import type {WorkerMeta} from '../../domain/worker.js';
import {createLogger} from '../../infrastructure/logging/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('orphan-cleaner');

interface RunningServe {
	pid: number;
	port?: number;
	cmd: string;
}

async function findOrphanServes(): Promise<RunningServe[]> {
	let stdout: string;
	try {
		const r = await execFileAsync('ps', ['-eo', 'pid=,ppid=,args='], {
			maxBuffer: 8 * 1024 * 1024,
		});
		stdout = r.stdout;
	} catch {
		return [];
	}

	const out: RunningServe[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trimStart();
		if (!trimmed) continue;

		const parts = trimmed.split(/\s+/);
		if (parts.length < 3) continue;

		const pidStr = parts[0];
		const ppidStr = parts[1];
		if (!pidStr || !ppidStr) continue;
		const pid = parseInt(pidStr, 10);
		const ppid = parseInt(ppidStr, 10);
		const args = parts.slice(2).join(' ');

		if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
		if (ppid !== 1) continue;

		if (!/\bopencode\s+serve\b/.test(args)) continue;

		const portMatch = args.match(/--port\s+(\d+)/);
		const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : undefined;
		out.push({
			pid,
			port,
			cmd: args,
		});
	}
	return out;
}

export async function reconcileOrphans(
	knownWorkers: WorkerMeta[],
): Promise<number> {
	const orphans = await findOrphanServes();
	if (orphans.length === 0) return 0;

	const knownPids = new Set(
		knownWorkers
			.map(w => w.process?.serve?.pid)
			.filter((p): p is number => Number.isFinite(p)),
	);

	const knownPorts = new Set(
		knownWorkers
			.map(w => w.process?.serve?.serverPort)
			.filter((p): p is number => Number.isFinite(p)),
	);

	let killed = 0;
	for (const orphan of orphans) {
		if (knownPids.has(orphan.pid)) continue;
		if (orphan.port !== undefined && knownPorts.has(orphan.port)) continue;

		if (!orphan.port) continue;
		try {
			process.kill(orphan.pid, 'SIGKILL');
			logger.info(`killed orphan serve pid=${orphan.pid} ${orphan.cmd}`);
			killed++;
		} catch {
			logger.info(`failed to kill orphan pid=${orphan.pid}: already gone`);
		}
	}

	if (killed > 0) {
		logger.info(`reconcileOrphans: killed ${killed} orphan serve processes`);
	}
	return killed;
}
