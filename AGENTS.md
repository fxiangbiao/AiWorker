# AGENTS.md — AiWorker

## 常用命令
```bash
npm run dev          # tsx 直接运行 CLI（无需编译）
npm run build        # tsc → dist/
npm test             # vitest run（smoke-test.ts，85 项测试）
npx tsc --noEmit     # 仅类型检查
```

- **无 lint/formatter 配置** — 本项目不包含 ESLint 或 Prettier。

## 环境要求
- 默认需要 `DEEPSEEK_API_KEY` 环境变量（`config/models.json` 通过 `${DEEPSEEK_API_KEY}` 引用）。
- lite 本地模型需要 `OPENAI_API_KEY`（指向 `localhost:8000`）。
- Node >= 22.0.0。

## 架构核心

### ESM + `.js` 导入扩展名（关键）
项目为 `"type": "module"`（ESM）。所有**相对导入**必须使用 **`.js` 扩展名**，即使源文件是 `.ts`：
```ts
import { toolRegistry } from "./core/tool-registry.js";   // ← 正确
import { toolRegistry } from "./core/tool-registry";      // ← 运行时失败
```
`tsx` 更宽容，但编译后的 `dist/` 代码缺少 `.js` 扩展名会直接报错。

### 单例模式
`ToolRegistry`、`HookManager`、`McpManager`、`AuditLog`、`SkillRegistry` 均通过 `.getInstance()` 或导出常量访问。**不要**直接 `new` 它们，遵循现有模式。

### Agent 循环
`src/core/agent-loop.ts` — 两个入口：`runAgentLoop`（同步）和 `runAgentLoopStream`（流式 + AbortSignal）。瓶颈是 LLM 延迟，工具按顺序执行。空响应达 3 次自动终止（断路器）。token 压缩阈值 75%，保留最近 3-8 个轮次。

### SQLite 运行时数据
- `data/` 目录在 `.gitignore` 中。数据库（`aiworker.db`、`audit.db`）由 `better-sqlite3` 运行时自动创建，WAL 模式。
- `better-sqlite3` 是**原生 C++ 插件**，需要 C++ 编译工具链或平台预编译包。
- 记忆边界文件（`data/memory/MEMORY.md`、`data/memory/USER.md`）有界管理（≈2200 和 ≈1375 字符），段落边界安全截断。
- `data/snapshots/` — 文件变更快照（diff），onTaskComplete 时自动清理 + 30min TTL。
- FTS5 查询前清洗特殊字符（`*` `AND` `OR` `NEAR` 等），防注入。

### 项目目录隔离
- `fs_read` / `fs_list` 基准路径为 `workingDir`（`--dir` 参数）。
- `fs_write` 基准路径为 `projectDir`（`--project-dir` 参数，默认 `./ai_default_project`），且**路径遍历防护**：`path.relative` 检查确保写入不越界。
- `ToolContext.projectDir` 贯穿全链路：CLI → BaseAgent → AgentLoop → 工具调用。

### 权限模式
三种模式：**ask**（只读）、**plan**（列出计划后确认执行）、**craft**（自动执行，高危仍需确认）。
- 危险检测: `src/security/danger-detector.ts` — 正则模式 (rm -rf /, DROP TABLE, git push --force 等)。
- `PermissionConfig` 统一定义在 `src/types.ts`，`permission-model.ts` 导入使用。
- `permissionCheck` handler 仅在 `onToolCallPre` 事件中生效（添加了事件类型校验）。

---

## 测试
- 唯一测试文件: `src/smoke-test.ts`（位于 `src/` 下，无独立 `tests/` 目录）。
- 使用 vitest 的 `expect`/`describe`/`it` DSL。
- 运行时创建 `data-test/` 目录，退出时清理。
- vitest 配置文件: `vitest.config.ts`。

---

## CLI
```
npm start -- --dir /some/path --mode <ask|plan|craft> --data-dir <path> --project-dir <path> --show-thinking
```
交互模式默认为 `craft`。`/mode` 命令可在运行时切换。
使用 **Commander.js** 解析参数，自研终端渲染器 (`src/terminal/renderer.ts`) 处理输出。

### 交互命令 (完整)

| 命令 | 功能 | 说明 |
|------|------|------|
| `/mode <ask\|plan\|craft>` | 切换权限模式 | 运行时切换 |
| `/plan <描述>` | 多专家 DAG 协作 | 模板优先 → LLM 生成 → 拓扑序执行 |
| `/debate <话题>` | 双专家辩论 | 独立分析 + 互审 + 综合报告，自动匹配最优专家对 |
| `/skill <名称>` | 手动激活技能 | 将 SKILL.md 注入当前对话 |
| `/new` | 开启新会话 | 清空上下文 + 重置 token 计数 |
| `/thinking` | 切换思考展示 | 折叠/展开 reasoning_content |
| `/log` | 查看监控日志 | 当前 session 轮次摘要表(迭代/工具/耗时) |
| `/context [查询]` | 上下文占用分析 | 分层 token 占比条形图 + MCP 工具列表 |
| `/skill-evo` | 技能沉淀开关 | 运行时开启/关闭自动技能提取 |
| `/status` | 显示状态 | 模式/模型/token/成本/技能数/排队数 |
| `/help` | 帮助 | 显示命令表 |
| `/exit` | 退出 | — |

### 终端渲染器注意事项
- **Windows readline 异步清理**: `rl.close()` 后需 50ms delay 才能确保下次 `createInterface` 不继承残留监听器。
- **`endLiveStatus()`**: 使用 `\r\x1b[2K`（CR + 清行），不带尾 `\n`，防止多 chunk 调用时产生大量空行。
- **`stopLiveStatus`**: `liveStatusActive` 标志实现幂等，防止多次调用副作用。
- **`thinkingFirstLine`**: 用 `thinkingLineCaptured` 标志持续累积到遇 `\n`，而非仅首个 chunk。
- **CJK 对齐**: `displayWidth()`/`padToWidth()` 处理 CJK 字符占 2 列的情况。
- **模型流式 token 计数**: `completeStream` 循环内仅捕获最终 usage 值，循环外一次性 `+=`，避免 DeepSeek 多 chunk 带 usage 导致计数膨胀。

---

## 代码规范
- **kebab-case** 文件名，如 `agent-loop.ts`、`hook-manager.ts`。
- 所有领域类型定义在 `src/types.ts`。用 `import type { ... }` 导入。
- `ToolResult` 统一使用 `success: boolean` + 可选 `error: string`。
- `HookResult` 使用 `proceed: boolean` 控制短路。
- **不添加注释** — 除非绝对必要说明复杂逻辑。
- `coerceToolArgs`: 数字字符串转换前校验合法数字格式（含科学计数法），排除 NaN/Infinity，`"true"`/`"false"` 优先于数字转换判断。
- 设计文档: `个人AI-Agent助手设计方案.md`（1278 行，中文）。

---

## 专家智能体与路由
- `src/agents/router.ts` — 关键词正则路由（`routeToExpert()`），LLM 语义兜底（`routeToExpertLLM()`）。
- 添加新专家需继承 `BaseAgent`（参考 `default-agent.ts` / `research-agent.ts` / `coding-agent.ts`），并在 `router.ts` 中添加路由规则。
- Agent 配置: TS 硬编码 fallback + YAML 文件覆盖 (`config/agents/*.yaml`)。
  - YAML 中的 `modelPreference` 使用白名单校验 (`default/coding/reasoning/writing/creative/lite`), 无效值降级到 `default`。
- 路由优先级: coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)。
- `run()` / `runStream()` 触发 `onTaskComplete` 时传入 `data.messages`（供 skill evolution 等 handler 使用）。
- Task 完成后的 `result.messages` 被清空为 `[]`，避免内存膨胀。

---

## MCP Manager
- 单例 `McpManager`，位于 `src/mcp/mcp-manager.ts` — 支持 `stdio` 和 `HTTP` 传输。
- 从 `config/mcp.json` 加载配置（`loadConfig()`）。`enabled: false` 可禁用特定服务器。
- 发现的服务工具自动注册到 `ToolRegistry`，命名格式 `mcp_{server}_{tool}`。
- 连接失败时优雅降级，不阻塞启动。
- `src/mcp/builtin-server.ts` — 内置 MCP stdio 服务器，提供 4 个工具：
  - `math_eval` — 数学表达式计算（沙箱 `new Function()` + Math 方法白名单 Set + 局部 sandbox 对象）
  - `uuid_gen` — UUID v4 生成
  - `json_format` — JSON 格式化验证
  - `timestamp_convert` — 时间戳 ↔ 日期互转
- Windows: `spawn()` 设置 `shell: true` 以解析 `.cmd` 文件。
- **重连机制**: 统一 `scheduleReconnect` 入口，防止 exit handler + health check 并发触发重连风暴；listener 可追踪清理，避免僵尸引用。
  - `health-check.ts`: 健康检查连续 3 次失败后触发重连。`recordFailure` **不**调用 `shouldRetry`（避免双重 increment），交由 `scheduleReconnect` 统一管理。
  - `connection-pool.ts`: 指数退避 `min(1000 * 2^attempts, 30000)`，最大 5 次重连后标记 dead。

---

## Team 协调器
- `src/core/team-coordinator.ts` — 多智能体 DAG 编排。
- `/plan <任务>` CLI 命令: 模板优先匹配 → LLM 生成执行计划 → 拓扑序执行。
- 4 种内置模板: 游戏开发流水线、产品分析报告、全栈功能开发、投资分析。
- 失败容忍: 非关键步骤失败跳过，关键步骤失败中止。
- 步间隔离: 每个子 Agent 独立会话，独立迭代预算。
- **环路检测**: Kahn 算法检测循环依赖，发现后抛错而非静默删除依赖。
- **死锁检测**: execute 中步骤依赖无法满足时返回故障报告。

### 辩论模式
- `TeamCoordinator.debate()` — 两专家独立分析同一问题，交换结论互审，合成综合报告。
- CLI: `/debate <话题>`，关键词自动匹配最优专家对:
  - 投资/股票 → financial vs data-analysis
  - 游戏 → game-dev vs product-ops
  - 技术选型 → coding vs research
  - 产品/运营 → product-ops vs research
  - 默认 → research vs coding

---

## Skills 系统
- `src/core/skill-registry.ts` — 单例，递归加载 `skills/` 目录下 `SKILL.md` 文件。
- 每个技能 = YAML frontmatter（`name`、`triggers`、`expert`、`tools_required`）+ Markdown 正文。
- `skillRegistry.match(input, agentId)` — 正则触发词匹配，非法正则自动跳过不抛异常。
- `skillRegistry.reloadSkill(path)` — 热加载单个 SKILL.md，同名覆盖。
- 通过 `context-manager.ts` → `assembleContext()` 注入系统提示词。
- 依赖缺失的技能在运行时自动隐藏（降级）。

### 技能自进化 (M2)
- `src/core/skill-evolution.ts` — 复杂任务后自动沉淀 SKILL.md 候选。
- 触发阈值: iterations >= 3, toolCalls >= 3, 未截断。
- 生成 → 验证 → 评分 → >= 3★ 注册到 `skills/{expert}/`。
- **配置开关**:
  - 配置文件: `config/hooks.json` 中 `evaluateSkillCreation` 条目设置 `"enabled": false` 永久关闭。
  - 运行时: `/skill-evo` 命令切换当前会话开关（`hookManager.on/off`）。
- **注意**: 当前为模板空壳版本，M2.1 将接入 LLM 知识提取 + 去重 + 用户确认。

---

## 记忆系统
- **工作记忆**: 当前会话消息历史，SQLite 持久化（`messages` 表）。
- **情景记忆**: FTS5 跨会话检索 + 中文分词（`Intl.Segmenter`）+ 时间衰减（每天 15%）。
  - 任务完成时 `summarizeSession` 自动存入 episodic memory。
  - 新会话启动时 `assembleContext` 自动检索相关历史记忆注入系统提示词。
  - 三阶段检索: FTS5 原始 → FTS5 分词 → LIKE fallback。
  - FTS5 MATCH 查询前清洗特殊字符（`*` `AND` `OR` 等），防注入。
- **语义记忆**: MEMORY.md（双段: 项目信息 + 会话历史）+ USER.md（用户画像）。
  - 有界管理: 段落边界安全截断 (`safeTruncate`)，防止破损 Markdown。
  - 并发写保护: Promise 互斥锁 (`acquireLock`)，防止 lost-update。
  - `extractUserProfile`: 单次遍历 patterns（消除 O(n^2) 查找），从消息中提取技术栈/偏好标签。
- **token 估算**: 统一使用 `Math.ceil(chars / 3.5)`（context-manager + compressor 保持一致）。

---

## 上下文管理
- `src/core/context-manager.ts` — 组装上下文 + 压缩 + 分层统计。
- `src/core/project-profiler.ts` — 启动时扫描工作目录，生成项目画像（类型/包管理器/测试框架/顶层目录/关键文件），注入 system prompt。
- `freezeSnapshot()`: 会话开始时捕获 MEMORY.md + USER.md 快照，保证前缀缓存有效性。
- `getContextBreakdown()`: 分层 token 占比统计（系统提示词/项目记忆/用户画像/情景记忆/技能/会话历史/当前消息），`/context` 命令显示条形图。
- `mergeUserProfile`: 简单覆盖策略（有界截断），从对话中提取技术栈、习惯等标签。
- Token 压缩: 75% 阈值触发，保留最近 3-8 个完整轮次，中间摘要替代。

---

## Hook 系统
- 5 个生命周期事件: onMessage / onToolCallPre / onToolCallPost / onTaskComplete / onError
- 14 个已注册 handler (config/hooks.json):
  - **onMessage**: `autoLoadProjectMemory`（自动加载项目文件）, `sensitiveDataFilter`（敏感信息检测）
  - **onToolCallPre**: `dangerousCommandBlock`（高危命令拦截）, `permissionCheck`（权限检查, 仅 onToolCallPre）, `sensitiveDataFilter`, `confirmHighRisk`（Craft 模式弹确认）, `captureDiff`（文件快照）
  - **onToolCallPost**: `auditLog`（审计）, `captureDiff`（计算 diff）, `toolCallLogger`（工具调用日志, 真实 args/duration/success）
  - **onTaskComplete**: `updateMemory`（持久化摘要）, `evaluateSkillCreation`（技能沉淀, 可开关）, `turnLogger`（轮次日志，真实 userInput/token/success/failed 计数）
  - **onError**: `retryWithBackoff`（重试标记）, `fallbackModel`（模型降级）
- `createEvaluateSkillCreation`: 传入 messages + modelRouter（供 M2.1 LLM 知识提取使用）。
- `createTurnLogger`: 从 `data.messages` 提取首个 user message 作为 `userInput`，统计 tool role 消息的 success/failed 计数。
- `createToolCallLogger`: 从 hook context 取真实 args、success、resultPreview，记录 duration（onToolCallPre 时间戳）。
- `interactiveConfirm`: 临时退出 raw mode → stdin 读取 y/N → 10s 超时自动拒绝。
- `loadedSessions` / `snapshots` 在 onTaskComplete 时自动清理 + 30min TTL 兜底。
- Hook 配置支持 `enabled: false` 字段，`hook-config-loader` 跳过 disabled 条目。
- `hookManager.has(id)`: 检查指定 ID 的 handler 是否已注册。

---

## 监控日志
- `src/memory/session-store.ts` 新增 `turn_logs` / `tool_call_logs` 两张表。
- `TurnLog`: 轮次级（session/agent/seq/userInput/iterations/toolCalls/success/failed/tokens/finishReason）。
- `ToolCallLog`: 调用级（toolName/args/duration/success/resultPreview）。
- `getTurnLogs(sessionId)` / `getToolCallLogs(turnId)` — snake_case → camelCase 显式映射。
- CLI `/log` 命令显示当前 session 轮次摘要表。
- `updateTurnLog(turnId, partial)` — 动态字段更新（camelCase → snake_case 列名转换）。

---

## 模型路由
- `src/core/model-router.ts` — 多 profile 路由 + token 计数 + 成本计算。
- Profile 配置: `config/models.json`，支持 `${ENV}` 环境变量引用，`resolveEnv()` 解析。
- 流式 token 计数: `completeStream` 内对每个 chunk 的 usage 仅捕获最终值，循环外一次性 `+=`。
- `resetTokenUsage()`: `/new` 时清零累计 token。

---

## Web 搜索
- `web_search` 工具在 `src/tools/builtin.ts` 中，使用 Bing（`cn.bing.com`）HTML 抓取。
- 零 API key。通过正则解析 `<li class="b_algo">` 块。
- `web_fetch`: 15s AbortController 超时 + HTML 清理 + 输出限长 10000 字符。
