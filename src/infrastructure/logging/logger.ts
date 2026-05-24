import {createWriteStream, mkdirSync} from 'fs';
import path from 'path';
import {LOG_FILE} from '../filesystem/paths.js';

let stream: ReturnType<typeof createWriteStream> | null = null;

function getStream() {
	if (!stream) {
		mkdirSync(path.dirname(LOG_FILE), {recursive: true});
		stream = createWriteStream(LOG_FILE, {flags: 'a'});
		stream.on('error', () => {});
	}
	return stream;
}

export interface Logger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
	const prefix = module;

	function write(level: string, msg: string, args: unknown[]) {
		const ts = new Date().toISOString();
		const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
		const line = `[${ts}] [${level}] [${prefix}] ${msg}${parts.length ? ' ' + parts.join(' ') : ''}\n`;
		getStream().write(line);
		if (level === 'error') {
			process.stderr.write(line);
		}
	}

	return {
		info(msg: string, ...args: unknown[]) { write('INFO', msg, args); },
		warn(msg: string, ...args: unknown[]) { write('WARN', msg, args); },
		error(msg: string, ...args: unknown[]) { write('ERROR', msg, args); },
	};
}
