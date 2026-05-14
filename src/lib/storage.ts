import {promises as fs, existsSync, mkdirSync} from 'fs';
import path from 'path';
import {
	APPROVALS_DIR,
	SERVER_PID_FILE,
	SERVER_PORT_FILE,
	WORKBOSS_ROOT,
	WORKERS_DIR,
	approvalPath,
	workerDir,
	workerMetaPath,
} from './paths.js';
import type {PendingApproval, WorkerMeta} from './types.js';

export function ensureRoot(): void {
	for (const d of [WORKBOSS_ROOT, WORKERS_DIR, APPROVALS_DIR]) {
		if (!existsSync(d)) mkdirSync(d, {recursive: true, mode: 0o700});
	}
}

export async function listWorkers(): Promise<WorkerMeta[]> {
	ensureRoot();
	let entries: string[];
	try {
		entries = await fs.readdir(WORKERS_DIR);
	} catch {
		return [];
	}
	const out: WorkerMeta[] = [];
	for (const name of entries) {
		const meta = await readWorkerMeta(name).catch(() => null);
		if (meta) out.push(meta);
	}
	out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return out;
}

export async function readWorkerMeta(name: string): Promise<WorkerMeta> {
	const raw = await fs.readFile(workerMetaPath(name), 'utf8');
	return JSON.parse(raw) as WorkerMeta;
}

export async function writeWorkerMeta(meta: WorkerMeta): Promise<void> {
	ensureRoot();
	const dir = workerDir(meta.name);
	if (!existsSync(dir)) mkdirSync(dir, {recursive: true, mode: 0o700});
	await fs.writeFile(
		workerMetaPath(meta.name),
		JSON.stringify(meta, null, 2) + '\n',
		'utf8',
	);
}

export async function deleteWorker(name: string): Promise<void> {
	const dir = workerDir(name);
	if (!existsSync(dir)) return;
	await fs.rm(dir, {recursive: true, force: true});
}

export async function listPendingApprovals(): Promise<PendingApproval[]> {
	ensureRoot();
	let files: string[];
	try {
		files = await fs.readdir(APPROVALS_DIR);
	} catch {
		return [];
	}
	const out: PendingApproval[] = [];
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		try {
			const raw = await fs.readFile(path.join(APPROVALS_DIR, f), 'utf8');
			out.push(JSON.parse(raw) as PendingApproval);
		} catch {
			/* skip */
		}
	}
	out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
	return out;
}

export async function writeApproval(a: PendingApproval): Promise<void> {
	ensureRoot();
	await fs.writeFile(
		approvalPath(a.id),
		JSON.stringify(a, null, 2) + '\n',
		'utf8',
	);
}

export async function deleteApproval(id: string): Promise<void> {
	try {
		await fs.unlink(approvalPath(id));
	} catch {
		/* already gone */
	}
}

export async function readServerPid(): Promise<number | null> {
	try {
		const raw = await fs.readFile(SERVER_PID_FILE, 'utf8');
		const pid = parseInt(raw.trim(), 10);
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null;
	}
}

export async function readServerPort(): Promise<number | null> {
	try {
		const raw = await fs.readFile(SERVER_PORT_FILE, 'utf8');
		const port = parseInt(raw.trim(), 10);
		return Number.isFinite(port) ? port : null;
	} catch {
		return null;
	}
}

export async function writeServerInfo(
	pid: number,
	port: number,
): Promise<void> {
	ensureRoot();
	await fs.writeFile(SERVER_PID_FILE, String(pid), 'utf8');
	await fs.writeFile(SERVER_PORT_FILE, String(port), 'utf8');
}

export async function clearServerInfo(): Promise<void> {
	for (const f of [SERVER_PID_FILE, SERVER_PORT_FILE]) {
		try {
			await fs.unlink(f);
		} catch {
			/* ignore */
		}
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
