import os from 'os';
import path from 'path';

const HOME = os.homedir();

export const DEFAULT_PORT = 58212;

export function getServerPort(): number {
	const env = process.env['WORKBOSS_PORT'];
	if (env) {
		const n = parseInt(env, 10);
		if (Number.isFinite(n) && n > 0 && n < 65536) return n;
	}
	return DEFAULT_PORT;
}

export function getServerUrl(): string {
	return `http://127.0.0.1:${getServerPort()}`;
}

export const WORKBOSS_ROOT = path.join(HOME, '.workboss');
export const WORKERS_DIR = path.join(WORKBOSS_ROOT, 'workers');
export const APPROVALS_DIR = path.join(WORKBOSS_ROOT, 'approvals');
export const SERVER_LOG_FILE = path.join(WORKBOSS_ROOT, 'server.log');
export const ORCHESTRATOR_STATE_FILE = path.join(WORKBOSS_ROOT, 'orchestrator.json');
export const LOG_FILE = path.join(WORKBOSS_ROOT, 'workboss.log');
export const LAUNCHD_PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', 'com.workboss.server.plist');
export const LAUNCHD_LABEL = 'com.workboss.server';

export function workerDir(name: string): string {
	return path.join(WORKERS_DIR, name);
}

export function workerMetaPath(name: string): string {
	return path.join(workerDir(name), 'meta.json');
}

export function workerOpenCodeConfigPath(name: string): string {
	return path.join(workerDir(name), 'opencode.json');
}

export function workerMissionPath(name: string): string {
	return path.join(workerDir(name), 'mission.md');
}

export function workerInboxPath(name: string): string {
	return path.join(workerDir(name), 'inbox.md');
}

export function approvalPath(id: string): string {
	return path.join(APPROVALS_DIR, `${id}.json`);
}
