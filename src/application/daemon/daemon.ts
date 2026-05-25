import http from 'http';
import type {WorkerMeta} from '../../domain/worker.js';
import type {PendingApproval} from '../../domain/approval.js';
import type {WorkerRepository} from '../../domain/worker.js';
import type {ApprovalRepository} from '../../domain/approval.js';
import {getAdapter, listAdapters} from '../orchestration/agents/index.js';
import type {HookContext} from '../orchestration/agents/types.js';
import type {WorkerPatrol} from './worker-patrol.js';
import {reconcileOrphans} from './orphan-cleaner.js';
import type {LivenessWatcher} from './liveness-watcher.js';
import type {RpcRequest, RpcResponse} from '../../infrastructure/http/server-rpc.js';
import {createLogger} from '../../infrastructure/logging/logger.js';
import {getServerPort, getServerUrl} from '../../infrastructure/filesystem/paths.js';

interface Registration {
  meta: WorkerMeta;
  abort: AbortController;
}

const logger = createLogger('daemon');

const HOOK_ROUTE_PREFIX = '/claude-hook/';

export class Daemon {
  private workerRepo: WorkerRepository;
  private approvalRepo: ApprovalRepository;
  private workerPatrol: WorkerPatrol;
  private registry = new Map<string, Registration>();

  constructor(
    workerRepo: WorkerRepository,
    approvalRepo: ApprovalRepository,
    workerPatrol: WorkerPatrol,
    _livenessWatcher: LivenessWatcher,
  ) {
    this.workerRepo = workerRepo;
    this.approvalRepo = approvalRepo;
    this.workerPatrol = workerPatrol;
  }

  private initHookContext(): void {
    const hookCtx: HookContext = {
      workerRepo: this.workerRepo,
      approvalRepo: this.approvalRepo,
    };
    for (const adapter of listAdapters()) {
      adapter.setHookContext?.(hookCtx);
    }
  }

  private async registerForEvents(meta: WorkerMeta): Promise<void> {
    if (this.registry.has(meta.name)) return;
    const abort = new AbortController();
    this.registry.set(meta.name, {meta, abort});
    const adapter = getAdapter(meta.agent);
    adapter.subscribe?.({
      meta,
      abort: abort.signal,
      onApproval: async (a) => { await this.approvalRepo.write(a); },
      onResolved: async (id) => { await this.approvalRepo.delete(id); },
      onSessionIdLearned: async sid => {
        await this.workerRepo.update(meta.name, m => ({...m, sessionId: sid}));
        const r = this.registry.get(meta.name);
        if (r) r.meta.sessionId = sid;
      },
      log: (msg: string) => logger.info(msg),
    });
  }

  private unregister(name: string): void {
    const r = this.registry.get(name);
    if (!r) return;
    r.abort.abort();
    this.registry.delete(name);
    logger.info(`worker ${name}: unregistered`);
  }

  private async forwardReply(req: {
    id: string;
    reply: 'once' | 'always' | 'reject';
    message?: string;
  }): Promise<RpcResponse> {
    const approvals = await this.approvalRepo.list();
    const target = approvals.find(a => a.id === req.id);
    if (!target) {
      return {ok: false, error: `approval ${req.id} not found or already handled`};
    }

    try {
      await this.deliverThrough(target, req.reply, req.message);
      logger.info(`replied ${target.worker}/${target.id} ${req.reply}`);
      return {ok: true};
    } catch (err) {
      return {ok: false, error: `forward reply failed: ${String(err)}`};
    }
  }

  private async deliverThrough(
    target: PendingApproval,
    reply: 'once' | 'always' | 'reject',
    message: string | undefined,
  ): Promise<void> {
    const reg = this.registry.get(target.worker);
    if (!reg) {
      await this.approvalRepo.delete(target.id);
      throw new Error(`worker ${target.worker} not registered — approval discarded`);
    }
    try {
      await getAdapter(reg.meta.agent).deliverReply({
        meta: reg.meta,
        approval: target,
        reply,
        message,
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('no longer waiting')) {
        logger.info(`approval ${target.id}: hook responder gone, discarding approval`);
      } else {
        throw err;
      }
    }
    await this.approvalRepo.delete(target.id);
  }

  private async handleRpc(req: RpcRequest): Promise<RpcResponse> {
    switch (req.kind) {
      case 'ping':
        return {ok: true, data: {pid: process.pid, workers: this.registry.size}};
      case 'approvals.list':
        return {ok: true, data: await this.approvalRepo.list()};
      case 'approvals.reply':
        return this.forwardReply(req);
      case 'workers.attach': {
        const all = await this.workerRepo.list();
        const meta = all.find(w => w.name === req.name);
        if (!meta) return {ok: false, error: `worker ${req.name} not found`};
        await this.registerForEvents(meta);
        return {ok: true};
      }
      case 'workers.detach':
        this.unregister(req.name);
        return {ok: true};
    }
  }

  private async readJson<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private async dispatchHookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workerName: string,
  ): Promise<void> {
    const reg = this.registry.get(workerName);
    if (!reg) {
      this.sendJson(res, 200, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `workboss does not know worker "${workerName}"`,
        },
      });
      return;
    }

    const adapter = getAdapter(reg.meta.agent);
    if (adapter.handleHookRequest) {
      await adapter.handleHookRequest(req, res, workerName);
      return;
    }

    this.sendJson(res, 200, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `worker "${workerName}" agent ${reg.meta.agent} has no hook handler`,
      },
    });
  }

  private startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        (async () => {
          const url = req.url ?? '/';
          if (req.method === 'POST' && url === '/rpc') {
            try {
              const body = await this.readJson<RpcRequest>(req);
              this.sendJson(res, 200, await this.handleRpc(body));
            } catch (err) {
              this.sendJson(res, 500, {ok: false, error: String(err)});
            }
            return;
          }
          if (req.method === 'POST' && url.startsWith(HOOK_ROUTE_PREFIX)) {
            await this.dispatchHookRequest(
              req,
              res,
              decodeURIComponent(url.slice(HOOK_ROUTE_PREFIX.length)),
            );
            return;
          }
          this.sendJson(res, 404, {error: `not found: ${req.method} ${url}`});
        })().catch(err => {
          if (!res.headersSent) this.sendJson(res, 500, {error: String(err)});
        });
      });
      server.on('error', reject);
      const port = getServerPort();
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  async run(): Promise<void> {
    this.initHookContext();

    await this.startHttpServer();
    const workbossUrl = getServerUrl();
    logger.info(`workboss server up on ${workbossUrl}, pid=${process.pid}`);

    const allWorkers = await this.workerRepo.list();

    await reconcileOrphans(allWorkers).catch(err =>
      logger.info(`orphan reconciliation failed: ${String(err)}`),
    );

    for (const meta of allWorkers) {
      const adapter = getAdapter(meta.agent);
      await adapter.refreshDaemonSettings(meta, workbossUrl).catch(err =>
        logger.info(`refresh settings ${meta.name} failed: ${String(err)}`),
      );
    }

    for (const meta of allWorkers) {
      await this.registerForEvents(meta).catch(err =>
        logger.info(`attach ${meta.name} failed: ${String(err)}`),
      );
    }

    await this.workerPatrol.sweep(workbossUrl).catch(err =>
      logger.info(`initial sweep failed: ${String(err)}`),
    );
    const sweepInterval = setInterval(() => {
      void this.workerPatrol.sweep(workbossUrl).catch(err =>
        logger.info(`sweep failed: ${String(err)}`),
      );
    }, 60_000);
    sweepInterval.unref();

    const shutdown = async (sig: string) => {
      logger.info(`received ${sig}, shutting down`);
      for (const r of this.registry.values()) r.abort.abort();
      for (const adapter of listAdapters()) {
        await adapter.shutdown().catch(err =>
          logger.info(`adapter shutdown failed: ${String(err)}`),
        );
      }
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await new Promise<void>(() => {});
  }
}
