import {getServerPort} from '../filesystem/paths.js';

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
	const port = getServerPort();
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
			error: `cannot reach workboss server on port ${port}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
