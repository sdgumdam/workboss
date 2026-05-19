/**
 * Find agent sessions on this machine that workboss does not yet know about.
 *
 * Two sources:
 *   1. live processes — `ps` shows running `opencode serve` and `claude`
 *      invocations; we extract port / session id / cwd from each
 *   2. on-disk session history — Claude's jsonl files under
 *      ~/.claude/projects/, OpenCode's sqlite rows in opencode.db
 *
 * The caller filters out sessions that are already registered (by sessionId
 * or live serverUrl) before deciding what to surface or auto-register.
 */

import {execFile} from 'child_process';
import {promises as fs} from 'fs';
import os from 'os';
import path from 'path';
import {promisify} from 'util';

const execFileAsync = promisify(execFile);

export type DiscoveredAgent = 'claude' | 'opencode';

export interface DiscoveredSession {
	agent: DiscoveredAgent;
	cwd?: string;
	sessionId?: string;
	/** Live opencode server URL if we caught the process running. */
	serverUrl?: string;
	/** PID if alive. */
	pid?: number;
	/** True when this was found via `ps` rather than only on disk. */
	alive: boolean;
	lastActivity?: Date;
	title?: string;
	messageCount?: number;
}

const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------- live processes ----------

async function findCurrentClaudeSessionId(
	cwd: string,
): Promise<string | undefined> {
	const encoded = cwd.replace(/[/_.]/g, '-');
	const dir = path.join(
		process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
		'projects',
		encoded,
	);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return undefined;
	}
	let best: {sid: string; mtimeMs: number} | null = null;
	for (const f of entries) {
		if (!f.endsWith('.jsonl')) continue;
		try {
			const st = await fs.stat(path.join(dir, f));
			if (!best || st.mtimeMs > best.mtimeMs) {
				best = {sid: f.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs};
			}
		} catch {
			/* skip */
		}
	}
	if (!best) return undefined;
	const STALE_MS = 24 * 60 * 60 * 1000;
	if (Date.now() - best.mtimeMs > STALE_MS) return undefined;
	return best.sid;
}

async function lsofCwd(pid: number): Promise<string | undefined> {
	try {
		const {stdout} = await execFileAsync('lsof', [
			'-a',
			'-p',
			String(pid),
			'-d',
			'cwd',
			'-Fn',
		]);
		for (const line of stdout.split('\n')) {
			if (line.startsWith('n')) return line.slice(1);
		}
	} catch {
		/* not allowed or pid gone */
	}
	return undefined;
}

async function fetchOpencodeLatestSession(
	serverUrl: string,
): Promise<string | undefined> {
	try {
		const res = await fetch(`${serverUrl}/session?max=1`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as Array<{id?: string}>;
		if (Array.isArray(data) && data[0]?.id) return data[0].id;
	} catch {
		/* server might require auth or be unreachable */
	}
	return undefined;
}

async function findOpencodeSessionForCwd(
	cwd: string,
): Promise<string | undefined> {
	const db = path.join(
		os.homedir(),
		'.local',
		'share',
		'opencode',
		'opencode.db',
	);
	try {
		await fs.access(db);
	} catch {
		return undefined;
	}
	const sql =
		`SELECT id FROM session WHERE directory = '${cwd.replace(/'/g, "''")}' ` +
		`AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1;`;
	try {
		const {stdout} = await execFileAsync(
			'sqlite3',
			['-readonly', db, sql],
			{maxBuffer: 1024 * 1024},
		);
		const id = stdout.trim();
		return id || undefined;
	} catch {
		return undefined;
	}
}

function classifyPsLine(line: string): {
	pid: number;
	hit:
		| {agent: 'opencode'; port?: number; sessionId?: string; isAttachClient?: boolean}
		| {agent: 'claude'; sessionId?: string};
} | null {
	const trimmed = line.trimStart();
	if (!trimmed) return null;
	const spaceAt = trimmed.indexOf(' ');
	if (spaceAt === -1) return null;
	const pid = Number.parseInt(trimmed.slice(0, spaceAt), 10);
	if (!Number.isFinite(pid)) return null;
	const args = trimmed.slice(spaceAt + 1);

	// 1. opencode serve --port <P>: full HTTP-backed worker.
	const serve = args.match(/\bopencode\s+serve\b[^|]*?--port\s+(\d+)/);
	if (serve) {
		return {pid, hit: {agent: 'opencode', port: Number.parseInt(serve[1]!, 10)}};
	}

	// 2. opencode attach <url>: client of another server, not a worker.
	if (/\bopencode\s+attach\b/.test(args)) {
		return {pid, hit: {agent: 'opencode', isAttachClient: true}};
	}

	// 3. opencode --session ses_xxx / opencode -s ses_xxx (TUI mode with
	// explicit session).
	const sessionFlag = args.match(/\bopencode\b[^|]*?(?:--session|\s-s)\s+(ses_\S+)/);
	if (sessionFlag) {
		return {pid, hit: {agent: 'opencode', sessionId: sessionFlag[1]}};
	}

	// 4. Bare `opencode` (or `opencode <project>`): TUI mode, no API, no
	// explicit sid in cmdline.
	if (/(?:^|\s|\/)opencode(?:\s|$)/.test(args) && !args.includes(' --')) {
		return {pid, hit: {agent: 'opencode'}};
	}
	if (/^(?:\S+\/)?opencode\s/.test(args.trimStart())) {
		return {pid, hit: {agent: 'opencode'}};
	}

	// 5. claude  (with or without --resume <uuid>)
	//    Skip VSCode extension instances (--output-format stream-json).
	const claudeBin = /(?:^|\s|\/)claude(?:\s|$)/.test(args);
	if (claudeBin && !args.includes('--output-format')) {
		const resume = args.match(/--resume\s+(\S+)/);
		const sessionId =
			resume && UUID_RE.test(resume[1] ?? '') ? resume[1]! : undefined;
		return {pid, hit: {agent: 'claude', sessionId}};
	}
	return null;
}

async function hasNetworkConnection(pid: number): Promise<boolean> {
	try {
		const {stdout} = await execFileAsync('lsof', [
			'-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED', '-P', '-n',
		]);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

async function isOrphan(pid: number): Promise<boolean> {
	try {
		const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=']);
		return stdout.trim() === '1';
	} catch {
		return true;
	}
}

export async function findAliveAgents(): Promise<DiscoveredSession[]> {
	let stdout: string;
	try {
		const r = await execFileAsync('ps', ['-eo', 'pid=,args='], {
			maxBuffer: 8 * 1024 * 1024,
		});
		stdout = r.stdout;
	} catch {
		return [];
	}

	const out: DiscoveredSession[] = [];
	const seen = new Set<string>();
	for (const line of stdout.split('\n')) {
		const c = classifyPsLine(line);
		if (!c) continue;
		const cwd = await lsofCwd(c.pid);

		if (c.hit.agent === 'opencode') {
			if (c.hit.isAttachClient) continue;

			if (c.hit.port === undefined) {
				const [orphan, connected] = await Promise.all([
					isOrphan(c.pid),
					hasNetworkConnection(c.pid),
				]);
				if (orphan && !connected) {
					try { process.kill(c.pid, 'SIGTERM'); } catch {}
					continue;
				}
			}

			let serverUrl: string | undefined;
			let sessionId: string | undefined = c.hit.sessionId;

			if (c.hit.port !== undefined) {
				serverUrl = `http://127.0.0.1:${c.hit.port}`;
				if (!sessionId) {
					sessionId = await fetchOpencodeLatestSession(serverUrl);
				}
			} else if (!sessionId && cwd) {
				sessionId = await findOpencodeSessionForCwd(cwd);
			}

			const key = sessionId ? `opencode:${sessionId}` : `pid:${c.pid}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				agent: 'opencode',
				pid: c.pid,
				cwd,
				serverUrl,
				sessionId,
				alive: true,
			});
			continue;
		}

		// claude
		let sessionId = c.hit.sessionId;
		if (!sessionId && cwd) {
			sessionId = await findCurrentClaudeSessionId(cwd);
		}
		const key = sessionId ? `claude:${sessionId}` : `pid:${c.pid}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			agent: 'claude',
			pid: c.pid,
			cwd,
			sessionId,
			alive: true,
		});
	}
	return out;
}

// ---------- historical sessions ----------

async function readJsonlHead(
	file: string,
	maxBytes = 65536,
): Promise<Record<string, unknown>[]> {
	const handle = await fs.open(file, 'r');
	try {
		const buf = Buffer.alloc(maxBytes);
		const {bytesRead} = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead === 0) return [];
		const text = buf.slice(0, bytesRead).toString('utf8');
		const lines = text.split('\n');
		if (bytesRead === maxBytes) lines.pop();
		const out: Record<string, unknown>[] = [];
		for (const line of lines) {
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				/* skip */
			}
		}
		return out;
	} finally {
		await handle.close();
	}
}

async function countLines(file: string): Promise<number> {
	const data = await fs.readFile(file, 'utf8');
	let n = 0;
	for (let i = 0; i < data.length; i++) {
		if (data.charCodeAt(i) === 10) n++;
	}
	return n;
}

export async function findClaudeHistory(): Promise<DiscoveredSession[]> {
	const root = path.join(
		process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
		'projects',
	);
	let dirs: string[];
	try {
		dirs = await fs.readdir(root);
	} catch {
		return [];
	}

	const out: DiscoveredSession[] = [];
	await Promise.all(
		dirs.map(async dir => {
			const dirPath = path.join(root, dir);
			let entries: string[];
			try {
				const st = await fs.stat(dirPath);
				if (!st.isDirectory()) return;
				entries = await fs.readdir(dirPath);
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.endsWith('.jsonl')) continue;
				const sid = entry.slice(0, -'.jsonl'.length);
				const file = path.join(dirPath, entry);

				let cwd: string | undefined;
				let title: string | undefined;
				try {
					const records = await readJsonlHead(file);
					for (const rec of records) {
						const c = rec['cwd'];
						if (!cwd && typeof c === 'string') cwd = c;
						if (!title && typeof rec['summary'] === 'string') {
							title = rec['summary'] as string;
						}
						if (cwd && title) break;
					}
				} catch {
					/* skip */
				}
				if (!cwd) {
					const guess = dir.replace(/^-/, '/').replace(/-/g, '/');
					try {
						const st = await fs.stat(guess);
						if (st.isDirectory()) cwd = guess;
					} catch {
						/* skip */
					}
				}
				if (!cwd) continue;

				let lastActivity: Date | undefined;
				try {
					const st = await fs.stat(file);
					lastActivity = st.mtime;
				} catch {
					/* skip */
				}
				let messageCount: number | undefined;
				try {
					messageCount = await countLines(file);
				} catch {
					/* skip */
				}
				out.push({
					agent: 'claude',
					sessionId: sid,
					cwd,
					title,
					lastActivity,
					messageCount,
					alive: false,
				});
			}
		}),
	);
	return out;
}

export async function findOpencodeHistory(): Promise<DiscoveredSession[]> {
	const db = path.join(
		os.homedir(),
		'.local',
		'share',
		'opencode',
		'opencode.db',
	);
	try {
		await fs.access(db);
	} catch {
		return [];
	}
	const query =
		`SELECT id, directory, title, time_updated FROM session ` +
		`WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 500;`;
	let stdout: string;
	try {
		const r = await execFileAsync(
			'sqlite3',
			['-readonly', '-json', db, query],
			{maxBuffer: 16 * 1024 * 1024},
		);
		stdout = r.stdout;
	} catch {
		return [];
	}
	if (!stdout.trim()) return [];
	let rows: Array<{
		id: string;
		directory: string;
		title: string;
		time_updated: number;
	}>;
	try {
		rows = JSON.parse(stdout);
	} catch {
		return [];
	}
	return rows.map(r => ({
		agent: 'opencode' as const,
		sessionId: r.id,
		cwd: r.directory,
		title: r.title,
		lastActivity: new Date(r.time_updated),
		alive: false,
	}));
}

/**
 * Full discovery: alive processes + history, with alive entries promoted
 * (when the same sessionId appears in both, only the alive one is kept).
 */
export async function discoverAll(): Promise<DiscoveredSession[]> {
	const [alive, claudeHist, ocHist] = await Promise.all([
		findAliveAgents(),
		findClaudeHistory(),
		findOpencodeHistory(),
	]);

	const aliveSids = new Set(
		alive.map(a => a.sessionId).filter((s): s is string => !!s),
	);
	const historical = [...claudeHist, ...ocHist].filter(
		h => !h.sessionId || !aliveSids.has(h.sessionId),
	);

	const out = [...alive, ...historical];
	out.sort((a, b) => {
		if (a.alive !== b.alive) return a.alive ? -1 : 1;
		const at = a.lastActivity?.getTime() ?? 0;
		const bt = b.lastActivity?.getTime() ?? 0;
		return bt - at;
	});
	return out;
}
