import {existsSync} from 'fs';
import {promises as fs} from 'fs';
import path from 'path';

import type {AgentKind} from '../../../domain/worker.js';
import {createWorkerMeta} from '../../../domain/worker.js';
import {ensureRoot, FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {workbossSessionExists, createWorkerWindow} from '../../../infrastructure/tmux/tmux.js';
import {getAdapter} from '../agents/index.js';

import {ok, fail, ensureServerUp, createWorkerScaffold, notifyAggregator} from './utils.js';

const workerRepo = new FsWorkerRepository();

export interface SpawnArgs {
	name: string;
	missionFile?: string;
	missionInline?: string;
	cwd: string;
	agent?: AgentKind;
	port?: number;
}

async function resolveMissionBody(args: {
	missionFile?: string;
	missionInline?: string;
}): Promise<string> {
	if (args.missionFile) return fs.readFile(args.missionFile, 'utf8');
	if (args.missionInline) return args.missionInline;
	fail('missing --mission <file> or --task "..."');
}

export async function spawnWorker(args: SpawnArgs): Promise<void> {
	ensureRoot();
	const agent = args.agent ?? 'opencode';
	const adapter = getAdapter(agent);
	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);

	const workbossServerUrl = await ensureServerUp();
	const missionBody = await resolveMissionBody(args);
	await createWorkerScaffold(args.name, missionBody);

	const createdAt = new Date().toISOString();
	await workerRepo.write(createWorkerMeta({name: args.name, agent, cwd: cwdAbs, createdAt}));

	const result = await adapter.spawnNew({
		workerName: args.name,
		cwdAbs,
		missionBody,
		workbossServerUrl,
		preferredPort: args.port,
	});
	const inWorkbossTmux = await workbossSessionExists();
	const tui: {tmuxWindow?: string; startedAt?: string} | undefined = inWorkbossTmux && result.tuiCommand
		? {tmuxWindow: args.name, startedAt: new Date().toISOString()}
		: undefined;
	await workerRepo.write(createWorkerMeta({
		name: args.name,
		agent,
		cwd: cwdAbs,
		createdAt,
		sessionId: result.sessionId,
		process: result.process ? {serve: result.process, tui} : tui ? {tui} : undefined,
	}));
	await notifyAggregator(args.name);

	if (inWorkbossTmux && result.tuiCommand) {
		await createWorkerWindow(args.name, result.tuiCommand, cwdAbs);
	}

	ok(`worker "${args.name}" ${result.process?.pid ? 'up' : 'registered'}`);
	ok(`  agent      : ${agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	if (inWorkbossTmux && result.tuiCommand) {
		ok(`  TUI window : ${args.name} (click tab or Ctrl+B n to view)`);
	} else {
		for (const line of result.postSpawnHint) ok(line);
	}
}
