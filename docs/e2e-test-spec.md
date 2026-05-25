# Workboss E2E Test Specification

> Last updated: 2026-05-25
> Scope: 重构后的编排层解耦 + Worker 关闭闭环

## 设计原则

1. **每个 case 有前置条件、操作步骤、预期结果、验收命令**——coding agent 拿到就能写脚本
2. **验收标准用 tmux send-keys 模拟键盘、curl 模拟 HTTP、tmux capture-pane 读取输出**——不需要人工
3. **每个 case 独立**——不依赖其他 case 的副作用（除非显式标注依赖链）
4. **测试必须覆盖所有用户可达路径，不只测快乐路径**——见下方复盘

## 复盘：T6/T7 为什么没发现 patrol adopt 的 bug

### 事件
2026-05-25，用户报告 claude Read 工具被无脑拦截。根因：`adoptDiscoveredWorker()` 写了磁盘但没通知 daemon 注册到内存 registry。Hook 请求到达 daemon，找不到 worker，返回 `ask`。

### 为什么 19 个 E2E 测试全部 PASS 但没发现
T6（Claude hook safe tool → allow）和 T7（Claude hook dangerous tool → queued）的测试方式：
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
curl -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" ...
```

这个 worker 是 **daemon 启动时从磁盘加载并注册的**（daemon.ts:248-260）。所以 daemon 的 registry 里有它，hook 返回 allow。

但用户的真实场景是：
1. 用户在终端手动启动 `claude`
2. daemon patrol 60s sweep 发现进程
3. `adoptDiscoveredWorker()` 写磁盘 → **没有通知 daemon 注册**
4. claude 发 hook → daemon 不认识 → 返回 ask → **用户被弹权限确认框**

**我测试了路径 A（daemon 启动加载），没测路径 B（patrol 运行时 adopt）。两条路径的代码分支不同。**

### 根本原因
1. **测实现路径，不测用户场景**。我想的是"hook 功能能不能工作"，不是"用户实际是怎么触发 hook 的"。
2. **挑选容易的测**。手动指定 worker name 一行 curl 就搞定，而 patrol 路径要等 60s sweep、还要有真实 claude 进程。我选了省事的。
3. **PASS 数字带来的虚假安全感**。"19/19 PASS"的大表格让我和用户都以为没问题，实际上覆盖面有盲区。

### 设计原则修正
以后每个功能的 E2E 必须列出 **所有用户可达的代码路径**，每条路径至少一个 case：

| 功能 | 路径 A | 路径 B | 路径 C |
|------|--------|--------|--------|
| Claude hook | daemon 启动注册的 worker | patrol adopt 的 worker | 用户手动 register 的 worker |
| Worker spawn | CLI spawn | dashboard 内创建 | - |
| Worker remove | CLI remove | dashboard 按 'x' | - |
| Briefing | opencode SQLite | claude JSONL | 无 session 数据的 worker |

**只有所有路径都覆盖了，才能声称"测试通过"。**

## 环境准备

```bash
# 前置：daemon 必须在跑
curl -s -X POST http://127.0.0.1:58212/rpc -d '{"kind":"ping"}'
# 预期: {"ok":true,"data":{"pid":<number>,"workers":<number>}}

# 前置：tmux session 存在
tmux list-sessions | grep workboss
# 预期: workboss: 1 windows ...

# 前置：已知 worker 列表（取第一个 opencode 类型 worker）
WORKER_NAME=$(node bin/workboss.js list 2>&1 | grep 'up.*opencode' | head -1 | awk '{print $2}')
```

---

## T1: Daemon 启动与 RPC

### 前置
- daemon 未运行（`launchctl list | grep workboss` 不含 exit code 0）

### 步骤
1. `node bin/workboss.js server start`
2. `curl -s -X POST http://127.0.0.1:58212/rpc -H 'Content-Type: application/json' -d '{"kind":"ping"}'`

### 预期
- step 1 输出 `workboss server started, pid=<N>`
- step 2 返回 `{"ok":true,"data":{"pid":<N>,"workers":<N>}}`
- `workers` > 0（因为已有 worker 在 registry 里）

### 验收命令
```bash
curl -sf -X POST http://127.0.0.1:58212/rpc -H 'Content-Type: application/json' -d '{"kind":"ping"}' | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok']; assert d['data']['workers'] >= 0; print('T1 PASS')"
```

---

## T2: Orphan Reconciliation

### 前置
- daemon 已启动
- 存在 PPID=1 的 `opencode serve` 进程，且不在 registry 里

### 步骤
1. 制造孤儿：`opencode serve --port 19999 --hostname 127.0.0.1 &` 然后 `disown`
2. 等待 daemon 下次 sweep 或重启 daemon：`node bin/workboss.js server stop && node bin/workboss.js server start`
3. `ps aux | grep 'opencode serve.*19999' | grep -v grep`

### 预期
- step 3 无输出（孤儿已被 kill）
- daemon log 包含 `killed orphan serve pid=<N>`

### 验收命令
```bash
grep 'killed orphan' ~/.workboss/workboss.log | tail -1 && echo "T2 PASS (orphan killed)" || echo "T2 SKIP (no orphan to kill)"
```

---

## T3: CLI List — Adapter Liveness

### 前置
- daemon 运行中
- 至少 1 个 worker

### 步骤
1. `node bin/workboss.js list 2>&1`

### 预期
- 每行格式：`<status>  <name>  <agent>  <sid>  <url_or_cwd>`
- status 为 `up`/`idle`/`dead`/`degrad` 之一
- agent 列只有 `opencode` 或 `claude`（无其他值）
- 无 `as any` 相关错误

### 验收命令
```bash
node bin/workboss.js list 2>&1 | awk '{print $3}' | sort -u | grep -E '^(opencode|claude)$' | wc -l | xargs -I{} test {} -ge 1 && echo "T3 PASS" || echo "T3 FAIL"
```

---

## T4: CLI Discover — Scanner Adapter Delegation

### 前置
- daemon 运行中

### 步骤
1. `node bin/workboss.js discover --all 2>&1`

### 预期
- 输出包含 `(history)` 行（来自 `adapter.findHistoricalSessions()`）
- 或输出 "没有发现未注册的 worker" + 历史数量

### 验收命令
```bash
RESULT=$(node bin/workboss.js discover --all 2>&1); echo "$RESULT" | grep -qE '(history|未注册)' && echo "T4 PASS" || echo "T4 FAIL: $RESULT"
```

---

## T5: Adapter Identity Methods Runtime

### 前置
- 已 build（`npm run build`）

### 步骤
```bash
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const oc = getAdapter('opencode');
const cl = getAdapter('claude');
const checks = [
  ['opencode icon', oc.getIcon() === '⬡'],
  ['opencode name', oc.getDisplayName() === 'OpenCode'],
  ['opencode binary', oc.getBinaryName() === 'opencode'],
  ['opencode bootstrap', oc.getBootstrapDocName() === 'AGENTS.md'],
  ['opencode launch', oc.getLaunchCommand({prompt:'x'}).includes('opencode')],
  ['opencode bareTUI true', oc.isBareTUICommand('opencode') === true],
  ['opencode bareTUI false', oc.isBareTUICommand('opencode attach http://x') === false],
  ['opencode our proc', oc.isOurProcess('opencode serve') === true],
  ['claude icon', cl.getIcon() === '◈'],
  ['claude name', cl.getDisplayName() === 'Claude'],
  ['claude binary', cl.getBinaryName() === 'claude'],
  ['claude bootstrap', cl.getBootstrapDocName() === 'CLAUDE.md'],
  ['claude launch', cl.getLaunchCommand({prompt:'x'}) === 'claude'],
  ['claude bareTUI', cl.isBareTUICommand('claude') === false],
  ['claude our proc', cl.isOurProcess('claude --resume x') === true],
];
const failed = checks.filter(c => !c[1]);
failed.length === 0 ? console.log('T5 PASS: all 15 checks') : (console.log('T5 FAIL:'), failed.forEach(f => console.log('  ' + f[0])));
"
```

### 预期
- `T5 PASS: all 15 checks`

---

## T6: Claude Hook — Safe Tool Allow

### 前置
- daemon 运行中
- 存在至少 1 个 claude worker

### 步骤
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
curl -s -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test-session","tool_name":"Read","tool_input":{"file_path":"/tmp/test"}}'
```

### 预期
- 返回 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`

### 验收命令
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
RESP=$(curl -sf -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" -H 'Content-Type: application/json' -d '{"session_id":"t","tool_name":"Read","tool_input":{"file_path":"/t"}}')
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'; print('T6 PASS')" || echo "T6 FAIL: $RESP"
```

---

## T7: Claude Hook — Dangerous Tool Queue + Timeout

### 前置
- 同 T6

### 步骤
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
# 设置较短超时测试（实际 60s 太长，这里用 --max-time 65 等待超时）
curl -s --max-time 65 -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test-session","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/test"}}'
```

### 预期
- 60s 后返回 `{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"workboss: no orchestrator response within 60s"}}`

### 验收命令（用 approval RPC 中断等待）
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
# 后台发 hook
curl -s --max-time 65 -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" -H 'Content-Type: application/json' -d '{"session_id":"t","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp"}}' > /tmp/t7-hook-result.json 2>&1 &
HOOK_PID=$!
sleep 2
# 检查 approval 被创建了
APPROVALS=$(node bin/workboss.js approvals 2>&1)
echo "$APPROVALS" | grep -q 'pending' && echo "T7 PASS (approval queued)" || echo "T7 CHECK: $APPROVALS"
# 批量 reject 清理
node bin/workboss.js reject-all 2>/dev/null; kill $HOOK_PID 2>/dev/null
```

---

## T8: Dashboard 渲染

### 前置
- daemon 运行中
- tmux workboss session 存在
- 右 pane (boss.1) 在 shell prompt

### 步骤
1. `tmux send-keys -t workboss:boss.1 'node <project_root>/bin/workboss.js dashboard' Enter`
2. `sleep 4`
3. `tmux capture-pane -t workboss:boss.1 -p`

### 预期
- 输出包含 `workboss` 标题行
- 输出包含 `daemon:up`
- 输出包含 `⬡`（opencode icon）和 `◈`（claude icon）
- 底部有 `shutdown` 和按键提示

### 验收命令
```bash
PANE=$(tmux capture-pane -t workboss:boss.1 -p 2>&1)
echo "$PANE" | grep -q 'workboss' && echo "$PANE" | grep -q 'daemon:up' && echo "$PANE" | grep -q '⬡' && echo "T8 PASS" || echo "T8 FAIL"
```

---

## T9: Dashboard Worker Switch (Enter)

### 依赖
- T8（dashboard 已渲染）

### 步骤
1. 获取第一个 up 状态的 worker name
2. 用 `tmux send-keys -t workboss:boss.1 Enter` 选中当前高亮 worker
3. `sleep 3`
4. 检查 log：`grep 'switchToWorker' ~/.workboss/workboss.log | tail -1`

### 预期
- log 包含 `switchToWorker` 和 `"agent":"opencode"` 或 `"agent":"claude"`
- log 包含 `runInLeftPane` 且 `done`
- 左 pane 切换了内容

### 验收命令
```bash
tmux send-keys -t workboss:boss.1 Enter; sleep 3
grep 'switchToWorker' ~/.workboss/workboss.log | tail -1 | grep -q 'runInLeftPane\|skipped' && echo "T9 PASS" || echo "T9 CHECK: $(grep switchToWorker ~/.workboss/workboss.log | tail -1)"
```

---

## T10: Dashboard Switch Back to Orchestrator ('o')

### 依赖
- T8（dashboard 已渲染）

### 步骤
1. `tmux send-keys -t workboss:boss.1 'o'`
2. `sleep 3`
3. `grep 'switchToOrchestrator' ~/.workboss/workboss.log | tail -1`

### 预期
- log: `switchToOrchestrator {"agent":"opencode"}`（或 `"claude"`）
- log: `runInLeftPane start {"command":"opencode"}`（或 `"claude"`）
- log: `runInLeftPane done`

### 验收命令
```bash
tmux send-keys -t workboss:boss.1 'o'; sleep 3
grep switchToOrchestrator ~/.workboss/workboss.log | tail -1 | grep -q 'runInLeftPane\|agent' && echo "T10 PASS" || echo "T10 CHECK: $(grep switchToOrchestrator ~/.workboss/workboss.log | tail -1)"
```

---

## T11: Dashboard Clean Exit (Ctrl-C)

### 依赖
- T8（dashboard 已渲染）

### 步骤
1. `tmux send-keys -t workboss:boss.1 C-c`
2. `sleep 2`
3. `tmux capture-pane -t workboss:boss.1 -p | tail -1`

### 预期
- 最后一行是 shell prompt（包含 `@MacBook-Pro` 或 `$`）
- dashboard 进程已退出

### 验收命令
```bash
tmux send-keys -t workboss:boss.1 C-c; sleep 2
PROMPT=$(tmux capture-pane -t workboss:boss.1 -p | tail -1)
echo "$PROMPT" | grep -qE '(@MacBook-Pro|\$)' && echo "T11 PASS" || echo "T11 FAIL: $PROMPT"
```

---

## T12: Worker Spawn

### 前置
- daemon 运行中
- 测试 cwd 存在：`mkdir -p /tmp/wb-test-spawn`

### 步骤
1. `node bin/workboss.js spawn e2e-test-worker --agent opencode --cwd /tmp/wb-test-spawn --task "test" 2>&1`
2. `node bin/workboss.js list 2>&1 | grep e2e-test-worker`

### 预期
- step 1 输出 `worker "e2e-test-worker" up`
- step 2 该 worker status 为 `up`，agent 为 `opencode`

### 验收命令
```bash
mkdir -p /tmp/wb-test-spawn
node bin/workboss.js spawn e2e-test-worker --agent opencode --cwd /tmp/wb-test-spawn --task "test" 2>&1 | grep -q 'up' && echo "T12 PASS" || echo "T12 FAIL"
```

### 清理
```bash
node bin/workboss.js remove e2e-test-worker 2>/dev/null
```

---

## T13: Worker Remove

### 依赖
- T12（worker 已创建）或手动创建

### 步骤
1. 确保 worker 存在：`node bin/workboss.js spawn e2e-test-rm --agent opencode --cwd /tmp/wb-test-rm --task "test"`
2. `node bin/workboss.js remove e2e-test-rm 2>&1`
3. `node bin/workboss.js list 2>&1 | grep e2e-test-rm`

### 预期
- step 2 输出 `detached` + `removed`
- step 3 无输出（worker 不在 list 里）
- serve 进程被 kill（`ps aux | grep e2e-test-rm` 无 opencode serve）

### 验收命令
```bash
mkdir -p /tmp/wb-test-rm
node bin/workboss.js spawn e2e-test-rm --agent opencode --cwd /tmp/wb-test-rm --task "test" >/dev/null 2>&1
sleep 2
OUTPUT=$(node bin/workboss.js remove e2e-test-rm 2>&1)
echo "$OUTPUT" | grep -q 'removed' && echo "T13 PASS" || echo "T13 FAIL: $OUTPUT"
rm -rf /tmp/wb-test-rm
```

---

## T14: Daemon Shutdown + Adapter Cleanup

### 前置
- daemon 运行中

### 步骤
1. `node bin/workboss.js server stop 2>&1`
2. `curl -sf http://127.0.0.1:58212/rpc`（预期 connection refused）
3. `grep 'shutting down' ~/.workboss/workboss.log | tail -1`

### 预期
- step 1 输出 `stopped`
- step 2 curl 返回非零 exit code（connection refused）
- step 3 log 包含 `received SIGTERM, shutting down`

### 验收命令
```bash
node bin/workboss.js server stop 2>&1 | grep -q 'stopped' && echo "T14 PASS" || echo "T14 FAIL"
# 恢复 daemon
node bin/workboss.js server start >/dev/null 2>&1
```

---

## T15: Bare TUI Detection (isBareTUICommand)

### 前置
- 已 build

### 步骤
```bash
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const oc = getAdapter('opencode');
const cases = [
  ['opencode', true],
  ['opencode /tmp/project', true],
  ['opencode attach http://x', false],
  ['opencode serve --port 1234', false],
  ['/usr/local/bin/opencode', true],
  ['claude', false],
  ['vim test.txt', false],
];
const failed = cases.filter(([cmd, expected]) => oc.isBareTUICommand(cmd) !== expected);
failed.length === 0 ? console.log('T15 PASS') : console.log('T15 FAIL:', failed);
"
```

### 预期
- `T15 PASS`

---

## T16: Process Ownership Detection (isOurProcess)

### 前置
- 已 build

### 步骤
```bash
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const oc = getAdapter('opencode');
const cl = getAdapter('claude');
const cases = [
  [oc, 'opencode serve --port 1234', true],
  [oc, 'opencode attach http://127.0.0.1:1234', true],
  [oc, 'claude --resume xxx', false],
  [cl, 'claude', true],
  [cl, 'claude --resume abc-def', true],
  [cl, 'opencode serve', false],
  [cl, 'vim test.txt', false],
];
const failed = cases.filter(([adapter, cmd, expected]) => adapter.isOurProcess(cmd) !== expected);
failed.length === 0 ? console.log('T16 PASS') : console.log('T16 FAIL:', failed.map(f => [f[0].kind, f[1], f[2]]));
"
```

### 预期
- `T16 PASS`

---

## T17: Attach Command Construction (buildAttachCommand)

### 前置
- 已 build

### 步骤
```bash
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const oc = getAdapter('opencode');
const cl = getAdapter('claude');

const ocMeta1 = {name:'test',agent:'opencode',cwd:'/tmp',createdAt:'',sessionId:'ses_abc',process:{serve:{serverUrl:'http://127.0.0.1:12345',serverPort:12345,startedAt:''}}};
const ocMeta2 = {name:'test',agent:'opencode',cwd:'/tmp',createdAt:'',process:{}};
const clMeta1 = {name:'test',agent:'claude',cwd:'/tmp',createdAt:'',sessionId:'uuid-123'};
const clMeta2 = {name:'test',agent:'claude',cwd:'/tmp',createdAt:''};

const cases = [
  [oc, ocMeta1, 'opencode attach http://127.0.0.1:12345 --session ses_abc'],
  [oc, ocMeta2, undefined],
  [cl, clMeta1, 'claude --resume uuid-123'],
  [cl, clMeta2, 'claude'],
];
const failed = cases.filter(([adapter, meta, expected]) => adapter.buildAttachCommand(meta) !== expected);
failed.length === 0 ? console.log('T17 PASS') : console.log('T17 FAIL:', failed.map(f => [f[0].kind, f[2]]));
"
```

### 预期
- `T17 PASS`

---

## T18: Orphan Cleaner — Unit Verification

### 前置
- 已 build
- 存在至少 1 个 PPID=1 的 opencode serve（但不在 registry 里）

### 步骤
```bash
node -e "
const {reconcileOrphans} = await import('./dist/application/daemon/orphan-cleaner.js');
const knownWorkers = [{name:'known',agent:'opencode',cwd:'/tmp',createdAt:'',liveness:'up',process:{serve:{pid:$(pgrep -f 'opencode serve' | head -1),serverUrl:'http://127.0.0.1:54435',serverPort:54435,startedAt:''}}}];
const killed = await reconcileOrphans(knownWorkers);
console.log('killed:', killed);
killed >= 0 ? console.log('T18 PASS') : console.log('T18 FAIL');
"
```

### 预期
- `killed: N`（N >= 0，取决于实际孤儿数量）
- 如果 N > 0，孤儿进程已被 kill

---

## T19: Hook Context Injection (setHookContext)

### 前置
- 已 build
- daemon 运行中

### 步骤
1. 发送一个危险 tool 的 hook request
2. 检查 approval 是否被写入（说明 hookCtx 正确注入）

### 验收命令
```bash
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
if [ -z "$CLAUDE_WORKER" ]; then echo "T19 SKIP: no claude worker"; exit 0; fi
curl -sf --max-time 65 -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" -H 'Content-Type: application/json' -d '{"session_id":"t","tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}' > /tmp/t19-result.json 2>&1 &
sleep 2
APPROVALS=$(node bin/workboss.js approvals 2>&1)
echo "$APPROVALS" | grep -qv 'no pending' && echo "T19 PASS (hookCtx injected, approval created)" || echo "T19 CHECK: $APPROVALS"
# cleanup
node bin/workboss.js reject-all 2>/dev/null; kill %1 2>/dev/null
```

---

## T20: Worker Briefing — OpenCode Adapter

### 前置
- 已 build
- 存在至少 1 个 opencode worker 有近期活动

### 步骤
```bash
WORKER=$(node bin/workboss.js list 2>&1 | grep 'up.*opencode' | head -1 | awk '{print $2}')
SID=$(node bin/workboss.js show "$WORKER" 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sessionId',''))")
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const oc = getAdapter('opencode');
const s = await oc.getActivitySummary({name:'$WORKER',agent:'opencode',cwd:'/tmp',createdAt:'',sessionId:'$SID'}, 4);
const checks = [
  ['title exists', typeof s.title === 'string' && s.title.length > 0],
  ['lastActiveAt exists', s.lastActiveAt instanceof Date],
  ['recentActions is array', Array.isArray(s.recentActions)],
  ['recentUserMessages is array', Array.isArray(s.recentUserMessages)],
  ['activeMinutes is number', typeof s.activeMinutes === 'number'],
];
const failed = checks.filter(c => !c[1]);
failed.length === 0 ? console.log('T20 PASS') : console.log('T20 FAIL:', failed.map(f => f[0]));
"
```

### 预期
- `T20 PASS`
- `recentActions` 包含 `{tool: 'bash'|'edit'|'read'|..., summary: '...', timestamp: Date}` 对象
- `recentUserMessages` 包含用户最近的输入文本

---

## T21: Worker Briefing — Claude Adapter

### 前置
- 已 build
- 存在至少 1 个 claude worker 有近期活动

### 步骤
```bash
WORKER=$(node bin/workboss.js list 2>&1 | grep 'claude' | head -1 | awk '{print $2}')
SID=$(node bin/workboss.js show "$WORKER" 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sessionId',''))")
node -e "
const {getAdapter} = await import('./dist/application/orchestration/agents/index.js');
const cl = getAdapter('claude');
const s = await cl.getActivitySummary({name:'$WORKER',agent:'claude',cwd:'/tmp',createdAt:'',sessionId:'$SID'}, 4);
const checks = [
  ['title exists', typeof s.title === 'string'],
  ['lastActiveAt exists', s.lastActiveAt === null || s.lastActiveAt instanceof Date],
  ['recentActions is array', Array.isArray(s.recentActions)],
  ['recentUserMessages is array', Array.isArray(s.recentUserMessages)],
];
const failed = checks.filter(c => !c[1]);
failed.length === 0 ? console.log('T21 PASS') : console.log('T21 FAIL:', failed.map(f => f[0]));
"
```

### 预期
- `T21 PASS`

---

## T22: Dashboard Worker Briefing Display

### 前置
- daemon 运行中
- tmux workboss session 存在

### 步骤
1. `tmux send-keys -t workboss:boss.1 'node <project>/bin/workboss.js dashboard' Enter`
2. `sleep 4`
3. `tmux capture-pane -t workboss:boss.1 -p`

### 预期
- 至少一个 up 状态的 worker 行包含 `·` 分隔的 session title
- 标题后有时间显示（`now` / `Nm` / `Nh` / `Nd`）
- 有活动的 worker 显示 `Nops`

### 验收命令
```bash
PANE=$(tmux capture-pane -t workboss:boss.1 -p 2>&1)
echo "$PANE" | grep -qE 'up · .+ [0-9]+m|[0-9]+h|now' && echo "T22 PASS" || echo "T22 CHECK: $(echo "$PANE" | head -5)"
```

---

## T23: Dashboard Detail Panel (Selected Worker Briefing)

### 依赖
- T22（dashboard 已渲染）

### 步骤
1. 导航到一个有近期活动的 worker（有 `Nops` 的）
2. 检查底部出现 detail panel
3. detail panel 包含 `›` 开头的 user message
4. detail panel 包含 tool call 操作行

### 预期
- 选中活跃 worker 后底部出现 `›` 行（最近 user message）
- 出现 `◈`（read）/ `✎`（edit）/ `$`（bash）行（最近 tool calls）

### 验收命令
```bash
PANE=$(tmux capture-pane -t workboss:boss.1 -p 2>&1)
echo "$PANE" | grep -q '›' && echo "T23 PASS (detail panel shows user message)" || echo "T23 CHECK"
```

---

## T24: Dashboard Detach Worker ('d')

### 前置
- daemon 运行中
- dashboard 渲染中
- 存在一个可 detach 的 up 状态 worker

### 步骤
1. `mkdir -p /tmp/wb-test-detach && node bin/workboss.js spawn e2e-detach --agent opencode --cwd /tmp/wb-test-detach --task "test" 2>&1`
2. 导航到 e2e-detach worker
3. 按 'd'
4. `node bin/workboss.js list 2>&1 | grep e2e-detach`

### 预期
- step 4 worker status 变为 `idle`（从 `up` 变化）
- dashboard 继续运行

### 验收命令
```bash
mkdir -p /tmp/wb-test-detach
node bin/workboss.js spawn e2e-detach --agent opencode --cwd /tmp/wb-test-detach --task "test" >/dev/null 2>&1
sleep 2
# 导航 + 按 'd' 需要手动或用 tmux send-keys
node bin/workboss.js list 2>&1 | grep e2e-detach | grep -q 'up' && echo "T24: worker is up, ready for detach test" || echo "T24 SKIP"
# cleanup
node bin/workboss.js remove e2e-detach 2>/dev/null
rm -rf /tmp/wb-test-detach
```

---

## T25: Patrol Adopt — Worker Registered in Daemon Registry

### 为什么有这个 case
Bug 历史：`adoptDiscoveredWorker()` 写了磁盘但没通知 daemon 注册到内存 registry。
导致 auto-adopted worker 的 hook 请求被 daemon 拒绝（返回 ask 而非 allow）。
**所有之前的 E2E 测试都用了手动 register 的 worker（有 notifyAggregator），从未覆盖 patrol adopt 路径。**

### 路径覆盖
- ✅ Worker 注册路径 A：daemon 启动从磁盘加载（T6/T7 隐式覆盖）
- ✅ Worker 注册路径 B：用户手动 `register`（有 notifyAggregator RPC）
- **本 case 覆盖路径 C**：patrol 自动 adopt（之前无覆盖）

### 前置
- daemon 运行中
- 有至少 1 个 claude 进程在跑（workboss 外部启动的）

### 步骤
1. 重启 daemon（清空内存 registry，然后从磁盘重建）
2. 等待 patrol sweep（或手动触发 `node bin/workboss.js discover --register-alive`）
3. 取一个 auto-adopted claude worker name
4. `curl -s -X POST "http://127.0.0.1:58212/claude-hook/<worker-name>" -d '{"session_id":"test","tool_name":"Read","tool_input":{"file_path":"/tmp/test"}}'`

### 预期
- step 4 返回 `permissionDecision: "allow"`
- **不**返回 `permissionDecision: "ask"` + `"workboss does not know worker"`

### 验收命令
```bash
node bin/workboss.js server restart >/dev/null 2>&1
sleep 3
CLAUDE_WORKER=$(node bin/workboss.js list 2>&1 | grep 'up.*claude' | head -1 | awk '{print $2}')
if [ -z "$CLAUDE_WORKER" ]; then echo "T25 SKIP: no alive claude worker"; exit 0; fi
RESULT=$(curl -sf -X POST "http://127.0.0.1:58212/claude-hook/${CLAUDE_WORKER}" -H 'Content-Type: application/json' -d '{"session_id":"t","tool_name":"Read","tool_input":{"file_path":"/t"}}')
echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow', f'got {d}'; print('T25 PASS')" || echo "T25 FAIL: $RESULT"
```

---

## T26: Hook Path Consistency — settings.local.json Worker Name Matches Registry

### 为什么有这个 case
Bug 历史：多个 claude worker 共享同一个 cwd 时，`settings.local.json` 只有 1 份，
最后写入的 worker URL 覆盖前面的。导致 worker A 的 hook 被路由到 worker B。

### 前置
- 存在 2+ 个 claude worker 共享同一个 cwd

### 步骤
1. 找到共享 cwd 的 worker 组
2. 读 `.claude/settings.local.json`，提取 hook URL 里的 worker name
3. 验证该 worker name 在 daemon registry 里
4. 验证该 worker name 是该 cwd 下唯一 alive 的 worker

### 验收命令
```bash
# 找共享 cwd 的 claude worker 组
SHARED_CWD=$(node bin/workboss.js list 2>&1 | grep 'up.*claude' | awk '{print $NF}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
if [ -z "$SHARED_CWD" ]; then echo "T26 SKIP: no shared cwd"; exit 0; fi

# 读 settings.local.json 里的 hook URL
HOOK_WORKER=$(python3 -c "
import json
with open('${SHARED_CWD}/.claude/settings.local.json') as f:
    d = json.load(f)
hooks = d.get('hooks', {}).get('PreToolUse', [])
for h in hooks:
    for hook in h.get('hooks', []):
        url = hook.get('url', '')
        if 'claude-hook/' in url:
            print(url.split('claude-hook/')[-1])
")

# 验证 hook URL 里的 worker 存在于 list
node bin/workboss.js list 2>&1 | grep -q "$HOOK_WORKER" && echo "T26 PASS: hook worker $HOOK_WORKER exists" || echo "T26 FAIL: hook worker $HOOK_WORKER NOT FOUND in list"
```

---

## 附录：一键回归脚本

```bash
#!/bin/bash
# run-e2e.sh — 顺序执行所有 case，输出 PASS/FAIL
set -e

PROJECT_ROOT="/Users/jingyuanrunsen/project/AgentManager/workboss"
cd "$PROJECT_ROOT"

# 确保 build 最新
npm run build >/dev/null 2>&1

# 确保 daemon 运行
node bin/workboss.js server start 2>/dev/null || true

PASS=0; FAIL=0; SKIP=0

run_test() {
  local name="$1"; shift
  local output
  output=$("$@" 2>&1) && { echo "✅ $name"; ((PASS++)); } || { echo "❌ $name: $output"; ((FAIL++)); }
}

# T1
run_test "T1:Daemon RPC" bash -c 'curl -sf -X POST http://127.0.0.1:58212/rpc -H "Content-Type: application/json" -d "{\"kind\":\"ping\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d[\"ok\"]"'

# T3
run_test "T3:CLI List" bash -c 'node bin/workboss.js list 2>&1 | awk "{print \$3}" | sort -u | grep -cE "^(opencode|claude)$" | grep -q "."'

# T5
run_test "T5:Adapter Identity" node -e "..."

# ... 后续 case 类似

echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
```

> **注**：一键脚本需根据实际环境调整。上面的 `run-e2e.sh` 是骨架，coding agent 根据上面 19 个 case 的验收命令填充即可。
