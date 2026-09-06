# Sprint 44 — Token 统计与展示修正（上下文窗口 / 轮次用量 / 口径统一）（1.2.0）

> 状态：📋 **计划待确认（v3：二轮审查修订落地——R1 方案 A / R2-R11 补全）**
> 需求：审计发现 TUI/Web 的 token 展示存在口径混乱、上下文窗口虚构等问题；目标：模型上下文窗口可配置且真实化、本轮用量与占比可展示、token 口径统一并标注。**计费统计统一移除**——API 价格经常变化，由应用端维护计价表统计费用无意义（费用请用户在 DeepSeek 平台核对），本次删净 UI/后端/配置中的费用展示与计价逻辑
> 前置：Sprint 43（1.1.0，9ac57bc 已提交推送）

## 一、目标

1. **上下文窗口可配置 + 真实化**：`models.json` 支持配置 provider/model 级上下文窗口（用户需求），压缩预算与展示统计分离，删除 context-manager 硬编码 8000 与 compressor 的窗口混用
2. **本轮/会话用量可展示**：每轮结束产出「本轮 usage（prompt/completion + 上下文占比）」，TUI 回答 footer 与 Web 助手气泡可展示；Web `/context` 按当前会话真实计算
3. **token 口径统一并标注**：本轮 / 会话 / 进程全局三档语义清晰、各展示点标注来源，消除"三个数字都对不上"
4. **移除计费统计**：删除计价配置、cost 计算与全部费用展示（TUI footer ¥、/status、/config、Web StatusBar cost、PRICING 常量）

## 二、现状问题（审计编号）

| # | 问题 | 位置 |
|---|---|---|
| P1 | TUI footer 与 Web StatusBar 展示进程累计 token，被误读为本轮；TUI `/new` 会清掉 Web 显示 | index.ts:976、StatusBar.svelte:25、ChatPanel.svelte:423-425 |
| P2 | 三条会话口径矛盾：/log（hooks 差分，含压缩）vs /trace、/stats（事件求和，不含压缩）vs 全局计数器 | handlers.ts:780-891、trace.ts:164-170 |
| P3 | 无模型上下文长度数据源：windowSize 硬编码 8000、compressor 硬编码 32768、ModelProfile 无 contextWindow | context-manager.ts:191、compressor.ts:8、model-router.ts:23-36 |
| P4 | 计费统计：计价只认 default provider、Web 写死 PRICING、展示与真实账单脱节——**价格多变，应用端统计无意义 → 统一移除** | model-router.ts:201-208、status.ts:12、StatusBar.svelte:9 |
| P5 | breakdown 用 projection（无 tool 消息）估算，字符÷3.5 无 CJK 区分，与真实请求偏差大 | context-manager.ts:129-166 |
| P6 | Web /context 固定 sessionId="" → 上下文 Tab 恒为静态，与选中会话无关；无占比展示 | server.ts:922-927、SystemPanel.svelte:565-576 |

## 三、设计

### 1. 数据层

#### 1.1 models.json 增 `contextWindow`（provider/model 级 + profile 覆盖，可配置）

**需求（用户）**：配置需支持配置对应 provider 模型的上下文窗口。设计采用**三级可配置 + 内置兜底**：

```jsonc
{
  // ① provider/model 级窗口表：provider 默认 + "provider.model" 精确覆盖
  "contextWindow": {
    "deepseek": 1048576,             // 官方口径：V4 全系默认 1M context
    "openai": 131072,
    "anthropic": 200000,
    "google": 262144,                // Google Gemma 4 26B 官方 256K
    "deepseek.deepseek-v4-flash": 1048576,  // 具体模型精确覆盖（优先级高于 provider 默认）
    "openai.Gemma-4-26B-A4B": 16384,        // 本地实测最佳上下文（官方 256K 由部署资源限制收窄）
    "openai.Qwen3.8-27B": 16384             // 本地实测最佳上下文（官方 1M 由部署资源限制收窄）
  },
  // ② default / profiles 级窗口：单个生效路由可再覆盖
  "default": { "provider": "deepseek", "model": "deepseek-v4-flash", ..., "contextWindow": 1048576 },
  "profiles": { "lite": { "provider": "openai", "model": "Qwen3.8-27B", ... } }  // 无 contextWindow → 命中顶层精确键
}
```

**deepseek-v4-flash 官方上下文窗口（已核实）**：**1M context = 1,048,576 token**（依据 [DeepSeek-V4 Preview Release（官方，2026-04-24）](https://api-docs.deepseek.com/news/news260424/)："1M context is now the default across all official DeepSeek services"、"Both models (V4-Pro / V4-Flash) support 1M context"；旧 deepseek-chat/reasoner 已退役路由到 v4-flash，其原窗口不代表该模型名）。1M 按 2^20 计；若厂商按 1,000,000 计，改 models.json 一处即可。

**其余模型窗口说明（官方口径 + 本地实测）**：
- **Google Gemma 4 26B-A4B**：模型标称 262,144 token（256K，Amazon Bedrock 模型卡与 [google/gemma-4-26B-A4B-it](https://huggingface.co/google/gemma-4-26B-A4B-it) 一致）；**用户本地部署实测最佳上下文 16384** → models.json 顶层精确键按本地值 16384 配置（本地推理资源决定实际可用窗口）
- **Qwen3.8-27B**：阿里云 Model Studio 官方页 [qwen3.8-27b](https://help.aliyun.com/en/model-studio/qwen3-8-27b) Context Window 1,000,000（1M）；**用户本地部署实测最佳上下文 16384** → 顶层精确键按本地值 16384 配置
- 原则：**本地实际运行窗口优先**（配置覆盖官方/内置表），官方云端口径仅作兜底；本地模型未来可做 Ollama `/api/show` 等运行时探测（num_ctx 即此类值，见后续项，不在本 sprint）
- **openai 移除 gpt-4o 精确键**（用户要求；openai 默认 131072 保留）

**解析优先级（`ModelRouter.getContextWindow(preference?)`）**，按生效 profile（含运行时 model 覆盖）取首个命中：
1. profile 自身 `contextWindow`
2. 顶层 `contextWindow["<provider>.<model>"]`（provider 归一化小写）
3. 顶层 `contextWindow["<provider>"]`
4. 内置兜底表（deepseek 1048576 / openai 128000 / anthropic 200000 / google 262144 / 其他 32768）
5. `CONTEXT_WINDOW_FALLBACK = 32768`（最终兜底）

- `ModelsConfig.contextWindow?: Record<string, number>`；`ModelProfile.contextWindow?: number`
- `getAvailableModels()` 输出补解析后的 `contextWindow`（`/config model`、Web 配置/设备卡展示）
- 校验：正整数；非法值回退兜底并 warning
- 运行时 `/config add-model`（`addProfile`）不带窗口 → 走回退链 2-5；需要精确窗口时在 models.json 手配（README 注明）

#### 1.2 压缩预算窗口与物理窗口**分离**（审查 A1）

`compressor.ts:8` 现 `CONTEXT_WINDOW=32768` 同时充当占比分母、**压缩触发阈值（0.75）**、**压缩目标预算（0.35）**。若直接绑定模型物理窗口（1M），触发阈值 ≈786k、目标 ≈367k → 压缩几乎失效、历史与成本无界增长。

**修正**：
- `ContextCompressor` 保留独立**预算窗口**概念（常量改名 `COMPRESS_BUDGET`，默认 32768 语义不变；构造参数 `budgetWindow` 可注入，阈值 0.75 / 目标 0.35 / `KEEP_TARGET_RATIO` / `MIN_KEEP_TURNS` 全部沿用现状）——它是成本护栏，**不随**模型窗口走
- 模型物理 `contextWindow` 只用于：展示（TUI/Web/设备卡）、上下文占比分母、真实溢出保护（现有 finishReason=length 压缩重试兜底不变）
- 若未来希望按模型窗口压缩：另加可配置项（本 sprint 不做，注明）

#### 1.3 上下文分层统计真实化（P3/P5 + 审查 R5）

- `getContextBreakdown(systemPrompt, sessionId, userMessage, agentId?, windowSize?)`：
  - `windowSize` 参数化（调用方传 modelRouter 当前 contextWindow；TUI statusWindowPct、/context、server /context、Web 全改传）
  - 历史改为 `replayEvents(sessionId)` 派生文本（**含 tool 消息与 tool_calls 参数字符**），对齐 assembleContext 组装
  - **估算核心收敛为共享函数**（新 util `estimateText`）：CJK ≈1 token/字、ASCII ≈1 token/4 字符；compressor 遍历消息 + tool_calls JSON 调用它，context-manager 直接调用它（避免两处分叉）
  - breakdown.total 为估算值：tools JSON、实时注入（budget 提醒/防循环）不在其内 → UI 统一标注「估算，仅展示」
- `ContextBreakdown.windowSize` 已有；返回增 `remaining = windowSize - total`
- **性能（审查 R5，必做）**：TUI `statusWindowPct` 随 `printStatus` 高频触发（每条消息/命令后），全量 `replayEvents`（逐次 parse 事件 JSON、含 20k 上限 tool 文本）在长会话下成本陡增 → 按会话 `updatedAt`/事件数缓存 breakdown（会话无新事件则复用上次结果）；`/context` 命令与 Web Tab 走完整计算（可点刷新）
- **既有测试破坏（审查 B5）**：`test/cli-commands.test.ts:74` windowSize mock、server `deps.getContextBreakdown` 签名、CLI `/context` 输出断言需同步更新

#### 1.4 会话级用量账本 + 三档 token 口径（P1/P2 根治，审查 A4/R6）

- `ModelRouter` 维护 `sessionScopes: Map<sessionId, {prompt, completion}>`（**仅 token，无费用**）：
  - `complete/completeWithProfile/completeStream` 增可选 `scope?: string`（加在 `ModelCompleteOptions`；**仅供 router 记账，不进 adapter 请求体、不进 usage 事件**——dispatch 显式构造 adapter options，天然剥离，写明保证）
  - agent-loop 两处调用点传 `sessionId`；压缩请求带 scope（见 1.5）
- **三档 token 口径定义（单一语义，UI 各点标注）**：
  - `本轮` = 会话账本 onMessage 快照 → onTaskComplete 差分（含同轮压缩；**不含** loop 外摘要，见 1.5；并发两会话不串算）
  - `会话累计（持久、展示主口径）` = assistant/message 事件 usage 求和（= 现 computeSessionStats 语义；**不含**摘要/压缩请求、错误轮——跨重启一致）
  - `进程全局` = 现有全局累计（/status、StatusBar 标注"全局"）
  - 包含矩阵：压缩 → 计入"本轮"，不计"会话累计"；摘要 → 仅"进程全局"（见 1.5）；错误轮真实消耗 → 计入会话账本现值（仅运行期参考），turn 差分置 0（保留现状语义）、事件求和不含
- `createTurnLogger`（handlers.ts）：基线/差分改读会话账本（替换全局计数，修复并发串算）；错误轮置 0 保留
- **账本生命周期（审查 R6，必做）**：
  - `ModelRouter` 暴露 `deleteScope(sessionId)`；Web `DELETE /sessions/:id`（server.ts）调用清理
  - TUI `/new`（session.ts:24 `resetTokenUsage`）一并清空 sessionScopes（TUI 为单会话前端，旧 id 永不重用，防 Map 无界增长）
  - Web 多会话场景账本随会话自然留存，仅在会话删除时清理；可选项：会话账本上限（如最近 500 个，超出丢弃最旧——v1 不做，注明）

#### 1.5 scope 贯通：压缩计入本轮、摘要仅全局（审查 A3，用户已选**方案 A**）

区分两类 loop 外/内的整理请求：

- **`maybeCompress`（agent-loop 迭代内，await，天然在 onMessage..onTaskComplete 窗口内）→ 带 scope 计入本轮**：
  `ContextManager.maybeCompress(messages, scope?)` / `compressor.compress(messages, scope?)` / `generateSummary(messages, scope?)` 透传 sessionId，`modelProvider` 闭包把 scope 放入 options → router 记入会话账本
- **`summarizeSession`（loop 外，base-agent.ts:155/240 保持 fire-and-forget，**不改 await、不阻塞每轮交互**）→ 不带 scope**：
  token 只进进程全局计数，不进会话账本/任何轮差分；因其在 onTaskComplete 结算后异步完成，现状语义本就如此，UI 口径统一标注「会话/轮次统计不含上下文整理（摘要）消耗」
- 时序依据（供实现，审查 R11）：base-agent.run 内 onTaskComplete（写 TurnLog/账本结算）先于 runStream resolve → server done 事件，故 done 处读取即为本轮结算值，不重复差分

### 2. 计费统计移除（P4，统一去掉）

**理由（用户）**：API 价格经常变化，应用端维护计价表并统计费用无意义，费用应由用户在平台侧核对。

- `config/models.json`：删除 `pricing` 键；`ModelsConfig` 删 `pricing` 类型
- `ModelRouter`：删除 `getCost()`（含 pricing 解析）；保留 token 计数 getters；`dispatch` 不再读单价
- TUI：删除 `index.ts:972-978` 回答 footer 的 `¥cost` 段（保留 `token` 段，本轮化见 3.1）；`/status`（config.ts:79-93）、`/config`（config.ts:243-249）删除成本输出行
- Web：删除 `web/src/lib/stores/status.ts` PRICING 常量；`StatusBar.svelte` 移除 cost 项
- 验证：全仓无 `getCost` / `PRICING` / `pricing` 残留引用（含 **test/cli-commands.test.ts:28 的 `getCost: vi.fn(() => 0)` mock 一并删除**，审查 R8）
- Web `promptTokens/completionTokens` stores（移除 cost 后无展示消费方）：保留供 trace/会话 tooltip 使用，不删（审查 R10）
- README/docs 补一句：token 用量可查，费用请在 DeepSeek 平台账单核对（可选一行）

### 3. TUI 展示

#### 3.1 回答 footer 本轮化（P1，无费用）

`index.ts:972-978` 运行前快照会话账本 → 回答后打印：
`[迭代: N, 工具: M, 本轮: ↑x ↓y tok (窗口 z%)]`（z 分母 = 当前模型 contextWindow，估算标注；注意 1M 窗口下 z 通常 <1%，属正常）
进程累计不再出现在 footer（/status 查）。

#### 3.2 /context 真实窗口 + 剩余

`session.ts:250-295`：分母改传 `modelRouter.getContextWindow()`；表格尾行加「剩余可用 = windowSize − total」。

#### 3.3 /status /config 展示窗口、移除成本

- `/status`：`模型: xxx (窗口 128k)` + token 三档摘要（本轮/会话/全局，标注来源）；**删除成本行**
- `/config`：模型列表（`getAvailableModels`）带 contextWindow 展示；删除成本行
- `/log`：底部「轮次差分求和」标注（**审查 R2**：数据源是 TurnLog 求和，非事件求和，标注不得写错口径）

### 4. Web 展示

#### 4.1 SSE done 下发本轮 usage（审查 A2/R7/R11）

- `/chat` done 事件增 `turnUsage: { prompt, completion, total, contextPct }`：onTaskComplete（写 TurnLog/账本结算）先于 run 返回 → done 处读取账本差分值，不重复差分（R11）；`contextPct` 分母按**该会话 agent 的 modelPreference** 解析窗口（R7），非写死 default
- `/plan` `/debate`：协调器每步 `agent.run` 无 sessionId → 每步 `createSession` 产生多个内部子会话（team-coordinator.ts:146/211/223/237/241），无单一"本轮"可结算 → **本次不下发 turnUsage**（保留全局 tokenUsage），避免不可核对的数字；其内部子会话在 trace/log 正常可见（现有行为，注明）
- 子会话残留边界（审查 R9）：plan/debate 内部子会话进 sessions 表、重启后 syncServerSessions 会合入 Web 侧栏——属**现状既有行为**，本次不处理，验收时不作为缺陷

#### 4.2 助手气泡 token 脚注

- UIMessage 增 `_turnUsage?: { prompt, completion, total, contextPct }`
- `ChatPanel.svelte` done 处理写入当前助手消息；`AnswerBlock` 底部显示 `本轮 ↑p ↓c · N tok · 窗口 y%（估算）`
- reload 回填见 4.5（历史消息显示"单次请求 usage"，与实时"整轮合计"口径差异用 tooltip 标注，见 §5 口径标注）

#### 4.3 StatusBar 语义修正

`StatusBar.svelte`：`tokens: N` → `全局 tok N`（标注累计语义）；**删除 cost 项**；不再 import PRICING。

#### 4.4 Web /context 会话化（P6 + 审查 C2/R4）

- `GET /context?sessionId=`：server.ts:922-927 透传 sessionId
- **agent 取数链（审查 R4，必写）**：session.record.agentId → `deps.createAgent(agentId).getConfig().systemPrompt` + 把 agentId 传给 breakdown（技能匹配才正确）——替换现有恒 default 的 `deps.getSystemPrompt?.()` 用法
- SystemPanel 上下文 Tab：按当前选中会话刷新，显示窗口长度 + 每层占比条 + 剩余量 + 估算标注
- **C2 兜底**：本地新对话尚未建服务器会话（GET 404/空）→ 展示空态提示「该会话尚未在服务器建立（发送首条消息后可见）」；后端 404 不再静默空对象
- 设备/模型卡（DeviceStatus.model）增 `contextWindow` 展示

#### 4.5 GET /sessions/:id 附带 usage（reload 回填，审查 R3）

- server.ts:747-756：assistant/message 事件本带 usage 但 replayEvents 丢弃 → 响应补 **按 assistant 事件顺序的平行数组** `usages: Array<{ promptTokens, completionTokens, totalTokens } | null>`（与 messages 中 assistant 消息一一对应；含中间 tool_calls 消息的迭代请求 usage；replay 回退到投影表时全为 null）
- 前端 `loadRemoteMessages` 读取并按序填充 `_turnUsage`（口径：单次请求，见 4.2 标注）

### 5. 口径标注（P2）

- Sidebar 会话 tok（事件求和）、TracePanel stats（事件求和）、TracePanel 最近活动（轮次差分）、StatusBar（全局累计）四处各加 title/tooltip 标注取值来源，使不一致不再误导
- 气泡实时数字 = 本轮差分 vs reload 数字 = 单请求 usage：tooltip 注明「运行期整轮合计 / 历史单次请求」

## 四、测试

- model-router：contextWindow 解析链（profile 字段 > `provider.model` 键 > provider 键 > 内置表 > 32768 兜底；运行时 model 覆盖后重命中）；非法值回退；getAvailableModels 含 contextWindow；会话账本累加/差分（**并发两会话互不串算**）；scope 不进 adapter 请求体；deleteScope；/new 全清账本
- 计费移除回归：getCost/PRICING/pricing 全仓零残留（含 cli-commands.test.ts mock 删除）；/status、/config、footer 无成本输出
- compressor：预算窗口独立语义（默认 32768 阈值/目标回归不变；注入 budgetWindow 生效；**不随**模型窗口）
- context-manager：breakdown 用 replayEvents 含 tool 消息与 tool_calls 字符；estimateText CJK/ASCII；windowSize 参数化；remaining；**缓存按 updatedAt 命中/失效**
- handlers turn logger：账本差分（并发隔离）、错误轮置 0 保留、压缩带 scope 计入本轮、**摘要（不带 scope）仅增全局不扰差分**（时序单测）
- server：/status（contextWindow、无 pricing/cost）、/context?sessionId（agent 取数链 + 404 兜底）、/chat done 带 turnUsage（contextPct 按会话 agent 窗口）、/plan /debate done 不带 turnUsage、GET /sessions 附平行 usages
- TUI：footer 本轮字段无 ¥、/context 剩余行、/status 无成本（CLI 集成断言）
- **既有 fixture 更新（审查 B5/R8）**：cli-commands.test.ts（windowSize mock + getCost mock）、/context 输出、config /status 快照、server deps mock
- Web：web tsc 0 错误 + web:build；StatusBar（无 cost/全局标注）、上下文 Tab 会话化空态、气泡脚注静态核对
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build` + web tsc

## 五、风险与边界

- **deepseek-v4-flash 窗口已按官方 1M（1048576）配置**；1M 按 2^20 计，若按 1,000,000 计改 models.json 一处；其余 provider/model 均可配置覆盖，不涉及代码
- **计费统计移除为破坏性变更**（UI cost 项消失、models.json pricing 删除）→ CHANGELOG 醒目说明；费用请用户在平台核对
- 压缩预算窗口默认 32768 为成本护栏（不随模型窗口）；如希望按模型窗口压缩需后续显式配置项（本 sprint 不做）
- breakdown/占比为估算（无 tokenizer），仅展示；真实 token 以 provider usage 事件为准
- 会话累计主口径 = 事件求和（跨重启一致）；运行期"本轮"= 账本差分（含压缩、不含摘要）；摘要仅全局；差异通过 UI 标注说明，不追求数字相等
- **摘要保持 fire-and-forget（方案 A）**：每轮交互延迟不回归；代价是摘要 token 不归属任何会话/轮次口径（标注说明）
- /plan /debate 不提供单轮 turnUsage（多内部子会话），保留全局 tokenUsage；子会话进侧栏属现状行为，不在本次范围
- 上下文占比在流式过程中不实时更新（done 时结算）；1M 窗口下占比通常 <1%，展示正常
- meta 调用（进化/生成器/裁判）不带 scope → 不计入会话账本（UI 口径标注）
- 会话账本为内存结构：进程重启后"本轮/会话现值"口径消失，持久口径（事件求和 + TurnLog）不受影响

## 六、版本

1.2.0：package.json → CHANGELOG.md → README 徽章（提交时同步；CHANGELOG 记计费移除）

## 七、改动文件清单（预估）

后端：`config/models.json`（+contextWindow、−pricing）、`src/core/model-router.ts`、`src/core/context-manager.ts`、`src/memory/compressor.ts`、`src/memory/util（新 estimateText）`、`src/hooks/handlers.ts`、`src/core/agent-loop.ts`、`src/types.ts`、`src/agents/base-agent.ts`、`src/memory/session-store.ts`（如需）、`src/server.ts`、`src/index.ts`、`src/commands/config.ts`、`src/commands/session.ts`、`src/terminal/trace-view.ts`
Web：`web/src/lib/stores/status.ts`（−PRICING）、`web/src/components/StatusBar.svelte`（−cost、全局标注）、`web/src/components/ChatPanel.svelte`、`web/src/components/AnswerBlock.svelte`、`web/src/components/SystemPanel.svelte`、`web/src/components/Sidebar.svelte`、`web/src/components/TracePanel.svelte`、`web/src/lib/stores/chat.svelte.ts`（`_turnUsage`）、`web/src/media/status.ts`（DeviceStatus + contextWindow）
测试：`test/` 相应新增/回归 + 既有 fixture 更新（cli-commands.test.ts 等）
