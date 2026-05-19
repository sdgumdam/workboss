/**
 * Filesystem layout for workboss runtime state.
 *
 *   ~/.workboss/
 *     workers/<name>/
 *       meta.json              workboss-managed: agent type, port, pid, cwd, created_at
 *       opencode.json          OPENCODE_CONFIG to inject when launching the worker
 *       mission.md             user-authored task brief (read by the worker)
 *       inbox.md               workboss appends messages here; worker reads on each turn
 *     approvals/
 *       <approval-id>.json     pending request snapshot (cleaned up after reply)
 *     server.pid               PID of the running aggregator daemon (if any)
 *     server.port              port the aggregator daemon is listening on
 *     server.log               aggregator log
 */

import os from 'os';
import path from 'path';

const HOME = os.homedir();

export const WORKBOSS_ROOT = path.join(HOME, '.workboss');
export const WORKERS_DIR = path.join(WORKBOSS_ROOT, 'workers');
export const APPROVALS_DIR = path.join(WORKBOSS_ROOT, 'approvals');
export const SERVER_PID_FILE = path.join(WORKBOSS_ROOT, 'server.pid');
export const SERVER_PORT_FILE = path.join(WORKBOSS_ROOT, 'server.port');
export const SERVER_LOG_FILE = path.join(WORKBOSS_ROOT, 'server.log');

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
