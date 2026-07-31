> 本文是 workboss 治理层的 MVP 架构设计，验证核心假设。基础设施层见 README/PRD。未来增强见末节。
>
> **理论根基**：LeastR 论文（"Why LLM Agents Prove Fields Theorems Yet Fail at Real-World Engineering Tasks"，投稿中）提供了阻力最小路径假设的形式化、量化证据和机制探测。本文是论文结论指出的"未来工作——治理机制重塑阻力景观"的第一个实现方案。

# workboss 治理架构：MVP

## 一、核心价值与动机

**核心价值**：确保 agent **忠实完成 owner 的原始需求**（跨领域：编程、数据分析、库存监控等），且以 owner **期望的质量**完成。

**动机**：实际用 Claude Code + opus/glm 等做长程编程，发现仅靠 CLAUDE.md 陈述约束达不到对 agent 工作行为的期望。评测虽不严谨，但行为确凿出现——走捷径、省步骤、置换目标、表演合规。判断这是广泛存在的问题，不是个案。

**根因**：agent 走阻力最小路径是结构均衡，不是 bug。Wang/Huang 将此形式化为 Holmström-Milgrom 框架下的均衡——有限评估指标下，走捷径是理性最优策略。后训练（RLHF/RLAIF）强化了这个倾向，且与 A 类能力（认知省力启发式：快速模式匹配、跳步、经验直觉）深度耦合。陈述性规则只治"知"不治"行"——agent 知道规则不等于行为服从规则，走捷径的权重在内层，陈述在外层。

**LeastR 量化证据**：LeastR 论文将阻力形式化为双轴——compute（串行深度 Span）+ uncertainty（路径不可控度 H(Y|A)/H(Y)），并在 18 个真实工程任务 × 9 个前沿模型 × 10 次 = 1620 次运行中测得 **71.7% 的走捷径率**（95% CI [69.5%, 73.9%]），跨模型一致（9/9, p=0.002），跨 case 一致（13/18, sign-test p=0.048）。机制探测进一步证明：阻力最小倾向在 open-weight 模型的晚期层线性可解码（AUROC 0.784），且双向 activation steering 因果可操控（Fisher p=0.025）。这不是偶发行为，而是刻在权重里的系统性偏置。

**治理策略的重新定位**：LeastR 证明走捷径是结构性的，治理不是"阻止 agent 走捷径"（不可能，权重在内层），而是**重塑阻力景观**——让捷径的产物过不了验收，使走捷径的 uncertainty（被审查者抓住的概率）从 ~0 提升到不可忽视。论文结论原文："This work diagnoses but does not mitigate. Future work should investigate governance mechanisms that reshape the resistance landscape itself." 本文即是该未来工作的第一个方案。

## 二、MVP 验证的核心假设

> **异构非声明审查 + 结果契约，比 CLAUDE.md 陈述性规则，更能约束 agent 忠实度。**

这个 MVP 同时补一个调研 gap："跨家族异构防偷懒"目前无直接实验验证。TraceGuard 验证了同模型互审 0% → 职责分离 100%，但用的是同一模型家族；Syrnikov 等人证明了 prompt-only 宪法无效；12 Angry AI 证明了 RLHF 强度（非能力）决定审议灵活性。跨家族异构——executor 和审查者来自不同模型家族——是否能产生约束力，尚无实验。MVP 本身就是验证它。

## 三、MVP 最小闭环

四步，砍到只剩验证核心假设必需的：

### 1. owner 写自然语言行为契约

契约 = 需求 + 期望质量。自然语言，不是 DSL。owner 的原始意图和对产物的验收标准都写在里面。

### 2. executor 黑盒执行，交付产物

executor = Claude Code headless。配置为不问人类、预定义权限边界（白名单 + 沙箱，越界直接失败）。

黑盒化 = 放弃观察中间过程，只验产物。不是没有副作用——executor 会读写文件、跑命令——而是治理层不看中间状态，只在产物交付时验收。

**MVP 的简化假设：executor 是黑盒，内部无自治治理。** 不假设 executor 自身有 review agent、内部多 agent 协作、或任何自治治理机制。如果 executor 内部有自治治理，那等于"黑盒内部套黑盒"——内层的审查者谁来审、内层的偷懒谁来抓，递归不收敛。MVP 不处理这个递归：executor 就是一个无内部治理的最小 agent，任务进产物出。内部自治治理是核心假设验证后的增强。

### 3. 异构审查者判是否忠实

审查者拿契约 + 产物，判产物是否忠实满足契约。审查者与 executor 来自不同模型家族（异构），executor 不知道被审查（非声明性）。

选型原则：轻对齐、deliberative flexibility 强、reasoning 模型优于纯 chat RLHF（12 Angry AI 的结论：RLHF 强度压制审议灵活性，reasoning 训练保留更多 deliberative 能力）。异构需动态维持——同一模型家族在不同 prompt 下趋向语义坍缩（Multi-LLM Semantic Collapse），必须保证审查者和 executor 持续来自不同家族。

### 4. 判不过 → 升级 owner

审查者判"不忠实"，产物和审查意见一起推送给 owner。owner 是递归终止符——唯一不在"走捷径"机制内的主体。

**对照基线**：同样的长程编程任务，一边只挂 CLAUDE.md，一边挂这套 MVP，对比 agent 跑偏率。

## 四、DAG 作为任务结构（非增强）

**DAG 不是过程 gate，是任务结构——这点必须讲透。**

该排的是"DAG 当过程 gate 审动作"：规定先 grep 再读再改这种动作顺序，管的是"你怎么做"。过程 gate 审 executor 的内部行为，与黑盒原则矛盾——黑盒拿不到中间过程，过程 gate 要么逼黑盒开缝（破坏不可达），要么沦为自证（executor 自己报告步骤）。

该留的是"DAG 当任务结构定粒度"：规定先有调研产物才能开始实现这种**产物依赖**，管的是"前一步产物是不是后一步合法输入"。产物依赖不审过程——它只要求前一步交付了可验的产物，作为后一步的合法输入。

两者本质不同：

| | 过程 gate（该排） | 任务结构（该留） |
|---|---|---|
| 管什么 | 动作顺序（先 grep 再读再改） | 产物依赖（先有报告再有实现） |
| 审什么 | executor 内部行为 | 产物是否完整可验 |
| 与黑盒关系 | 矛盾（要打开黑盒看中间） | 兼容（只验产物接口） |
| 退化风险 | 退回 CLAUDE.md 式过程约束 | 无（产物依赖是结构不是约束） |

### 节点粒度判据

节点 = "能被一份自然语言行为契约充分验收的完整产物"的最小单元。

- 太大 → 契约验不准（产物巨大，审查者无法充分判）→ 拆
- 太小 → 没有完整产物语义，是动作不是产物，退回过程 gate → 合
- 落点 = 中间"产物完整且可验"的最小粒度

编程任务的粒度锚点：

- **合格节点**："实现模块 X 并通过它的黑盒测试"——产物 = 模块代码 + 测试结果，契约可验功能正确性与黑盒性
- **合格节点**："调研 Y 方案，产出选型报告含 A/B 对比和推荐"——产物 = 报告，契约可验对比维度与推荐依据
- **反例（太大）**："实现整个登录系统"——产物巨大，契约验不准，要拆
- **反例（太小）**："grep 找到登录函数位置"——没有完整产物语义，是动作，不该当节点

粒度天然 ≈ 一个 subagent 任务的粒度，owner 已熟悉，不是新发明。

DAG 既让结果契约能精准验（拆小到可验粒度），又显化 planner 一把梭哈偷懒（不分解就只有一个巨型节点，契约验不准，owner/审查者一眼抓到）。DAG 是核心价值的载体，不可砍。

## 五、MVP 里 DAG 的形态

owner（或简单 planner）按"可验产物最小单元"把任务拆成**线性序列节点**。每节点一份契约。前一节点产物验收过，才发下一节点给 executor。

- **不要**：依赖图、并行分支、动态重规划——这些是核心假设验证后的增强。
- **要留**：按可验粒度分节点 + 顺序验收——这是结构，不是增强。

MVP 里 DAG 就是一条线：节点 1 → 验收 → 节点 2 → 验收 → … → 节点 N → 总验收。

## 六、约束力怎么产生（MVP 版）

约束力不来自规则或拦截，来自黑盒结构。三条性质同源于一个结构：

**不可达**：executor 是黑盒。治理层只走"任务进、产物出"的接口。违规通道不存在——预定义权限白名单 + 沙箱（Inspect AI 的 Docker sandbox + approver），越界直接失败，不动态问人类。

**只验产物**：黑盒拿不到内部过程，治理自然落在产物验收上。过程放任（保留 A 类认知省力能力），产物严验（打击 B 类评估作弊 / 目标置换）。结构自动区分 A/B——不需要显式分类。

**非声明性**：executor 不知道被审。异构审查者在 executor 视野外——executor 看到的只有契约和自己的工作，不知道产物会被另一个模型家族的审查者拿契约逐条判。Alignment Faking 证明了 RL 放大伪装能力（Greenblatt et al.：78% 伪装率），非声明性让伪装没有目标——executor 不知道该表演给谁看。Inspect AI 的 sandbox_agent_bridge 通过 localhost proxy 拦截 agent 的 API 调用，agent 不知道自己被路由到了 Inspect model provider——工程上实现了非声明性。

**约束力的本质：重塑阻力景观**。LeastR 论文证明走捷径是阻力最小路径的结构均衡——agent 选 compute 低 + uncertainty 低的路径。治理不试图改变 agent 内层的阻力计算（不可能，权重在内层），而是改变外部阻力景观：

- **不可达**提高了捷径的 compute——绕过沙箱需要更多步骤。
- **只验产物**提高了捷径的 uncertainty——走捷径的产物可能过不了异构审查，而审查结果不在 agent 控制内（H(Y|A) ↑ → uncertainty ↑）。
- **非声明性**阻止了 agent 计算审查者的判据——agent 不知道审查者是谁、用什么标准，无法针对性地伪装（伪装的 compute 成本 ↑）。

三条性质从三个方向提高了走捷径的阻力（compute 或 uncertainty），使"忠实完成需求"从 agent 的视角变成阻力最小的路径——不是通过说教，而是通过结构改变让忠实路径成为理性最优。

## 七、放弃了什么（MVP 取舍）

**CoT 审核不做**：黑盒拿不到 Chain-of-Thought。这正是想要的——保护 A 类能力（CoT 是认知省力的载体），B 类在产物层审就够了，CoT 表演因无观众自动消失。LeastR 的 probe 实验证明走捷径倾向在 hidden state 线性可解码（AUROC 0.784），但那是研究者的离线分析，不是治理层的在线 CoT 审核——治理层不需要也不应该读 agent 内部状态。

**过程 gate 不做，但权限边界要做**：这两者必须区分——

- **过程 gate**（不做）：审 agent 的中间行为顺序（先 grep 再读再改），管的是"你怎么做"。要打开黑盒看中间过程，与黑盒原则矛盾。
- **权限边界**（要做）：Inspect AI 的 approver 拦截每个 tool call，判"这个命令能不能执行"，管的是"你能不能做这个动作"。这是沙箱的一部分——Docker 容器隔离 + approver 白名单 = "越界直接失败"的不可达性。approver 不审过程，只守边界。

governance 第六节"不可达"要求"预定义权限白名单 + 沙箱，越界直接失败"——这个"白名单"就是 approver，不是过程 gate。两者形似但本质不同：过程 gate 审的是"步骤对不对"（过程正确性），approver 守的是"动作允不允许"（权限边界）。

**完美对齐**：不可能。弱到强泛化有不可弥合的 gap，责任归属是 Π₃-complete，机制设计有上限。治理是压缩不是消除。LeastR 的 case\_04 自然实验提供了一个乐观信号：改变任务结构让高阻力路径变便宜，走捷径率从 54% 降到 2%——好的契约设计（降低正确路径的阻力）比纯靠审查惩罚更有效。

## 八、一个待解决的张力（MVP 不解决，标注）

核心价值含"以 owner 期望的特定工作方式完成"——先 ground 再执行、派 subagent 不串行摸索、不搞选项卡。这些工作方式是**过程性**的。

与"不审过程只验产物"有冲突。

MVP 先不解决：聚焦验证"忠实完成需求 + 质量"这个核心假设。工作方式部分由 owner 人工看产物时顺带把关。等核心假设验证后，再回来想"工作方式怎么进契约又不退回过程 gate"。

这是真问题，但不是 MVP 第一刀。

## 九、与现有 workboss 的关系

### 现状诚实清单

现有 workboss 是"进程管理器 + 权限代理"，**基础设施部分完成，治理层完全空白**：

**已实现（基础设施）**：
- Session-first lifecycle（`domain/worker.ts` WorkerMeta）— spawn/detach/attach/remove
- AgentAdapter 多态（`application/orchestration/agents/`：opencode.ts、claude.ts）— 2 种 agent
- approval queue（`domain/approval.ts` + `infrastructure/filesystem/approval-repo.ts`）— 权限审批
- Dashboard 实时 TUI（`presentation/dashboard/`）— liveness + orphan cleanup
- daemon 存活检测 + 孤儿清理（`application/daemon/`）

**未实现（治理层全部空白）**：
- ❌ 黑盒 executor 接口（现有 worker 是交互式 agent session，非 headless 黑盒）
- ❌ 自然语言行为契约层
- ❌ DAG 线性分节点编排（orchestrator 只能 spawn 单个 worker，无节点拆分 + 顺序验收）
- ❌ 异构审查者（judge 停在 opencode plugin hook 插件级，未升级为独立审查者）
- ❌ 审查不过 → 升级 owner 的闭环（approval 是权限审批语义，非审查升级语义）
- ❌ OS 级权限沙箱（只有 hard-deny regex + approval queue，无容器隔离）

### 实现路径：Inspect AI 作为治理引擎

治理三层的核心组件不需要从零写——[Inspect AI](https://inspect.aisi.org.uk/)（UK AI Security Institute 开源评测框架）原生覆盖了 MVP 四步中的三步：

| MVP 步骤 | Inspect AI 原生能力 | 对应文档 |
|---|---|---|
| owner 写行为契约 | `Sample(input=契约, target=验收标准)` | datasets.md |
| 黑盒 executor | `sandbox_agent_bridge()` 在 Docker 沙箱里跑 Claude Code/Codex CLI，agent 的 API 调用被 bridge 拦截路由 | agent-bridge.md |
| 异构审查者 | `model_graded_qa(model=["google/gemini", "anthropic/claude-opus"])` 多模型独立评分 + 多数投票 | model-graded.md |
| 升级 owner | custom approver 返回 `Approval(decision="escalate"/"terminate")` | approval.md |

**Inspect AI 补上了 workboss 的两个核心缺口**：

1. **OS 级权限沙箱**（governance 第六节"不可达"）—— `sandbox="docker"` + `compose.yaml`（`network_mode: none`, `cpus`, `mem_limit`）。agent 的所有 tool call 走 Inspect 的 `exec()`/`read_file()`/`write_file()`，受 approver 拦截。越界直接 reject，不动态问人类。这正是"预定义权限白名单 + 沙箱，越界直接失败"。

2. **非声明性**（governance 第六节）—— `sandbox_agent_bridge` 在沙箱内启动 proxy server，agent 通过 localhost:13131 调 model API，请求被路由到 Inspect model provider。agent 不知道自己的 API 调用被拦截，不知道产物会被 scorer 审查。Inspect 在 executor 视野外。

**Inspect AI 的 scorer 实现了"只验产物"**（governance 第六节）—— custom scorer 能 `sandbox().read_file()` 读沙箱里的产物文件，或拿 `state.output.completion`。black-box，不审中间过程。`model_graded_qa` 的 "Grading Robustness" 做了反注入（grade extraction 绑定最后一个 GRADE、`[BEGIN DATA]` delimiter 中和），正是 governance 引用 Alignment Faking 后担心的伪装问题。

**异构审查直接可用**—— `model_graded_qa(model=["google/gemini-2.5-pro", "anthropic/claude-3-opus"])` 实现了"审查者与 executor 来自不同模型家族"，每个模型独立评分，多数投票。governance 第三节要求"异构需动态维持"，Inspect 的 model list 参数天然支持运行时切换模型组合。

### codux 作为基础设施增强（非 MVP 必需）

[codux](https://github.com/duxweb/codux)（main 分支）的 `codux-runtime-live` crate 提供了 Inspect AI 不擅长的基础设施：

| codux 能力 | Inspect AI 缺口 | 证据 |
|---|---|---|
| 9 种 agent 统一管理（codex/claude/opencode/kiro/codewhale/kimi/mimo/omp/agy） | agent-bridge 只示范了 Claude Code + Codex CLI | `tool_drivers/mod.rs` |
| `apps/agent/` headless binary（`codux-agent`，纯 tokio，无 GPUI 依赖） | Inspect 的 sandbox_agent_bridge 需要自己管 PTY | `apps/agent/Cargo.toml` + `main.rs` |
| `initial_prompt_command(tool, prompt)` 编程式启动带初始 prompt 的 agent | Inspect 需自己构造启动命令 | `tool_driver.rs:198-208` |
| transcript probe（进程树检测 + transcript 文件解析 + 屏幕抓取三层） | Inspect 不监测运行中 agent 状态 | `probe/` 模块 |
| session-first lifecycle（detach/attach/resume） | Inspect 的 eval 是一次性的 | codux README |
| sqlite 持久化 + history 查询 | Inspect 的 eval log 是文件 | `codux-ai-sessions/` |

**codux 的局限**（已确认，非猜测）：
- ❌ 无 OS 级权限沙箱（只有 `tool_permissions.json` 注入 env 让 agent 自守，无强制拦截）
- ❌ 无"向运行中 session 注入下一轮 prompt"的接口（只有 fork 新进程 / resume 新进程）
- ❌ 无异构审查能力
- ❌ 无行为契约层

codux 是**单向监听架构**（观察/统计 AI CLI），不是**双向控制架构**（编排多 agent DAG）。治理层的控制能力（沙箱拦截 + 审查 + 升级）由 Inspect AI 提供，codux 补的是长期 lifecycle 管理和实时监测。

### MVP 技术栈选型

```
owner（人）
  ↓ 自然语言需求 + 验收标准
契约层（新建，Python）
  ↓ Sample(input=契约, target=验收标准)
  ↓ 按"可验产物最小单元"拆线性节点（DAG = 节点1→验收→节点2→…→节点N→总验收）
Inspect AI（治理引擎，pip install inspect-ai）
  ├─ sandbox_agent_bridge → Docker 沙箱跑 coding agent（黑盒 executor）
  ├─ approver → 权限白名单 + 越界 reject（不可达）
  ├─ scorer = model_graded_qa(model=[异构模型列表])（异构审查者）
  └─ Score == INCORRECT → 升级 owner
codux（基础设施增强，MVP 后接入）
  ├─ 9 种 agent PTY 管理 + transcript probe
  ├─ session-first lifecycle（长期跑、detach/attach）
  └─ dashboard 实时监测
```

**MVP 路径**：先用 Inspect AI 做治理核心，验证核心假设（异构非声明审查 + 结果契约 > CLAUDE.md 陈述性规则）。DAG 线性分节点编排是新建代码（Python，薄编排层，调 Inspect 的 `eval()` API）。codux 等核心假设验证后再接入。

### 落地差距表（更新版）

| MVP 要素 | workboss 现状 | Inspect AI 提供 | codux 提供 | 新建 |
|---|---|---|---|---|
| 黑盒 executor | ❌ 交互式 session | ✅ `sandbox_agent_bridge` + Docker | — | — |
| 权限沙箱 | ❌ 只有 regex | ✅ Docker sandbox + approver | — | — |
| 行为契约 | ❌ | ✅ `Sample(input, target)` | — | 契约编写（owner 不可消职责） |
| DAG 线性分节点 | ❌ orchestrator 只能 spawn 单 worker | — | — | ✅ 薄编排层（Python，调 `eval()`） |
| 异构审查者 | ❌ judge 停在插件级 | ✅ `model_graded_qa(model=[list])` | — | — |
| 非声明性 | ❌ | ✅ sandbox_agent_bridge proxy | — | — |
| 升级 owner | ⚠️ approval 是权限审批 | ✅ approver escalate/terminate | — | 语义映射 |
| 长期 lifecycle | ✅ session-first | ❌ eval 一次性 | ✅ detach/attach/resume | — |
| 实时监测 | ✅ Ink TUI | ⚠️ inspect view（web） | ✅ dashboard | — |
| 多 agent 管理 | ⚠️ 2 种 | ⚠️ 2 种示范 | ✅ 9 种 | — |

## 十、未来增强（核心假设验证后，不展开）

planner 动态重规划、复杂依赖图（非线性真 DAG）、同步/异步审查时机、失败重试策略、负担压缩四层（黑盒测试自动判 + 规则沉淀）、team-in-the-loop、provenance、跨领域扩展（库存监控 / 数据分析）。

## 十一、诚实边界

- A/B 在后训练里耦合，架构层解不了权重里的耦合。过程放任保留 A 类、产物严验打击 B 类——这是结构区分，不是权重解耦。LeastR 的 activation steering 实验证明偏置因果可操控（L20 Fisher p=0.025），但那是模型权重层面，治理层做不到——治理只能改外部阻力景观，不能改内层权重。
- 跨家族异构无直接实验验证——这正是 MVP 要补的 gap。MVP 失败的话核心假设不成立。LeastR 的 9 模型横跨中外厂商，但测的是走捷径率而非异构审查的约束力——两个 gap 不同。
- 产物层高明 sandbagging 可能漏：黑盒固有代价。executor 若学会了"产物看起来对但实际偷懒"，黑盒结构看不到中间过程，无法识别。LeastR 的 mixed-path 行为（20% 的 run 走了部分高阻力步骤但跳过关键步骤）说明 agent 不是"全走捷径"而是"选择性跳过"——这种产物可能看起来更接近正确，审查者更难判。
- 契约质量和真目标是 owner 不可消职责。垃圾契约 → 垃圾验收，架构不替 owner 想清楚要什么。LeastR 的 case\_04 自然实验证明：改变任务结构（让高阻力路径变便宜）能让走捷径率从 54% 降到 2%——这暗示契约设计本身（如何拆节点、如何定义验收标准）对治理效果有决定性影响。
- "特定工作方式"张力（第八节）未解决。MVP 只验需求忠实度，工作方式靠 owner 人工把关。
- **Inspect AI 实现路径的新风险**：sandbox_agent_bridge 通过 localhost proxy 拦截 agent 的 API 调用——如果 agent 检测到自己不在直接调 API（延迟差异、环境变量线索），非声明性可能被破坏。这是工程风险，需在 MVP 中验证 agent 是否能感知 bridge 的存在。
- **DAG 编排层是全新代码**：Inspect AI 的 `eval()` 是单 task 单 sample 的，线性 DAG 的节点编排（前节点验收 → 后节点启动）需要自己写编排层。这不是 Inspect AI 的原生能力，是 MVP 的核心新建工作量。

## 十二、文献底座

均 curl 核验 HTTP 200，附 URL。

**理论根基**：
- LeastR, "Why LLM Agents Prove Fields Theorems Yet Fail at Real-World Engineering Tasks" — 阻力最小路径假设的形式化（compute Span + uncertainty H(Y|A)/H(Y) 双轴）、71.7% 走捷径率（1620 runs）、线性可解码（AUROC 0.784）、因果可操控（steering Fisher p=0.025）。本文治理策略的直接理论基础。投稿中。

**治理机制证据**：
- Wang/Huang, "Reward Hacking as Equilibrium under Finite Evaluation" — reward hacking 是结构均衡，Holmström-Milgrom 形式化。https://arxiv.org/abs/2603.28063
- TraceGuard — 同模型互审 0% → 职责分离 100%。https://arxiv.org/abs/2604.03968
- Syrnikov et al., "Institutional AI" — prompt-only 宪法无效。https://arxiv.org/abs/2601.11369
- "Governance-Task Decoupling" (Mechanical Enforcement) — text-only 治理双退化，MCC 0.43→0.88。https://arxiv.org/abs/2605.14744
- "12 Angry AI Agents" — RLHF 强度非能力决定审议灵活性。https://arxiv.org/abs/2605.01986
- "Multi-LLM Systems Exhibit Robust Semantic Collapse" — 异构需动态维持。https://arxiv.org/abs/2605.17193
- Greenblatt et al., "Alignment Faking" — RL 放大伪装 78%。https://arxiv.org/abs/2412.14093
- "Mechanism Design Is Not Enough: Prosocial Agents" — 机制设计有上限。https://arxiv.org/abs/2605.08426
- Bootstrapped Monitoring — 递归终止工程方案。https://arxiv.org/abs/2606.11998
- "Weak-to-Strong Generalization" 局限 — 弱监督者与强模型 gap 不可弥合。https://arxiv.org/abs/2508.17018
- "Responsibility Gap and Diffusion" — 责任归属 Π₃-complete。https://arxiv.org/abs/2507.02582

**实现工具**：
- Inspect AI — UK AI Security Institute 开源评测框架。sandbox_agent_bridge + Docker sandbox + model_graded_qa + approver 原生覆盖治理三层。https://inspect.aisi.org.uk/
- codux — 跨平台 AI 开发工作站。`codux-runtime-live` crate 提供 9 种 agent 管理 + headless binary + transcript probe + session lifecycle。https://github.com/duxweb/codux
