import {execFile} from 'child_process';
import {promisify} from 'util';
import {getServerUrl, LAUNCHD_LABEL, LAUNCHD_PLIST_PATH} from '../../../infrastructure/filesystem/paths.js';
import {ensureRoot} from '../../../infrastructure/filesystem/worker-repo.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';
import {ensurePlist} from '../../../infrastructure/launchd/plist.js';

import {ok, fail} from './utils.js';

const execFileAsync = promisify(execFile);

async function launchctl(...args: string[]): Promise<{stdout: string; stderr: string}> {
	return execFileAsync('launchctl', args);
}

async function isDaemonLoaded(): Promise<boolean> {
	try {
		const {stdout} = await launchctl('list');
		return stdout.includes(LAUNCHD_LABEL);
	} catch {
		return false;
	}
}

async function pingDaemon(): Promise<{alive: boolean; pid?: number; workers?: number}> {
	const r = await rpcCall({kind: 'ping'});
	if (r.ok && r.data && typeof r.data === 'object') {
		const d = r.data as {pid: number; workers: number};
		return {alive: true, pid: d.pid, workers: d.workers};
	}
	return {alive: false};
}

export async function serverStart(): Promise<void> {
	ensureRoot();
	const ping = await pingDaemon();
	if (ping.alive) {
		ok(`workboss server already running, pid=${ping.pid}`);
		return;
	}

	await ensurePlist();

	const loaded = await isDaemonLoaded();
	if (!loaded) {
		await launchctl('load', '-w', LAUNCHD_PLIST_PATH);
	}

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const check = await pingDaemon();
		if (check.alive) {
			ok(`workboss server started, pid=${check.pid}, http=${getServerUrl()}`);
			return;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	fail(`server did not come up within 5s. Check launchctl list ${LAUNCHD_LABEL}`);
}

export async function serverStop(): Promise<void> {
	const loaded = await isDaemonLoaded();
	if (loaded) {
		await launchctl('unload', LAUNCHD_PLIST_PATH);
		ok('workboss server stopped (launchd job unloaded)');
		return;
	}
	const ping = await pingDaemon();
	if (!ping.alive) {
		ok('workboss server is not running');
		return;
	}
	ok('workboss server is not running (launchd job not loaded)');
}

export async function serverRestart(): Promise<void> {
	await serverStop();
	await new Promise(r => setTimeout(r, 500));
	await serverStart();
}

export async function serverStatus(): Promise<void> {
	const ping = await pingDaemon();
	if (!ping.alive) {
		ok('workboss server not running');
		return;
	}
	ok(`workboss server running, pid=${ping.pid}, http=${getServerUrl()}`);
	if (ping.workers !== undefined) {
		ok(`  attached workers: ${ping.workers}`);
	}
}

export {pingDaemon};
