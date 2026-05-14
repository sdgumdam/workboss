import {
	approve,
	approvalsList,
	attachWorker,
	bossCmd,
	detachWorker,
	discoverCmd,
	listWorkersCmd,
	messageWorker,
	printHelp,
	registerWorker,
	reject,
	removeWorker,
	serverStart,
	serverStatus,
	serverStop,
	showWorker,
	spawnWorker,
	tailWorker,
} from './commands.js';
import type {AgentKind} from './lib/types.js';

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string | boolean>;
}

function parse(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags = new Map<string, string | boolean>();
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i]!;
		if (tok.startsWith('--')) {
			const eq = tok.indexOf('=');
			if (eq !== -1) {
				flags.set(tok.slice(2, eq), tok.slice(eq + 1));
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith('--')) {
					flags.set(tok.slice(2), next);
					i++;
				} else {
					flags.set(tok.slice(2), true);
				}
			}
		} else if (tok === '-n') {
			const next = argv[i + 1];
			if (next !== undefined) {
				flags.set('n', next);
				i++;
			}
		} else {
			positional.push(tok);
		}
	}
	return {positional, flags};
}

function s(p: ParsedArgs, k: string): string | undefined {
	const v = p.flags.get(k);
	return typeof v === 'string' ? v : undefined;
}

function b(p: ParsedArgs, k: string): boolean {
	return p.flags.has(k);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (
		args.length === 0 ||
		args[0] === 'help' ||
		args[0] === '--help' ||
		args[0] === '-h'
	) {
		printHelp();
		return;
	}

	const cmd = args[0]!;
	const rest = parse(args.slice(1));

	switch (cmd) {
		case 'server': {
			const sub = rest.positional[0];
			if (sub === 'start') return serverStart();
			if (sub === 'stop') return serverStop();
			if (sub === 'status' || sub === undefined) return serverStatus();
			console.error(`unknown server subcommand: ${sub}`);
			process.exit(1);
		}

		case 'boss':
			return bossCmd({
				agent: (s(rest, 'agent') as 'opencode' | 'claude' | undefined),
			});

		case 'spawn': {
			const name = rest.positional[0];
			if (!name) {
				console.error(
					'usage: workboss spawn <name> --task "..." --cwd <path> [--agent opencode|claude]',
				);
				process.exit(1);
			}
			const cwd = s(rest, 'cwd');
			if (!cwd) {
				console.error('--cwd is required');
				process.exit(1);
			}
			return spawnWorker({
				name,
				cwd,
				missionFile: s(rest, 'mission'),
				missionInline: s(rest, 'task'),
				agent: (s(rest, 'agent') as AgentKind | undefined) ?? 'opencode',
				port: s(rest, 'port') ? parseInt(s(rest, 'port')!, 10) : undefined,
			});
		}

		case 'register': {
			const name = rest.positional[0];
			const agent = s(rest, 'agent') as AgentKind | undefined;
			const cwd = s(rest, 'cwd');
			const sessionId = s(rest, 'session-id') ?? s(rest, 'session');
			if (!name || !agent || !cwd || !sessionId) {
				console.error(
					'usage: workboss register <name> --agent opencode|claude --cwd <path> --session-id <sid> [--server-url <url>]',
				);
				process.exit(1);
			}
			return registerWorker({
				name,
				agent,
				cwd,
				sessionId,
				serverUrl: s(rest, 'server-url'),
			});
		}

		case 'attach': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss attach <name>');
				process.exit(1);
			}
			return attachWorker(name);
		}

		case 'discover':
			return discoverCmd({
				all: b(rest, 'all'),
				registerAlive: b(rest, 'register-alive'),
				json: b(rest, 'json'),
			});

		case 'detach': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss detach <name>');
				process.exit(1);
			}
			return detachWorker(name);
		}

		case 'remove':
		case 'rm': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss remove <name>');
				process.exit(1);
			}
			return removeWorker(name);
		}

		case 'kill': {
			// alias kept for muscle memory; semantically the same as detach
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss detach <name>');
				process.exit(1);
			}
			return detachWorker(name);
		}

		case 'list':
			return listWorkersCmd();

		case 'show': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss show <name>');
				process.exit(1);
			}
			return showWorker(name);
		}

		case 'message': {
			const name = rest.positional[0];
			const text = rest.positional.slice(1).join(' ');
			if (!name || !text) {
				console.error('usage: workboss message <name> "text"');
				process.exit(1);
			}
			return messageWorker(name, text);
		}

		case 'tail': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss tail <name> [-n N]');
				process.exit(1);
			}
			const n = s(rest, 'n') ?? '20';
			return tailWorker(name, parseInt(n, 10));
		}

		case 'approvals': {
			const sub = rest.positional[0];
			if (sub === 'list' || sub === undefined) return approvalsList();
			console.error(`unknown approvals subcommand: ${sub}`);
			process.exit(1);
		}

		case 'approve': {
			const id = rest.positional[0];
			if (!id) {
				console.error('usage: workboss approve <id> [--always]');
				process.exit(1);
			}
			return approve(id, b(rest, 'always'));
		}

		case 'reject': {
			const id = rest.positional[0];
			if (!id) {
				console.error('usage: workboss reject <id> --reason "..."');
				process.exit(1);
			}
			return reject(id, s(rest, 'reason') ?? 'rejected');
		}

		default:
			console.error(`unknown command: ${cmd}`);
			printHelp();
			process.exit(1);
	}
}

main().catch(err => {
	console.error('workboss:', err instanceof Error ? err.message : String(err));
	process.exit(1);
});
