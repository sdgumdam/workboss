# discipline-hooks 插件 v2 实施计划

## 背景

v1 问题：system prompt 注入了几百行 PUA prose，LLM 经常不遵守。后处理用正则匹配，容易绕过且误判。

v2 核心改进：
1. 精简 system prompt 为硬规则 checklist
2. 用 GLM-4.7 LLM 做二分判断（WARNING/OK），替代正则
3. 用 `messages.transform` hook 提取完整工具上下文，不只是看输出文本
4. judge 能看到"实际工具返回了什么" vs "assistant 输出了什么"，能检查证据是否真实

## 改动范围

只改一个文件：`.opencode/plugin/discipline-hooks.ts`

## 文件结构

```
常量定义
  API_ENDPOINT    = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
  MODEL_ID        = "glm-4.7"
  CACHE_TTL_MS    = 5 * 60 * 1000
  CACHE_MAX_SIZE  = 100
  JUDGE_TIMEOUT_MS = 3000
  MAX_RETRIES     = 1

工具函数
  truncate(text, headLen, tailLen) → 头部+尾部拼接，中间 "..."
  parseVerdict(raw) → JSON parse → 递归找 verdict → 字符串匹配 → null
  cleanupCache(cache) → 删除 >5min 条目 + 大小超限删除最旧

缓存
  Map<sessionID, {
    userQuestion: string
    toolResults: Array<{ toolName, args, result }>
    assistantTexts: string[]
    updatedAt: number
  }>

日志函数（沿用现有 log.info）

Hard rules system prompt（精简版，砍掉 PUA prose）

Judge prompt 模板

Judge 调用函数
  async judge(text, cached): Promise<{verdict, reason} | null>

Plugin 主函数
  hooks["experimental.chat.system.transform"]
  hooks["experimental.chat.messages.transform"]
  hooks["experimental.text.complete"]
```

## 各部分详细规格

### 1. truncate(text, headLen, tailLen)

```
text.length <= headLen + tailLen → 原样返回
否则 → text.slice(0, headLen) + "\n...\n" + text.slice(-tailLen)
```

截断规格：

| 字段 | 头部 | 尾部 |
|------|------|------|
| userQuestion | 200 | 0 |
| toolResult.args | 200 | 0 |
| toolResult.result | 300 | 200 |
| assistantText | 150 | 50 |

### 2. parseVerdict(raw)

```
1. JSON.parse(raw)
2. 递归遍历找 key === "verdict" 的值
3. 找到 → 值为 "WARNING" 或 "OK" → 返回 {verdict, reason}
4. 找不到 → raw 字符串包含 "WARNING" → 返回 {verdict: "WARNING", reason: "parsed from string"}
5. 都不匹配 → 返回 null
```

### 3. cleanupCache(cache)

```
1. now = Date.now()
2. 遍历 cache，删除 now - updatedAt > CACHE_TTL_MS 的条目
3. 如果 cache.size > CACHE_MAX_SIZE
   → 按 updatedAt 升序排列
   → 删除最旧的直到 size ≤ CACHE_MAX_SIZE
```

三层防护（任一层失效都有兜底）：
- TTL 5 分钟（防泄漏）
- 大小上限 100 条（防并发 session 暴增）
- 单条体积可控（~19KB，工具结果截断）

### 4. Hard rules system prompt（精简版）

保留内容：
- Pre-output checklist（5 条）
- Anti-patterns（4 条）
- Negative evidence rule（含真实失败案例）
- Debugging protocol（4 步）

砍掉内容（这些已在 AGENTS.md 中）：
- PUA 通用方法论/压力升级
- Owner 意识/能动性
- 开发规范（代码/commit/测试）

### 5. Judge prompt

```
你是 AI 输出质量检查员。判断 assistant 的最新输出是否包含【没有实际工具输出支撑】的诊断结论。

实际工具输出 = 下面 toolResults 列表中的内容。
- 如果 assistant 在输出中引用了某些工具结果，检查 toolResults 中是否真的存在对应内容
- 如果 assistant 的结论需要工具输出支撑，检查 toolResults 中是否有对应的实际数据
- "没找到/not found/空" 本身不算有效证据，除非 assistant 同时证明了搜索位置正确

判断标准：
- OK = 所有结论都有对应工具输出支撑，或输出中无诊断结论
- WARNING = 存在没有工具输出支撑的结论，或引用了 toolResults 中不存在的"证据"

用户问题: {userQuestion}
工具调用记录:
{toolResults 格式化输出}
当前 assistant 输出:
{currentOutput}

回答 JSON: {"verdict": "OK" 或 "WARNING", "reason": "一句话说明"}
```

### 6. Judge 调用

```
async judge(text, cached):
  body = {
    model: "glm-4.7",
    messages: [
      { role: "system", content: judgePrompt },
      { role: "user", content: 拼装内容 }
    ],
    max_tokens: 100,
    temperature: 0,
    response_format: { type: "json_object" },
    thinking: { type: "disabled" }
  }

  headers = {
    Authorization: "Bearer " + process.env.zhipucoding,
    Content-Type: "application/json"
  }

  result = await Promise.race([
    fetch(API_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) }),
    timeout(JUDGE_TIMEOUT_MS)
  ])

  解析 response → content 字段
  verdict = parseVerdict(content)
  if verdict === null → 重跑一次（同参数）
  if 仍 null → 返回 null（放行）
  返回 verdict
```

### 7. messages.transform hook

```
遍历 output.messages:
  sessionID = msg.info.metadata.sessionID

  如果 msg.info.role === "user":
    遍历 msg.parts, 找 type === "text" 的 → truncate(200, 0) → 存 userQuestion

  如果 msg.info.role === "assistant":
    遍历 msg.parts:
      type === "tool-invocation" && state === "result"
        → { toolName, args: truncate(args, 200, 0), result: truncate(result, 300, 200) }
        → append to toolResults
      type === "text"
        → truncate(150, 50) → append to assistantTexts

  cache.set(sessionID, { userQuestion, toolResults, assistantTexts, updatedAt: Date.now() })
  cleanupCache(cache)
```

### 8. text.complete hook

```
text = output.text
if (!text || text.length < 50) return

sessionID = input.sessionID
cached = cache.get(sessionID)

if (!cached || !process.env.zhipucoding) return  // 没有上下文或没有 key，放行

result = await judge(text, cached)

if (!result) → 放行，日志 "judge_failed"
if (result.verdict === "WARNING")
  output.text = text + "\n---\n**[DISCIPLINE WARNING]** " + result.reason + "\n---"
  日志: verdict=WARNING, reason
else
  日志: verdict=OK, reason

cache.delete(sessionID)  // 清理缓存
```

## Hook 时序

```
用户发消息
  ↓
messages.transform #1（看到 user message）
  ↓
LLM 生成 → 工具调用
  ↓
工具执行 → 结果返回
  ↓
messages.transform #2（看到 tool results，更新缓存）
  ↓
LLM 生成最终输出
  ↓
text.complete（从缓存取工具上下文 + 当前输出 → judge）
```

## API 验证记录

- API: `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`
- Key: `process.env.zhipucoding`
- Model: `glm-4.7`
- `thinking: {"type": "disabled"}` → 无推理，~53 tokens，秒回
- `response_format: {"type": "json_object"}` → JSON 输出（可能嵌套，parseVerdict 处理）
- 测试结果：WARNING 判断正确（无证据结论），OK 判断正确（有证据结论）

## 验证步骤

1. `bun build --no-bundle` 编译通过
2. 开新 opencode session，确认日志出现 `plugin loaded`
3. 故意输出一条无证据的结论，观察 WARNING 是否追加
4. 输出有证据的结论，观察 OK 通过
5. 确认日志中 verdict + reason 记录正常
