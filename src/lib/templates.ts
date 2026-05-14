/**
 * Generators for the files we drop into a worker's runtime directory.
 * Kept as pure functions so they're easy to inspect and override.
 */

/**
 * Default permission ruleset injected into every spawned OpenCode worker via
 * OPENCODE_CONFIG. Ordering matters: OpenCode evaluates with "last match
 * wins", so deny rules sit at the bottom to override the broader allows.
 *
 * Edit-or-write goes through `ask` so the orchestrator (or you) decides per
 * worker. read and webfetch are pre-approved per user preference.
 */
export function defaultOpenCodePermissionConfig(): string {
	const cfg = {
		$schema: 'https://opencode.ai/config.json',
		permission: {
			bash: {
				'*': 'ask',
				'ls *': 'allow',
				'cat *': 'allow',
				'grep *': 'allow',
				'rg *': 'allow',
				'find *': 'allow',
				pwd: 'allow',
				'git status': 'allow',
				'git diff*': 'allow',
				'git log*': 'allow',
				'git branch*': 'allow',
				'git show*': 'allow',
				'npm test*': 'allow',
				'npm run test*': 'allow',
				'bun test*': 'allow',
				'pytest*': 'allow',
				'curl *': 'allow',
				'wget *': 'allow',
				'rm -rf *': 'deny',
				'sudo *': 'deny',
				'git push --force*': 'deny',
				'git push -f*': 'deny',
				'git reset --hard*': 'deny',
				'git checkout -- *': 'deny',
				'*curl*| sh*': 'deny',
				'*curl*| bash*': 'deny',
				'*wget*| sh*': 'deny',
				'*wget*| bash*': 'deny',
			},
			edit: 'ask',
			read: 'allow',
			webfetch: 'allow',
		},
	};
	return JSON.stringify(cfg, null, 2) + '\n';
}

export function workerBootstrapInstructions(
	workerName: string,
	missionPath: string,
	inboxPath: string,
): string {
	return [
		`# You are a workboss-managed worker named "${workerName}".`,
		'',
		'## Your mission',
		`The complete task brief is in \`${missionPath}\`. Read it first if you have not already.`,
		'',
		'## Inbox protocol (important)',
		`The user works with you via a coordinator called "workboss". The coordinator drops messages for you into \`${inboxPath}\`.`,
		'',
		'**Before responding to the user, do this:**',
		'',
		`1. \`cat ${inboxPath}\` to see if there is new content since you last checked.`,
		'2. If there are messages you have not yet acted on, treat them as instructions from the coordinator and address them in your reply.',
		'3. If the inbox is empty or unchanged, just continue with whatever the user is currently asking.',
		'',
		'You do not need to write to any workboss files yourself. Your normal session transcript is enough for the coordinator to see your progress.',
		'',
	].join('\n');
}

export interface MissionInput {
	title?: string;
	body: string;
}

export function renderMissionFile(input: MissionInput): string {
	const title = input.title?.trim() ?? 'Mission';
	return `# ${title}\n\n${input.body.trim()}\n`;
}
