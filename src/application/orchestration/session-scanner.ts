import {execFile} from 'child_process';
import {promisify} from 'util';

import {listAdapters} from './agents/index.js';
import type {ClassifiedProcess, DiscoveredSession} from './agents/types.js';

const execFileAsync = promisify(execFile);

export type {DiscoveredSession};

async function lsofCwd(pid: number): Promise<string | undefined> {
	try {
		const {stdout} = await execFileAsync('lsof', [
			'-a',
			'-p',
			String(pid),
			'-d',
			'cwd',
			'-Fn',
		]);
		for (const line of stdout.split('\n')) {
			if (line.startsWith('n')) return line.slice(1);
		}
	} catch {
	}
	return undefined;
}

async function hasNetworkConnection(pid: number): Promise<boolean> {
	try {
		const {stdout} = await execFileAsync('lsof', [
			'-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED', '-P', '-n',
		]);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

async function isOrphan(pid: number): Promise<boolean> {
	try {
		const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=']);
		return stdout.trim() === '1';
	} catch {
		return true;
	}
}

function classifyLine(line: string): ClassifiedProcess | null {
	for (const adapter of listAdapters()) {
		const hit = adapter.classifyPsLine(line);
		if (hit) return hit;
	}
	return null;
}

export async function findAliveAgents(): Promise<DiscoveredSession[]> {
	let stdout: string;
	try {
		const r = await execFileAsync('ps', ['-eo', 'pid=,args='], {
			maxBuffer: 8 * 1024 * 1024,
		});
		stdout = r.stdout;
	} catch {
		return [];
	}

	const out: DiscoveredSession[] = [];
	const seen = new Set<string>();
	for (const line of stdout.split('\n')) {
		const hit = classifyLine(line);
		if (!hit) continue;

		if (hit.isAttachClient) continue;

		if (hit.agent === 'opencode' && hit.port === undefined) {
			const [orphan, connected] = await Promise.all([
				isOrphan(hit.pid),
				hasNetworkConnection(hit.pid),
			]);
			if (orphan && !connected) {
				try { process.kill(hit.pid, 'SIGTERM'); } catch {}
				continue;
			}
		}

		const cwd = await lsofCwd(hit.pid);
		const adapter = listAdapters().find(a => a.kind === hit.agent);
		if (!adapter) continue;

		const session = await adapter.enrichAliveSession(hit, cwd ?? '');
		const key = session.sessionId ? `${session.agent}:${session.sessionId}` : `pid:${session.pid}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(session);
	}
	return out;
}

export async function findHistoricalSessions(): Promise<DiscoveredSession[]> {
	const results = await Promise.all(
		listAdapters().map(a => a.findHistoricalSessions()),
	);
	return results.flat();
}

export async function discoverAll(): Promise<DiscoveredSession[]> {
	const [alive, historical] = await Promise.all([
		findAliveAgents(),
		findHistoricalSessions(),
	]);

	const aliveSids = new Set(
		alive.map(a => a.sessionId).filter((s): s is string => !!s),
	);
	const dedupedHistory = historical.filter(
		h => !h.sessionId || !aliveSids.has(h.sessionId),
	);

	const out = [...alive, ...dedupedHistory];
	out.sort((a, b) => {
		if (a.alive !== b.alive) return a.alive ? -1 : 1;
		const at = a.lastActivity?.getTime() ?? 0;
		const bt = b.lastActivity?.getTime() ?? 0;
		return bt - at;
	});
	return out;
}
