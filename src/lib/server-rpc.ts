/**
 * Tiny JSON-over-TCP/Unix-socket protocol the workboss CLI uses to talk to
 * the long-running aggregator daemon. The daemon owns the SSE subscriptions
 * to every worker; CLI invocations just ask it to list, approve, or reject.
 *
 * We avoid a full HTTP framework — the surface is tiny and a single line of
 * NDJSON request -> NDJSON response is enough.
 *
 * Wire format:
 *   client -> server: one JSON object terminated by "\n"
 *   server -> client: one JSON object terminated by "\n"
 */

import net from 'net';
import {readServerPort} from './storage.js';

export type RpcRequest =
	| {kind: 'ping'}
	| {kind: 'approvals.list'}
	| {kind: 'approvals.reply'; id: string; reply: 'once' | 'always' | 'reject'; message?: string}
	| {kind: 'workers.attach'; name: string}
	| {kind: 'workers.detach'; name: string};

export type RpcResponse =
	| {ok: true; data?: unknown}
	| {ok: false; error: string};

export async function rpcCall(req: RpcRequest): Promise<RpcResponse> {
	const port = await readServerPort();
	if (port === null) {
		return {
			ok: false,
			error: 'workboss server is not running. Start it with `workboss server start`.',
		};
	}
	return new Promise(resolve => {
		const sock = net.createConnection({host: '127.0.0.1', port}, () => {
			sock.write(JSON.stringify(req) + '\n');
		});
		let buf = '';
		sock.setEncoding('utf8');
		sock.on('data', chunk => {
			buf += chunk;
			const nl = buf.indexOf('\n');
			if (nl !== -1) {
				try {
					const res = JSON.parse(buf.slice(0, nl)) as RpcResponse;
					resolve(res);
				} catch (err) {
					resolve({ok: false, error: `bad response: ${String(err)}`});
				}
				sock.end();
			}
		});
		sock.on('error', err => {
			resolve({
				ok: false,
				error: `cannot reach workboss server on ${port}: ${err.message}`,
			});
		});
	});
}
