import {spawn} from 'child_process';
import {promises as fs} from 'fs';
import os from 'os';
import {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {render, Box, Text, useApp, useInput, useStdout} from 'ink';

import type {LivenessStatus, WorkerMeta, WorkerRepository} from '../../domain/worker.js';
import type {ApprovalRepository} from '../../domain/approval.js';
import {FsWorkerRepository} from '../../infrastructure/filesystem/worker-repo.js';
import {FsApprovalRepository} from '../../infrastructure/filesystem/approval-repo.js';
import {workerMissionPath} from '../../infrastructure/filesystem/paths.js';
import {getAdapter} from '../../application/orchestration/agents/index.js';
import {findAliveAgents} from '../../application/orchestration/session-scanner.js';

const LIVENESS_ORDER: Record<LivenessStatus, number> = {
	up: 0, degraded: 1, idle: 2, dead: 3,
};

const LIVENESS_ICON: Record<LivenessStatus, string> = {
	up: '●', degraded: '◐', dead: '✗', idle: '○',
};

const LIVENESS_COLOR: Record<LivenessStatus, string> = {
	up: 'green', degraded: 'yellow', dead: 'red', idle: 'gray',
};

const AGENT_ICON: Record<string, string> = {
	opencode: '⬡',
	claude: '◈',
};

export type DashboardAction =
	| {kind: 'worker'; name: string}
	| {kind: 'shutdown'}
	| {kind: 'quit'};

interface DashboardProps {
	workerRepo: WorkerRepository;
	approvalRepo: ApprovalRepository;
	onAction: (action: DashboardAction) => void;
}

interface WorkerDisplay {
	name: string;
	displayName: string;
	status: LivenessStatus;
	agent: string;
	cwd: string;
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

function WorkerRow({worker, selected}: {
	worker: WorkerDisplay;
	selected: boolean;
}) {
	const icon = LIVENESS_ICON[worker.status] ?? '○';
	const color = LIVENESS_COLOR[worker.status] ?? 'gray';
	const agentIcon = AGENT_ICON[worker.agent] ?? '?';
	const prefix = selected ? '▸' : ' ';

	return (
		<Text wrap="truncate">
			<Text color={selected ? 'blue' : undefined}>{prefix} </Text>
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

function DashboardView({workerRepo, approvalRepo, onAction}: DashboardProps) {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const [allWorkers, setAllWorkers] = useState<WorkerDisplay[]>([]);
	const [filter, setFilter] = useState<FilterMode>('all');
	const [approvalCount, setApprovalCount] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [time, setTime] = useState(new Date().toLocaleTimeString());

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

	const refresh = useCallback(async () => {
		const [raw, approvals] = await Promise.all([
			workerRepo.list(),
			approvalRepo.list(),
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
				shortSid,
				pid: meta.process?.serve?.pid,
			};
		});

		const sorted = sortByLiveness(enriched);
		setAllWorkers(sorted);
		setApprovalCount(approvals.length);
		setSelectedIndex((prev) => Math.min(prev, Math.max(sorted.length - 1, 0)));
	}, [workerRepo, approvalRepo]);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => {
			void refresh();
			setTime(new Date().toLocaleTimeString());
		}, 2000);
		return () => clearInterval(timer);
	}, [refresh]);

	const fire = useCallback((action: DashboardAction) => {
		onAction(action);
		exit();
	}, [onAction, exit]);

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
		} else if (_input === 's') {
			fire({kind: 'shutdown'});
		} else if (key.ctrl && _input === 'c') {
			fire({kind: 'quit'});
		}
	});

	useMouse((event) => {
		if (event.action !== 'press' || event.button !== 0) return;
		const row = event.y - 2;
		if (row < 0 || row >= visibleWorkers.length) return;
		const clickedIndex = viewport.start + row;
		if (clickedIndex === selectedIndex) {
			const worker = workers[clickedIndex];
			if (worker) fire({kind: 'worker', name: worker.name});
		} else {
			setSelectedIndex(clickedIndex);
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
							/>
						);
					})
				)}
			</Box>

			<Box>
				{approvalCount > 0 ? (
					<Text color="yellow">
						⚠ {approvalCount} pending approval{approvalCount > 1 ? 's' : ''}
					</Text>
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
					{time} | {workers.length}w | Tab filter · ↑↓·Enter·click · s shutdown · ⌘C
				</Text>
			</Box>
		</Box>
	);
}

export class Dashboard {
	private readonly workerRepo: WorkerRepository;
	private readonly approvalRepo: ApprovalRepository;

	constructor(workerRepo: WorkerRepository, approvalRepo: ApprovalRepository) {
		this.workerRepo = workerRepo;
		this.approvalRepo = approvalRepo;
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
					approvalRepo={this.approvalRepo}
					onAction={onAction}
				/>,
			);
			doUnmount = instance.unmount;
		});
	}
}

async function resolveWorkerCommand(
	name: string,
	workerRepo: WorkerRepository,
): Promise<{cmd: string; cwd: string} | null> {
	const meta = await workerRepo.read(name).catch(() => null);
	if (!meta) return null;

	if (meta.agent === 'opencode') {
		const url = meta.process?.serve?.serverUrl;
		if (!url || !meta.sessionId) return null;
		return {cmd: `opencode attach ${url} --session ${meta.sessionId}`, cwd: meta.cwd};
	}

	if (meta.agent === 'claude') {
		const cmd = meta.sessionId ? `claude --resume ${meta.sessionId}` : 'claude';
		return {cmd, cwd: meta.cwd};
	}

	return null;
}

function spawnTUI(command: string, cwd: string): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn('sh', ['-c', command], {cwd, stdio: 'inherit'});
		child.on('exit', () => resolve());
		child.on('error', () => resolve());
	});
}

export async function runDashboardLoop(): Promise<void> {
	const workerRepo = new FsWorkerRepository();
	const approvalRepo = new FsApprovalRepository();
	const dashboard = new Dashboard(workerRepo, approvalRepo);

	while (true) {
		const action = await dashboard.show();

		if (action.kind === 'quit') break;

		if (action.kind === 'shutdown') {
			const {shutdownCmd} = await import(
				'../../application/orchestration/commands/shutdown.js'
			);
			await shutdownCmd();
			break;
		}

		if (action.kind === 'worker') {
			const resolved = await resolveWorkerCommand(action.name, workerRepo);
			if (resolved) await spawnTUI(resolved.cmd, resolved.cwd);
		}
	}
}
