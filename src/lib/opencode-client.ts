/**
 * Thin client for an opencode `serve` instance. We only use the bits we need:
 *   GET  /permission                       -> list pending
 *   POST /permission/:id/reply             -> reply once/always/reject
 *   GET  /event   (SSE)                    -> stream bus events
 *
 * OpenCode 1.14.x runs the experimental HttpApi under those exact paths
 * (see opencode/packages/opencode/src/server/routes/instance/httpapi/...).
 *
 * The endpoints are guarded by OpenCode's Authorization middleware. If the
 * worker was launched without a password, no auth header is needed; if you
 * set OPENCODE_SERVER_PASSWORD before spawning the worker, we pass it here.
 */

import type {ReplyKind} from './types.js';

export interface OpenCodePermissionRequest {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: {messageID: string; callID: string};
}

export interface OpenCodeBusEvent {
	id: string;
	type: string;
	properties: Record<string, unknown>;
}

export interface OpenCodeClientOptions {
	baseUrl: string; // e.g. http://127.0.0.1:4096
	username?: string;
	password?: string;
}

function authHeader(opts: OpenCodeClientOptions): Record<string, string> {
	if (!opts.password) return {};
	const user = opts.username ?? 'opencode';
	const tok = Buffer.from(`${user}:${opts.password}`).toString('base64');
	return {Authorization: `Basic ${tok}`};
}

export async function listPermissions(
	opts: OpenCodeClientOptions,
): Promise<OpenCodePermissionRequest[]> {
	const res = await fetch(`${opts.baseUrl}/permission`, {
		headers: {...authHeader(opts)},
	});
	if (!res.ok) {
		throw new Error(
			`opencode permission/list failed: ${res.status} ${res.statusText}`,
		);
	}
	return (await res.json()) as OpenCodePermissionRequest[];
}

export async function replyPermission(
	opts: OpenCodeClientOptions,
	requestID: string,
	reply: ReplyKind,
	message?: string,
): Promise<void> {
	const body: Record<string, unknown> = {reply};
	if (message) body.message = message;
	const res = await fetch(`${opts.baseUrl}/permission/${requestID}/reply`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...authHeader(opts),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(
			`opencode permission/reply failed: ${res.status} ${res.statusText} ${text}`,
		);
	}
}

/**
 * Open an SSE connection to the worker's `/event` stream and yield parsed
 * bus events. Yields forever until the caller breaks out of the loop or the
 * underlying stream closes; reconnection is the caller's responsibility.
 */
export async function* subscribeEvents(
	opts: OpenCodeClientOptions,
	signal?: AbortSignal,
): AsyncGenerator<OpenCodeBusEvent> {
	const res = await fetch(`${opts.baseUrl}/event`, {
		headers: {Accept: 'text/event-stream', ...authHeader(opts)},
		signal,
	});
	if (!res.ok || !res.body) {
		throw new Error(
			`opencode /event subscribe failed: ${res.status} ${res.statusText}`,
		);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	while (true) {
		const {value, done} = await reader.read();
		if (done) return;
		buf += decoder.decode(value, {stream: true});
		// SSE messages are separated by blank lines. Within each, "data: ..."
		// lines accumulate into the message body.
		while (true) {
			const sepIdx = buf.indexOf('\n\n');
			if (sepIdx === -1) break;
			const block = buf.slice(0, sepIdx);
			buf = buf.slice(sepIdx + 2);
			const dataLines: string[] = [];
			for (const line of block.split('\n')) {
				if (line.startsWith('data:')) {
					dataLines.push(line.slice(5).trimStart());
				}
			}
			if (dataLines.length === 0) continue;
			const payload = dataLines.join('\n');
			try {
				yield JSON.parse(payload) as OpenCodeBusEvent;
			} catch {
				/* skip malformed */
			}
		}
	}
}
