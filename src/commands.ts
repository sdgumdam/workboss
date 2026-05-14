import {spawn, spawnSync} from 'child_process';
import {promises as fs, existsSync} from 'fs';
import net from 'net';
import path from 'path';
import {fileURLToPath} from 'url';
import {
	ensureRoot,
	deleteWorker,
	isProcessAlive,
	listPendingApprovals,
	listWorkers,
	readServerPid,
	readServerPort,
	readWorkerMeta,
	writeWorkerMeta,
} from './lib/storage.js';
import {
	SERVER_LOG_FILE,
	WORKBOSS_ROOT,
	workerDir,
	workerInboxPath,
	workerMissionPath,
	workerOpenCodeConfigPath,
} from './lib/paths.js';
import {
	defaultOpenCodePermissionConfig,
	renderMissionFile,
	workerBootstrapInstructions,
} from './lib/templates.js';
import {rpcCall} from './lib/server-rpc.js';
import type {AgentKind, WorkerMeta} from './lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- helpers ----------

function fail(msg: string): never {
	console.error(`workboss: ${msg}`);
	process.exit(1);
}

function ok(msg: string): void {
	console.log(msg);
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close();
				reject(new Error('failed to allocate port'));
			}
		});
		srv.on('error', reject);
	});
}

async function waitForOpenCodeReady(
	url: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// /permission returns 200 with [] when the server is healthy.
			const res = await fetch(`${url}/permission`);
			if (res.ok || res.status === 401) return true; // 401 means auth required but server is up
		} catch {
			/* not ready yet */
		}
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
}

// ---------- server lifecycle ----------

export async function serverStart(): Promise<void> {
	ensureRoot();
	const existingPid = await readServerPid();
	if (existingPid && isProcessAlive(existingPid)) {
		ok(`workboss server already running, pid=${existingPid}`);
		return;
	}

	const serverEntry = path.join(__dirname, 'server-entry.js');
	const out = await fs.open(SERVER_LOG_FILE, 'a');
	const child = spawn(process.execPath, [serverEntry], {
		detached: true,
		stdio: ['ignore', out.fd, out.fd],
	});
	child.unref();
	out.close().catch(() => {});

	// Wait for it to write its port file.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const port = await readServerPort();
		const pid = await readServerPid();
		if (port && pid && isProcessAlive(pid)) {
			ok(`workboss server started, pid=${pid}, rpc=127.0.0.1:${port}`);
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

export async function serverStatus(): Promise<void> {
	const pid = await readServerPid();
	const port = await readServerPort();
	if (pid && isProcessAlive(pid)) {
		ok(`workboss server running, pid=${pid}, rpc port=${port ?? '?'}`);
		const res = await rpcCall({kind: 'ping'});
		if (res.ok && res.data && typeof res.data === 'object') {
			const d = res.data as {pid: number; workers: number};
			ok(`  attached workers: ${d.workers}`);
		}
	} else {
		ok('workboss server not running');
	}
}

// ---------- worker lifecycle ----------

export interface SpawnArgs {
	name: string;
	missionFile?: string;
	missionInline?: string;
	cwd: string;
	agent?: AgentKind;
	port?: number;
}

export async function spawnWorker(args: SpawnArgs): Promise<void> {
	ensureRoot();
	const agent: AgentKind = args.agent ?? 'opencode';
	if (agent !== 'opencode') {
		fail(`agent ${agent} not yet supported in MVP (opencode only)`);
	}

	if (!existsSync(args.cwd)) {
		fail(`cwd does not exist: ${args.cwd}`);
	}

	const cwdAbs = path.resolve(args.cwd);
	const dir = workerDir(args.name);
	if (existsSync(dir)) {
		fail(`worker "${args.name}" already exists at ${dir}`);
	}
	await fs.mkdir(dir, {recursive: true, mode: 0o700});

	// Resolve mission body
	let missionBody: string;
	if (args.missionFile) {
		missionBody = await fs.readFile(args.missionFile, 'utf8');
	} else if (args.missionInline) {
		missionBody = args.missionInline;
	} else {
		fail('missing --mission <file> or --task "..."');
	}

	await fs.writeFile(
		workerMissionPath(args.name),
		renderMissionFile({title: args.name, body: missionBody}),
		'utf8',
	);
	await fs.writeFile(workerInboxPath(args.name), '', 'utf8');
	await fs.writeFile(
		workerOpenCodeConfigPath(args.name),
		defaultOpenCodePermissionConfig(),
		'utf8',
	);

	const port = args.port ?? (await findFreePort());
	const url = `http://127.0.0.1:${port}`;

	// Write an AGENTS.md into the worker's cwd so the agent sees the bootstrap
	// instructions automatically. opencode reads AGENTS.md by convention.
	const agentsMdPath = path.join(cwdAbs, 'AGENTS.md');
	const bootstrap = workerBootstrapInstructions(
		args.name,
		workerMissionPath(args.name),
		workerInboxPath(args.name),
	);
	const marker = `<!-- workboss:${args.name} -->`;
	let existing = '';
	try {
		existing = await fs.readFile(agentsMdPath, 'utf8');
	} catch {
		/* none */
	}
	if (!existing.includes(marker)) {
		const prefix = existing.trim() ? existing.trimEnd() + '\n\n' : '';
		await fs.writeFile(
			agentsMdPath,
			`${prefix}${marker}\n${bootstrap}`,
			'utf8',
		);
	}

	// Spawn opencode serve.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OPENCODE_CONFIG: workerOpenCodeConfigPath(args.name),
	};

	const logPath = path.join(dir, 'serve.log');
	const out = await fs.open(logPath, 'a');
	const child = spawn(
		'opencode',
		[
			'serve',
			'--port',
			String(port),
			'--hostname',
			'127.0.0.1',
		],
		{
			cwd: cwdAbs,
			env,
			detached: true,
			stdio: ['ignore', out.fd, out.fd],
		},
	);
	child.unref();
	out.close().catch(() => {});

	const meta: WorkerMeta = {
		name: args.name,
		agent,
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		serverUrl: url,
		serverPort: port,
		pid: child.pid,
	};
	await writeWorkerMeta(meta);

	const ready = await waitForOpenCodeReady(url, 15000);
	if (!ready) {
		fail(
			`opencode serve did not become ready within 15s. Check ${logPath}`,
		);
	}

	// Tell the running aggregator to attach.
	const attached = await rpcCall({kind: 'workers.attach', name: args.name});
	if (!attached.ok) {
		console.warn(`workboss: spawned but aggregator could not attach: ${attached.error}`);
		console.warn(`  start it with: workboss server start`);
	}

	ok(`worker "${args.name}" up`);
	ok(`  agent : ${agent}`);
	ok(`  cwd   : ${cwdAbs}`);
	ok(`  serve : ${url}`);
	ok(`  pid   : ${child.pid}`);
	ok('');
	ok(`Attach a TUI client to start working with it:`);
	ok(`  opencode attach ${url}`);
}

export interface AdoptArgs {
	name: string;
	url: string;
	cwd?: string;
}

export async function adoptWorker(args: AdoptArgs): Promise<void> {
	ensureRoot();
	const dir = workerDir(args.name);
	if (existsSync(dir)) {
		fail(`worker "${args.name}" already exists at ${dir}`);
	}
	await fs.mkdir(dir, {recursive: true, mode: 0o700});

	const ready = await waitForOpenCodeReady(args.url, 5000);
	if (!ready) {
		fail(`cannot reach opencode server at ${args.url}`);
	}

	const meta: WorkerMeta = {
		name: args.name,
		agent: 'opencode',
		cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
		createdAt: new Date().toISOString(),
		serverUrl: args.url,
		notes: 'adopted',
	};
	await writeWorkerMeta(meta);
	await fs.writeFile(workerInboxPath(args.name), '', 'utf8');

	const res = await rpcCall({kind: 'workers.attach', name: args.name});
	if (!res.ok) {
		console.warn(`workboss: adopted but aggregator could not attach: ${res.error}`);
	}
	ok(`adopted "${args.name}" from ${args.url}`);
}

export async function listWorkersCmd(): Promise<void> {
	const ws = await listWorkers();
	if (ws.length === 0) {
		ok('(no workers)');
		return;
	}
	const port = await readServerPort();
	const serverUp = port !== null;
	for (const w of ws) {
		const alive = w.pid ? isProcessAlive(w.pid) : true; // adopted has no pid; assume alive
		const status = alive ? 'up  ' : 'down';
		ok(
			`${status}  ${w.name.padEnd(20)}  ${w.agent}  ${w.serverUrl ?? '(no url)'}  ${w.cwd}`,
		);
	}
	if (!serverUp) {
		ok('');
		ok('(workboss server is not running; approvals are not being captured)');
	}
}

export async function showWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	ok(JSON.stringify(meta, null, 2));
}

export async function messageWorker(
	name: string,
	text: string,
): Promise<void> {
	await readWorkerMeta(name).catch(() => fail(`worker "${name}" not found`));
	const stamp = new Date().toISOString();
	const block = `\n---\n[${stamp}] workboss:\n${text.trim()}\n`;
	await fs.appendFile(workerInboxPath(name), block, 'utf8');
	ok(`appended message to ${workerInboxPath(name)}`);
}

export async function tailWorker(name: string, n: number): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);

	// We use the opencode CLI directly to read the session list in the worker's cwd.
	// This is the simplest signal of progress without parsing the sqlite db ourselves.
	const result = spawnSync('opencode', ['session', 'list', '--max-count', String(n)], {
		cwd: meta!.cwd,
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		fail(`opencode session list failed: ${result.stderr || result.stdout}`);
	}
	ok(result.stdout.trimEnd());
}

export async function killWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);

	await rpcCall({kind: 'workers.detach', name});

	if (meta!.pid && isProcessAlive(meta!.pid)) {
		try {
			process.kill(meta!.pid, 'SIGTERM');
			ok(`sent SIGTERM to opencode serve pid=${meta!.pid}`);
			// Give it 2s to exit gracefully
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && isProcessAlive(meta!.pid)) {
				await new Promise(r => setTimeout(r, 100));
			}
			if (isProcessAlive(meta!.pid)) {
				process.kill(meta!.pid, 'SIGKILL');
				ok(`escalated to SIGKILL`);
			}
		} catch (err) {
			console.warn(`failed to kill pid ${meta!.pid}: ${String(err)}`);
		}
	}
	await deleteWorker(name);
	ok(`worker "${name}" removed`);
}

// ---------- approvals ----------

export async function approvalsList(): Promise<void> {
	const port = await readServerPort();
	if (port === null) {
		// Read directly from disk; server may be down.
		const local = await listPendingApprovals();
		if (local.length === 0) {
			ok('(no pending approvals; workboss server is not running)');
			return;
		}
		for (const a of local) {
			ok(
				`${a.id}  ${a.worker.padEnd(20)}  ${a.permission}  ${JSON.stringify(a.patterns)}`,
			);
		}
		return;
	}
	const res = await rpcCall({kind: 'approvals.list'});
	if (!res.ok) fail(res.error);
	const list = (res.data ?? []) as Array<{
		id: string;
		worker: string;
		permission: string;
		patterns: string[];
		capturedAt: string;
	}>;
	if (list.length === 0) {
		ok('(no pending approvals)');
		return;
	}
	for (const a of list) {
		const age = Math.floor(
			(Date.now() - new Date(a.capturedAt).getTime()) / 1000,
		);
		ok(
			`${a.id}  ${a.worker.padEnd(20)}  ${a.permission.padEnd(8)}  ${age}s  ${JSON.stringify(a.patterns)}`,
		);
	}
}

export async function approve(id: string, always: boolean): Promise<void> {
	const res = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: always ? 'always' : 'once',
	});
	if (!res.ok) fail(res.error);
	ok(`approved ${id} (${always ? 'always' : 'once'})`);
}

export async function reject(id: string, reason: string): Promise<void> {
	const res = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: 'reject',
		message: reason,
	});
	if (!res.ok) fail(res.error);
	ok(`rejected ${id}`);
}

export function printHelp(): void {
	ok(`workboss — LLM-supervised worker fleet for OpenCode

Server (the aggregator daemon that watches workers and queues approvals):
  workboss server start
  workboss server stop
  workboss server status

Workers:
  workboss spawn <name> --task "..." --cwd <path>
  workboss spawn <name> --mission <file> --cwd <path>
  workboss adopt <name> --url <opencode-url> [--cwd <path>]
  workboss list
  workboss show <name>
  workboss message <name> "text"
  workboss tail <name> [-n 20]
  workboss kill <name>

Approvals (intended to be called by the orchestrator, not you directly):
  workboss approvals list
  workboss approve <id> [--always]
  workboss reject <id> --reason "..."

Workboss root: ${WORKBOSS_ROOT}
`);
}
