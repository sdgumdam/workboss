import {Daemon} from './daemon.js';
import {FsWorkerRepository} from '../../infrastructure/filesystem/worker-repo.js';
import {FsApprovalRepository} from '../../infrastructure/filesystem/approval-repo.js';
import {WorkerPatrol} from './worker-patrol.js';
import {LivenessWatcher} from './liveness-watcher.js';
import {getAdapter} from '../orchestration/agents/index.js';
import {ensureRoot} from '../../infrastructure/filesystem/worker-repo.js';
import type {AgentKind} from '../../domain/worker.js';

async function main(): Promise<void> {
	ensureRoot();
	const workerRepo = new FsWorkerRepository();
	const approvalRepo = new FsApprovalRepository();
	const livenessWatcher = new LivenessWatcher(workerRepo, (kind: string) => getAdapter(kind as AgentKind));
	const patrol = new WorkerPatrol(workerRepo, livenessWatcher);
	const daemon = new Daemon(workerRepo, approvalRepo, patrol, livenessWatcher);
	await daemon.run();
}

main().catch(err => {
	console.error('workboss server crashed:', err);
	process.exit(1);
});
