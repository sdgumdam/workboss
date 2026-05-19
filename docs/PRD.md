# Workboss 交互 PRD

## 布局

```
┌──────────────────┬─────────────────────────┐
│                  │  workboss dashboard     │
│  boss            │                         │
│  (orchestrator)  │  ● alpha   up    0待审  │
│  TUI             │  ● beta    up    2待审  │
│                  │  ○ gamma   idle  -      │
│                  │                         │
│                  │  [← 返回 boss]          │
│                  │  [⏻ shutdown]           │
│                  │  ⚠ 2 pending approvals │
└──────────────────┴─────────────────────────┘
```

- 左侧 60%：当前活动窗口内容（boss 或 worker TUI）
- 右侧 40%：dashboard，全局常驻，所有 window 都显示
- tmux 状态栏隐藏 window tab，不暴露 tmux 导航

## Dashboard

一个 TUI 程序（`workboss-dashboard`），跑在右侧 pane。

### 显示内容

- worker 列表：名称、状态（up/degraded/idle/dead）、待审批数
- 当前所在窗口高亮
- 待审批汇总（数量 + 最早等待时间）
- 两个按钮：`[← 返回 boss]`、`[⏻ shutdown]`

### 交互

- 点击 worker 名 → `tmux select-window` 切到该 worker 全屏
- 点击 `[← 返回 boss]` → 切回 boss window
- 点击 `[⏻ shutdown]` → 执行关机流程
- 数据实时刷新（LivenessWatcher 事件驱动，2 秒兜底轮询）

## 导航

唯一导航路径：dashboard 点击。不暴露任何 tmux 原生操作：

- 所有 tmux 快捷键 unbind（包括 `Ctrl+B d`、`Ctrl+B n/p`、`Ctrl+B x`、`Ctrl+B &` 等）
- tmux 状态栏隐藏 window tab
- 关闭终端窗口 = 自然离开，session 后台继续
- 重新进入 = `workboss boss`（attach 到已有 session）

## 退出

一个操作：shutdown。两个触发入口：

1. 点击 dashboard 的 `[⏻ shutdown]`
2. 命令行 `workboss shutdown`

### Shutdown 流程

1. detach 所有 worker（SIGTERM serve 进程 + 关 tmux window）
2. stop daemon
3. kill tmux session

不提供 detach 作为独立概念。离开 = 关窗口，回来 = `workboss boss`。

## LivenessWatcher

- daemon 定时（60s）+ commands 操作后（spawn/detach/attach）双触发
- 状态变化时更新 WorkerMeta.liveness 并发 `liveness-changed` 事件
- dashboard 订阅事件，实时刷新显示
