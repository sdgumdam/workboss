import {execFile} from 'child_process';
import {promisify} from 'util';
import type {TmuxClient} from '../../domain/tmux.js';

const execFileAsync = promisify(execFile);

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
