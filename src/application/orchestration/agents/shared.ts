/**
 * Helpers used by more than one adapter. Lives outside both adapter modules
 * to avoid them having to import each other.
 */

import {promises as fs} from 'fs';
import path from 'path';
import {workerInboxPath, workerMissionPath} from '../../../infrastructure/filesystem/paths.js';
import {workerBootstrapInstructions} from '../../../presentation/templates/templates.js';

/**
 * Append a workboss instruction block, marked with an HTML comment so we
 * recognise it on re-runs, to the given doc inside the worker cwd. Existing
 * content is preserved.
 */
export async function injectBootstrapDoc(
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
		/* file does not exist yet */
	}
	if (existing.includes(marker)) return;
	const prefix = existing.trim() ? existing.trimEnd() + '\n\n' : '';
	await fs.writeFile(docPath, `${prefix}${marker}\n${bootstrap}`, 'utf8');
}

export const OPENCODE_DB_PATH = path.join(
	process.env['HOME'] || '/root',
	'.local', 'share', 'opencode', 'opencode.db',
);

export const CLAUDE_PROJECTS_DIR = path.join(
	process.env['HOME'] || '/root',
	'.claude', 'projects',
);

const TOOL_SUMMARY_MAX = 60;
const USER_MSG_MAX = 120;
const RECENT_ACTIONS_LIMIT = 10;
const RECENT_MESSAGES_LIMIT = 5;
const DETAIL_ACTIONS_SHOWN = 3;
const ROW_TITLE_MAX = 30;
const DETAIL_MSG_MAX = 80;
const DETAIL_ACTION_MAX = 70;

export {TOOL_SUMMARY_MAX, USER_MSG_MAX, RECENT_ACTIONS_LIMIT, RECENT_MESSAGES_LIMIT, DETAIL_ACTIONS_SHOWN, ROW_TITLE_MAX, DETAIL_MSG_MAX, DETAIL_ACTION_MAX};

type ToolSummaryArgs = {
	toolName: string;
	input: Record<string, unknown>;
	metadata?: {description?: string};
};

export function formatToolSummary(args: ToolSummaryArgs): string {
	const {toolName, input, metadata} = args;
	const cmd = (input['command'] as string) ?? '';
	const filePath = (input['filePath'] as string) ?? (input['file_path'] as string) ?? '';

	if (cmd && (toolName === 'bash' || toolName === 'Bash')) {
		return cmd.slice(0, TOOL_SUMMARY_MAX);
	}
	if (filePath && (toolName === 'edit' || toolName === 'write' || toolName === 'read' || toolName === 'Write' || toolName === 'Read')) {
		return filePath.slice(0, TOOL_SUMMARY_MAX);
	}
	if (metadata?.description) {
		return metadata.description.slice(0, TOOL_SUMMARY_MAX);
	}
	return JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX);
}

export function truncateMessage(text: string): string {
	return text.slice(0, USER_MSG_MAX).replace(/\n/g, ' ');
}

export function sqlEscape(value: string): string {
	return value.replace(/'/g, "''");
}
