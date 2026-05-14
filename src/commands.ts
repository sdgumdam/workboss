import {spawn} from 'child_process';
import {promises as fs, existsSync} from 'fs';
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
} from './lib/paths.js';
import {renderMissionFile} from './lib/templates.js';
import {rpcCall} from './lib/server-rpc.js';
import type {AgentKind, WorkerMeta} from './lib/types.js';
import {getAdapter} from './lib/agents/index.js';
import {
	discoverAll,
	type DiscoveredSession,
} from './lib/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- io helpers ----------

function fail(msg: string): never {
	console.error(`workboss: ${msg}`);
	process.exit(1);
}

function ok(msg: string): void {
	console.log(msg);
}

async function ensureServerUp(): Promise<string> {
	const port = await readServerPort();
	if (port === null) {
		fail(
			'workboss server is not running. Start it first with `workboss server start`.',
		);
	}
	return `http://127.0.0.1:${port}`;
}

async function resolveMissionBody(args: {
	missionFile?: string;
	missionInline?: string;
}): Promise<string> {
	if (args.missionFile) return fs.readFile(args.missionFile, 'utf8');
	if (args.missionInline) return args.missionInline;
	fail('missing --mission <file> or --task "..."');
}

async function createWorkerScaffold(
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

async function notifyAggregator(name: string): Promise<void> {
	const attached = await rpcCall({kind: 'workers.attach', name});
	if (!attached.ok) {
		console.warn(`workboss: aggregator could not attach: ${attached.error}`);
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
	if (!pid || !isProcessAlive(pid)) {
		ok('workboss server not running');
		return;
	}
	ok(`workboss server running, pid=${pid}, http port=${port ?? '?'}`);
	const res = await rpcCall({kind: 'ping'});
	if (res.ok && res.data && typeof res.data === 'object') {
		const d = res.data as {pid: number; workers: number};
		ok(`  attached workers: ${d.workers}`);
	}
}

// ---------- worker spawn ----------

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
	const adapter = getAdapter(agent);

	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);

	const workbossServerUrl = await ensureServerUp();
	const missionBody = await resolveMissionBody(args);
	await createWorkerScaffold(args.name, missionBody);

	const startedAt = new Date().toISOString();
	let meta: WorkerMeta = {
		name: args.name,
		agent,
		cwd: cwdAbs,
		createdAt: startedAt,
	};
	await writeWorkerMeta(meta);

	const result = await adapter.spawnNew({
		workerName: args.name,
		cwdAbs,
		missionBody,
		workbossServerUrl,
		preferredPort: args.port,
	});

	meta = {
		...meta,
		sessionId: result.sessionId,
		process: result.process,
	};
	await writeWorkerMeta(meta);

	await notifyAggregator(args.name);

	ok(`worker "${args.name}" ${result.process?.pid ? 'up' : 'registered'}`);
	ok(`  agent      : ${agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	for (const line of result.postSpawnHint) ok(line);
}

// ---------- register (adopt existing session) ----------

export interface RegisterArgs {
	name: string;
	agent: AgentKind;
	cwd: string;
	sessionId: string;
	serverUrl?: string;
}

function portFromUrl(url: string): number | undefined {
	try {
		const u = new URL(url);
		const p = parseInt(u.port, 10);
		return Number.isFinite(p) ? p : undefined;
	} catch {
		return undefined;
	}
}

export async function registerWorker(args: RegisterArgs): Promise<void> {
	ensureRoot();
	const adapter = getAdapter(args.agent);
	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);

	const workbossServerUrl = await ensureServerUp();

	await createWorkerScaffold(
		args.name,
		`Registered from existing ${args.agent} session ${args.sessionId} at ${cwdAbs}.`,
	);
	await adapter.prepareCwd({
		workerName: args.name,
		cwdAbs,
		workbossServerUrl,
	});

	const meta: WorkerMeta = {
		name: args.name,
		agent: args.agent,
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		sessionId: args.sessionId,
		process: args.serverUrl
			? {
					serverUrl: args.serverUrl,
					serverPort: portFromUrl(args.serverUrl),
					startedAt: new Date().toISOString(),
				}
			: undefined,
		notes: 'registered',
	};
	await writeWorkerMeta(meta);

	await notifyAggregator(args.name);

	ok(`registered "${args.name}"`);
	ok(`  agent      : ${args.agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  session id : ${args.sessionId}`);
	if (args.serverUrl) ok(`  server     : ${args.serverUrl}`);
}

// ---------- attach / detach / remove ----------

export async function attachWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	for (const line of getAdapter(meta!.agent).attachHint(meta!)) ok(line);
}

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

export async function removeWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	if (meta!.process?.pid && isProcessAlive(meta!.process.pid)) {
		await detachWorker(name);
	} else {
		await rpcCall({kind: 'workers.detach', name});
	}
	await deleteWorker(name);
	ok(`removed worker "${name}" (session data on disk is untouched)`);
}

// ---------- inspection ----------

export async function listWorkersCmd(): Promise<void> {
	const ws = await listWorkers();
	if (ws.length === 0) {
		ok('(no workers)');
		return;
	}
	for (const w of ws) {
		const procPid = w.process?.pid;
		const procAlive = procPid ? isProcessAlive(procPid) : false;
		const status = !procPid ? 'idle ' : procAlive ? 'up   ' : 'dead ';
		const sid = w.sessionId ? w.sessionId.slice(0, 12) + '…' : '(no-sid)';
		const where = w.process?.serverUrl ?? w.cwd;
		ok(
			`${status}  ${w.name.padEnd(20)}  ${w.agent.padEnd(8)}  ${sid.padEnd(15)}  ${where}`,
		);
	}
	if (!(await readServerPort())) {
		ok('');
		ok('(workboss server is not running; approvals are not being captured)');
	}
}

export async function showWorker(name: string): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	ok(JSON.stringify(meta, null, 2));
}

export async function messageWorker(name: string, text: string): Promise<void> {
	await readWorkerMeta(name).catch(() => fail(`worker "${name}" not found`));
	const stamp = new Date().toISOString();
	await fs.appendFile(
		workerInboxPath(name),
		`\n---\n[${stamp}] workboss:\n${text.trim()}\n`,
		'utf8',
	);
	ok(`appended message to ${workerInboxPath(name)}`);
}

export async function tailWorker(name: string, n: number): Promise<void> {
	const meta = await readWorkerMeta(name).catch(() => null);
	if (!meta) fail(`worker "${name}" not found`);
	try {
		ok(await getAdapter(meta!.agent).tail({meta: meta!, n}));
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
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

// ---------- discover ----------

function suggestName(d: DiscoveredSession, taken: Set<string>): string {
	const base = d.sessionId
		? `disc-${d.sessionId.replace(/^ses_/, '').slice(0, 8)}`
		: d.cwd
			? `disc-${path.basename(d.cwd).slice(0, 12)}`
			: `disc-${d.agent}`;
	let name = base;
	let n = 2;
	while (taken.has(name)) name = `${base}-${n++}`;
	return name;
}

function fmtAge(d?: Date): string {
	if (!d) return '?';
	const ms = Date.now() - d.getTime();
	if (ms < 0) return 'just now';
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s 前`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m 前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h 前`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d 前`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo 前`;
	return `${Math.floor(mo / 12)}y 前`;
}

function shortSid(sid?: string): string {
	if (!sid) return '(no-sid)';
	return sid.startsWith('ses_')
		? sid.slice(0, 12) + '…'
		: sid.slice(0, 8) + '…';
}

function shortCwd(cwd: string | undefined, maxLen = 40): string {
	if (!cwd) return '?';
	const home = process.env['HOME'];
	let out = cwd;
	if (home && cwd.startsWith(home)) out = '~' + cwd.slice(home.length);
	if (out.length <= maxLen) return out;
	return '…' + out.slice(out.length - (maxLen - 1));
}

export interface DiscoverOptions {
	all?: boolean;
	registerAlive?: boolean;
	json?: boolean;
}

export async function discoverCmd(opts: DiscoverOptions): Promise<void> {
	const known = await listWorkers();
	const knownSids = new Set(
		known.map(w => w.sessionId).filter((s): s is string => !!s),
	);
	const knownUrls = new Set(
		known.map(w => w.process?.serverUrl).filter((u): u is string => !!u),
	);
	const knownNames = new Set(known.map(w => w.name));

	const unknown = (await discoverAll()).filter(d => {
		if (d.sessionId && knownSids.has(d.sessionId)) return false;
		if (d.serverUrl && knownUrls.has(d.serverUrl)) return false;
		return true;
	});
	const alive = unknown.filter(d => d.alive);
	const history = unknown.filter(d => !d.alive);

	if (opts.json) {
		ok(JSON.stringify({alive, history, known: known.length}, null, 2));
		return;
	}

	if (alive.length === 0 && (!opts.all || history.length === 0)) {
		ok('没有发现未注册的 worker（机器上已经全部被 workboss 管着）。');
		if (!opts.all && history.length > 0) {
			ok(`(还有 ${history.length} 个历史 session 没注册；--all 查看)`);
		}
		return;
	}

	if (alive.length > 0) {
		ok('可立即收编 (alive, 未注册):');
		for (const d of alive) {
			const where = d.serverUrl ?? (d.pid ? `pid ${d.pid}` : '?');
			ok(
				`  ${d.agent.padEnd(8)}  ${where.padEnd(28)}  ${shortCwd(d.cwd, 35).padEnd(37)}  ${shortSid(d.sessionId)}`,
			);
		}
	}

	if (opts.all && history.length > 0) {
		ok('');
		ok('历史 session (idle, 未注册):');
		for (const d of history.slice(0, 50)) {
			const title = d.title ? ` ("${d.title.slice(0, 30)}")` : '';
			ok(
				`  ${d.agent.padEnd(8)}  ${shortCwd(d.cwd, 35).padEnd(37)}  ${shortSid(d.sessionId).padEnd(15)}  ${fmtAge(d.lastActivity)}${title}`,
			);
		}
		if (history.length > 50) {
			ok(`  ... 还有 ${history.length - 50} 条 (--json 拿完整列表)`);
		}
	} else if (!opts.all && history.length > 0) {
		ok('');
		ok(`(另有 ${history.length} 个历史 session 未注册；--all 查看)`);
	}

	if (opts.registerAlive && alive.length > 0) {
		ok('');
		ok('--register-alive: 自动收编 alive worker:');
		const taken = new Set(knownNames);
		for (const d of alive) {
			if (!d.cwd) {
				ok(`  ✗ ${d.agent} pid=${d.pid}: 无法拿到 cwd，跳过`);
				continue;
			}
			if (!d.sessionId) {
				ok(
					`  ✗ ${d.agent} pid=${d.pid} (${d.cwd}): 无 session id，请等 worker 内一次工具调用让 workboss 学习，或手动 register`,
				);
				continue;
			}
			const name = suggestName(d, taken);
			taken.add(name);
			try {
				await registerWorker({
					name,
					agent: d.agent,
					cwd: d.cwd,
					sessionId: d.sessionId,
					serverUrl: d.serverUrl,
				});
				ok(`  ✓ ${name}  ${d.agent}  ${shortSid(d.sessionId)}`);
			} catch (err) {
				ok(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}

// ---------- help ----------

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
  workboss discover [--all] [--register-alive]   # auto-find unregistered workers

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
