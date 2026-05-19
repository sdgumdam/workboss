import {promises as fs} from 'fs';
import path from 'path';
import {
	APPROVALS_DIR,
	SERVER_PID_FILE,
	SERVER_PORT_FILE,
	approvalPath,
} from './paths.js';
import {ensureRoot} from './worker-repo.js';
import type {PendingApproval, ApprovalRepository} from '../../domain/approval.js';

export class FsApprovalRepository implements ApprovalRepository {
	async list(): Promise<PendingApproval[]> {
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

	async write(a: PendingApproval): Promise<void> {
		ensureRoot();
		await fs.writeFile(
			approvalPath(a.id),
			JSON.stringify(a, null, 2) + '\n',
			'utf8',
		);
	}

	async delete(id: string): Promise<void> {
		try {
			await fs.unlink(approvalPath(id));
		} catch {
			/* already gone */
		}
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
