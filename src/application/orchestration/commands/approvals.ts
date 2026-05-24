import {FsApprovalRepository} from '../../../infrastructure/filesystem/approval-repo.js';
import {rpcCall} from '../../../infrastructure/http/server-rpc.js';

import {ok, fail} from './utils.js';

const approvalRepo = new FsApprovalRepository();

interface ApprovalRow {
	id: string;
	worker: string;
	permission: string;
	patterns: string[];
	capturedAt?: string;
}

function formatApprovalRow(a: ApprovalRow): string {
	const age = a.capturedAt
		? `${Math.floor((Date.now() - new Date(a.capturedAt).getTime()) / 1000)}s`
		: '?';
	return `${a.id}  ${a.worker.padEnd(20)}  ${a.permission.padEnd(8)}  ${age.padEnd(5)}  ${JSON.stringify(a.patterns)}`;
}

export async function approvalsList(): Promise<void> {
	const r = await rpcCall({kind: 'ping'});
	const serverUp = r.ok;
	const list = serverUp
		? await (async () => {
				const ar = await rpcCall({kind: 'approvals.list'});
				if (!ar.ok) fail(ar.error);
				return (ar.data ?? []) as ApprovalRow[];
			})()
		: ((await approvalRepo.list()) as ApprovalRow[]);

	if (list.length === 0) {
		ok(
			serverUp
				? '(no pending approvals)'
				: '(no pending approvals; workboss server is not running)',
		);
		return;
	}
	for (const a of list) ok(formatApprovalRow(a));
}

export async function approve(id: string, always: boolean): Promise<void> {
	const r = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: always ? 'always' : 'once',
	});
	if (!r.ok) fail(r.error);
	ok(`approved ${id} (${always ? 'always' : 'once'})`);
}

export async function reject(id: string, reason: string): Promise<void> {
	const r = await rpcCall({
		kind: 'approvals.reply',
		id,
		reply: 'reject',
		message: reason,
	});
	if (!r.ok) fail(r.error);
	ok(`rejected ${id}`);
}
