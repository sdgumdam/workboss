import path from 'path';

import type {DiscoveredSession} from '../session-scanner.js';
import {discoverAll} from '../session-scanner.js';
import {FsWorkerRepository} from '../../../infrastructure/filesystem/worker-repo.js';
import {shortSid, shortCwd, fmtAge, pickUniqueName} from '../../../presentation/format.js';

import {ok} from './utils.js';
import {registerWorker} from './lifecycle.js';

const workerRepo = new FsWorkerRepository();

export interface DiscoverOptions {
	all?: boolean;
	registerAlive?: boolean;
	json?: boolean;
}

export interface KnownIndex {
	sids: Set<string>;
	urls: Set<string>;
	names: Set<string>;
}

export async function indexKnownWorkers(): Promise<KnownIndex> {
	const ws = await workerRepo.list();
	return {
		sids: new Set(ws.map(w => w.sessionId).filter((s): s is string => !!s)),
		urls: new Set(
			ws.map(w => w.process?.serve?.serverUrl).filter((u): u is string => !!u),
		),
		names: new Set(ws.map(w => w.name)),
	};
}

export function partitionUnknown(
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

export function printAliveSection(alive: DiscoveredSession[]): void {
	if (alive.length === 0) return;
	ok('可立即收编 (alive, 未注册):');
	for (const d of alive) {
		const where = d.serverUrl ?? (d.pid ? `pid ${d.pid}` : '?');
		ok(
			`  ${d.agent.padEnd(8)}  ${where.padEnd(28)}  ${shortCwd(d.cwd, 35).padEnd(37)}  ${shortSid(d.sessionId)}`,
		);
	}
}

export function printHistorySection(
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

export function nameSuggestion(d: DiscoveredSession): string {
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
