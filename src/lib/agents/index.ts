import {claudeAdapter} from './claude.js';
import {openCodeAdapter} from './opencode.js';
import type {AgentAdapter} from './types.js';
import type {AgentKind} from '../types.js';

export {claudeAdapter, openCodeAdapter};
export type {AgentAdapter} from './types.js';

const REGISTRY: Record<AgentKind, AgentAdapter> = {
	claude: claudeAdapter,
	opencode: openCodeAdapter,
};

export function getAdapter(kind: AgentKind): AgentAdapter {
	const a = REGISTRY[kind];
	if (!a) throw new Error(`unsupported agent: ${kind}`);
	return a;
}

export function listAdapters(): AgentAdapter[] {
	return Object.values(REGISTRY);
}
