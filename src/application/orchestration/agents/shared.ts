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
