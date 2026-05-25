import {promises as fs} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';
import os from 'os';
import {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {render, Box, Text, useApp, useInput, useStdout} from 'ink';

import type {LivenessStatus, WorkerMeta, WorkerRepository} from '../../domain/worker.js';
import type {PendingApproval} from '../../domain/approval.js';
import {FsWorkerRepository} from '../../infrastructure/filesystem/worker-repo.js';
import {workerMissionPath, ORCHESTRATOR_STATE_FILE, getServerPort} from '../../infrastructure/filesystem/paths.js';
import {getAdapter} from '../../application/orchestration/agents/index.js';
import {findAliveAgents} from '../../application/orchestration/session-scanner.js';
import {
	runInLeftPane,
	LEFT_PANE,
	getLeftPaneChildCommand,
} from '../../infrastructure/tmux/tmux.js';
import {createLogger} from '../../infrastructure/logging/logger.js';
import {pingDaemon} from '../../application/orchestration/commands/server.js';
import {rpcCall} from '../../infrastructure/http/server-rpc.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('dashboard');

const LIVENESS_ORDER: Record<LivenessStatus, number> = {
	up: 0, degraded: 1, idle: 2, dead: 3,
};

const LIVENESS_ICON: Record<LivenessStatus, string> = {
	up: '●', degraded: '◐', dead: '✗', idle: '○',
};

const LIVENESS_COLOR: Record<LivenessStatus, string> = {
	up: 'green', degraded: 'yellow', dead: 'red', idle: 'gray',
};

export type DashboardAction =
	| {kind: 'worker'; name: string}
	| {kind: 'back'}
	| {kind: 'shutdown'}
	| {kind: 'quit'}
	| {kind: 'approve'; id: string}
	| {kind: 'reject'; id: string}
	| {kind: 'approve-all'}
	| {kind: 'reject-all'};

interface DashboardProps {
	workerRepo: WorkerRepository;
	onAction: (action: DashboardAction) => void;
}

interface WorkerDisplay {
	name: string;
	displayName: string;
	status: LivenessStatus;
	agent: string;
	cwd: string;
	sessionId: string;
	shortSid: string;
	pid?: number;
}

interface MouseEvent {
	button: number;
	x: number;
	y: number;
	action: 'press' | 'release' | 'motion';
}

function useMouse(onMouse: (event: MouseEvent) => void): void {
	const handlerRef = useRef(onMouse);
	handlerRef.current = onMouse;

	useEffect(() => {
		process.stdout.write('\x1b[?1000h');

		const onStdinData = (data: Buffer) => {
			const str = data.toString('binary');
			let idx = 0;
			while (idx < str.length) {
				const escPos = str.indexOf('\x1b[M', idx);
				if (escPos === -1) break;
				const bPos = escPos + 3;
				if (bPos + 2 >= str.length) break;
				const cb = str.charCodeAt(bPos) - 32;
				const cx = str.charCodeAt(bPos + 1) - 32;
				const cy = str.charCodeAt(bPos + 2) - 32;
				const button = cb & 3;
				const action: MouseEvent['action'] = cb & 0x40
					? 'motion'
					: cb & 0x20
						? 'release'
						: 'press';
				handlerRef.current({button, x: cx, y: cy, action});
				idx = bPos + 3;
			}
		};

		process.stdin.on('data', onStdinData);

		return () => {
			process.stdout.write('\x1b[?1000l');
			process.stdin.removeListener('data', onStdinData);
		};
	}, []);
}

function deriveDisplayName(name: string, cwd: string): string {
	if (!name.startsWith('auto-')) return name;
	const segments = cwd.replace(os.homedir(), '~').split('/');
	return segments[segments.length - 1] || name;
}

async function getLeftPaneSessionId(): Promise<string | null> {
	try {
		const {stdout: panePid} = await execFileAsync('tmux', [
			'display-message', '-t', LEFT_PANE, '-p', '#{pane_pid}',
		]);
		const shellPid = parseInt(panePid.trim(), 10);
		if (!Number.isFinite(shellPid)) return null;
		const {stdout: children} = await execFileAsync('pgrep', ['-P', String(shellPid)]);
		const childPids = children.trim().split('\n').filter(Boolean);
		for (const cpid of childPids) {
			try {
				const {stdout: cmd} = await execFileAsync('ps', ['-p', cpid, '-o', 'command=']);
				const m = cmd.match(/--session\s+(\S+)/);
				if (m) return m[1];
			} catch {}
		}
	} catch {}
	return null;
}

async function readMissionTitle(name: string): Promise<string> {
	try {
		const content = await fs.readFile(workerMissionPath(name), 'utf8');
		for (const line of content.split('\n')) {
			const trimmed = line.replace(/^#+\s*/, '').trim();
			if (trimmed) return trimmed.length > 40 ? trimmed.slice(0, 37) + '...' : trimmed;
		}
	} catch {}
	return '';
}

async function checkLivenessBatch(
	workers: WorkerMeta[],
): Promise<Map<string, LivenessStatus>> {
	const result = new Map<string, LivenessStatus>();

	const alive = await findAliveAgents();

	const aliveBySid = new Map<string, typeof alive[0]>();
	for (const a of alive) {
		if (a.sessionId) aliveBySid.set(a.sessionId, a);
	}

	const unmatchedAlive = alive.filter((a) => {
		if (!a.sessionId) return true;
		return !workers.some((w) => w.sessionId === a.sessionId);
	});

	const claimedCwds = new Set<string>();
	for (const meta of workers) {
		if (meta.sessionId && aliveBySid.has(meta.sessionId)) {
			result.set(meta.name, 'up');
			claimedCwds.add(meta.cwd + ':' + meta.agent);
		}
	}

	for (const meta of workers) {
		if (result.has(meta.name)) continue;
		const cwdKey = meta.cwd + ':' + meta.agent;
		if (claimedCwds.has(cwdKey)) continue;
		const match = unmatchedAlive.find(
			(a) => a.cwd === meta.cwd && a.agent === meta.agent && a.alive,
		);
		if (match) {
			result.set(meta.name, 'up');
			claimedCwds.add(cwdKey);
			continue;
		}
	}

	for (const meta of workers) {
		if (result.has(meta.name)) continue;
		try {
			const adapter = getAdapter(meta.agent);
			const r = await adapter.checkLiveness(meta);
			result.set(meta.name, r.status);
		} catch {
			result.set(meta.name, meta.liveness ?? 'idle');
		}
	}

	return result;
}

function sortByLiveness(workers: WorkerDisplay[]): WorkerDisplay[] {
	return [...workers].sort(
		(a, b) => (LIVENESS_ORDER[a.status] ?? 9) - (LIVENESS_ORDER[b.status] ?? 9),
	);
}

const HEADER_ROWS = 2;
const FOOTER_ROWS = 4;

function WorkerRow({worker, selected, isCurrent}: {
	worker: WorkerDisplay;
	selected: boolean;
	isCurrent: boolean;
}) {
	const icon = LIVENESS_ICON[worker.status] ?? '○';
	const color = LIVENESS_COLOR[worker.status] ?? 'gray';
	const agentIcon = getAdapter(worker.agent as 'opencode' | 'claude').getIcon();
	const prefix = selected ? '▸' : ' ';

	return (
		<Text wrap="truncate">
			<Text color={selected ? 'blue' : undefined}>{prefix} </Text>
			{isCurrent ? <Text color="cyan">►</Text> : <Text> </Text>}
			<Text color={color}>{icon}</Text>
			<Text> </Text>
			<Text dimColor>{agentIcon}</Text>
			<Text> </Text>
			<Text color={selected ? 'blue' : undefined} bold={selected}>{worker.displayName}</Text>
			<Text dimColor> {worker.shortSid}</Text>
			{worker.pid ? <Text dimColor>:{worker.pid}</Text> : null}
			<Text dimColor> {worker.status}</Text>
		</Text>
	);
}

type FilterMode = 'all' | 'active' | 'idle';

const FILTER_LABEL: Record<FilterMode, string> = {
	all: 'all',
	active: 'active',
	idle: 'idle',
};

const FILTER_FN: Record<FilterMode, (s: LivenessStatus) => boolean> = {
	all: () => true,
	active: (s) => s === 'up' || s === 'degraded',
	idle: (s) => s === 'idle' || s === 'dead',
};

const NEXT_FILTER: Record<FilterMode, FilterMode> = {
	all: 'active',
	active: 'idle',
	idle: 'all',
};

interface DaemonStatus {
	alive: boolean;
	pid?: number;
	workers?: number;
}

function DashboardView({workerRepo, onAction}: DashboardProps) {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const [allWorkers, setAllWorkers] = useState<WorkerDisplay[]>([]);
	const [filter, setFilter] = useState<FilterMode>('all');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [time, setTime] = useState(new Date().toLocaleTimeString());
	const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>({alive: false});
	const [approvals, setApprovals] = useState<PendingApproval[]>([]);
	const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
	const [activePaneSessionId, setActivePaneSessionId] = useState<string | null>(null);

	const visibleApprovals = useMemo(
		() => approvals.filter((a) => !dismissedIds.has(a.id)),
		[approvals, dismissedIds],
	);

	const workers = useMemo(
		() => allWorkers.filter((w) => FILTER_FN[filter](w.status)),
		[allWorkers, filter],
	);

	const availableHeight = Math.max((stdout?.rows ?? 24) - HEADER_ROWS - FOOTER_ROWS, 3);

	const viewport = useMemo(() => {
		if (workers.length <= availableHeight) {
			return {start: 0, end: workers.length};
		}
		const half = Math.floor(availableHeight / 2);
		let start = Math.max(selectedIndex - half, 0);
		const end = Math.min(start + availableHeight, workers.length);
		if (end === workers.length) {
			start = Math.max(end - availableHeight, 0);
		}
		return {start, end};
	}, [workers.length, selectedIndex, availableHeight]);

	const visibleWorkers = workers.slice(viewport.start, viewport.end);

	const refreshWorkers = useCallback(async () => {
		const [raw, daemon, leftPaneSid] = await Promise.all([
			workerRepo.list(),
			pingDaemon(),
			getLeftPaneSessionId(),
		]);

		const [livenessMap, missionTitles] = await Promise.all([
			checkLivenessBatch(raw),
			Promise.all(raw.map((meta) => readMissionTitle(meta.name))),
		]);

		const enriched: WorkerDisplay[] = raw.map((meta, i) => {
			const sid = meta.sessionId ?? '';
			const shortSid = sid.length > 8 ? sid.slice(-8) : sid;
			return {
				name: meta.name,
				displayName: missionTitles[i] || deriveDisplayName(meta.name, meta.cwd),
				status: livenessMap.get(meta.name) ?? 'idle',
				agent: meta.agent,
				cwd: meta.cwd,
				sessionId: sid,
				shortSid,
				pid: meta.process?.serve?.pid,
			};
		});

		const sorted = sortByLiveness(enriched);
		setAllWorkers(sorted);
		setDaemonStatus(daemon);
		setActivePaneSessionId(leftPaneSid);
		setSelectedIndex((prev) => Math.min(prev, Math.max(sorted.length - 1, 0)));
	}, [workerRepo]);

	const refreshApprovals = useCallback(async () => {
		const r = await rpcCall({kind: 'approvals.list'});
		if (r.ok && Array.isArray(r.data)) {
			const approvalList = r.data as PendingApproval[];
			setApprovals(approvalList);
			setDismissedIds((prev) => {
				const currentIds = new Set(approvalList.map((a) => a.id));
				let changed = false;
				for (const id of prev) {
					if (!currentIds.has(id)) changed = true;
				}
				return changed ? new Set() : prev;
			});
		}
	}, []);

	useEffect(() => {
		void refreshWorkers();
		const timer = setInterval(() => {
			void refreshWorkers();
			setTime(new Date().toLocaleTimeString());
		}, 2000);
		return () => clearInterval(timer);
	}, [refreshWorkers]);

	useEffect(() => {
		void refreshApprovals();
		const timer = setInterval(() => {
			void refreshApprovals();
		}, 500);
		return () => clearInterval(timer);
	}, [refreshApprovals]);

	const handleApproval = useCallback(
		(kind: 'approve' | 'reject', ids: string[]) => {
			setDismissedIds((prev) => {
				const next = new Set(prev);
				for (const id of ids) next.add(id);
				return next;
			});
			for (const id of ids) {
				rpcCall({
					kind: 'approvals.reply',
					id,
					reply: kind === 'approve' ? 'once' : 'reject',
					...(kind === 'reject' ? {message: 'rejected by orchestrator'} : {}),
				}).catch(() => {});
			}
		},
		[],
	);

	const fire = useCallback(
		(action: DashboardAction) => {
			if (action.kind === 'approve') {
				handleApproval('approve', [action.id]);
				return;
			}
			if (action.kind === 'reject') {
				handleApproval('reject', [action.id]);
				return;
			}
			if (action.kind === 'approve-all') {
				handleApproval('approve', visibleApprovals.map((a) => a.id));
				return;
			}
			if (action.kind === 'reject-all') {
				handleApproval('reject', visibleApprovals.map((a) => a.id));
				return;
			}
			onAction(action);
			exit();
		},
		[onAction, exit, handleApproval, visibleApprovals],
	);

	useInput((_input, key) => {
		if (key.tab) {
			setFilter((prev) => NEXT_FILTER[prev]);
			setSelectedIndex(0);
		} else if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		} else if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(prev + 1, workers.length - 1));
		} else if (key.return) {
			if (workers.length === 0) return;
			const worker = workers[selectedIndex];
			if (worker) {
				fire({kind: 'worker', name: worker.name});
			}
		} else if (key.escape || _input === 'o') {
			fire({kind: 'back'});
		} else if (_input === 's') {
			fire({kind: 'shutdown'});
		} else if (key.ctrl && _input === 'c') {
			fire({kind: 'quit'});
		} else if (_input === 'a') {
			if (visibleApprovals.length > 0) {
				const a = visibleApprovals[0];
				if (a) fire({kind: 'approve', id: a.id});
			}
		} else if (_input === 'r') {
			if (visibleApprovals.length > 0) {
				const a = visibleApprovals[0];
				if (a) fire({kind: 'reject', id: a.id});
			}
		} else if (_input === 'A') {
			if (visibleApprovals.length > 0) fire({kind: 'approve-all'});
		} else if (_input === 'R') {
			if (visibleApprovals.length > 0) fire({kind: 'reject-all'});
		}
	});

	useMouse((event) => {
		if (event.action !== 'press' || event.button !== 0) return;
		const headerEnd = 2;
		const workerAreaEnd = headerEnd + visibleWorkers.length;
		const approvalRow = event.y - headerEnd;

		if (event.y >= headerEnd && event.y < workerAreaEnd) {
			const clickedIndex = viewport.start + approvalRow;
			if (clickedIndex === selectedIndex) {
				const worker = workers[clickedIndex];
				if (worker) fire({kind: 'worker', name: worker.name});
			} else {
				setSelectedIndex(clickedIndex);
			}
			return;
		}

		if (visibleApprovals.length > 0) {
			const approvalListEnd = workerAreaEnd + Math.min(visibleApprovals.length, 3);
			const buttonRow = approvalListEnd;
			if (event.y === buttonRow) {
				if (event.x <= 12) {
					const a = visibleApprovals[0];
					if (a) fire({kind: 'approve', id: a.id});
					return;
				}
				if (event.x > 12 && event.x <= 24) {
					const a = visibleApprovals[0];
					if (a) fire({kind: 'reject', id: a.id});
					return;
				}
			}
		}
	});

	return (
		<Box flexDirection="column" height="100%">
			<Box>
				<Text backgroundColor="blue" color="white" bold>
					{' workboss '}
				</Text>
				<Text backgroundColor="gray" color="white">
					{` ${FILTER_LABEL[filter]}(${workers.length}) `}
				</Text>
				<Text> </Text>
				{daemonStatus.alive ? (
					<Text color="green">
						{`daemon:up pid=${daemonStatus.pid} port=${getServerPort()}`}
					</Text>
				) : (
					<Text color="red">daemon:DOWN</Text>
				)}
			</Box>

			<Box flexDirection="column" flexGrow={1}>
				{workers.length === 0 ? (
					<Text dimColor>  No workers registered</Text>
				) : (
					visibleWorkers.map((w) => {
						const i = workers.indexOf(w);
						return (
							<WorkerRow
								key={w.name}
								worker={w}
								selected={i === selectedIndex}
								isCurrent={w.sessionId !== '' && w.sessionId === activePaneSessionId}
							/>
						);
					})
				)}
			</Box>

			<Box flexDirection="column">
				{visibleApprovals.length > 0 ? (
					<>
						{visibleApprovals.slice(0, 3).map((a) => {
							const toolName = (a.metadata as Record<string, unknown>)?.tool_name ?? '?';
							const patterns = a.patterns.length > 0 ? a.patterns[0] : '';
							const shortPatterns = typeof patterns === 'string' && patterns.length > 60
								? patterns.slice(0, 57) + '...'
								: patterns;
							return (
								<Box key={a.id}>
									<Text color="yellow" bold>{'⚠ '}</Text>
									<Text color="yellow">{a.worker}</Text>
									<Text dimColor>{` ${toolName} `}</Text>
									<Text>{shortPatterns}</Text>
								</Box>
							);
						})}
						<Box>
							<Text color="green" bold>{' [✓ approve] '}</Text>
							<Text color="red" bold>{' [✗ reject] '}</Text>
							{visibleApprovals.length > 1 ? (
								<Text dimColor>{`(${visibleApprovals.length} pending · A/R for all)`}</Text>
							) : null}
						</Box>
					</>
				) : (
					<Text color="green">✓ no pending approvals</Text>
				)}
			</Box>

			<Box justifyContent="center">
				<Text backgroundColor="red" color="white" bold>
					{' ⏻ shutdown '}
				</Text>
			</Box>

			<Box>
				<Text dimColor>
					{' '}
					{time} | {workers.length}w | Tab·↑↓·Enter·click · o back · a/r approve/reject · A/R all · s shutdown · ⌘C
				</Text>
			</Box>
		</Box>
	);
}

export class Dashboard {
	private readonly workerRepo: WorkerRepository;

	constructor(workerRepo: WorkerRepository) {
		this.workerRepo = workerRepo;
	}

	async show(): Promise<DashboardAction> {
		return new Promise<DashboardAction>((resolve) => {
			let settled = false;
			let doUnmount: (() => void) | null = null;

			const onAction = (action: DashboardAction) => {
				if (settled) return;
				settled = true;
				doUnmount?.();
				resolve(action);
			};

			const instance = render(
				<DashboardView
					workerRepo={this.workerRepo}
					onAction={onAction}
				/>,
			);
			doUnmount = instance.unmount;
		});
	}
}

async function getLeftPaneCwd(): Promise<string | null> {
	const child = await getLeftPaneChildCommand();
	if (!child) return null;
	try {
		const {stdout} = await execFileAsync('lsof', ['-p', String(child.pid), '-Fn']);
		for (const line of stdout.split('\n')) {
			if (line.startsWith('n/') && !line.includes('/opt/homebrew') && !line.includes('/Library/')) {
				return line.slice(1);
			}
		}
	} catch {}
	return null;
}

async function switchToWorker(meta: WorkerMeta): Promise<void> {
	const leftPaneSid = await getLeftPaneSessionId();
	if (meta.sessionId && meta.sessionId === leftPaneSid) {
		logger.info('switchToWorker skipped: already in left pane', {name: meta.name, sessionId: meta.sessionId});
		return;
	}

	const child = await getLeftPaneChildCommand();
	if (child) {
		const adapter = getAdapter(meta.agent);
		if (adapter.isBareTUICommand(child.cmd)) {
			const paneCwd = await getLeftPaneCwd();
			if (paneCwd === meta.cwd) {
				logger.info('switchToWorker skipped: bare TUI already in this project', {name: meta.name, cwd: meta.cwd});
				return;
			}
		}
	}

	const adapter = getAdapter(meta.agent);
	logger.info('switchToWorker', {name: meta.name, agent: meta.agent, hasUrl: !!meta.process?.serve?.serverUrl, sessionId: meta.sessionId ?? 'null'});

	const {ensureServerUp} = await import('../../application/orchestration/commands/utils.js');
	const serverUrl = await ensureServerUp();
	const cmd = await adapter.resumeAndAttach(meta, serverUrl);

	if (cmd) {
		logger.info('runInLeftPane', {cmd});
		await runInLeftPane(cmd);
		logger.info('runInLeftPane done');
	} else {
		logger.warn('could not construct command for worker', {name: meta.name});
	}
}

async function switchToOrchestrator(): Promise<void> {
	let state: {agent: string; cwd: string} | null = null;
	try {
		const raw = await fs.readFile(ORCHESTRATOR_STATE_FILE, 'utf8');
		state = JSON.parse(raw);
	} catch {}
	if (!state) {
		logger.warn('no orchestrator state file found');
		return;
	}
	const adapter = getAdapter(state.agent as 'opencode' | 'claude');
	const cmd = adapter.getLaunchCommand({});
	logger.info('switchToOrchestrator', {agent: state.agent});
	await runInLeftPane(cmd);
}

const workerRepo = new FsWorkerRepository();

export async function runDashboardLoop(): Promise<void> {
	const dashboard = new Dashboard(workerRepo);

	while (true) {
		const action = await dashboard.show();
		logger.info('action', action);

		if (action.kind === 'quit') break;

		if (action.kind === 'shutdown') {
			const {shutdownCmd} = await import(
				'../../application/orchestration/commands/shutdown.js'
			);
			await shutdownCmd();
			break;
		}

		if (action.kind === 'worker') {
			const meta = await workerRepo.read(action.name).catch(() => null);
			if (meta) await switchToWorker(meta);
		}

		if (action.kind === 'back') {
			await switchToOrchestrator();
		}
	}
}
