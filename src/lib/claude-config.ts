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
 */

import {promises as fs, existsSync} from 'fs';
import path from 'path';

export interface ClaudeSettingsParams {
	workerName: string;
	workbossServerUrl: string; // e.g. http://127.0.0.1:4123
	hookTimeoutSec?: number; // default 300
}

export function buildClaudeSettings(p: ClaudeSettingsParams): unknown {
	const hookUrl = `${p.workbossServerUrl}/claude-hook/${encodeURIComponent(p.workerName)}`;
	return {
		permissions: {
			allow: [
				'Read(**)',
				'Bash(ls *)',
				'Bash(cat *)',
				'Bash(grep *)',
				'Bash(rg *)',
				'Bash(find *)',
				'Bash(pwd)',
				'Bash(git status)',
				'Bash(git diff*)',
				'Bash(git log*)',
				'Bash(git branch*)',
				'Bash(git show*)',
				'Bash(npm test*)',
				'Bash(npm run test*)',
				'Bash(bun test*)',
				'Bash(pytest*)',
				'Bash(curl *)',
				'Bash(wget *)',
				'WebFetch',
			],
			deny: [
				'Bash(rm -rf *)',
				'Bash(sudo *)',
				'Bash(git push --force*)',
				'Bash(git push -f*)',
				'Bash(git reset --hard*)',
				'Bash(git checkout -- *)',
			],
		},
		hooks: {
			PreToolUse: [
				{
					matcher: '*',
					hooks: [
						{
							type: 'http',
							url: hookUrl,
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
