import {spawn, spawnSync} from 'child_process';
import {promises as fs, existsSync} from 'fs';
import net from 'net';
import path from 'path';
import {fileURLToPath} from 'url';
import {
	deleteWorker,
	ensureRoot,
	isProcessAlive,
	listPendingApprovals,
	listWorkers,
	readServerPid,
	readServerPort,
	readWorkerMeta,
	updateWorkerMeta,
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
import {writeClaudeSettings} from './lib/claude-config.js';
import {createSession} from './lib/opencode-client.js';

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
			const res = await fetch(`${url}/permission`);
			if (res.ok || res.status === 401) return true;
		} catch {
			/* not ready */
		}
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
}

async function writeWorkerScaffold(args: {
	name: string;
	missionFile?: string;
	missionInline?: string;
}): Promise<void> {
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
}

async function injectBootstrapDoc(
	cwdAbs: string,
	workerName: string,
	docName: 'AGENTS.md' | 'CLAUDE.md',
): Promise<void> {
	const docPath = path.join(cwdAbs, docName);
	const bootstrap = workerBootstrapInstructions(
		workerName,
		workerMissionPath(workerName),
		workerInboxPath(workerName),
	);
	const marker = `<!-- workboss:${workerName} -->`;
	let existing = '';
	try {
		existing = await fs.readFile(docPath, 'utf8');
	} catch {
		/* none */
	}
	if (!existing.includes(marker)) {
		const prefix = existing.trim() ? existing.trimEnd() + '\n\n' : '';
		await fs.writeFile(docPath, `${prefix}${marker}\n${bootstrap}`, 'utf8');
	}
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

export async function serverStatus(): Promise<void> {
	const pid = await readServerPid();
	const port = await readServerPort();
	if (pid && isProcessAlive(pid)) {
		ok(`workboss server running, pid=${pid}, http port=${port ?? '?'}`);
		const res = await rpcCall({kind: 'ping'});
		if (res.ok && res.data && typeof res.data === 'object') {
			const d = res.data as {pid: number; workers: number};
			ok(`  attached workers: ${d.workers}`);
		}
	} else {
		ok('workboss server not running');
	}
}

// ---------- worker spawn (creates a fresh session) ----------

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
	if (agent !== 'opencode' && agent !== 'claude') {
		fail(`unknown agent: ${agent}`);
	}
	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);
	const dir = workerDir(args.name);
	if (existsSync(dir)) fail(`worker "${args.name}" already exists at ${dir}`);

	await fs.mkdir(dir, {recursive: true, mode: 0o700});
	await writeWorkerScaffold(args);

	if (agent === 'opencode') {
		await spawnOpenCodeWorker(args, cwdAbs);
		return;
	}
	if (agent === 'claude') {
		await spawnClaudeWorker(args, cwdAbs);
		return;
	}
}

async function spawnOpenCodeWorker(
	args: SpawnArgs,
	cwdAbs: string,
): Promise<void> {
	await fs.writeFile(
		workerOpenCodeConfigPath(args.name),
		defaultOpenCodePermissionConfig(),
		'utf8',
	);

	await injectBootstrapDoc(cwdAbs, args.name, 'AGENTS.md');

	const port = args.port ?? (await findFreePort());
	const url = `http://127.0.0.1:${port}`;

	const env: NodeJS.ProcessEnv = {
		...process.env,
		OPENCODE_CONFIG: workerOpenCodeConfigPath(args.name),
	};
	const logPath = path.join(workerDir(args.name), 'serve.log');
	const out = await fs.open(logPath, 'a');
	const child = spawn(
		'opencode',
		['serve', '--port', String(port), '--hostname', '127.0.0.1'],
		{
			cwd: cwdAbs,
			env,
			detached: true,
			stdio: ['ignore', out.fd, out.fd],
		},
	);
	child.unref();
	out.close().catch(() => {});

	const startedAt = new Date().toISOString();
	const initialMeta: WorkerMeta = {
		name: args.name,
		agent: 'opencode',
		cwd: cwdAbs,
		createdAt: startedAt,
		process: {pid: child.pid, serverUrl: url, serverPort: port, startedAt},
	};
	await writeWorkerMeta(initialMeta);

	const ready = await waitForOpenCodeReady(url, 15000);
	if (!ready) {
		fail(`opencode serve did not become ready within 15s. Check ${logPath}`);
	}

	// Create a session on this server so we have a durable id to point at.
	let sessionId: string | undefined;
	try {
		sessionId = await createSession({baseUrl: url}, args.name);
	} catch (err) {
		console.warn(
			`workboss: opencode server is up but POST /session failed: ${String(err)}`,
		);
	}
	if (sessionId) {
		await updateWorkerMeta(args.name, m => ({...m, sessionId}));
	}

	const attached = await rpcCall({kind: 'workers.attach', name: args.name});
	if (!attached.ok) {
		console.warn(
			`workboss: spawned but aggregator could not attach: ${attached.error}`,
		);
	}

	ok(`worker "${args.name}" up`);
	ok(`  agent      : opencode`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  server     : ${url}`);
	ok(`  session id : ${sessionId ?? '(unset)'}`);
	ok(`  pid        : ${child.pid}`);
	ok('');
	ok(`Attach a TUI client:`);
	if (sessionId) {
		ok(`  opencode attach ${url} --session ${sessionId}`);
	} else {
		ok(`  opencode attach ${url}`);
	}
}

async function spawnClaudeWorker(
	args: SpawnArgs,
	cwdAbs: string,
): Promise<void> {
	const port = await readServerPort();
	if (port === null) {
		fail(
			'workboss server is not running. Start it first with `workboss server start`.',
		);
	}
	const workbossServerUrl = `http://127.0.0.1:${port}`;

	const settingsPath = await writeClaudeSettings(cwdAbs, {
		workerName: args.name,
		workbossServerUrl,
	});

	await injectBootstrapDoc(cwdAbs, args.name, 'CLAUDE.md');

	const meta: WorkerMeta = {
		name: args.name,
		agent: 'claude',
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		notes: `claude settings: ${settingsPath}`,
	};
	await writeWorkerMeta(meta);

	const attached = await rpcCall({kind: 'workers.attach', name: args.name});
	if (!attached.ok) {
		console.warn(
			`workboss: registered but aggregator could not attach: ${attached.error}`,
		);
	}

	ok(`worker "${args.name}" registered`);
	ok(`  agent      : claude`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  settings   : ${settingsPath}`);
	ok(`  session id : (will be learned from first hook call)`);
	ok('');
	ok(`Start the worker:`);
	ok(`  cd ${cwdAbs} && claude`);
	ok('');
	ok(`The next PreToolUse from this Claude session will register through workboss.`);
}

// ---------- register: attach to an existing session id ----------

export interface RegisterArgs {
	name: string;
	agent: AgentKind;
	cwd: string;
	sessionId: string;
	serverUrl?: string; // opencode-only, if a server is already running
}

export async function registerWorker(args: RegisterArgs): Promise<void> {
	ensureRoot();
	const cwdAbs = path.resolve(args.cwd);
	const dir = workerDir(args.name);
	if (existsSync(dir)) fail(`worker "${args.name}" already exists at ${dir}`);
	if (!existsSync(cwdAbs)) fail(`cwd does not exist: ${cwdAbs}`);

	await fs.mkdir(dir, {recursive: true, mode: 0o700});
	await fs.writeFile(workerInboxPath(args.name), '', 'utf8');

	// A placeholder mission, since registering an existing session usually
	// means the user has already been working with it.
	await fs.writeFile(
		workerMissionPath(args.name),
		renderMissionFile({
			title: args.name,
			body: `Registered from existing ${args.agent} session ${args.sessionId} at ${cwdAbs}.`,
		}),
		'utf8',
	);

	// Drop the agent-specific bootstrap doc so future sessions in this cwd
	// also follow the workboss inbox protocol.
	if (args.agent === 'claude') {
		const port = await readServerPort();
		if (port === null) {
			fail(
				'workboss server is not running. Start it first with `workboss server start`.',
			);
		}
		const workbossUrl = `http://127.0.0.1:${port}`;
		await writeClaudeSettings(cwdAbs, {
			workerName: args.name,
			workbossServerUrl: workbossUrl,
		});
		await injectBootstrapDoc(cwdAbs, args.name, 'CLAUDE.md');
	} else if (args.agent === 'opencode') {
		await fs.writeFile(
			workerOpenCodeConfigPath(args.name),
			defaultOpenCodePermissionConfig(),
			'utf8',
		);
		await injectBootstrapDoc(cwdAbs, args.name, 'AGENTS.md');
	}

	const meta: WorkerMeta = {
		name: args.name,
		agent: args.agent,
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		sessionId: args.sessionId,
		process: args.serverUrl
			? {
					serverUrl: args.serverUrl,
					serverPort: tryPortFromUrl(args.serverUrl),
					startedAt: new Date().toISOString(),
				}
			: undefined,
		notes: 'registered',
	};
	await writeWorkerMeta(meta);

	const attached = await rpcCall({kind: 'workers.attach', name: args.name});
	if (!attached.ok) {
		console.warn(`workboss: aggregator could not attach: ${attached.error}`);
	}

	ok(`registered "${args.name}"`);
	ok(`  agent      : ${args.agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  session id : ${args.sessionId}`);
	if (args.serverUrl) ok(`  server     : ${args.serverUrl}`);
	if (args.agent === 'claude') {
		ok('');
		ok(`Restart the claude session in this cwd for workboss hooks to take effect.`);
	}
}

function tryPortFromUrl(url: string): number | undefined {
	try {
		const u = new URL(url);
		const p = parseInt(u.port, 10);
		return Number.isFinite(p) ? p : undefined;
	} catch {
		return undefined;
	}
}

// ---------- attach: print the command the user should run ----------

export async function attachWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	const m = meta!;

	if (m.agent === 'opencode') {
		const url = m.process?.serverUrl;
		if (!url) {
			ok(`worker "${name}" has no running opencode server.`);
			ok(`  Resume it with:`);
			if (m.sessionId) {
				ok(`    cd ${m.cwd} && opencode serve --port <P>`);
				ok(`    opencode attach http://127.0.0.1:<P> --session ${m.sessionId}`);
			} else {
				ok(`    cd ${m.cwd} && opencode serve --port <P>`);
				ok(`    opencode attach http://127.0.0.1:<P>`);
			}
			return;
		}
		if (m.sessionId) {
			ok(`opencode attach ${url} --session ${m.sessionId}`);
		} else {
			ok(`opencode attach ${url}`);
		}
		return;
	}

	if (m.agent === 'claude') {
		if (m.sessionId) {
			ok(`cd ${m.cwd} && claude --resume ${m.sessionId}`);
		} else {
			ok(`cd ${m.cwd} && claude`);
			ok(`# session id will be learned on the first PreToolUse hook`);
		}
		return;
	}
}

// ---------- inspection ----------

export async function listWorkersCmd(): Promise<void> {
	const ws = await listWorkers();
	if (ws.length === 0) {
		ok('(no workers)');
		return;
	}
	const port = await readServerPort();
	const serverUp = port !== null;
	for (const w of ws) {
		const procPid = w.process?.pid;
		const procAlive = procPid ? isProcessAlive(procPid) : false;
		const status = procPid
			? procAlive
				? 'up   '
				: 'dead '
			: 'idle ';
		const sid = w.sessionId ? w.sessionId.slice(0, 12) + '…' : '(no-sid)';
		const where = w.process?.serverUrl ?? w.cwd;
		ok(
			`${status}  ${w.name.padEnd(20)}  ${w.agent.padEnd(8)}  ${sid.padEnd(15)}  ${where}`,
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

	if (meta!.agent === 'opencode') {
		const result = spawnSync(
			'opencode',
			['session', 'list', '--max-count', String(n), '--format', 'json'],
			{cwd: meta!.cwd, encoding: 'utf8'},
		);
		if (result.status !== 0) {
			fail(`opencode session list failed: ${result.stderr || result.stdout}`);
		}
		ok(result.stdout.trimEnd());
		return;
	}

	if (meta!.agent === 'claude') {
		if (!meta!.sessionId) {
			ok(`(no session id yet; nothing to tail)`);
			return;
		}
		// Read tail of ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
		const encoded = meta!.cwd.replace(/[\\/.]/g, '-');
		const jsonl = path.join(
			process.env['HOME'] ?? '',
			'.claude',
			'projects',
			encoded,
			`${meta!.sessionId}.jsonl`,
		);
		try {
			const text = await fs.readFile(jsonl, 'utf8');
			const lines = text.split('\n').filter(Boolean);
			ok(lines.slice(-n).join('\n'));
		} catch (err) {
			fail(`could not read claude transcript: ${String(err)}`);
		}
	}
}

// ---------- lifecycle: detach / remove ----------

/**
 * Stop the process currently attached to this worker (if any). The worker
 * meta and its session pointer are preserved; you can resume later by
 * spawning a new process bound to the same sessionId.
 */
export async function detachWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);

	await rpcCall({kind: 'workers.detach', name});

	const pid = meta!.process?.pid;
	if (pid && isProcessAlive(pid)) {
		try {
			process.kill(pid, 'SIGTERM');
			ok(`sent SIGTERM to pid=${pid}`);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && isProcessAlive(pid)) {
				await new Promise(r => setTimeout(r, 100));
			}
			if (isProcessAlive(pid)) {
				process.kill(pid, 'SIGKILL');
				ok(`escalated to SIGKILL`);
			}
		} catch (err) {
			console.warn(`failed to kill pid ${pid}: ${String(err)}`);
		}
	}

	await updateWorkerMeta(name, m => {
		const next = {...m};
		delete next.process;
		return next;
	});

	ok(
		`detached "${name}" (session ${meta!.sessionId ?? '?'} preserved; resume with \`workboss attach ${name}\`)`,
	);
}

/**
 * Permanently remove the workboss worker entry. Does NOT delete the agent's
 * session data — that lives in ~/.claude/projects/ or the opencode db and is
 * managed by the agent itself.
 */
export async function removeWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);

	// First detach any live process.
	if (meta!.process?.pid && isProcessAlive(meta!.process.pid)) {
		await detachWorker(name);
	} else {
		await rpcCall({kind: 'workers.detach', name});
	}
	await deleteWorker(name);
	ok(`removed worker "${name}" (session data on disk is untouched)`);
}

// ---------- approvals ----------

export async function approvalsList(): Promise<void> {
	const port = await readServerPort();
	if (port === null) {
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
	ok(`workboss — LLM-supervised worker fleet (opencode + claude code)

Workboss treats each worker as a *session pointer* (the durable LLM history
on disk). Processes attached to a worker are transient — you can detach,
kill, and resume by binding a new process to the same session id.

Server (the aggregator daemon that captures approvals and routes replies):
  workboss server start
  workboss server stop
  workboss server status

Workers — create new (spawns a fresh session):
  workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
  workboss spawn <name> --mission <file> --cwd <path>

Workers — adopt an existing session:
  workboss register <name> --agent opencode|claude --cwd <path> \\
                            --session-id <sid> [--server-url <url>]

Workers — inspection / interaction:
  workboss list
  workboss show <name>
  workboss attach <name>            # prints the command to resume the session
  workboss message <name> "text"
  workboss tail <name> [-n N]

Workers — lifecycle:
  workboss detach <name>            # kill current process, keep session
  workboss remove <name>            # forget the worker (session on disk stays)

Approvals (intended to be called by the orchestrator, not directly):
  workboss approvals list
  workboss approve <id> [--always]
  workboss reject <id> --reason "..."

Workboss root: ${WORKBOSS_ROOT}
`);
}
