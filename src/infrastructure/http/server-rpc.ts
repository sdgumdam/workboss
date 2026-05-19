/**
 * RPC client used by the workboss CLI to talk to the running aggregator
 * daemon. The daemon exposes an HTTP server on a random local port; we POST
 * a JSON request to /rpc and parse the JSON response.
 */

import {readServerPort} from '../filesystem/approval-repo.js';

export type RpcRequest =
	| {kind: 'ping'}
	| {kind: 'approvals.list'}
	| {
			kind: 'approvals.reply';
			id: string;
			reply: 'once' | 'always' | 'reject';
			message?: string;
	  }
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
			error:
				'workboss server is not running. Start it with `workboss server start`.',
		};
	}
	try {
		const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(req),
		});
		const data = (await res.json()) as RpcResponse;
		return data;
	} catch (err) {
		return {
			ok: false,
			error: `cannot reach workboss server on ${port}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
