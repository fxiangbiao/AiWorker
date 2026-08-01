# AGENTS.md — AiWorker

## 常用命令
```bash
npm run dev          # tsx 直接运行 CLI（无需编译）
npm run build        # tsc → dist/
npm test             # vitest run（smoke-test.ts，85 项测试）
```

- **无 lint/formatter 配置** — 本项目不包含 ESLint 或 Prettier。
- **无 `typecheck` 脚本** — `tsc` 在 `npm run build` 中执行。仅需类型检查时用 `npx tsc --noEmit`。

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
`ToolRegistry`、`HookManager`、`McpManager`、`AuditLog` 均通过 `.getInstance()` 访问。**不要**直接 `new` 它们，遵循现有模式。

### 同步 Agent 循环
Agent 循环（`src/core/agent-loop.ts`）是同步设计——LLM 延迟是瓶颈，而非 I/O。每次迭代内工具按顺序执行。除非有实测依据，不要引入异步并行。

### SQLite 运行时数据
- `data/` 目录在 `.gitignore` 中。数据库（`aiworker.db`、`audit.db`）由 `better-sqlite3` 在运行时自动创建，使用 WAL 模式 + FTS5。
- `better-sqlite3` 是**原生 C++ 插件**，需要可用的 C++ 编译工具链或平台预编译包。
- 记忆边界文件（`data/memory/MEMORY.md`、`data/memory/USER.md`）有界管理（≈2200 和 ≈1375 字符），使用段落边界安全截断。

### 项目目录隔离
Agent 的 `fs_write` 输出默认写入 `projectDir`（`--project-dir` 参数，默认 `./ai_default_project`）。`ToolContext.projectDir` 贯穿全链路：CLI → BaseAgent → AgentLoop → 工具调用。

### 权限模式
三种模式：**ask**（只读）、**plan**（列出计划后确认执行）、**craft**（自动执行，高危仍需确认）。危险检测使用 `src/security/danger-detector.ts` 中的正则模式。

## 测试
- 唯一测试文件: `src/smoke-test.ts`（位于 `src/` 下，无独立 `tests/` 目录）。
- 使用 vitest 的 `expect`/`describe`/`it` DSL。
- 运行时创建 `data-test/` 目录，退出时清理。
- vitest 无配置文件，使用默认设置。
- 测试被排除在 `tsc` 编译之外（`tsconfig.json` 排除了 `tests` 目录，但 `smoke-test.ts` 在 `src/` 下所以照常编译）。

## CLI
```
npm start -- --dir /some/path --mode <ask|plan|craft> --data-dir <path> --project-dir <path>
```
交互模式默认为 `craft`。`/mode` 命令可在运行时切换。
使用 **Commander.js** 解析参数，**Inquirer** 处理交互。

### 交互命令
| 命令 | 功能 |
|------|------|
| `/mode <ask\|plan\|craft>` | 切换权限模式 |
| `/plan <描述>` | 多专家 DAG 协作 |
| `/debate <话题>` | 双专家辩论模式 |
| `/skill <名称>` | 手动激活技能 |
| `/status` | 显示状态 |
| `/help` | 帮助 |
| `/exit` | 退出 |

## 代码规范
- **kebab-case** 文件名，如 `agent-loop.ts`、`hook-manager.ts`。
- 所有领域类型定义在 `src/types.ts`。用 `import type { ... }` 导入。
- `ToolResult` 统一使用 `success: boolean` + 可选 `error: string`。
- `HookResult` 使用 `proceed: boolean` 控制短路。
- 设计文档: `个人AI-Agent助手设计方案.md`（1278 行，中文）。

## 专家智能体与路由
- `src/agents/router.ts` — 关键词正则路由（`routeToExpert()`），LLM 语义兜底（`routeToExpertLLM()`）。
- 添加新专家需继承 `BaseAgent`（参考 `default-agent.ts` / `research-agent.ts` / `coding-agent.ts`），并在 `router.ts` 中添加路由规则。
- Agent YAML 配置位于 `config/agents/`（6 个配置文件）。
- 路由优先级: coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)。

## MCP Manager
- 单例 `McpManager`，位于 `src/mcp/mcp-manager.ts` — 支持 `stdio` 和 `HTTP` 传输。
- 从 `config/mcp.json` 加载配置（`loadConfig()`）。
- 发现的服务工具自动注册到 `ToolRegistry`，命名格式 `mcp_{server}_{tool}`。
- 连接失败时优雅降级，不阻塞启动。
- `src/mcp/builtin-server.ts` — 内置 MCP stdio 服务器，提供 4 个工具（math_eval / uuid_gen / json_format / timestamp_convert）。启动时通过 `tsx` spawn。
- Windows: `spawn()` 设置 `shell: true` 以解析 `.cmd` 文件。
- **重连机制**: 统一 `scheduleReconnect` 入口，防止 exit handler + health check 并发触发重连风暴；listener 可追踪清理，避免僵尸引用。

## Web 搜索
- `web_search` 工具在 `src/tools/builtin.ts` 中，使用 Bing（`cn.bing.com`）HTML 抓取。
- 零 API key。通过正则解析 `<li class="b_algo">` 块。

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

## Skills 系统
- `src/core/skill-registry.ts` — 单例，递归加载 `skills/` 目录下 `SKILL.md` 文件。
- 每个技能 = YAML frontmatter（`name`、`triggers`、`expert`、`tools_required`）+ Markdown 正文。
- `skillRegistry.match(input, agentId)` — 正则触发词匹配，非法正则自动跳过不抛异常。
- 通过 `context-manager.ts` → `assembleContext()` 注入系统提示词。
- 依赖缺失的技能在运行时自动隐藏（降级）。

## 记忆系统
- **工作记忆**: 当前会话消息历史，SQLite 持久化。
- **情景记忆**: FTS5 跨会话检索 + 中文分词（`Intl.Segmenter`）+ 时间衰减（每天 15%）。
  - 任务完成时 `summarizeSession` 自动存入 episodic memory。
  - 新会话启动时 `assembleContext` 自动检索相关历史记忆注入系统提示词。
- **语义记忆**: MEMORY.md（双段: 项目信息 + 会话历史）+ USER.md（用户画像）。
  - 有界管理: 段落边界安全截断，防止破损 Markdown。
  - 并发写保护: Promise 互斥锁，防止 lost-update。

## Hook 系统
- 5 个生命周期事件: onMessage / onToolCallPre / onToolCallPost / onTaskComplete / onError
- 12 个已注册 handler: 敏感数据过滤、项目记忆加载、高危确认、Diff 快照、技能评估、权限检查、命令拦截、审计日志、重试退避、模型降级、记忆更新、用户画像写入。
- `loadedSessions` / `snapshots` 在 onTaskComplete 时自动清理 + 30min TTL 兜底。
