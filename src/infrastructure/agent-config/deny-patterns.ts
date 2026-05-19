/**
 * Server-side hard deny list. Even if the worker's local config is tampered
 * with, the aggregator runs every approval *attempt* (from any source: an
 * orchestrator, a CLI user, an attached TUI client) through this list before
 * forwarding to the worker. Patterns that match are forcibly rejected with a
 * reason; the request never gets an "allow" reply from workboss.
 *
 * These are categorically irreversible / out-of-scope-for-an-agent actions:
 * destroying history, escalating to root, or shell-injection patterns where
 * a remote payload becomes executable.
 *
 * NOT in this list (and thus reachable via normal allow/ask):
 *   plain curl/wget downloads, npm install, git push (non-force), git commit,
 *   any kind of file write inside the worker's cwd, anything benign.
 */

export interface HardDenyRule {
	permission: string; // 'bash' | 'edit' | 'webfetch' | ...
	regex: RegExp;
	reason: string;
}

export const HARD_DENY: HardDenyRule[] = [
	{
		permission: 'bash',
		regex: /\brm\s+-rf\b/,
		reason: 'rm -rf is irreversible and forbidden by workboss policy',
	},
	{
		permission: 'bash',
		regex: /\bsudo\b/,
		reason: 'sudo escalates privileges and is forbidden by workboss policy',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+push\s+(?:-f\b|--force\b)/,
		reason: 'git push --force rewrites remote history; forbidden by workboss policy',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+reset\s+--hard\b/,
		reason: 'git reset --hard discards working tree changes; forbidden by workboss policy',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+checkout\s+--\s/,
		reason: 'git checkout -- discards local changes; forbidden by workboss policy',
	},
	{
		permission: 'bash',
		regex: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh)\b/,
		reason: 'piping a remote download into a shell is a known RCE pattern; forbidden by workboss policy',
	},
];

export function matchHardDeny(
	permission: string,
	patterns: readonly string[],
): HardDenyRule | null {
	for (const rule of HARD_DENY) {
		if (rule.permission !== permission) continue;
		for (const pat of patterns) {
			if (rule.regex.test(pat)) return rule;
		}
	}
	return null;
}
