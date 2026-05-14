import {spawn} from 'child_process';
import {promises as fs, existsSync} from 'fs';
import os from 'os';
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
import {
	fmtAge,
	pickUniqueName,
	shortCwd,
	shortSid,
} from './lib/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// io / common helpers
// ============================================================================

function fail(msg: string): never {
	console.error(`workboss: ${msg}`);
	process.exit(1);
}

function ok(msg: string): void {
	console.log(msg);
}

async function loadWorker(name: string): Promise<WorkerMeta> {
	try {
		return await readWorkerMeta(name);
	} catch {
		fail(`worker "${name}" not found`);
	}
}

async function ensureServerUp(): Promise<string> {
	const port = await readServerPort();
	if (port !== null) return `http://127.0.0.1:${port}`;
	// Auto-start so the user doesn't have to remember `workboss server start`.
	await serverStart();
	const after = await readServerPort();
	if (after === null) fail('failed to auto-start workboss server');
	return `http://127.0.0.1:${after}`;
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
	const r = await rpcCall({kind: 'workers.attach', name});
	if (!r.ok) console.warn(`workboss: aggregator could not attach: ${r.error}`);
}

/**
 * SIGTERM, wait up to `graceMs`, then SIGKILL. Quietly no-ops when the
 * process is already gone.
 */
async function gracefulKill(pid: number, graceMs = 2000): Promise<void> {
	if (!isProcessAlive(pid)) return;
	try {
		process.kill(pid, 'SIGTERM');
		ok(`sent SIGTERM to pid=${pid}`);
	} catch {
		return; // already gone
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && isProcessAlive(pid)) {
		await new Promise(r => setTimeout(r, 100));
	}
	if (isProcessAlive(pid)) {
		try {
			process.kill(pid, 'SIGKILL');
			ok(`escalated to SIGKILL`);
		} catch {
			/* ignore */
		}
	}
}

function processFromUrl(url: string): WorkerMeta['process'] | undefined {
	if (!url) return undefined;
	const startedAt = new Date().toISOString();
	try {
		const u = new URL(url);
		const port = parseInt(u.port, 10);
		return {
			serverUrl: url,
			serverPort: Number.isFinite(port) ? port : undefined,
			startedAt,
		};
	} catch {
		return {serverUrl: url, startedAt};
	}
}

// ============================================================================
// server lifecycle
// ============================================================================

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
	const r = await rpcCall({kind: 'ping'});
	if (r.ok && r.data && typeof r.data === 'object') {
		const d = r.data as {pid: number; workers: number};
		ok(`  attached workers: ${d.workers}`);
	}
}

// ============================================================================
// worker spawn / register / lifecycle
// ============================================================================

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
	const agent = args.agent ?? 'opencode';
	const adapter = getAdapter(agent);
	if (!existsSync(args.cwd)) fail(`cwd does not exist: ${args.cwd}`);
	const cwdAbs = path.resolve(args.cwd);

	const workbossServerUrl = await ensureServerUp();
	const missionBody = await resolveMissionBody(args);
	await createWorkerScaffold(args.name, missionBody);

	const createdAt = new Date().toISOString();
	await writeWorkerMeta({name: args.name, agent, cwd: cwdAbs, createdAt});

	const result = await adapter.spawnNew({
		workerName: args.name,
		cwdAbs,
		missionBody,
		workbossServerUrl,
		preferredPort: args.port,
	});
	await writeWorkerMeta({
		name: args.name,
		agent,
		cwd: cwdAbs,
		createdAt,
		sessionId: result.sessionId,
		process: result.process,
	});
	await notifyAggregator(args.name);

	ok(`worker "${args.name}" ${result.process?.pid ? 'up' : 'registered'}`);
	ok(`  agent      : ${agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	for (const line of result.postSpawnHint) ok(line);
}

export interface RegisterArgs {
	name: string;
	agent: AgentKind;
	cwd: string;
	sessionId: string;
	serverUrl?: string;
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

	await writeWorkerMeta({
		name: args.name,
		agent: args.agent,
		cwd: cwdAbs,
		createdAt: new Date().toISOString(),
		sessionId: args.sessionId,
		process: args.serverUrl ? processFromUrl(args.serverUrl) : undefined,
		notes: 'registered',
	});
	await notifyAggregator(args.name);

	ok(`registered "${args.name}"`);
	ok(`  agent      : ${args.agent}`);
	ok(`  cwd        : ${cwdAbs}`);
	ok(`  session id : ${args.sessionId}`);
	if (args.serverUrl) ok(`  server     : ${args.serverUrl}`);
}

export async function attachWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	for (const line of getAdapter(meta.agent).attachHint(meta)) ok(line);
}

export async function detachWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	await rpcCall({kind: 'workers.detach', name});
	if (meta.process?.pid) await gracefulKill(meta.process.pid);
	await updateWorkerMeta(name, m => {
		const {process: _omit, ...rest} = m;
		return rest;
	});
	ok(
		`detached "${name}" (session ${meta.sessionId ?? '?'} preserved; resume with \`workboss attach ${name}\`)`,
	);
}

export async function removeWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	if (meta.process?.pid && isProcessAlive(meta.process.pid)) {
		await detachWorker(name);
	} else {
		await rpcCall({kind: 'workers.detach', name});
	}
	await deleteWorker(name);
	ok(`removed worker "${name}" (session data on disk is untouched)`);
}

// ============================================================================
// inspection
// ============================================================================

function workerStatusLabel(w: WorkerMeta): string {
	if (!w.process?.pid) return 'idle ';
	return isProcessAlive(w.process.pid) ? 'up   ' : 'dead ';
}

export interface ListOptions {
	includeHistory?: boolean;
}

/**
 * Show every worker on this machine in a single flat table.
 *
 * The daemon continuously sweeps the host and brings every live agent
 * session into the workboss roster on its own, so by the time this command
 * runs there is no meaningful "registered vs not" distinction left to
 * surface. The user just sees workers.
 *
 * --history adds idle on-disk sessions (no live process) for archaeology.
 */
export async function listWorkersCmd(opts: ListOptions = {}): Promise<void> {
	const workers = await listWorkers();
	let history: DiscoveredSession[] = [];
	if (opts.includeHistory) {
		const known = {
			sids: new Set(
				workers.map(w => w.sessionId).filter((s): s is string => !!s),
			),
			urls: new Set(
				workers
					.map(w => w.process?.serverUrl)
					.filter((u): u is string => !!u),
			),
			names: new Set<string>(),
		};
		history = partitionUnknown(await discoverAll(), known).history;
	}

	if (workers.length === 0 && history.length === 0) {
		ok('(no workers on this machine)');
		return;
	}

	for (const w of workers) {
		const sid = shortSid(w.sessionId).padEnd(15);
		const where = w.process?.serverUrl ?? w.cwd;
		ok(
			`${workerStatusLabel(w)}  ${w.name.padEnd(20)}  ${w.agent.padEnd(8)}  ${sid}  ${where}`,
		);
	}
	if (opts.includeHistory) {
		for (const d of history.slice(0, 50)) {
			const title = d.title ? ` "${d.title.slice(0, 30)}"` : '';
			ok(
				`${fmtAge(d.lastActivity).padEnd(8)}  ${'(history)'.padEnd(20)}  ${d.agent.padEnd(8)}  ${shortSid(d.sessionId).padEnd(15)}  ${shortCwd(d.cwd, 35)}${title}`,
			);
		}
		if (history.length > 50) {
			ok(`... 还有 ${history.length - 50} 条`);
		}
	}

	if (!(await readServerPort())) {
		ok('');
		ok('(workboss server 没在跑；新 worker 不会被自动收编)');
	}
}

export async function showWorker(name: string): Promise<void> {
	const meta = await loadWorker(name);
	ok(JSON.stringify(meta, null, 2));
}

export async function messageWorker(name: string, text: string): Promise<void> {
	await loadWorker(name);
	const stamp = new Date().toISOString();
	await fs.appendFile(
		workerInboxPath(name),
		`\n---\n[${stamp}] workboss:\n${text.trim()}\n`,
		'utf8',
	);
	ok(`appended message to ${workerInboxPath(name)}`);
}

export async function tailWorker(name: string, n: number): Promise<void> {
	const meta = await loadWorker(name);
	try {
		ok(await getAdapter(meta.agent).tail({meta, n}));
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}

// ============================================================================
// approvals
// ============================================================================

interface ApprovalRow {
	id: string;
	worker: string;
	permission: string;
	patterns: string[];
	capturedAt?: string;
}

function formatApprovalRow(a: ApprovalRow): string {
	const age = a.capturedAt
		? `${Math.floor((Date.now() - new Date(a.capturedAt).getTime()) / 1000)}s`
		: '?';
	return `${a.id}  ${a.worker.padEnd(20)}  ${a.permission.padEnd(8)}  ${age.padEnd(5)}  ${JSON.stringify(a.patterns)}`;
}

export async function approvalsList(): Promise<void> {
	const serverUp = (await readServerPort()) !== null;
	const list = serverUp
		? await (async () => {
				const r = await rpcCall({kind: 'approvals.list'});
				if (!r.ok) fail(r.error);
				return (r.data ?? []) as ApprovalRow[];
			})()
		: ((await listPendingApprovals()) as ApprovalRow[]);

	if (list.length === 0) {
		ok(
			serverUp
				? '(no pending approvals)'
				: '(no pending approvals; workboss server is not running)',
		);
		return;
	}
	for (const a of list) ok(formatApprovalRow(a));
}

export async function approve(id: string, always: boolean): Promise<void> {
	const r = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: always ? 'always' : 'once',
	});
	if (!r.ok) fail(r.error);
	ok(`approved ${id} (${always ? 'always' : 'once'})`);
}

export async function reject(id: string, reason: string): Promise<void> {
	const r = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: 'reject',
		message: reason,
	});
	if (!r.ok) fail(r.error);
	ok(`rejected ${id}`);
}

// ============================================================================
// discover
// ============================================================================

interface KnownIndex {
	sids: Set<string>;
	urls: Set<string>;
	names: Set<string>;
}

async function indexKnownWorkers(): Promise<KnownIndex> {
	const ws = await listWorkers();
	return {
		sids: new Set(ws.map(w => w.sessionId).filter((s): s is string => !!s)),
		urls: new Set(
			ws.map(w => w.process?.serverUrl).filter((u): u is string => !!u),
		),
		names: new Set(ws.map(w => w.name)),
	};
}

function partitionUnknown(
	all: DiscoveredSession[],
	known: KnownIndex,
): {alive: DiscoveredSession[]; history: DiscoveredSession[]} {
	const unknown = all.filter(d => {
		if (d.sessionId && known.sids.has(d.sessionId)) return false;
		if (d.serverUrl && known.urls.has(d.serverUrl)) return false;
		return true;
	});
	return {
		alive: unknown.filter(d => d.alive),
		history: unknown.filter(d => !d.alive),
	};
}

function printAliveSection(alive: DiscoveredSession[]): void {
	if (alive.length === 0) return;
	ok('可立即收编 (alive, 未注册):');
	for (const d of alive) {
		const where = d.serverUrl ?? (d.pid ? `pid ${d.pid}` : '?');
		ok(
			`  ${d.agent.padEnd(8)}  ${where.padEnd(28)}  ${shortCwd(d.cwd, 35).padEnd(37)}  ${shortSid(d.sessionId)}`,
		);
	}
}

function printHistorySection(
	history: DiscoveredSession[],
	opts: {limit: number; showFull: boolean},
): void {
	if (!opts.showFull || history.length === 0) return;
	ok('');
	ok('历史 session (idle, 未注册):');
	for (const d of history.slice(0, opts.limit)) {
		const title = d.title ? ` ("${d.title.slice(0, 30)}")` : '';
		ok(
			`  ${d.agent.padEnd(8)}  ${shortCwd(d.cwd, 35).padEnd(37)}  ${shortSid(d.sessionId).padEnd(15)}  ${fmtAge(d.lastActivity)}${title}`,
		);
	}
	if (history.length > opts.limit) {
		ok(`  ... 还有 ${history.length - opts.limit} 条 (--json 拿完整列表)`);
	}
}

function nameSuggestion(d: DiscoveredSession): string {
	if (d.sessionId) {
		return `disc-${d.sessionId.replace(/^ses_/, '').slice(0, 8)}`;
	}
	if (d.cwd) return `disc-${path.basename(d.cwd).slice(0, 12)}`;
	return `disc-${d.agent}`;
}

async function autoRegisterAlive(
	alive: DiscoveredSession[],
	taken: Set<string>,
): Promise<void> {
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
		const name = pickUniqueName(nameSuggestion(d), taken);
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

export interface DiscoverOptions {
	all?: boolean;
	registerAlive?: boolean;
	json?: boolean;
}

export async function discoverCmd(opts: DiscoverOptions): Promise<void> {
	const known = await indexKnownWorkers();
	const {alive, history} = partitionUnknown(await discoverAll(), known);

	if (opts.json) {
		ok(JSON.stringify({alive, history, known: known.names.size}, null, 2));
		return;
	}

	if (alive.length === 0 && (!opts.all || history.length === 0)) {
		ok('没有发现未注册的 worker（机器上已经全部被 workboss 管着）。');
		if (!opts.all && history.length > 0) {
			ok(`(还有 ${history.length} 个历史 session 没注册；--all 查看)`);
		}
		return;
	}

	printAliveSection(alive);
	printHistorySection(history, {limit: 50, showFull: !!opts.all});
	if (!opts.all && history.length > 0) {
		ok('');
		ok(`(另有 ${history.length} 个历史 session 未注册；--all 查看)`);
	}

	if (opts.registerAlive && alive.length > 0) {
		ok('');
		ok('--register-alive: 自动收编 alive worker:');
		await autoRegisterAlive(alive, new Set(known.names));
	}
}

// ============================================================================
// boss — one-shot bootstrap of the orchestrator session
// ============================================================================

const ORCHESTRATOR_TEMPLATE = path.join(
	__dirname,
	'..',
	'templates',
	'ORCHESTRATOR.md',
);

const SUPERVISOR_HOME = path.join(os.homedir(), '.workboss', 'supervisor');

/**
 * Start the workboss daemon (if it isn't already), refresh the orchestrator
 * prompt in a dedicated supervisor cwd, and exec the chosen agent there
 * with stdio inherited so the user is dropped straight into the conversation.
 *
 * Equivalent to:
 *   workboss server start              # auto-started
 *   mkdir -p ~/.workboss/supervisor
 *   cp templates/ORCHESTRATOR.md ~/.workboss/supervisor/AGENTS.md
 *   cd ~/.workboss/supervisor && opencode
 */
export async function bossCmd(args: {
	agent?: 'opencode' | 'claude';
}): Promise<void> {
	await ensureServerUp();

	await fs.mkdir(SUPERVISOR_HOME, {recursive: true, mode: 0o700});
	const agent = args.agent ?? 'opencode';
	const docName = agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
	const promptContent = await fs.readFile(ORCHESTRATOR_TEMPLATE, 'utf8');
	await fs.writeFile(
		path.join(SUPERVISOR_HOME, docName),
		promptContent,
		'utf8',
	);

	ok(`workboss boss: launching ${agent} in ${SUPERVISOR_HOME}`);
	ok('');

	// Inject an initial user message so the orchestrator scans the machine
	// (registered + unregistered) the moment it boots, without the user
	// needing to type anything first. Only opencode supports a `--prompt`
	// flag with interactive TUI; for claude the inline mode is non-interactive
	// so we fall back to "type 'scan' once you're in".
	const bootScan =
		'立即扫一遍机器：调用 workboss list 看已注册 worker，调用 workboss discover 看机器上还有哪些活的 / 历史 session 没注册，把两边合并成一段紧凑的开机汇总给我看。然后等我下一步指令。';
	const cliArgs =
		agent === 'opencode' ? ['--prompt', bootScan] : [];
	if (agent === 'claude') {
		ok(
			'(提示：claude 启动后第一句对它说"扫一遍"它就会自动跑 list+discover 汇报)',
		);
		ok('');
	}

	const child = spawn(agent, cliArgs, {
		cwd: SUPERVISOR_HOME,
		stdio: 'inherit',
	});

	await new Promise<void>((resolve, reject) => {
		child.on('exit', code => {
			process.exitCode = code ?? 0;
			resolve();
		});
		child.on('error', err => {
			reject(
				new Error(
					`failed to launch ${agent}: ${err.message}. ` +
						`Is "${agent}" on your PATH?`,
				),
			);
		});
	});
}

// ============================================================================
// help
// ============================================================================

export function printHelp(): void {
	ok(`workboss — LLM-supervised worker fleet (opencode + claude code)

Workboss treats each worker as a *session pointer* (the durable LLM history
on disk). Processes attached to a worker are transient — you can detach,
kill, and resume by binding a new process to the same session id.

Quick start (one command):
  workboss boss [--agent opencode|claude]   # auto-start daemon + open orchestrator

Server (auto-started by most commands; manage manually if needed):
  workboss server start
  workboss server stop
  workboss server status

Workers — create new (spawns a fresh session):
  workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]
  workboss spawn <name> --mission <file> --cwd <path>

Workers — adopt an existing session:
  workboss register <name> --agent opencode|claude --cwd <path> \\
                            --session-id <sid> [--server-url <url>]
  workboss discover --register-alive             # auto-take-over every live worker

Workers — inspection / interaction:
  workboss list                # ✓ managed, ● unmanaged-alive, ◌ history
  workboss list --history      # include idle on-disk sessions
  workboss list --managed-only # hide the unmanaged ones
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
