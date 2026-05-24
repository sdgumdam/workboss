import http from 'http';
import type {WorkerMeta} from '../../domain/worker.js';
import type {PendingApproval} from '../../domain/approval.js';
import type {WorkerRepository} from '../../domain/worker.js';
import type {ApprovalRepository} from '../../domain/approval.js';
import {matchHardDeny} from '../../infrastructure/agent-config/deny-patterns.js';
import {
  classifyToolName,
  extractPatterns,
  type ClaudePreToolUseRequest,
} from '../../infrastructure/agent-config/claude-config.js';
import {getAdapter, claudeAdapter} from '../orchestration/agents/index.js';
import type {WorkerPatrol} from './worker-patrol.js';
import type {LivenessWatcher} from './liveness-watcher.js';
import type {RpcRequest, RpcResponse} from '../../infrastructure/http/server-rpc.js';
import {createLogger} from '../../infrastructure/logging/logger.js';
import {getServerPort, getServerUrl} from '../../infrastructure/filesystem/paths.js';

interface Registration {
  meta: WorkerMeta;
  abort: AbortController;
}

const logger = createLogger('daemon');

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

  private sendClaudeHookDecision(
    res: http.ServerResponse,
    decision: 'allow' | 'deny' | 'ask',
    reason: string,
  ): void {
    this.sendJson(res, 200, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        ...(reason ? {permissionDecisionReason: reason} : {}),
      },
    });
  }

  private async handleClaudeHook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    workerName: string,
  ): Promise<void> {
    const reg = this.registry.get(workerName);
    if (!reg) {
      logger.info(`claude hook from unknown worker "${workerName}", returning ask`);
      this.sendClaudeHookDecision(res, 'ask', `workboss does not know worker "${workerName}"`);
      return;
    }
    if (reg.meta.agent !== 'claude') {
      this.sendClaudeHookDecision(
        res,
        'ask',
        `worker "${workerName}" is not registered as a claude worker`,
      );
      return;
    }

    let body: ClaudePreToolUseRequest;
    try {
      body = await this.readJson<ClaudePreToolUseRequest>(req);
    } catch (err) {
      this.sendJson(res, 400, {error: `bad json: ${String(err)}`});
      return;
    }

    if (body.session_id && !reg.meta.sessionId) {
      await this.workerRepo.update(workerName, m => ({...m, sessionId: body.session_id}));
      reg.meta.sessionId = body.session_id;
      logger.info(`${workerName}: learned session_id=${body.session_id}`);
    }

    const permission = classifyToolName(body.tool_name);
    const patterns = extractPatterns(body.tool_name, body.tool_input);

    const hit = matchHardDeny(permission, patterns);
    if (hit) {
      logger.info(
        `QUEUE APPROVAL ${workerName} ${body.tool_name}: ${hit.reason} (${JSON.stringify(patterns)})`,
      );
      const approvalId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const approval: PendingApproval = {
        id: approvalId,
        worker: workerName,
        sessionID: body.session_id ?? '',
        permission,
        patterns,
        metadata: { tool_name: body.tool_name, tool_input: body.tool_input },
        always: [],
        capturedAt: new Date().toISOString(),
      };
      await this.approvalRepo.write(approval);

      const HOOK_TIMEOUT_MS = 60_000;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        claudeAdapter.dropHookResponder(approvalId);
        void this.approvalRepo.delete(approvalId);
        logger.info(`claude hook ${approvalId} timed out, returning ask`);
        this.sendClaudeHookDecision(res, 'ask', 'workboss: no orchestrator response within 60s');
      }, HOOK_TIMEOUT_MS);

      claudeAdapter.registerHookResponder(approvalId, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sendJson(res, 200, response);
      });

      res.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          claudeAdapter.dropHookResponder(approvalId);
          logger.info(`claude hook ${approvalId} dropped by client before reply — keeping approval for orchestrator`);
        }
      });
      return;
    }

    this.sendClaudeHookDecision(res, 'allow', '');
    return;
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
          if (req.method === 'POST' && url.startsWith('/claude-hook/')) {
            await this.handleClaudeHook(
              req,
              res,
              decodeURIComponent(url.slice('/claude-hook/'.length)),
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
    await this.startHttpServer();
    const workbossUrl = getServerUrl();
    logger.info(`workboss server up on ${workbossUrl}, pid=${process.pid}`);

    for (const meta of await this.workerRepo.list()) {
      if (meta.agent === 'claude') {
        const {writeClaudeSettings} = await import(
          '../../infrastructure/agent-config/claude-config.js'
        );
        await writeClaudeSettings(meta.cwd, {
          workerName: meta.name,
          workbossServerUrl: workbossUrl,
        }).catch(err =>
          logger.info(`update claude settings ${meta.name} failed: ${String(err)}`),
        );
      }
    }

    for (const meta of await this.workerRepo.list()) {
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
      claudeAdapter.respondToAllPending({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'workboss server is shutting down',
        },
      });
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await new Promise<void>(() => {});
  }
}
