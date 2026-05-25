# Refactor Plan: 编排层与具体 Agent 解耦 + Worker 关闭闭环

> Created: 2026-05-24
> Last updated: 2026-05-24

## 目标

1. **编排层与具体 agent 解耦** — 消除 38 处 agent-specific 耦合违规，全部收进 AgentAdapter
2. **tmux 操作与具体 agent 解耦** — tmux 层不感知 opencode/claude 二进制名
3. **Worker 关闭和资源清理闭环** — 同生共死，无孤儿进程，daemon crash recovery

## 设计原则

- AgentAdapter 是唯一的 agent 特定知识入口
- 编排层（daemon、dashboard、commands、scanner）只通过 `getAdapter(kind)` 多态调用
- TmuxClient 接口不包含任何 agent 二进制名
- Daemon 启动时 reconcile，shutdown 时全量清理

---

## 第一层：扩展 AgentAdapter 接口

在 `src/application/orchestration/agents/types.ts` 的 `AgentAdapter` 接口新增以下方法：

| 方法 | 签名 | 用途 | 消除实例 |
|------|------|------|---------|
| `getIcon` | `(): string` | agent 图标（⬡ / ◈） | 1 |
| `getDisplayName` | `(): string` | 显示名称（OpenCode / Claude） | 2 |
| `getBinaryName` | `(): string` | CLI 二进制名 | 3 |
| `getBootstrapDocName` | `(): string` | 启动文档名（AGENTS.md / CLAUDE.md） | 2 |
| `getLaunchCommand` | `(opts: {prompt?: string}) => string` | 编排器启动命令 | 3 |
| `getPostLaunchHint` | `(): string[]` | 启动后用户提示 | 1 |
| `isBareTUICommand` | `(cmd: string) => boolean` | 裸 TUI 进程检测 | 2 |
| `isOurProcess` | `(cmd: string) => boolean` | 进程归属判断 | 1 |
| `buildAttachCommand` | `(meta: WorkerMeta) => string \| undefined` | 同步构建 attach 命令 | 5 |
| `resumeAndAttach` | `(meta: WorkerMeta, serverUrl: string) => Promise<string \| undefined>` | resume serve + 返回 attach 命令 | 2 |
| `getRestartInstructions` | `(meta: WorkerMeta) => string[]` | 重启说明文本 | 1 |
| `refreshDaemonSettings` | `(meta: WorkerMeta, serverUrl: string) => Promise<void>` | daemon 启动时刷新 agent 配置 | 1 |
| `handleHookRequest?` | `(req, res, workerName: string) => Promise<void>` | HTTP hook 路由处理 | 6 |
| `shutdown` | `() => Promise<void>` | 优雅关闭（respond all pending） | 1 |
| `classifyPsLine` | `(line: string) => ClassifiedProcess \| null` | ps 输出分类 | 1 |
| `findSessionIdByCwd` | `(cwd: string) => Promise<string \| undefined>` | 按 cwd 找 session | 2 |
| `findHistoricalSessions` | `() => Promise<DiscoveredSession[]>` | 历史发现 | 2 |
| `enrichAliveSession` | `(hit, cwd) => Promise<DiscoveredSession>` | 补充 alive 发现信息 | 1 |

**新增辅助类型：**

```typescript
export interface ClassifiedProcess {
  pid: number;
  agent: AgentKind;
  port?: number;
  sessionId?: string;
  isAttachClient?: boolean;
}
```

---

## 第二层：Daemon 解耦

### 当前问题
- `daemon.ts` 直接 import `claudeAdapter` 和 `claude-config` 函数
- 86 行 `handleClaudeHook` 硬编码在 daemon 里
- `/claude-hook/` 路由硬编码
- 启动时 `if meta.agent === 'claude'` 分支写配置

### 改造
1. daemon 启动时遍历 `listAdapters()`，对每个 adapter 注册其 HTTP 路由（如果有 `handleHookRequest`）
2. `handleClaudeHook` 逻辑移入 `ClaudeAdapter.handleHookRequest()`
3. 去掉 `claudeAdapter` 直接 import，只用 `getAdapter()`
4. `classifyToolName` / `extractPatterns` 移入 `ClaudeAdapter`
5. 启动时 refresh settings 遍历所有 adapter 调用 `refreshDaemonSettings()`

---

## 第三层：Dashboard 解耦

### 当前问题
- `attachCommand()` 硬编码 opencode attach / claude --resume
- `switchToWorker()` 里 resume 逻辑直接 `getAdapter('opencode') as any`
- `isBareTUI` 正则重复
- orchestrator 切换硬编码二进制名

### 改造
1. `attachCommand()` → `adapter.buildAttachCommand(meta)`
2. resume 逻辑 → `adapter.resumeAndAttach(meta, serverUrl)`
3. `isBareTUI` → `adapter.isBareTUICommand(cmd)`
4. orchestrator 命令 → `adapter.getLaunchCommand({prompt})`
5. 图标/名称 → `adapter.getIcon()` / `adapter.getDisplayName()`

---

## 第四层：Session Scanner 解耦

### 当前问题
- `classifyPsLine()` 硬编码 opencode/claude 正则
- `findClaudeHistory()` / `findOpencodeHistory()` 硬编码
- `findAliveAgents()` 里 agent 分支
- `findCurrentClaudeSessionId()` / `findOpencodeSessionForCwd()` 硬编码

### 改造
1. `classifyPsLine()` → 遍历 `listAdapters()`，每个 adapter 的 `classifyPsLine()` 尝试匹配
2. `findHistoricalSessions()` → 遍历 `listAdapters()`，合并结果
3. `findAliveAgents()` 里的分支 → `adapter.enrichAliveSession(hit, cwd)`
4. `findSessionIdByCwd()` → `adapter.findSessionIdByCwd(cwd)`

---

## 第五层：Tmux / Process 解耦

### 当前问题
- `tmux.ts:isBareTUI()` 硬编码 opencode 正则
- `process.ts:isProcessStillOurs()` 硬编码 opencode/claude

### 改造
1. `isBareTUI()` → 调用 `adapter.isBareTUICommand(cmd)`，传入 adapter 引用
2. `isProcessStillOurs()` → 调用 `adapter.isOurProcess(cmd)`
3. `TmuxClient` 接口不变，但 `CliTmuxClient` 实现中不包含 agent 知识

---

## 第六层：Worker 关闭闭环

### 同生共死
- worker 注册时记录 serve PID 和 port
- 切走 worker 时不杀 serve（保持 alive）
- 切回 worker 时复用已有 serve（检查 PID 是否活着）
- 显式删除/关闭 worker 时 kill serve 进程

### Daemon Crash Recovery
- daemon 启动时 `reconcileOrphans()`：
  1. 扫描所有 PPID=1 的 `opencode serve` 进程
  2. 跟 registry 里的 serve PID 比对
  3. 不在 registry 里的杀掉
- daemon shutdown 时遍历所有 worker 调用 `detachWorker()`
- daemon shutdown 时遍历所有 adapter 调用 `shutdown()`

### 新增文件
- `src/application/daemon/orphan-cleaner.ts` — 孤儿进程检测和清理

---

## 第七层：代码质量（同步进行）

- 拆分 `DashboardView`（303 行）→ 提取 `useWorkerData`、`useApproval`、`useKeyBindings` hooks
- 去掉 `_livenessWatcher`（daemon.ts:37）和 `_approvalRepo`（dashboard.tsx:576）死代码
- `worker-repo.list()` 加缓存（内存 map + write/delete 时失效）
- 去掉所有 `as any` casts（dashboard.tsx:668,684）
- 去掉重复的裸 TUI 检测正则（3 处 → 1 处在 adapter）

---

## TODO 列表

### Phase 1: 扩展接口 + 实现
- [x] 1.1 在 `types.ts` 新增 `ClassifiedProcess` 类型和 18 个方法签名
- [x] 1.2 `opencode.ts` 实现全部新方法
- [x] 1.3 `claude.ts` 实现全部新方法（含 `handleHookRequest`、`classifyPsLine` 等）
- [x] 1.4 编译验证

### Phase 2: Daemon 解耦
- [x] 2.1 把 `handleClaudeHook` 移入 `ClaudeAdapter.handleHookRequest()`
- [x] 2.2 daemon HTTP 路由改为遍历 adapter 注册
- [x] 2.3 去掉 daemon.ts 对 `claudeAdapter` 的直接 import
- [x] 2.4 启动时 refresh settings 改为遍历 adapter
- [x] 2.5 编译验证

### Phase 3: Dashboard 解耦
- [x] 3.1 `attachCommand()` 改用 `adapter.buildAttachCommand()`
- [x] 3.2 `switchToWorker()` resume 逻辑改用 `adapter.resumeAndAttach()`
- [x] 3.3 `isBareTUI` 改用 `adapter.isBareTUICommand()`
- [x] 3.4 orchestrator 切换改用 `adapter.getLaunchCommand()`
- [x] 3.5 图标/名称改用 adapter
- [x] 3.6 编译验证

### Phase 4: Commands 解耦
- [x] 4.1 `lifecycle.ts` 的 `attachWorker()` / `respawnOpenCodeServe()` 改用 adapter
- [x] 4.2 `boss.ts` 去掉 agent 分支，改用 adapter
- [x] 4.3 `communication.ts` 去掉 agent 分支，改用 adapter
- [x] 4.4 编译验证

### Phase 5: Session Scanner 解耦
- [x] 5.1 `classifyPsLine()` 改为遍历 adapter
- [x] 5.2 `findHistoricalSessions()` 改为遍历 adapter
- [x] 5.3 `findAliveAgents()` 分支改为 `adapter.enrichAliveSession()`
- [x] 5.4 编译验证

### Phase 6: Tmux / Process 解耦
- [x] 6.1 `isBareTUI()` 改为调用 adapter（通过 registerBareTUIDetector 注入）
- [x] 6.2 `isProcessStillOurs()` 删除（已迁入 adapter 内部）
- [x] 6.3 编译验证

### Phase 7: Worker 关闭闭环
- [x] 7.1 新建 `orphan-cleaner.ts`，实现 `reconcileOrphans()`
- [x] 7.2 daemon 启动时调用 `reconcileOrphans()`
- [x] 7.3 daemon shutdown 时遍历所有 adapter 调用 `shutdown()`
- [x] 7.4 `resumeServe` 改为先检查已有 serve PID 是否存活（已有，在 resumeAndAttach 里）
- [x] 7.5 编译验证

### Phase 8: 代码质量
- [x] 8.1 拆分 `DashboardView` 提取 hooks — 跳过（当前 742 行，暂无需求压力）
- [x] 8.2 去掉死代码（`_livenessWatcher`、`inferUrlFromPid`、`attachCommand`、`respawnOpenCodeServe`、`isProcessStillOurs`）
- [x] 8.3 `worker-repo.list()` 加缓存 — 跳过（暂无性能问题）
- [x] 8.4 去掉 `as any` casts — done（dashboard switchToWorker 重写后消除）
- [x] 8.5 编译验证

### Phase 9: 端到端验证
- [x] 9.1 `npm run build` 通过
- [x] 9.2 手动验证 worker spawn/detach/remove 闭环 — 待人工验证
- [x] 9.3 手动验证 dashboard worker 切换 — 待人工验证
- [x] 9.4 手动验证 daemon crash recovery — 待人工验证
- [x] 9.5 清理当前 3 个孤儿 serve 进程 — daemon 启动时自动 reconcile

---

## 执行日志

| 时间 | Phase | 动作 | 结果 |
|------|-------|------|------|
| 2026-05-24 | - | 创建重构计划文档 | done |
| 2026-05-24 | 1.1 | types.ts 新增 ClassifiedProcess, DiscoveredSession, HookContext, ResumeServeResult 类型 + 18 个方法签名 | done |
| 2026-05-24 | 1.2 | opencode.ts 实现 getIcon/getDisplayName/getBinaryName/getBootstrapDocName/getLaunchCommand/getPostLaunchHint/isBareTUICommand/isOurProcess/buildAttachCommand/resumeAndAttach/getRestartInstructions/refreshDaemonSettings/shutdown/classifyPsLine/findSessionIdByCwd/findHistoricalSessions/enrichAliveSession | done |
| 2026-05-24 | 1.3 | claude.ts 实现全部新方法 + handleHookRequest（从 daemon 移入）+ classifyPsLine/findSessionIdByCwd/findHistoricalSessions/enrichAliveSession | done |
| 2026-05-24 | 1.4 | tsc --noEmit 通过 | done |
| 2026-05-24 | 2 | Daemon 解耦：删除 handleClaudeHook（86行），改用 dispatchHookRequest → adapter.handleHookRequest；initHookContext 注入 repos；refreshDaemonSettings 替代 if/claude 分支；shutdown 遍历 listAdapters | done |
| 2026-05-24 | 3 | Dashboard 解耦：删除 attachCommand（硬编码 opencode/claude），改用 adapter.resumeAndAttach；isBareTUI 改用 adapter.isBareTUICommand；switchToOrchestrator 改用 adapter.getLaunchCommand；AGENT_ICON 改用 adapter.getIcon | done |
| 2026-05-24 | 4 | Commands 解耦：boss.ts 删除所有 agent === 'opencode'/'claude' 分支，改用 adapter.getLaunchCommand/getBootstrapDocName/getPostLaunchHint/getBinaryName；lifecycle.ts attachWorker 改用 adapter.resumeAndAttach；communication.ts 改用 adapter.getBootstrapDocName/getDisplayName/getRestartInstructions | done |
| 2026-05-24 | 5 | Session Scanner 解耦：492 行 → 128 行；classifyPsLine/findClaudeHistory/findOpencodeHistory/findCurrentClaudeSessionId/findOpencodeSessionForCwd 全部移入 adapter；scanner 只剩 findAliveAgents（遍历 adapter.enrichAliveSession）、findHistoricalSessions（遍历 adapter）、discoverAll | done |
| 2026-05-24 | 6 | Tmux/Process 解耦：tmux.ts isBareTUI 改为可注入的 registerBareTUIDetector；agents/index.ts 启动时注册；process.ts 删除 isProcessStillOurs（已迁入 adapter 内部） | done |
| 2026-05-24 | 7 | Worker 关闭闭环：新建 orphan-cleaner.ts（reconcileOrphans）；daemon 启动时调用；shutdown 遍历 adapter.shutdown() | done |
| 2026-05-24 | 8 | 代码质量：删除死代码（inferUrlFromPid、attachCommand、respawnOpenCodeServe、AGENT_ICON、isProcessStillOurs）；清理 exports（claudeAdapter/openCodeAdapter 不再 export）；session-scanner 492→128 行 | done |
| 2026-05-24 | 9 | npm run build 通过，tsc --noEmit 通过，无测试文件（E2E only） | done |
| 2026-05-24 | 8+ | 补 eslint.config.mjs（ESLint 9 flat config），消除全部 10 个 non-null-assertion warnings，npm run build + npm run lint 均零问题 | done |
| 2026-05-25 | E2E | 19 项端到端验证全部通过：daemon RPC、orphan cleaner、CLI list/discover、claude hook allow/queue、dashboard 渲染/worker 切换/orchestrator 切换/退出、worker spawn/remove、daemon shutdown、adapter identity/bareTUI/isOurProcess/buildAttachCommand | done |
| 2026-05-25 | E2E doc | 编写 `docs/e2e-test-spec.md` — 19 个 test case，每个有前置/步骤/预期/验收命令，可由 coding agent 直接实现为一键脚本 | done |
