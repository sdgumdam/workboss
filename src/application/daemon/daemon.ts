import http from 'http';
import type {AddressInfo} from 'net';
import type {WorkerMeta} from '../../domain/worker.js';
import type {PendingApproval} from '../../domain/approval.js';
import type {WorkerRepository} from '../../domain/worker.js';
import type {ApprovalRepository} from '../../domain/approval.js';
import {writeServerInfo, clearServerInfo} from '../../infrastructure/filesystem/approval-repo.js';
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

interface Registration {
  meta: WorkerMeta;
  abort: AbortController;
}

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

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
      log,
    });
  }

  private unregister(name: string): void {
    const r = this.registry.get(name);
    if (!r) return;
    r.abort.abort();
    this.registry.delete(name);
    log(`worker ${name}: unregistered`);
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

    if (req.reply !== 'reject') {
      const hit = matchHardDeny(target.permission, target.patterns);
      if (hit) {
        log(
          `HARD DENY ${target.worker}/${target.id}: ${hit.reason} (${JSON.stringify(target.patterns)})`,
        );
        await this.deliverThrough(target, 'reject', `workboss policy: ${hit.reason}`);
        return {ok: false, error: `forbidden by workboss policy: ${hit.reason}`};
      }
    }

    try {
      await this.deliverThrough(target, req.reply, req.message);
      log(`replied ${target.worker}/${target.id} ${req.reply}`);
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
    if (!reg) throw new Error(`worker ${target.worker} not registered`);
    await getAdapter(reg.meta.agent).deliverReply({
      meta: reg.meta,
      approval: target,
      reply,
      message,
    });
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
      log(`claude hook from unknown worker "${workerName}", returning ask`);
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
      log(`${workerName}: learned session_id=${body.session_id}`);
    }

    const permission = classifyToolName(body.tool_name);
    const patterns = extractPatterns(body.tool_name, body.tool_input);

    const hit = matchHardDeny(permission, patterns);
    if (hit) {
      log(
        `HARD DENY (inline) ${workerName} ${body.tool_name}: ${hit.reason} (${JSON.stringify(patterns)})`,
      );
      this.sendClaudeHookDecision(res, 'deny', `workboss policy: ${hit.reason}`);
      return;
    }

    const approvalId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const approval: PendingApproval = {
      id: approvalId,
      worker: workerName,
      sessionID: body.session_id ?? '',
      permission,
      patterns,
      metadata: {tool_name: body.tool_name, tool_input: body.tool_input},
      always: [],
      capturedAt: new Date().toISOString(),
    };
    await this.approvalRepo.write(approval);
    log(
      `${workerName}: claude hook captured id=${approvalId} ${body.tool_name} ${JSON.stringify(patterns)}`,
    );

    const HOOK_TIMEOUT_MS = 30_000;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      claudeAdapter.dropHookResponder(approvalId);
      void this.approvalRepo.delete(approvalId);
      log(`claude hook ${approvalId} timed out, returning ask`);
      this.sendClaudeHookDecision(
        res,
        'ask',
        'workboss: no orchestrator response within 30s, please decide in worker TUI',
      );
    }, HOOK_TIMEOUT_MS);

    claudeAdapter.registerHookResponder(approvalId, response => {
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
        void this.approvalRepo.delete(approvalId);
        log(`claude hook ${approvalId} dropped by client before reply`);
      }
    });
  }

  private startHttpServer(): Promise<number> {
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
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr || typeof addr !== 'object') {
          reject(new Error('bad listen'));
          return;
        }
        resolve(addr.port);
      });
    });
  }

  async run(): Promise<void> {
    const port = await this.startHttpServer();
    await writeServerInfo(process.pid, port);
    const workbossUrl = `http://127.0.0.1:${port}`;
    log(`workboss server up on ${workbossUrl}, pid=${process.pid}`);

    for (const meta of await this.workerRepo.list()) {
      await this.registerForEvents(meta).catch(err =>
        log(`attach ${meta.name} failed: ${String(err)}`),
      );
    }

    await this.workerPatrol.sweep(workbossUrl).catch(err =>
      log(`initial sweep failed: ${String(err)}`),
    );
    const sweepInterval = setInterval(() => {
      void this.workerPatrol.sweep(workbossUrl).catch(err =>
        log(`sweep failed: ${String(err)}`),
      );
    }, 60_000);
    sweepInterval.unref();

    const shutdown = async (sig: string) => {
      log(`received ${sig}, shutting down`);
      for (const r of this.registry.values()) r.abort.abort();
      claudeAdapter.respondToAllPending({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'workboss server is shutting down',
        },
      });
      await clearServerInfo();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await new Promise<void>(() => {});
  }
}
