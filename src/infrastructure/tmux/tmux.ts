import {execFile} from 'child_process';
import {promisify} from 'util';
import type {TmuxClient} from '../../domain/tmux.js';
import {createLogger} from '../logging/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('tmux');

export const WORKBOSS_SESSION = 'workboss';
export const WORKBOSS_WINDOW = 'boss';
export const LEFT_PANE = `${WORKBOSS_SESSION}:${WORKBOSS_WINDOW}.0`;
export const RIGHT_PANE = `${WORKBOSS_SESSION}:${WORKBOSS_WINDOW}.1`;

async function run(args: string[]): Promise<string> {
	const {stdout} = await execFileAsync('tmux', args);
	return stdout.trim();
}

async function tryRun(args: string[]): Promise<string> {
	try {
		return await run(args);
	} catch {
		return '';
	}
}

export class CliTmuxClient implements TmuxClient {
	async isAvailable(): Promise<boolean> {
		try {
			await execFileAsync('tmux', ['-V']);
			return true;
		} catch {
			return false;
		}
	}

	async isInWorkbossSession(): Promise<boolean> {
		if (!process.env.TMUX) return false;
		const name = await tryRun(['display-message', '-p', '#{session_name}']);
		return name === WORKBOSS_SESSION;
	}

	async sessionExists(): Promise<boolean> {
		try {
			await execFileAsync('tmux', ['has-session', '-t', WORKBOSS_SESSION]);
			return true;
		} catch {
			return false;
		}
	}

	async createSplitLayout(bossCwd: string): Promise<void> {
		await run([
			'new-session', '-d',
			'-s', WORKBOSS_SESSION,
			'-n', WORKBOSS_WINDOW,
			'-c', bossCwd,
		]);
		await run([
			'split-window', '-h',
			'-t', `${WORKBOSS_SESSION}:${WORKBOSS_WINDOW}`,
			'-c', bossCwd,
			'-p', '30',
		]);
		await run(['set', '-t', WORKBOSS_SESSION, 'mouse', 'on']);
		await run(['set', '-t', WORKBOSS_SESSION, 'status-position', 'top']);
		await this.unbindWindowNavKeys();
	}

	async sendKeys(target: string, command: string): Promise<void> {
		await run(['send-keys', '-t', target, command, 'Enter']);
	}

	async killSession(): Promise<void> {
		await tryRun(['kill-session', '-t', WORKBOSS_SESSION]);
	}

	private async unbindWindowNavKeys(): Promise<void> {
		const keys = [
			['-T', 'prefix', 'n'],
			['-T', 'prefix', 'p'],
			['-T', 'prefix', '0'],
			['-T', 'prefix', '1'],
			['-T', 'prefix', '2'],
			['-T', 'prefix', '3'],
			['-T', 'prefix', '4'],
			['-T', 'prefix', '5'],
			['-T', 'prefix', '6'],
			['-T', 'prefix', '7'],
			['-T', 'prefix', '8'],
			['-T', 'prefix', '9'],
			['-T', 'prefix', "'"],
			['-T', 'prefix', 'l'],
			['-T', 'prefix', 'w'],
			['-T', 'prefix', '&'],
			['-T', 'prefix', '.'],
			['-T', 'prefix', ','],
		];
		for (const args of keys) {
			await tryRun(['unbind-key', ...args]);
		}
	}
}

export async function isTmuxAvailable(): Promise<boolean> {
	return new CliTmuxClient().isAvailable();
}

export async function isInWorkbossSession(): Promise<boolean> {
	return new CliTmuxClient().isInWorkbossSession();
}

export async function workbossSessionExists(): Promise<boolean> {
	return new CliTmuxClient().sessionExists();
}

export async function createSession(cwd: string): Promise<void> {
	await run(['new-session', '-d', '-s', WORKBOSS_SESSION, '-n', WORKBOSS_WINDOW, '-c', cwd]);
	await run(['set', '-t', WORKBOSS_SESSION, 'mouse', 'on']);
	await run(['set', '-t', WORKBOSS_SESSION, 'status-position', 'top']);
}

export async function createWorkerWindow(name: string, command: string, cwd: string): Promise<void> {
	await run(['new-window', '-t', WORKBOSS_SESSION, '-n', name, '-c', cwd]);
	await new Promise(r => setTimeout(r, 300));
	await run(['send-keys', '-t', `${WORKBOSS_SESSION}:${name}`, command, 'Enter']);
	await run(['select-window', '-t', `${WORKBOSS_SESSION}:${WORKBOSS_WINDOW}`]);
}

export async function killWorkerWindow(name: string): Promise<void> {
	await tryRun(['kill-window', '-t', `${WORKBOSS_SESSION}:${name}`]);
}

export async function selectWindow(name: string): Promise<void> {
	await run(['select-window', '-t', `${WORKBOSS_SESSION}:${name}`]);
}

export async function sendKeys(target: string, command: string): Promise<void> {
	await run(['send-keys', '-t', target, command, 'Enter']);
}

type BareTUIDetector = (cmd: string) => boolean;

let bareTUIDetector: BareTUIDetector = () => false;

export function registerBareTUIDetector(detector: BareTUIDetector): void {
	bareTUIDetector = detector;
}

function isBareTUI(cmd: string): boolean {
	return bareTUIDetector(cmd);
}

export async function getLeftPaneChildCommand(): Promise<{pid: number; cmd: string} | null> {
	try {
		const {stdout: pidStr} = await execFileAsync('tmux', [
			'display-message', '-t', LEFT_PANE, '-p', '#{pane_pid}',
		]);
		const shellPid = parseInt(pidStr.trim(), 10);
		if (!Number.isFinite(shellPid)) return null;
		const {stdout: children} = await execFileAsync('pgrep', ['-P', String(shellPid)]);
		const childPids = children.trim().split('\n').filter(Boolean);
		if (childPids.length === 0) return null;
		const firstChild = childPids[0];
		if (!firstChild) return null;
		const pid = parseInt(firstChild, 10);
		const {stdout: cmd} = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
		return {pid, cmd: cmd.trim()};
	} catch {
		return null;
	}
}

export async function runInLeftPane(command: string): Promise<void> {
	logger.info('runInLeftPane start', {command});

	const child = await getLeftPaneChildCommand();
	if (child) {
		if (isBareTUI(child.cmd)) {
			logger.info('left pane has bare opencode TUI, sending Ctrl-C for graceful exit', {pid: child.pid});
			await run(['send-keys', '-t', LEFT_PANE, 'C-c']);
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 200));
				const {stdout: cmd} = await execFileAsync('tmux', [
					'display-message', '-t', LEFT_PANE, '-p', '#{pane_current_command}',
				]);
				if (cmd.trim() === 'zsh' || cmd.trim() === 'bash' || cmd.trim() === 'sh') break;
			}
		} else {
			try { process.kill(child.pid, 'SIGKILL'); } catch {}
			logger.info('sent SIGKILL to pane child', {pid: child.pid});
			for (let i = 0; i < 20; i++) {
				await new Promise((r) => setTimeout(r, 100));
				const {stdout: cmd} = await execFileAsync('tmux', [
					'display-message', '-t', LEFT_PANE, '-p', '#{pane_current_command}',
				]);
				if (cmd.trim() === 'zsh' || cmd.trim() === 'bash' || cmd.trim() === 'sh') break;
			}
		}
	}

	logger.info('sending command', {command});
	await run(['send-keys', '-t', LEFT_PANE, command, 'Enter']);
	logger.info('runInLeftPane done');
}
