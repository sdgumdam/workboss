import {EventEmitter} from 'events';
import type {WorkerMeta, LivenessResult} from '../../domain/worker.js';
import {updateWorkerLiveness} from '../../domain/worker.js';
import type {WorkerRepository} from '../../domain/worker.js';
import type {AgentAdapter} from '../orchestration/agents/types.js';

export interface LivenessChangeEvent {
  worker: WorkerMeta;
  status: LivenessResult['status'];
  detail?: string;
}

export class LivenessWatcher extends EventEmitter {
  private repo: WorkerRepository;
  private getAdapter: (kind: string) => AgentAdapter;

  constructor(repo: WorkerRepository, getAdapter: (kind: string) => AgentAdapter) {
    super();
    this.repo = repo;
    this.getAdapter = getAdapter;
  }

  async checkAll(): Promise<void> {
    const workers = await this.repo.list();
    for (const w of workers) {
      const adapter = this.getAdapter(w.agent);
      const result = await adapter.checkLiveness(w);
      if (w.liveness !== result.status) {
        const updated = updateWorkerLiveness(w, result.status);
        await this.repo.write(updated);
        this.emit('liveness-changed', { worker: updated, status: result.status, detail: result.detail } satisfies LivenessChangeEvent);
      }
    }
  }
}
