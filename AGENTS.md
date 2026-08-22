# AGENTS.md — AiWorker

多智能体个人 AI Agent 助手：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆。TUI 终端与 Web UI 双界面。

## 常用命令

```bash
npm run dev            # tsx 直接运行 CLI（无需编译）
npm run build          # tsc → dist/
npm run start          # 生产运行（node dist/index.js，需先 build）
npm test               # vitest run（test/ 目录）
npm run lint           # ESLint
npm run web:dev        # Web UI 开发 :5173（API 代理 3000）
npm run web:build      # Web UI 构建 → web/dist/
```

## 环境要求

- `DEEPSEEK_API_KEY`（默认模型，必需）；`OPENAI_API_KEY`（lite 本地模型 localhost:8000，可选）
- Node >= 22.0.0

## 关键约定（违反会直接出错）

- **ESM + `.js` 导入扩展名**：所有相对导入必须带 `.js`，即使源文件是 `.ts`（`tsx` 宽容，但编译后 `dist/` 报错）：`import { toolRegistry } from "./core/tool-registry.js";`
- **单例模式**：`ToolRegistry` / `HookManager` / `McpManager` / `AuditLog` / `SkillRegistry` / `pluginManager` 通过 `.getInstance()` 或导出常量访问，不要直接 `new`
- **kebab-case** 文件名；领域类型集中在 `src/types.ts`（`import type { ... }`）
- `ToolResult` = `{ success, content, error? }`；`HookResult` = `{ proceed, modifiedData?, message? }`
- **不添加注释**，除非绝对必要
- `coerceToolArgs`：数字字符串转换前校验合法数字（含科学计数法），排除 NaN/Infinity；`"true"/"false"` 优先于数字判断
- 版本单一来源：`package.json` 的 `version`（经 `src/core/version.ts` 的 `getAppVersion()` 读取），改动同步更新 `CHANGELOG.md`
- 设计文档：`docs/个人AI-Agent助手设计方案.md`

## CLI 命令系统（`src/commands/`）

- 命令用**注册表**定义：`src/commands/types.ts` 的 `CliCommand`（name/aliases/usage/description/detail/handler），handler 签名 `(ctx, arg, line) => Promise<"continue"|"exit">`
- **新增命令**：在对应分组文件注册即可（`collab.ts`/`config.ts`/`session.ts`/`skills.ts`/`plugins.ts`/`jobs.ts`/`package.ts`/`misc.ts`），`/help` 表格与 Tab 补全自动生成；数组顺序 = 匹配优先级
- **命令级帮助**：`/<命令> --help|-h|help` 与 `/help <命令>` 显示 用法/功能/说明/别名（`renderCommandHelp`，index.ts 分发层拦截）；**必选参数命令无参数自动显示帮助**（`hasRequiredArgs`：usage 中 `<` 在 `[` 之前）；`/help` 表格精简为 命令+别名 / 一句话功能 两列
- `CommandContext`（零闭包捕获）由 `index.ts` 组装注入：会话状态/服务引用/输出抽象（`write`/`writeLine`/`printStatus`）；命令 handler 可独立单测（见 `test/cli-commands.test.ts`）
- 工具函数：`commands/format.ts`（displayWidth/padToWidth/formatDuration/fmtK）、`commands/clipboard.ts`（copyToClipboard）

## 模块速览

### 核心引擎 `src/core/`

- `agent-loop.ts` — `runAgentLoop`（同步）/ `runAgentLoopStream`（流式 + AbortSignal）。空响应 3 次断路器；**工具调用统一超时**（`withTimeout`，默认 60s，`deps.toolTimeoutMs` 可注入）；**迭代预算管理**：剩余 ≤5 轮注入一次收敛提示（`BUDGET_WARN_AT`）、连续相同 (tool,args) ≥3 注入提醒 / **≥6 强制终止**（`REPEAT_FORCE_STOP`，`repeatStreak` 共用计数）、连续 4 轮全部工具失败提前终止（`TOOL_FAIL_STREAK_MAX`）；**撞顶返回最后进展 + 建议**（不再裸返回"达到迭代上限"）；token 压缩阈值 75%；循环边界发 `step/start`/`step/end`（**`endStep()` 必须先于 `iterations++`**，编号才一致）；`executeTool` 包装层发 `tool/call`/`tool/result`；每轮 `assistant(tool_calls)` 经 appendMessage 持久化
- `model-router.ts` — 多 profile（`config/models.json`，支持 `${ENV}`）。**思考模式**：`thinking: true` 时 temperature 失效，经 `extra_body` 传递；流式 usage 只在循环外一次性 `+=`；`lastUsage` 供 assistant 事件携带 token
- `context-manager.ts` — `assembleContext()` 组装 + 压缩 + `getContextBreakdown()` 分层统计；`freezeSnapshot()` 捕获记忆快照保证前缀缓存；历史源用 `replayEvents`（含 tool 结果）；**工具结果剪枝**：组装输出前截断 >20K 字符的 tool 消息（完整内容仍在事件日志，replay-safe）
- `team-coordinator.ts` — DAG 编排：Kahn 环路检测 + 死锁检测；4 模板；非关键步骤失败跳过，关键失败中止；导出 `pickDebateAgents`（CLI 与 HTTP 共用）
- `trace.ts` — 轨迹投影：`projectTrace`（事件 → 时间线，含 full 完整内容）+ `computeSessionStats`
- `skill-registry.ts` / `skill-evolution.ts` — 递归加载 SKILL.md；自进化阈值 `iterations>=3 && toolCalls>=3`，Jaccard 0.5 去重，评分 >=3★ 注册，默认关闭（`skills/pending/` 存候选）
- `project-profiler.ts` — 启动扫描工作目录注入 system prompt；`type: "unknown"` = 未识别项目类型（展示层显示"未识别"）
- `tool-registry.ts` — 工具注册 + 可用性检查；**作用域视图**：`getScope(scopeId)` 返回 `ToolScopeView`（scope 注册 + 全局回退，同名遮蔽全局；agent-loop 传 `toolScope: agentId`，模型可见性与执行解析共用同一 view）；agent 可见性白名单（`config.tools` 非空时仅保留白名单；`mcp_` 前缀与插件注册工具豁免）
- `plugin-manager.ts` — 轻量插件契约（详见 README「插件开发」）：`config/plugins/<name>/` 默认导出 `setup(ctx)`；fail-soft + 幂等；**同名冲突警告**（记录到 `PluginInfo.warnings`）；插件工具默认全局可见，`{scope}` 注册可限定专家
- `zip.ts` — **零依赖 zip 读写**（.aw 包用）：`parseZip`（EOCD + Central Directory + Local Headers，deflateRaw/store）+ `readZipEntry`/`readZipFile` + `packZip`（导出打包，压缩后更大则 store，与 scripts/pack-aw.mjs 结构一致）
- `package-installer.ts` — **.aw 资产包安装/导出 + 裸格式**：manifest（formatVersion/type/name 白名单/semver/minAppVersion）校验；三类型路由 **plugin→config/plugins/（入口探测+回滚）、skill→skills/（SKILL.md）、mcp→config/mcp.json 合并（冲突需 force）**；解压路径穿越防护（`relative` 校验）；`installAny(path)` 按扩展名/目录自动识别（.aw / .md 技能 / .json MCP（文件名作服务器名）/ 插件目录）；`exportPackage(type,name)` 打包 .aw、`exportRaw(type,name)` 裸导出（skill .md / mcp .json）、`copyPluginDir(name,dest)` 插件目录复制；`listInstalled`/`listExportable`；导出 `parseSkillMeta`（frontmatter）；单例 `packageInstaller`（pluginsDir/skillsDir/mcpConfigPath）
- `job-runner.ts` — **后台任务**：`submit(agentId, prompt)` 立即返回 jobId；状态机 queued→running→done/failed；**并发上限 2**（FIFO 排队）；后台不注册 ask/confirm 通道（fail-closed 自动拒高危）、不写 TUI；结果写独立会话 + 审计（`job:done|failed`）+ `eventBus.broadcast({type:"job/done"})`；`cancel` 仅排队中；`clear()` 测试/重置用；`init(deps)` 由 index.ts 在 agents 创建后调用
- `scheduler.ts` — **定时调度**：`config/schedule.json`（BOM 容错）；**cron-parser v5 = 6 字段（秒 分 时 日 月 周），5 字段标准 cron 自动补秒前缀**（`normalizeCron`）；`nextFireAt` 无效返回 null；到点 `submit` + 重新调度；`addJob`/`removeJob` 写回配置；`start`/`stop`；超长延时（>24.8 天）分段 setTimeout
- `nl-schedule.ts` — **自然语言调度解析**（规则优先）：每 N 分钟/小时、每天/每晚、每周X（含"每周一到周五"区间）、每月X号、每工作日/每周末；时间词（凌晨~午夜，下午/晚上 hour<12 +12）+ 整点/半点/X点X分/X:XX；**无时间无频率返回 null**（LLM 兜底在命令层）；任务描述按**原始索引区间合并剥离**（防"每晚10点"词重叠）
- `env-loader.ts` — **极简 .env 加载**（零依赖）：`KEY=VALUE` / `#` 注释 / 可选引号 / BOM；**不覆盖已有 process.env**；index.ts 入口最先调用
- `onboarding.ts` — **首次运行引导**：`shouldOnboard(dataDir)`（无标记触发）；`runOnboarding(deps)` 三步（API Key 写 .env + 权限模式写 permissions.json + 目录确认）；完成/跳过均写 `data/onboarding.json`；`/setup` 重进（`CommandContext.ask` 提问通道）
- `llm/` — Provider Seam：`llm-adapter.ts`（LlmConnection/LlmAdapter 契约）、`llm-error.ts`（稳定错误码 + classifyError/isRetryable）、`adapter-registry.ts`（未知 id 降级 openai-compatible）、`openai-compatible.ts`（唯一接触 openai SDK 的模块；**流式已产出 chunk 后失败不重试**防重复）

### 智能体与路由 `src/agents/`

- `BaseAgent` 子类 ×7；`router.ts` 正则路由（带权重）→ LLM 语义兜底
- 优先级：coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)
- TS 硬编码 + YAML 覆盖（`config/agents/*.yaml`）；`modelPreference` 白名单校验，无效降级 `default`
- `run()`/`runStream()` 的 `onTaskComplete` 传入 `data.messages`；完成后 `result.messages` 清空防内存膨胀

### 工具与插件 `src/tools/`

- `builtin.ts` — 8 内置工具。`fs_read`/`fs_list`/`fs_write` 均基准 `workingDir`（读写统一目录）；`fs_write` 路径遍历防护（`path.relative` 检查）；**超长结果落盘**：fs_read/terminal 输出 >8000 字符经 `spillOrTruncate` 写入 `data/spills/`（需 `ToolContext.dataDir`，由 agent-loop 从 `deps.dataDir` 透传）
- `ask-channel.ts` — **ask_user 提问通道**：`AskProvider` 全局分发；TUI 走输入行（`tui.ask`），无 TUI 回退 stdin；HTTP 走 SSE `ask_user` 挂起 + POST `/api/v1/ask`；`isAskWaiting()` 供状态栏显示；`parseOptionInput`（单选/多选/自由文本统一解析）；已加入只读白名单（`PermissionModel.READONLY_TOOLS`）
- `terminal-session.ts` — **持久终端会话**：`cmd.exe /Q` + marker 分隔符；cd/env 跨调用保留；**超时销毁进程防缓冲区错位**（下次 exec 自动重启）；`process.on("exit")` 清理孤儿进程

### MCP `src/mcp/`

- `mcp-manager.ts` — stdio/HTTP 双传输，`config/mcp.json` 配置，工具命名 `mcp_{server}_{tool}`；`getStatuses()` 以连接池为数据源；启动时在 server/CLI 分支前 await loadConfig（5s 超时保护）
- `builtin-server.ts` — 内置 4 工具：math_eval（沙箱 `new Function()` + Math 白名单）/ uuid_gen / json_format / timestamp_convert
- **重连**：统一 `scheduleReconnect` 防风暴；指数退避 `min(1000*2^n, 30000)` 最多 5 次；Windows `spawn` 需 `shell: true`

### 记忆与上下文 `src/memory/`

- `session-store.ts` — SQLite（WAL）+ FTS5；`turn_logs`/`tool_call_logs` snake_case → camelCase 显式映射；**事件溯源**：`session_events` 仅追加日志（唯一真源），`appendEvent`/`getEvents`/`replayEvents`/`verifyProjection`；`appendMessage` 单点同事务双写（assistant 可携带 usage）；**自动标题**：首条 user 消息且 summary 为空时首行截断 ≤24 字符并发 `title/set` 事件（不覆盖手动重命名）
- `telemetry.ts` — 遥测导出：`TelemetrySink` seam + `TelemetryJsonlSink`（data/telemetry/<id>.jsonl）+ `TelemetryCoordinator`（脱敏瀑布、`(session.id, seq)` 幂等、emit 错误隔离 fail-closed）
- `session-export.ts` — 会话 Markdown 导出渲染（TUI `/export` 与 HTTP `/sessions/:id/export` 共用）：`renderSessionMarkdown(title, sessionId, messages)`
- 三层记忆：工作（消息历史）/ 情景（FTS5 + `Intl.Segmenter` 分词 + 每天 15% 时间衰减）/ 语义（MEMORY.md ≈2200 字 + USER.md ≈1375 字，互斥锁防 lost-update）
- **FTS5 MATCH 查询前清洗特殊字符**（`*` `AND` `OR` 等）防注入；token 估算统一 `Math.ceil(chars / 3.5)`

### Hook 与安全 `src/hooks/` + `src/security/`

- `hook-manager.ts` — 6 事件：onMessage / onToolCallPre / onToolCallPost / onTaskComplete / onError / onTelemetryRecord；`config/hooks.json` 注册 14 handlers；**trigger 逐 hook fail-soft**：单个 hook 抛错记审计（`action: hook:<event>`, `result: error`）视为放行，不中断任务；权限类 hook 用显式 `{ proceed: false }` 拦截
- **`approval-service.ts` 审批服务（权限决策单点）**：`checkCommandBlock` / `checkPermission` / `checkConfirmation`（plan 全确认、auto 高危确认）；**无确认通道默认拒绝（fail-closed）**；三个权限 hook（`dangerousCommandBlock`/`permissionCheck`/`confirmHighRisk`）均为薄委托，`index.ts` 构造注入（`confirm: requestConfirm`），测试可注入 mock
- 权限三模式：ask（只读工具，写/高危被 permissionCheck 拦截产生红色告警）/ plan（每步确认）/ auto（自动，高危仍确认）；`danger-detector.ts` 正则拦截高危操作
- **`sandbox.ts` 策略化命令沙箱**：`config/sandbox.json`（enabled/allowDirs/denyCommands/stripSecretEnv，缺失回退默认）；`checkCommand`（cwd 越界 fail-closed，allowDirs 空时=workingDir）/ `checkDeniedCommand`（子串匹配）/ `sanitizeEnv`（剥 KEY/TOKEN/SECRET/PASSWORD）；terminal_exec 全检查（含 cwd），terminal_session 仅 deny+env（会话 cwd 有状态无法约束）；**强制层先于权限层**
- `config/permissions.json` 是配置源（default_mode / modes / allowed_dirs / denied_patterns），CLI `--mode` 显式传入覆盖 default_mode；加载时 strip UTF-8 BOM
- 确认/提问通道：`confirm-channel.ts`（高危确认）+ `ask-channel.ts`（ask_user）均为 provider 分发——CLI 走 stdin，HTTP 走 SSE（`confirm_request` / `ask_user`）挂起 + POST `/api/v1/confirm` / `/api/v1/ask`（30s 超时自动拒绝）；server 端 `runWithChannels(write, fn)` 统一注册两个 provider
- 拦截失败时 server 发 `tool_blocked` SSE 事件，前端显示红色告警横幅
- Windows 下 terminal_exec / terminal_session 前缀 `chcp 65001` 强制 UTF-8 防 cmd 中文乱码

### 终端 TUI `src/terminal/`

- **帧缓冲引擎**：`screen.ts`（差分渲染 + CJK 宽 + SGR reset 防泄漏）/ `term.ts`（raw-mode 键解析，10ms 超时防 Esc 歧义，parseKeys 纯函数可测；CSI-u 与 Alt+Enter 解析）/ `components.ts`（MessageList/InputLine/StatusBar）/ `tui.ts`（16ms 节流 + 接管 stdout）
- **InputLine 多行输入**：`Shift+Enter`/`Alt+Enter`/`Ctrl+Enter` 插入换行，`Enter` 提交；多行时 `↑`/`↓` 移动光标行，单行时切历史；输入区动态高度 ≤8 行；历史条目扁平化为单行
- `renderer.ts` 薄封装；`markdown.ts` 行级渲染 + 表格块对齐 + OSC 8 超链接；`highlight.ts` 自研 tokenizer
- `--server` 模式跳过 TUI；CJK 用 `displayWidth()`/`padToWidth()` 对齐

### HTTP Server 与 Web UI

- `server.ts` — **API 统一 `/api/v1` 前缀**（`API_PREFIX` + `apiUrl()`）；静态资源托管仅排除 `/api`，新端点用 `apiUrl("/xxx")` 注册即生效；托管 `web/dist/`（路径穿越防护 + favicon 204 + Cache-Control）
- 端点：GET `/api/v1/agents` `/status`(含 version) `/tools` `/sessions`(+/:id, rename, export, DELETE) `/context` `/logs` `/skills` `/diffs` `/trace/:id` `/stats` `/telemetry/:id` `/mcp` `/plugins` `/config`；POST `/api/v1/chat` `/plan` `/debate` `/confirm` `/ask`（SSE 流式）
- **WebSocket 实时总线**：`event-bus.ts` 单例 EventBus（subscribe/broadcast）；`server.on("upgrade")` 处理 `/api/v1/ws`（`WebSocketServer({noServer:true})`，非 /ws 路径 destroy）；30s 心跳清理死连接；chat/plan/debate 的 `write` 闭包 **SSE + eventBus 双写**；会话创建/重命名/删除/新消息广播 `session/update`；前端 `web/src/lib/stores/ws.svelte.ts` 消费（指数退避重连），仅处理同步事件（`session/update` + 非流式中 `done`），避免与 SSE 双通道重复渲染
- `/plan` SSE 事件序列：plan → step_start → step_end → done；`/debate`：debate_start → done；均经 `deps.coordinator`（ServerDeps 依赖注入）
- `/chat` 接受 `sessionId`：Web UI 用 chat id 作为 sessionId 持久化
- `web/` — Svelte 5 + Vite 6；API 常量在 `chat.svelte.ts` 导出 `API = "/api/v1"`；vite proxy `/api → :3000`（需 `ws: true` 转发 WS）
- `ChatPanel.handleSSE()` 直接 mutate `store.messages`；`DOMPurify` 消毒 `marked.parse()` 输出防 XSS；`store.inputMode` 控制 chat/plan/debate
- 组件：`SystemPanel.svelte`（context/logs/skills/mcp/plugins/schedule/config/trace 八 Tab）、`TracePanel.svelte`（两栏）、`PlanStepsBlock.svelte`（步骤状态机）、`ConfirmCard.svelte`（确认卡片）、`AskCard.svelte`（提问卡片）、`FileDiffPanel.svelte`（diff 分栏）
- `/chat` 透传 `task.mode`；`permissionCheck` 读请求级 `ctx.data.permissions`；`captureDiff` 写磁盘快照 + 审计，`/diffs` 读取展示

## 测试

- `test/helpers.ts`：`makeTestDir(name)` 创建独立 `data-test/<name>/`（防并行 worker 冲突）、`setupEnv`（注册内置工具 + 审计）、`clearTools`
- **测试隔离**：读真实 `config/*.json` 的测试一律注入 fixture（`test/fixtures/models.json`，如 `new ModelRouter(FIXTURE_PATH)`），改配置不碎测试；`terminal-session.test.ts` 用 `describe.skipIf(process.platform !== "win32")`（真实 spawn cmd，非 Windows 跳过，CI Linux runner 兼容）
- `server.test.ts`：HTTP 端点全覆盖（mock coordinator/agent + listen(0) 随机端口 + fetch，避免真实 LLM）；**WebSocket 测试**用 `ws` 客户端连 `/api/v1/ws`（注意 `import { WebSocket as WsClient } from "ws"` 值导入，Node 22 全局 WebSocket 无 `.on` 方法）
- 核心：`core.test.ts` / `agent-loop.test.ts`（超时/防循环/白名单过滤/toolScope，mock modelRouter + 真实 SessionStore/ContextManager）/ `tool-registry.test.ts`（作用域遮蔽/回退/过滤）/ `trace.test.ts` / `session-events.test.ts` / `context-manager` 相关
- 工具与插件：`tools.test.ts` / `spill.test.ts` / `ask-channel.test.ts` / `terminal-session.test.ts`（真实 spawn cmd）/ `plugin-manager.test.ts`（临时目录插件加载：setup/工具/hook/config/scope/fail-soft/幂等/冲突警告）
- 安全与 Hook：`approval-service.test.ts`（决策矩阵 + fail-closed）/ `hooks.test.ts`（生命周期 + fail-soft）/ `sandbox.test.ts`（策略加载/BOM/cwd 越界/denyCommands/sanitizeEnv/接入 terminal_exec）
- 调度与引导：`job-runner.test.ts`（状态机/并发排队/失败/取消/WS 广播）/ `scheduler.test.ts`（nextFireAt/加载/增删持久化/fake timers 触发）/ `nl-schedule.test.ts`（自然语言→cron：频率/时间词/区间/剥离/无效 null）/ `env-loader.test.ts`（解析/注释/引号/不覆盖）/ `onboarding.test.ts`（触发/写文件/跳过/非法模式回退）
- 资产包：`package-installer.test.ts`（zip round-trip / manifest 校验 / 三类型安装含 mcp 冲突合并 / 路径穿越 / 回滚 / exportPackage round-trip / **裸格式 installAny（.md/.json/目录）+ exportRaw + copyPluginDir** / listInstalled）
- 其余：`memory.test.ts` / `mcp.test.ts` / `team.test.ts` / `llm-adapter.test.ts` / `skill-evolution.test.ts` / `cli-commands.test.ts` / `screen.test.ts` / `tui.test.ts` / `streaming-terminal.test.ts`
- vitest 配置在 `vitest.config.ts`（include `test/**/*.test.ts`）；CI 在 `.github/workflows/ci.yml`（windows+ubuntu 双平台，`npm ci` + lint + build + test + web:build）

## CLI 交互命令

```
/mode <ask|plan|auto>  切换权限模式
/plan <任务>             多专家 DAG 协作
/debate <话题>           双专家辩论
/bg <任务>               提交后台任务（不阻塞交互）
/jobs [cancel <id>]     查看/取消后台任务
/schedule               定时任务管理（add 支持自然语言如"每天早上8点生成早报"/remove/list，cron 5 字段）
/install <path> [-f]    安装 .aw 包或裸格式（.md 技能 / .json MCP / 插件目录，自动识别，-f 覆盖）
/pkg export <类型> <名> 打包导出 .aw；--raw 输出裸格式（skill .md / mcp .json / plugin 目录）；/pkg list
/setup                  重新运行首次引导（API Key/权限模式）
/skill <名称>            手动激活技能
/skills                  查看全部技能（分组+描述）
/new                     新会话
/log                     监控日志（轮次/耗时/token）
/context [查询]          上下文分层 token 占比 + MCP 工具列表
/plugins                 查看插件（config/plugins/ 状态与注册工具）
/trace [序号]            会话轨迹时间线（事件级复盘，--json 输出）
/status                  运行状态（版本/模式/模型/专家/token）
/config                  模型/温度/max-tokens/iterations/thinking/skill-evo（持久化 data/runtime-config.json）
/sessions                浏览会话
/switch <序号>           切换
/export [序号]           导出会话为 Markdown（默认当前会话，写工作目录）
/copy                    复制最后回答 Markdown
/help                    帮助
/exit                    退出
```

CLI 参数：`--dir <工作目录>`（读写统一基准，默认 `./ai_default_project`）`--data-dir` `--mode` `--show-thinking` `--server` `--port`
