export interface HardDenyRule {
	permission: string;
	regex: RegExp;
	reason: string;
}

export const HARD_DENY: HardDenyRule[] = [
	{
		permission: 'bash',
		regex: /\brm\s+-rf\b/,
		reason: 'rm -rf is irreversible and requires approval',
	},
	{
		permission: 'bash',
		regex: /\bsudo\b/,
		reason: 'sudo escalates privileges and requires approval',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+push\s+(?:-f\b|--force\b)/,
		reason: 'git push --force rewrites remote history and requires approval',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+reset\s+--hard\b/,
		reason: 'git reset --hard discards working tree changes and requires approval',
	},
	{
		permission: 'bash',
		regex: /\bgit\s+checkout\s+--\s/,
		reason: 'git checkout -- discards local changes and requires approval',
	},
	{
		permission: 'bash',
		regex: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh)\b/,
		reason: 'piping a remote download into a shell requires approval',
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
