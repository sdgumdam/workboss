import {promises as fs, existsSync, mkdirSync} from 'fs';
import {
	APPROVALS_DIR,
	WORKBOSS_ROOT,
	WORKERS_DIR,
	workerDir,
	workerMetaPath,
} from './paths.js';
import type {WorkerMeta, WorkerRepository} from '../../domain/worker.js';

export function ensureRoot(): void {
	for (const d of [WORKBOSS_ROOT, WORKERS_DIR, APPROVALS_DIR]) {
		if (!existsSync(d)) mkdirSync(d, {recursive: true, mode: 0o700});
	}
}

export class FsWorkerRepository implements WorkerRepository {
	async list(): Promise<WorkerMeta[]> {
		ensureRoot();
		let entries: string[];
		try {
			entries = await fs.readdir(WORKERS_DIR);
		} catch {
			return [];
		}
		const out: WorkerMeta[] = [];
		for (const name of entries) {
			const meta = await this.read(name).catch(() => null);
			if (meta) out.push(meta);
		}
		out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return out;
	}

	async read(name: string): Promise<WorkerMeta> {
		const raw = await fs.readFile(workerMetaPath(name), 'utf8');
		return JSON.parse(raw) as WorkerMeta;
	}

	async write(meta: WorkerMeta): Promise<void> {
		ensureRoot();
		const dir = workerDir(meta.name);
		if (!existsSync(dir)) mkdirSync(dir, {recursive: true, mode: 0o700});
		await fs.writeFile(
			workerMetaPath(meta.name),
			JSON.stringify(meta, null, 2) + '\n',
			'utf8',
		);
	}

	async update(
		name: string,
		patch: (meta: WorkerMeta) => WorkerMeta | Promise<WorkerMeta>,
	): Promise<WorkerMeta | null> {
		let meta: WorkerMeta;
		try {
			meta = await this.read(name);
		} catch {
			return null;
		}
		const next = await patch(meta);
		await this.write(next);
		return next;
	}

	async delete(name: string): Promise<void> {
		const dir = workerDir(name);
		if (!existsSync(dir)) return;
		await fs.rm(dir, {recursive: true, force: true});
	}
}
