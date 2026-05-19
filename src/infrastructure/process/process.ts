import {execFile} from 'child_process';
import {promisify} from 'util';
import type {AgentKind} from '../../domain/worker.js';

const execFileAsync = promisify(execFile);

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function isProcessStillOurs(
	pid: number,
	agent: AgentKind,
): Promise<boolean> {
	try {
		const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		const cmd = stdout.trim();
		if (!cmd) return false;
		if (agent === 'opencode') {
			return /\bopencode\b/.test(cmd);
		}
		return /\bclaude\b/.test(cmd);
	} catch {
		return false;
	}
}
