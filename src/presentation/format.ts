/**
 * Display helpers used across CLI output. Pure, no I/O.
 */

export function fmtAge(d?: Date): string {
	if (!d) return '?';
	const ms = Date.now() - d.getTime();
	if (ms < 0) return 'just now';
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s 前`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m 前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h 前`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d 前`;
	const mo = Math.floor(day / 30);
	if (mo < 12) return `${mo}mo 前`;
	return `${Math.floor(mo / 12)}y 前`;
}

export function shortSid(sid?: string): string {
	if (!sid) return '(no-sid)';
	return sid.startsWith('ses_')
		? sid.slice(0, 12) + '…'
		: sid.slice(0, 8) + '…';
}

export function shortCwd(cwd: string | undefined, maxLen = 40): string {
	if (!cwd) return '?';
	const home = process.env['HOME'];
	let out = cwd;
	if (home && cwd.startsWith(home)) out = '~' + cwd.slice(home.length);
	if (out.length <= maxLen) return out;
	return '…' + out.slice(out.length - (maxLen - 1));
}

/** Pick a non-colliding workboss-style name from a candidate base. */
export function pickUniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}
