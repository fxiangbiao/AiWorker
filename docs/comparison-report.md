# DeepSeek Harness vs AiWorker — 源码对比总结报告

> 分析依据：DeepSeek Harness 官方仓库（GitHub）+ 本地安装的完整实现（195 个 `@deepseek-ai/*` 包，版本 `0.1.0-rc.6`，即正在运行的 harness 本体）；AiWorker 本地源码（`src/` 47 个 TS 文件 + `web/`）。
>
> 参考：[官方架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [架构文档中文版](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md) · [子系统文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/README.md) · [DeepWiki 解析](https://deepwiki.com/deepseek-ai/deepseek-harness)

---

## 一、定位对比

| 维度 | **DeepSeek Harness (dsh)** | **AiWorker** |
|---|---|---|
| 定位 | 面向开发者/团队的开源 **Agent 运行时平台**（"一切皆插件"），DeepSeek 官方工具链 | 个人使用的**本地 AI Agent 助手**，多专家路由 + MCP + Skills + Hooks 自研单体 |
| 目标用户 | 开发者、需要深度定制/二次开发的团队、Agent 平台建设者 | 个人开发者在本地终端/浏览器与 AI 协作 |
| 形态 | Monorepo：`apps/cli` + `apps/web` + **195 个 npm 包**（编译产物 697 个 JS 文件 ≈ 12.1MB） | 单一 npm 包（`src/` 47 文件 ≈ 9,871 行 TS + `web/` 27 文件 ≈ 2,767 行） |
| 代码量级 | 约 10–20 倍于 AiWorker | 紧凑，可单人维护 |
| 技术栈 | TypeScript + **Cordis 插件框架**（Koishi 系）+ schemastery 模式校验 + React Web UI | TypeScript + OpenAI SDK + better-sqlite3 + Svelte 5/Vite + 自研 TUI |

---

## 二、架构形态：决定性差异

### DSH —— 插件化的"运行时平台"

- **一切皆插件**：连 agent-loop 本身、工具注册表、会话存储、压缩策略、权限 都是 Cordis 插件（`AgentLoop extends Service`、`ToolRuntime extends Service`），可被用户用 `cordis.yml` 替换、组合、热插拔（`cordis-plugin-hmr`）。
- 核心抽象是 **seam（能力缝）**：`ctx.fs` / `ctx.shell` / `ctx.sandbox` / `ctx.approval` / `ctx.compaction` / `ctx.web` / `ctx.subagents` …每个 seam 都有"抽象包 + 本地实现包 + 沙箱实现包"三件套（如 `dsh-fs` / `dsh-fs-local` / `dsh-fs-sandbox`），实现与契约完全解耦。
- 会话是**事件溯源（event-sourced）**：`dsh-session` 全量事件日志 + `dsh-session-persistence-jsonl` 持久化 + `dsh-session-projection-cache` 投影缓存 + SQLite FTS5 查询，支持回放、快照、跨会话引用。
- 前端是**双进程架构**：Host（Node）与 Web 客户端（React，30+ 个 `dsh-client-ui-*` 包）通过 WebSocket 通信，`dsh-client-connection` 负责断线重连。

### AiWorker —— 自研紧凑单体

- 经典分层单体：`core/`（agent-loop、model-router、context-manager、team-coordinator）+ `agents/`（7 个专家）+ `tools/` + `mcp/` + `memory/` + `hooks/` + `security/` + `terminal/`（自研 TUI 帧缓冲引擎）+ `server.ts`（REST + SSE）。
- 无插件机制，扩展靠直接改代码；配置靠 YAML/JSON（`config/agents/*.yaml`、`config/hooks.json`、`config/permissions.json`）。
- 前后端同进程：HTTP Server 托管 Svelte 构建产物，SSE 单向推送，`/api/v1/*` REST。

---

## 三、核心机制逐项对比

| 能力 | DeepSeek Harness | AiWorker |
|---|---|---|
| **Agent Loop** | `dsh-agent-loop`：事件驱动、AbortSignal、工具调用分阶段调度（exclusive 屏障/并行池）、runtime-context 投影 | `agent-loop.ts`：同步/流式双实现、空响应 3 次断路器、75% token 压缩阈值、保留最近 3-8 轮 |
| **多智能体编排** | 无内置"专家路由"；提供 `subagent`（spawn/fork 两种后端）、`workflow`（worker-thread 跑 JS 编排脚本）、`ralph`（fresh-agent 循环）、`goal`（事件溯源的目标驱动）——编排是**能力**而非角色 | **7 专家角色**（coding/financial/research/data-analysis/game-dev/product-ops/default），正则加权路由 + LLM 语义兜底；`/plan` DAG 编排（4 模板 + Kahn 环路检测 + 关键/非关键步骤）与 `/debate` 双专家互审 |
| **工具系统** | `dsh-tools` 的 `ToolRuntime`：**scoped 注册（作用域遮蔽全局）**、pre/guard/around/post/result 五段执行管线、Code Mode（`run_code` 传输）与原生工具双展示模式、JSON Schema（schemastery）强校验、TS/Python SDK 自动生成 | `tool-registry.ts` 单例注册 + 运行时可用性检查；6 内置工具（fs/terminal/web）+ MCP 工具 |
| **MCP** | `dsh-mcp-client`：连接 MCP 服务器并注册工具到 `ctx.tools` | `mcp-manager.ts`：stdio/HTTP 双传输、内置 4 工具服务器、健康检查、指数退避自动重连、连接池状态 |
| **执行沙箱** | **多后端进程沙箱**：bwrap / landlock-run / macOS Seatbelt / Windows ACL restricted-token，功能探测 fail-closed；`fs-sandbox`（读-写按模式隔离）、`bash/pwsh-sandbox`、`code-runtime`（worker-thread） | 无进程级沙箱；靠**路径遍历防护**（`path.relative` 校验）+ `--project-dir` 输出隔离 + 危险命令正则拦截（`danger-detector`） |
| **权限/审批** | `dsh-user-approval` 审批瀑布（approval waterfall，默认 fail-closed）+ `dsh-permission-presets`（沙箱模式 + 审批策略产品级组合）+ `dsh-sandbox-policy` 逐调用解析 | ask/plan/auto 三模式 + `confirm-channel`（CLI stdin / HTTP SSE 确认卡片，30s 超时自动拒绝）+ `permissionCheck` 钩子 |
| **记忆/会话** | 事件溯源会话 + JSONL 持久化 + 投影缓存 + SQLite FTS5 查询 + 跨会话引用 + 会话统计/标题服务 | 三层记忆：工作（SQLite WAL）、情景（FTS5 + 中文分词 + 15% 时间衰减）、语义（MEMORY.md/USER.md 有界管理）；`freezeSnapshot` 前缀缓存 |
| **上下文/压缩** | `dsh-compaction` 抽象 + `dsh-compaction-basic`（token-meter 驱动 + LLM 摘要）+ `dsh-compaction-tool-result-pruner`（replay-safe 剪枝）+ `spill`（超长结果落盘返回定位符）+ `time-context`/`tmux-context` | 自制 `compressor`：75% 阈值、冻结快照、分层 token 统计（`/context`）、`Intl.Segmenter` 分词 |
| **Skills** | `dsh-skill` 注册表 + `dsh-skill-filesystem`（本地 SKILL.md）+ `dsh-tool-skill` 加载工具 | `skill-registry.ts` 递归加载 SKILL.md + 正则触发 + **自进化**（迭代≥3 且工具调用≥3 → Jaccard 0.5 去重 → 评分≥3★ 注册，默认关闭存 pending） |
| **模型接入** | `dsh-llm` 抽象 + `dsh-llm-deepseek`/`dsh-llm-pi-ai` 适配器 + `dsh-llm-retry` 按 provider 重试 + `token-meter` 回放感知计量 | `model-router.ts` 多 profile（`config/models.json`，`${ENV}` 引用）+ DeepSeek 思考模式（`extra_body`，thinking 时禁用 temperature）+ lite 本地模型 |
| **UI** | Web（React，双进程 WebSocket）+ 可无头运行（`dsh-headless` 一键 bundle） | **TUI 终端**（自研帧缓冲差分渲染 + CJK 宽字符 + raw-mode + OSC 8 超链接）+ Web（Svelte 5 + SSE） |
| **可观测性** | `dsh-session-telemetry-otel`（OpenTelemetry 导出）、`session-stats`、`trajectory` 轨迹时间轴、`jobs` 后台任务注册表、`repeat-tool-reminder` 防循环 | TurnLog/ToolCallLog 审计（`/log`）、diff 快照审计（`data/snapshots/`）、状态栏 token/成本监控 |
| **其他高级件** | 持久 PTY（`dsh-terminal`）、定时调度（`dsh-schedule`）、凭证管理（`credentials`）、设置系统（`settings.yaml`）、附件（content-addressed）、Web 搜索 provider（`dsh-web-search-deepseek`）、插件自举（`dsh-tool-cordis` 让模型写插件） | — |

---

## 四、各自亮点

### DeepSeek Harness 的突出设计

1. **极致解耦**：seam 抽象 + 三件套实现（本地/沙箱/抽象），同一能力可无痛替换后端；连 loop 本身可换。
2. **事件溯源会话**：任何状态都可回放/投影/缓存，是"上下文工程"的底层保障。
3. **真正的安全纵深**：进程级沙箱多平台后端 + 审批瀑布 + 策略逐调用解析，安全不是补丁而是架构。
4. **模型可写代码**：`dsh-tool-cordis` 让 Agent 动态挂载插件、`dsh-agent-tool-presentation` 的 Code Mode——工具以代码形态给模型用。
5. **工程完备性**：OTel 遥测、后台任务、worker-thread workflow、双进程 Web 架构、i18n（`README.i18n.yaml`）。

### AiWorker 的突出设计

1. **"专家路由 + DAG 协作"开箱即用**：7 角色 + 模板化计划（零 LLM 成本）+ 辩论模式，个人场景直接可用。
2. **自研 TUI**：帧缓冲差分渲染、CJK 对齐、语法高亮零依赖，终端体验打磨到位。
3. **技能自进化闭环**：DSH 没有的自进化机制（自沉淀 + 去重 + 评分注册）。
4. **体积与可维护性**：约 1.2 万行覆盖完整功能面，单人可完全理解。
5. **三层记忆**贴合个人助手场景（USER.md 人格 + MEMORY.md 语义）。

---

## 五、关键差距与 AiWorker 可借鉴点

| # | 差距 | 建议方向 |
|---|---|---|
| 1 | 无插件机制，扩展成本高 | 可先做**轻量插件契约**（如按 `config/plugins/` 目录加载能力提供者），不必上 Cordis |
| 2 | 工具注册为全局单例，无作用域 | 参考 DSH 的 scoped registry，按 agent/session 分层遮蔽 |
| 3 | 无进程沙箱，安全依赖路径校验 | 可先引入 `dsh-sandbox-local` 的 Windows ACL 方案或 node 层 `vm` 隔离 terminal_exec |
| 4 | 会话是"消息数组 + SQLite 表"，非事件溯源 | 可增加**只追加事件日志 + 投影**，让 diff/回放/统计有单一事实源 |
| 5 | 审批耦合在 hook 里 | 抽成独立 `approval` 服务 + 回答者（answerer）分发，默认 fail-closed |
| 6 | 模型接入硬编码 OpenAI 格式 | 抽象 `llm` seam + provider 适配器（DSH 有 deepseek/pi-ai 两个对照实现可抄） |
| 7 | 无 OTel/轨迹观测 | 可加 `session-telemetry` 类似的事件导出，便于复盘 token 与失败 |
| 8 | Web 为 SSE 单向 | 若要实时工具状态/多端同步，可借鉴 WebSocket 下行 + 事件投影 |

---

## 六、结论

两者**不是同一物种**：`deepseek-harness` 是面向生态的**可插拔 Agent 运行时平台**（深度、完备性、安全架构行业标杆级），`AiWorker` 是面向个人的**紧凑自研 Agent 助手**（开箱即用、轻量、有独特的产品化设计如 TUI 与技能自进化）。

对 AiWorker 最有价值的不是移植整个插件体系，而是**吸收其架构思想**：抽象能力缝（seam）、事件溯源会话、作用域化工具注册、独立的审批服务、LLM provider 适配层。这些可以在保持现有单体和 1.2 万行规模的前提下渐进落地。

---

*报告基于本地安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 编译实现（195 包）与 AiWorker 源码逐项比对完成。*
