import path from 'path';
import type {WorkerRepository} from '../../domain/worker.js';
import {createWorkerMeta} from '../../domain/worker.js';
import {pickUniqueName} from '../../presentation/format.js';
import {getAdapter} from '../orchestration/agents/index.js';
import {discoverAll, type DiscoveredSession} from '../orchestration/session-scanner.js';
import type {LivenessWatcher} from './liveness-watcher.js';

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function nameForDiscovered(d: DiscoveredSession): string {
  if (d.sessionId) return `auto-${d.sessionId.replace(/^ses_/, '').slice(0, 8)}`;
  if (d.cwd) return `auto-${path.basename(d.cwd).slice(0, 12)}`;
  return `auto-${d.agent}-${d.pid ?? Date.now()}`;
}

async function adoptDiscoveredWorker(
  d: DiscoveredSession,
  workbossUrl: string,
  takenNames: Set<string>,
  repo: WorkerRepository,
): Promise<void> {
  if (!d.cwd) return;
  if (!d.sessionId) {
    return;
  }

  const name = pickUniqueName(nameForDiscovered(d), takenNames);
  takenNames.add(name);
  const adapter = getAdapter(d.agent);

  try {
    await adapter.prepareCwdMinimal({
      workerName: name,
      cwdAbs: d.cwd,
      workbossServerUrl: workbossUrl,
    });
  } catch (err) {
    log(`adopt ${name}: prepareCwdMinimal failed: ${String(err)}`);
    return;
  }

  const startedAt = new Date().toISOString();
  const meta = createWorkerMeta({
    name,
    agent: d.agent,
    cwd: d.cwd,
    createdAt: startedAt,
    sessionId: d.sessionId,
    process: d.serverUrl || d.pid
      ? {
          serve: {
            pid: d.pid,
            serverUrl: d.serverUrl,
            startedAt,
          },
        }
      : undefined,
    notes: 'auto-adopted',
  });
  await repo.write(meta);
  log(`adopted ${name}  ${d.agent}  ${d.sessionId}  ${d.cwd}`);
}

export class WorkerPatrol {
  private repo: WorkerRepository;
  private livenessWatcher: LivenessWatcher;

  constructor(repo: WorkerRepository, livenessWatcher: LivenessWatcher) {
    this.repo = repo;
    this.livenessWatcher = livenessWatcher;
  }

  async sweep(workbossUrl: string): Promise<void> {
    const known = await this.repo.list();
    const knownSids = new Set(
      known.map(w => w.sessionId).filter((s): s is string => !!s),
    );
    const knownUrls = new Set(
      known.map(w => w.process?.serve?.serverUrl).filter((u): u is string => !!u),
    );
    const takenNames = new Set(known.map(w => w.name));

    const discovered = await discoverAll();
    for (const d of discovered.filter(x => x.alive)) {
      if (d.sessionId && knownSids.has(d.sessionId)) continue;
      if (d.serverUrl && knownUrls.has(d.serverUrl)) continue;
      await adoptDiscoveredWorker(d, workbossUrl, takenNames, this.repo);
    }

    await this.livenessWatcher.checkAll();
  }
}
