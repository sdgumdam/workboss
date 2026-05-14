import {
	adoptWorker,
	approve,
	approvalsList,
	killWorker,
	listWorkersCmd,
	messageWorker,
	printHelp,
	reject,
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
	if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
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

		case 'spawn': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss spawn <name> --task "..." --cwd <path>');
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

		case 'adopt': {
			const name = rest.positional[0];
			const url = s(rest, 'url');
			if (!name || !url) {
				console.error('usage: workboss adopt <name> --url http://localhost:<port> [--cwd <path>]');
				process.exit(1);
			}
			return adoptWorker({name, url, cwd: s(rest, 'cwd')});
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

		case 'kill': {
			const name = rest.positional[0];
			if (!name) {
				console.error('usage: workboss kill <name>');
				process.exit(1);
			}
			return killWorker(name);
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
