import {claudeAdapter} from './claude.js';
import {openCodeAdapter} from './opencode.js';
import type {AgentAdapter} from './types.js';
import type {AgentKind} from '../../../domain/worker.js';
import {registerBareTUIDetector} from '../../../infrastructure/tmux/tmux.js';

export type {AgentAdapter} from './types.js';
export type {ClassifiedProcess, DiscoveredSession, HookContext} from './types.js';

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

registerBareTUIDetector((cmd: string) => {
	for (const adapter of Object.values(REGISTRY)) {
		if (adapter.isBareTUICommand(cmd)) return true;
	}
	return false;
});
