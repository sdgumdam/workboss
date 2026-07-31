/**
 * Generators for the files we drop into a Claude Code worker's cwd to wire
 * its permission flow through the workboss aggregator.
 *
 * Claude Code reads `.claude/settings.local.json` from the project cwd. We
 * write:
 *   - permissions.allow / deny: the static rules we'd otherwise duplicate at
 *     the workboss layer. These short-circuit common safe and unsafe calls
 *     without an HTTP roundtrip.
 *   - hooks.PreToolUse: a single HTTP hook pointed at our aggregator with the
 *     worker name baked into the URL path, so the server knows which queue
 *     to file the request under.
 *
 * If a settings.local.json already exists we merge non-destructively — we
 * only overwrite the keys we own.
 *
 * ## Hook 请求的完整路径（E2E 必须全部覆盖）
 *
 * Claude 进程发 PreToolUse hook → settings.local.json 里的 URL → daemon HTTP
 * → dispatchHookRequest → registry.lookup(workerName) → adapter.handleHookRequest
 *
 * Worker 进入 registry 有三条路径，**每条路径都必须有 E2E 测试**：
 *
 * | 路径 | 触发方式 | registry 时机 | E2E case |
 * |------|---------|--------------|----------|
 * | A. daemon 启动加载 | server start | 启动时遍历 disk | T6/T7 |
 * | B. 用户手动 register | CLI register | notifyAggregator RPC | T6/T7 |
 * | C. patrol 自动 adopt | 60s sweep | adoptDiscoveredWorker | T25 |
 *
 * Bug 历史 (2026-05-25): 路径 C 的 adoptDiscoveredWorker() 写了磁盘但没发
 * workers.attach RPC，导致 daemon registry 里没有这个 worker。Hook 到达后
 * 返回 ask 而非 allow，用户被弹权限确认框。
 *
 * 另一个已知问题：同 cwd 多个 claude worker 共享一份 settings.local.json，
 * 最后写入的 hook URL 覆盖前面的。见 T26。
 */

import {promises as fs, existsSync} from 'fs';
import path from 'path';

export interface ClaudeSettingsParams {
	workerName: string;
	workbossServerUrl: string; // e.g. http://127.0.0.1:4123
	hookTimeoutSec?: number; // default 300
}

export function buildClaudeSettings(p: ClaudeSettingsParams): unknown {
	return {
		permissions: {
			allow: [
				'Edit',
				'Write',
				'MultiEdit',
				'Read(**)',
				'WebFetch',
			],
			deny: [],
		},
		hooks: {
			PreToolUse: [
				{
					matcher: '*',
					hooks: [
						{
							type: 'http',
							url: `${p.workbossServerUrl}/claude-hook/${encodeURIComponent(p.workerName)}`,
							timeout: p.hookTimeoutSec ?? 300,
						},
					],
				},
			],
		},
	};
}

/**
 * Writes (or merges into) `<cwd>/.claude/settings.local.json` so a Claude Code
 * session started in that cwd will route every PreToolUse through workboss.
 */
export async function writeClaudeSettings(
	cwd: string,
	params: ClaudeSettingsParams,
): Promise<string> {
	const settingsDir = path.join(cwd, '.claude');
	if (!existsSync(settingsDir)) {
		await fs.mkdir(settingsDir, {recursive: true});
	}
	const settingsPath = path.join(settingsDir, 'settings.local.json');

	const ours = buildClaudeSettings(params) as Record<string, unknown>;
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<
			string,
			unknown
		>;
	} catch {
		/* fresh */
	}

	// Merge: keep any other keys the user had, but replace `permissions` and
	// `hooks` with ours so the workboss policy is authoritative.
	const merged = {
		...existing,
		permissions: ours['permissions'],
		hooks: ours['hooks'],
	};
	await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
	return settingsPath;
}

/**
 * The shape Claude Code POSTs to a PreToolUse HTTP hook (snake_case fields).
 */
export interface ClaudePreToolUseRequest {
	session_id: string;
	cwd?: string;
	hook_event_name?: 'PreToolUse';
	tool_name: string;
	tool_input: Record<string, unknown>;
}

export interface ClaudeHookResponse {
	hookSpecificOutput: {
		hookEventName: 'PreToolUse';
		permissionDecision: 'allow' | 'deny' | 'ask';
		permissionDecisionReason?: string;
	};
}

/**
 * Extract a list of human-readable / pattern-matchable strings from the tool
 * input. workboss uses these for hard-deny matching and for showing the user
 * what the worker is asking permission to do.
 */
export function extractPatterns(
	toolName: string,
	toolInput: Record<string, unknown>,
): string[] {
	const tn = toolName.toLowerCase();
	if (tn === 'bash') {
		const cmd = toolInput['command'];
		if (typeof cmd === 'string') return [cmd];
	}
	if (tn === 'edit' || tn === 'write' || tn === 'multiedit') {
		const fp = (toolInput['file_path'] ?? toolInput['path']) as
			| string
			| undefined;
		if (fp) return [fp];
	}
	if (tn === 'webfetch') {
		const url = toolInput['url'];
		if (typeof url === 'string') return [url];
	}
	// Fallback: stringified shape so the user has at least some context.
	return [JSON.stringify(toolInput).slice(0, 200)];
}

/**
 * Map a Claude tool name to the workboss permission category. The keys here
 * match what `lib/deny-patterns.ts` checks against.
 */
export function classifyToolName(toolName: string): string {
	const t = toolName.toLowerCase();
	if (t === 'bash') return 'bash';
	if (t === 'edit' || t === 'write' || t === 'multiedit') return 'edit';
	if (t === 'webfetch') return 'webfetch';
	if (t === 'read') return 'read';
	return t;
}
