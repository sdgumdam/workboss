import {existsSync} from 'fs';
import {promises as fs} from 'fs';

import type {WorkerMeta} from '../../../domain/worker.js';
import {FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {getServerUrl} from '../../../infrastructure/filesystem/paths.js';
import {workerDir, workerInboxPath, workerMissionPath} from '../../../infrastructure/filesystem/paths.js';
import {renderMissionFile} from '../../../presentation/templates/templates.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';

import {serverStart} from './server.js';

const workerRepo = new FsWorkerRepository();

export function fail(msg: string): never {
	console.error(`workboss: ${msg}`);
	process.exit(1);
}

export function ok(msg: string): void {
	console.log(msg);
}

export async function loadWorker(name: string): Promise<WorkerMeta> {
	try {
		return await workerRepo.read(name);
	} catch {
		fail(`worker "${name}" not found`);
	}
}

export async function ensureServerUp(): Promise<string> {
	const r = await rpcCall({kind: 'ping'});
	if (r.ok) return getServerUrl();
	await serverStart();
	const after = await rpcCall({kind: 'ping'});
	if (!after.ok) fail('failed to auto-start workboss server');
	return getServerUrl();
}

export async function createWorkerScaffold(
	name: string,
	missionBody: string,
): Promise<void> {
	const dir = workerDir(name);
	if (existsSync(dir)) fail(`worker "${name}" already exists at ${dir}`);
	await fs.mkdir(dir, {recursive: true, mode: 0o700});
	await fs.writeFile(
		workerMissionPath(name),
		renderMissionFile({title: name, body: missionBody}),
		'utf8',
	);
	await fs.writeFile(workerInboxPath(name), '', 'utf8');
}

export async function notifyAggregator(name: string): Promise<void> {
	const r = await rpcCall({kind: 'workers.attach', name});
	if (!r.ok) console.warn(`workboss: aggregator could not attach: ${r.error}`);
}
