# Sprint 26 — DSH 对比改进第二批（7 项）

> 承接报告 `docs/comparison-report.md`：Sprint 23/24/25 已落地 LLM seam、事件溯源、轨迹/遥测；
> 本批实现用户选定的 7 项：A 超长结果落盘、D 统一超时、F ask_user、C 持久终端、E 防循环、G 自动标题、B 工具结果剪枝、#5 审批服务 seam 化。

---

## A. 超长工具结果落盘（spill）

**问题**：`fs_read` 无大小上限（5MB 文件 ≈ 140 万 token 直接爆上下文）；`terminal_exec` 输出最多 10MB 全量塞进结果。

**方案**：
- 新文件 `src/tools/spill.ts`：`spillContent(dataDir, sessionId, content, ext)` → 内容超阈值（默认 **8000 字符**）时写入 `<dataDir>/spills/<sessionId>-<ts>-<rand>.txt`，返回定位符文本：
  ```
  [结果已落盘: data/spills/xxx.txt（N 字符 / ~M tokens）。如需完整内容，请用 fs_read 读取。]
  前 1500 字符预览: …
  ```
- `ToolContext` 增加 `dataDir?: string`；`AgentLoopDeps` 增加 `dataDir?: string`；`BaseAgent` 构造 deps 增加 `dataDir?: string`（全 optional，不破坏 team.test.ts）；`index.ts` 组装时传入。
- 接入点：`builtin.ts` 的 `fs_read`、`terminal_exec` 两个 handler —— 结果超阈值且 `ctx.dataDir` 存在则落盘，否则原地截断（fallback）。
- 事件溯源天然 replay-safe：事件只存定位符文本，完整内容在磁盘文件。

## D. 工具调用统一超时

**问题**：仅 `terminal_exec` 自带超时；其他工具（fs_read 大文件、web_fetch、MCP 工具）无统一护栏。

**方案**：
- `agent-loop.ts` `executeToolInner` 中包一层 `withTimeout(handler(args, ctx), TOOL_TIMEOUT_MS)`（`Promise.race`，默认 **60s**，常量导出）。
- 超时返回 `{success:false, error:"工具调用超时(60s): <toolName>"}`；terminal_exec 自身 30s 超时先触发，语义不变。
- 不取消底层操作（与 DSH `dsh-tool-call-timeout-policy` 同思路：护栏而非强杀）。

## F. ask_user 提问工具

**问题**：模型任务含糊时只能瞎猜，无法主动向用户澄清。

**方案**（复用 confirm-channel 的 provider 模式，零 ToolContext 改动）：
- 新文件 `src/tools/ask-channel.ts`：`AskProvider` / `setAskProvider` / `createHttpAskProvider(send, timeoutMs)` / `askResponse(id, answer)` / `requestAsk(question, options?)`；无 provider 时走 stdin 自由文本（复用 stdinConfirm 模式）。
- 新工具 `ask_user(question, options?)`：注册进 `builtin.ts`；handler 调 `requestAsk`；无 answerer（极端情况）返回错误。**加入 `PermissionModel.READONLY_TOOLS`**（只读无害，ask 模式放行）。
- HTTP：`server.ts` 新增 `runWithAsk(write, fn)` 包裹 `/chat`（与 runWithConfirm 并列），SSE 发 `ask_user` 事件；新增 `POST /api/v1/ask`（`{id, answer}`）。
- CLI/TUI：无 provider 时 stdin 兜底，与现有确认交互一致。
- Web：`chat.svelte.ts` 增加 `asks: AskItem[]`；`ChatPanel` handleSSE 增加 `ask_user` 分支 + `respondAsk()`；新组件 `AskCard.svelte`（问题 + 选项按钮 / 自由文本输入框 + 提交）。

## C. 持久终端会话

**问题**：`terminal_exec` 每次 spawn 新 cmd，`cd`/`export`/环境变量不保留，多步开发任务别扭。

**方案**：
- 新文件 `src/tools/terminal-session.ts`：`TerminalSession`（spawn `cmd.exe /Q`，stdin 写命令 + `echo <marker>` 分隔符，读 stdout 直到 marker 解析输出；`cd`/env 跨调用保留；启动时 `chcp 65001` 防中文乱码；**超时即销毁进程**防缓冲区错位，下次自动重启）+ 模块级 `Map<sessionId, TerminalSession>`。
- 新工具 `terminal_session`：`{action: "start"|"exec"|"end", command?, timeout?}`；exec 输出同样过 spill（A）。
- 非 Windows 平台回退说明（逻辑仍可用，spawn shell 不同）。

## E. 防循环提醒（repeat-tool-reminder）

**问题**：模型反复调用同一工具同一参数（如重复 fs_read）无干预；现有"空响应断路器"不覆盖此路径。

**方案**：
- `agent-loop.ts` 两处循环维护 `recentToolCalls: {name, argsKey}[]`（工具结果产生后追加，保留最近 ~10 条）。
- 循环顶部（`completeWithProfile` 之前）调 `maybeInjectRepeatReminder(messages, recentToolCalls)`：若**最近 ≥3 次连续相同 (name, argsKey)** 且该 streak 未提醒过 → 向 messages 注入 `{role:"system", content:"你已连续多次以相同参数调用 <tool>，结果没有变化。请停止重复，改用其他方式或直接给出最终回答。"}`；以 `lastReminderStreakKey` 防重复注入。

## G. 会话自动标题

**问题**：`/sessions` 与 Web 会话列表无标题（只有首条消息/日期）。

**方案**（复用现有 `sessions.summary` 即标题 + `title/set` 事件，零 UI 改动）：
- `SessionStore.appendMessage` 事务内：当 `role==="user"` 且 `sessions.summary IS NULL` 时，用首条非空行截断（≤24 字符 + "…"）作为标题，UPDATE summary + `appendEvent("title/set")`。
- 模板生成，不做 LLM 调用（避免延迟与额外 token）；CLI `/sessions` 与 Web 列表（`firstUserMsg || summary`）自动生效。

## B. 工具结果剪枝（replay-safe pruner）

**问题**：压缩器整轮丢弃中间历史；超大工具结果（spill 前的历史数据）仍可能超长。

**方案**：
- `context-manager.ts` 新增 `pruneOversizedToolMessages(messages)`：`assembleContext` 输出前对 `role==="tool"` 且 content > 20000 字符的消息截断为 `前 20000 字符 + "\n…[已截断，完整内容见事件日志/落盘文件]"`。
- replay-safe：`session_events` 保留完整内容，仅上下文投影截断。
- `compressor.ts` 的 `estimateTokens`/摘要输入同步受益（摘要本身已 slice 500）。

## #5. 审批服务 seam 化

**问题**：权限判断（permissionCheck/dangerousCommandBlock/confirmHighRisk）散落在 hooks 里，不可独立测试、默认策略不 fail-closed。

**方案**：
- 新文件 `src/security/approval-service.ts`：`ApprovalService`（构造注入 `PermissionModel` + `DangerDetector` + 回答者函数 `confirm: (req) => Promise<string|null>`），核心方法：
  - `checkToolCall(toolName, args, mode)` → `{decision: "allow"|"block"|"confirm", message?}`（ask 拦截、plan 全确认、auto 高危确认，**默认 block**）
  - `checkCommand(command, mode)`（危险命令检测，供 terminal_exec 同语义）
- `hooks/handlers.ts` 的 `createPermissionCheck` / `createDangerousCommandBlock` / `createConfirmHighRisk` 改为薄委托到 ApprovalService（行为等价，逻辑单点）；`index.ts` 组装注入。
- 行为不变，仅重构；补单元测试验证三模式矩阵。

---

## 测试计划

- `test/spill.test.ts`：阈值触发落盘 / 定位符内容 / 未超阈值不落盘 / 无 dataDir 原地截断
- `test/tool-timeout.test.ts`：mock 慢 handler 超时返回 error；快速 handler 正常
- `test/ask-channel.test.ts`：provider 应答 / 超时 null / stdin 兜底（mock）
- `test/terminal-session.test.ts`：exec 输出解析、cd 持久、超时销毁重启（Windows 可用性降级跳过）
- `test/agent-loop.test.ts`（扩展）：重复调用注入提醒（mock modelRouter 返回固定工具调用）
- `test/session-events.test.ts`（扩展）：appendMessage 首次 user 消息自动设标题 + title/set 事件；已有标题不覆盖
- `test/context-manager.test.ts`（扩展）：超长 tool 消息被截断、事件日志完整
- `test/approval-service.test.ts`：ask/plan/auto 三模式决策矩阵 + fail-closed 默认
- server.test.ts 扩展：`POST /api/v1/ask` 404/200；SSE `ask_user` 事件（mock）
- 全量回归：`tsc --noEmit`、`eslint`、`vitest`、`web:build`

## 提交

- 功能提交 ×1–2（core + web 拆分），README/AGENTS.md 同步（新增 ask_user/terminal_session 工具、spill、自动标题、超时护栏说明），`plans/sprint-26-*.md` 记录。

---

## 执行记录（Sprint 26 完成）

**实施偏差**（相对初始方案）：
- **C 持久终端**：按推荐默认，未引入 node-pty（spawn `cmd.exe /Q` + marker 分隔符）；修复了旧子进程 `exit` 迟到事件误伤新会话的竞态（exit 处理器仅清理自身进程的监听与引用）
- **G 自动标题**：按推荐默认，模板截断（≤24 字符，不调 LLM），复用 `sessions.summary` + `title/set` 事件（`source: "auto"`，不覆盖手动重命名）
- **D 超时**：`AgentLoopDeps` 增加 `toolTimeoutMs?`（默认 60s，测试注入短值）

**新增/改动文件**：
- 新增：`src/tools/spill.ts`（SPILL_THRESHOLD=8000 落盘 + 定位符）、`src/tools/ask-channel.ts`（AskProvider 分发）、`src/tools/terminal-session.ts`（持久 shell）、`src/security/approval-service.ts`（决策矩阵 + fail-closed）、`web/src/components/AskCard.svelte`
- 改动：`types.ts`（ToolContext.dataDir）、`agent-loop.ts`（dataDir 透传 + withTimeout + 防循环提醒）、`base-agent.ts`/`index.ts`（dataDir/approval 接线）、`builtin.ts`（fs_read/terminal 落盘 + ask_user/terminal_session 工具）、`session-store.ts`（自动标题）、`context-manager.ts`（工具结果剪枝）、`handlers.ts`（三个权限 hook 薄委托）、`permission-model.ts`（READONLY_TOOLS + ask_user）、`server.ts`（runWithChannels + /api/v1/ask）、`ChatPanel.svelte`/`chat.svelte.ts`（ask_user SSE + 提问卡片）

**测试**：新增 `spill` / `agent-loop`（超时+防循环）/ `ask-channel` / `terminal-session` / `approval-service` 5 个文件；扩展 `session-events`（自动标题 4 例）、`server`（/ask 端点 3 例）、`core`（8 内置工具断言）。全量 **266 通过**（原 233 + 33）。

**验证**：`tsc --noEmit` 0 错误；`eslint src/ test/` 0 警告；`vitest` 266 通过（20 文件）；`web:build` 成功。

