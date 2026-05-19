import {FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {CliTmuxClient} from '../../../infrastructure/tmux/tmux.js';
import {serverStop} from './server.js';
import {detachWorker} from './lifecycle.js';
import {ok} from './utils.js';

const workerRepo = new FsWorkerRepository();
const tmux = new CliTmuxClient();

export async function shutdownCmd(): Promise<void> {
	const workers = await workerRepo.list();

	for (const w of workers) {
		try {
			await detachWorker(w.name);
		} catch (e) {
			ok(`shutdown: failed to detach "${w.name}": ${e}`);
		}
	}

	await serverStop();

	if (await tmux.sessionExists()) {
		await tmux.killSession();
	}

	ok('workboss shutdown complete');
}
