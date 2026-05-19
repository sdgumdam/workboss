import {spawn} from 'child_process';
import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import {isProcessAlive} from '../../../infrastructure/process/process.js';
import {readServerPid, readServerPort} from '../../../infrastructure/filesystem/approval-repo.js';
import {ensureRoot} from '../../../infrastructure/filesystem/worker-repo.js';
import {SERVER_LOG_FILE} from '../../../infrastructure/filesystem/paths.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';

import {ok, fail} from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function serverStart(): Promise<void> {
	ensureRoot();
	const existingPid = await readServerPid();
	if (existingPid && isProcessAlive(existingPid)) {
		ok(`workboss server already running, pid=${existingPid}`);
		return;
	}
	const serverEntry = path.join(__dirname, '..', '..', '..', 'server-entry.js');
	const out = await fs.open(SERVER_LOG_FILE, 'a');
	const child = spawn(process.execPath, [serverEntry], {
		detached: true,
		stdio: ['ignore', out.fd, out.fd],
	});
	child.unref();
	out.close().catch(() => {});

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const port = await readServerPort();
		const pid = await readServerPid();
		if (port && pid && isProcessAlive(pid)) {
			ok(`workboss server started, pid=${pid}, http=127.0.0.1:${port}`);
			return;
		}
		await new Promise(r => setTimeout(r, 100));
	}
	fail(`server did not come up within 5s. See ${SERVER_LOG_FILE}`);
}

export async function serverStop(): Promise<void> {
	const pid = await readServerPid();
	if (!pid || !isProcessAlive(pid)) {
		ok('workboss server is not running');
		return;
	}
	process.kill(pid, 'SIGTERM');
	ok(`sent SIGTERM to workboss server, pid=${pid}`);
}

export async function serverRestart(): Promise<void> {
	await serverStop();
	const oldPid = await readServerPid();
	const deadline = Date.now() + 3000;
	while (oldPid && Date.now() < deadline && isProcessAlive(oldPid)) {
		await new Promise(r => setTimeout(r, 100));
	}
	await serverStart();
}

export async function serverStatus(): Promise<void> {
	const pid = await readServerPid();
	const port = await readServerPort();
	if (!pid || !isProcessAlive(pid)) {
		ok('workboss server not running');
		return;
	}
	ok(`workboss server running, pid=${pid}, http port=${port ?? '?'}`);
	const r = await rpcCall({kind: 'ping'});
	if (r.ok && r.data && typeof r.data === 'object') {
		const d = r.data as {pid: number; workers: number};
		ok(`  attached workers: ${d.workers}`);
	}
}
