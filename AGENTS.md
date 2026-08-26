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

- **ESM + `.js` 导入扩展名**：相对导入必须带 `.js`（tsx 宽容，但编译后 dist/ 报错）
- **单例模式**：`ToolRegistry` / `HookManager` / `McpManager` / `SkillRegistry` / `pluginManager` / `jobRunner` / `scheduler` / `packageInstaller` 等经 `.getInstance()` 或导出常量访问，不要直接 `new`
- **kebab-case** 文件名；领域类型集中 `src/types.ts`（`import type`）
- `ToolResult` = `{ success, content, error? }`；`HookResult` = `{ proceed, modifiedData?, message? }`
- **不添加注释**，除非绝对必要
- `coerceToolArgs`：数字字符串转换前校验合法数字，排除 NaN/Infinity；`"true"/"false"` 优先于数字判断
- 版本单一来源：`package.json`（经 `src/core/version.ts` 读取），改动同步更新 `CHANGELOG.md`
- 设计文档：`docs/个人AI-Agent助手设计方案.md`、`docs/AIOS-架构升级方案.md`（AI OS 规划，实施按 `plans/` 下 sprint 计划推进）

## CLI 命令系统（`src/commands/`）

- 命令注册表：`commands/types.ts` 的 `CliCommand`（name/aliases/usage/description/detail/handler），handler 签名 `(ctx, arg, line) => Promise<"continue"|"exit">`
- **新增命令**：在对应分组文件注册（`collab.ts`/`config.ts`/`session.ts`/`skills.ts`/`plugins.ts`/`jobs.ts`/`package.ts`/`misc.ts`），`/help` 表格与 Tab 补全自动生成；数组顺序 = 匹配优先级
- **命令级帮助**：`/<命令> --help|-h|help` 与 `/help <命令>` 显示用法/功能/说明/别名（`renderCommandHelp`，index.ts 分发层拦截）；必选参数命令无参数自动显示帮助（`hasRequiredArgs`：usage 中 `<` 在 `[` 之前）；`/help` 精简为两列
- `CommandContext` 由 index.ts 组装注入（会话状态/服务/输出抽象），handler 可独立单测
- 工具函数：`commands/format.ts`、`commands/clipboard.ts`

## 模块速览

### 核心 `src/core/`

- `agent-loop.ts` — `runAgentLoop` / `runAgentLoopStream`（流式+AbortSignal）。空响应 3 次断路器；工具超时 60s（`deps.toolTimeoutMs` 可注入）；**迭代预算**：剩余 ≤5 注入收敛提示（`BUDGET_WARN_AT`）、相同 (tool,args) ≥3 提醒 / ≥6 强停（`REPEAT_FORCE_STOP`）、连续 4 轮工具全失败终止（`TOOL_FAIL_STREAK_MAX`）、撞顶返回进展+建议；token 压缩 75%；循环边界发 `step/start`/`step/end`（**`endStep()` 必须先于 `iterations++`**）；`executeTool` 发 `tool/call`/`tool/result`；每轮 `assistant(tool_calls)` 经 appendMessage 持久化
- `model-router.ts` — 多 profile（`config/models.json`，`${ENV}` 引用）。思考模式 `thinking:true` 时 temperature 失效（extra_body）；流式 usage 循环外一次性 `+=`；**`addProfile` 运行时加模型 profile，`getProfileRaw` 供持久化**
- `context-manager.ts` — `assembleContext` + 压缩 + `getContextBreakdown`；`freezeSnapshot` 保前缀缓存；历史源用 `replayEvents`；工具结果 >20K 剪枝（事件日志完整）
- `team-coordinator.ts` — DAG 编排：Kahn 环路检测 + 死锁检测；4 模板；非关键失败跳过、关键中止；导出 `pickDebateAgents`
- `tool-registry.ts` — 工具注册 + 可用性；**作用域视图** `getScope(scopeId)`（scope 注册+全局回退，同名遮蔽；agent-loop 传 `toolScope: agentId`）；白名单（`config.tools` 非空时仅保留；`mcp_` 前缀与插件工具豁免）
- `plugin-manager.ts` — `config/plugins/<name>/` 默认导出 `setup(ctx)`；fail-soft + 幂等；同名冲突警告（`PluginInfo.warnings`）；插件工具默认全局可见，`{scope}` 限定
- `zip.ts` / `package-installer.ts` — 零依赖 zip 读写；**.aw 资产包**（manifest 校验/路径穿越防护/回滚）三类型路由 plugin→config/plugins/、skill→skills/、mcp→config/mcp.json；**`installAny` 裸格式**（.md 技能 / .json MCP（文件名作服务器名）/ 插件目录）；`exportPackage`（.aw）/`exportRaw`（.md/.json）/`copyPluginDir`；`listInstalled`/`listExportable`；导出 `parseSkillMeta`
- `app-manifest.ts` — 应用 manifest schema 校验（**terminal 权限 schema 级拒绝**、fs 权限限 `data/apps/<id>/` 内、entry 防穿越、工具声明校验、BOM 兼容）
- `app-manager.ts` — 应用生命周期状态机（installed→running→stopped→destroyed）+ `data/apps/state.json` 持久化 + **autostart 启动恢复** + destroy 幂等 + **插件兼容视图**（list() 合并 pluginManager，插件展示为 tool 类应用）
- `app-runtime.ts` — 子进程能力桥：tool/service 应用 `child_process` 隔离（`--max-old-space-size=256` + 行分隔 JSON-RPC）；能力 API（storage/notify/llm/fs/http，**无 terminal**）；60s 工具超时、输出截断、15s 心跳、**崩溃指数退避重启**（1s/2s/4s ≤3 次）；`init(deps)` 由 index.ts 注入（modelRouter/requestAsk/onCrashed）
- `app-sandbox.ts` / `process-manager.ts` — 沙箱路径防护（safeResolve/isInsideDir）；Agent/App/Job 统一进程注册表 + `process/*` 事件广播（agent-loop/job-runner/app-manager 登记）
- `security/sandbox.ts` — 含 `checkAppCapability(appId, capability, declared)`：应用能力强制层（storage 自动允许，其余静态声明命中，未命中走 ask 通道 fail-closed）
- `job-runner.ts` — 后台任务：submit 即返 jobId；queued→running→done/failed；并发 2 排队；不注册 ask/confirm（fail-closed 拒高危）、不写 TUI；完成写会话+审计+`eventBus.broadcast(job/done)`；`init(deps)` 由 index.ts 调用
- `scheduler.ts` — `config/schedule.json` cron 任务；**cron-parser v5 为 6 字段（秒 分 时 日 月 周），5 字段自动补秒前缀**；到点 submit+重排；超长延时分段 setTimeout
- `nl-schedule.ts` — 自然语言→cron（每N分钟/小时、每天/每晚、每周X、每月X号、时间词+12h）；无时间无频率返回 null；描述按原始索引区间剥离
- `env-loader.ts` / `onboarding.ts` — .env 加载（不覆盖已有变量，入口最先调用）；首次引导三步（key 写 .env / 模式写 permissions.json / 标记 onboarding.json），`/setup` 重进
- `llm/` — Provider Seam：`llm-adapter` 契约 + 稳定错误码 + adapter 注册表（未知 id 降级 openai-compatible）；`openai-compatible.ts` 是唯一接触 openai SDK 的模块（**流式已产出 chunk 后失败不重试**）

### 智能体与路由 `src/agents/`

- BaseAgent ×7；router 正则（带权重）→ LLM 语义兜底；优先级 coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)
- TS 硬编码 + YAML 覆盖（`config/agents/*.yaml`）；modelPreference 白名单校验，无效降级 default
- `run()`/`runStream()` 的 `onTaskComplete` 传入 `data.messages`；完成后 `result.messages` 清空防内存膨胀

### 工具与 MCP `src/tools/` + `src/mcp/`

- `builtin.ts` — 8 内置工具。fs 读写/列表基准 `workingDir`（写路径遍历防护）；超长结果 >8000 字符经 `spillOrTruncate` 落盘 `data/spills/`；terminal_exec 过沙箱
- `ask-channel.ts` — ask_user 通道：TUI 输入行 / HTTP SSE 挂起 + POST /ask；已加入只读白名单
- `terminal-session.ts` — 持久终端（cmd.exe /Q 或 /bin/sh，marker 分隔）；超时销毁防错位；exit 清理孤儿
- `mcp-manager.ts` — stdio/HTTP 双传输，`config/mcp.json`，工具 `mcp_{server}_{tool}`；指数退避重连（≤5 次）；Windows spawn 需 `shell: true`
- `builtin-server.ts` — 内置 4 工具（math_eval 沙箱 new Function + Math 白名单等）

### 记忆与上下文 `src/memory/`

- `session-store.ts` — SQLite（WAL）+ FTS5；turn_logs/tool_call_logs 显式字段映射；**事件溯源** `session_events` 仅追加（`appendEvent`/`getEvents`/`replayEvents`/`verifyProjection`）；`appendMessage` 单点同事务双写；自动标题（首条 user 消息 ≤24 字符，发 `title/set` 事件）
- `telemetry.ts` — TelemetrySink seam + JSONL 后端；脱敏瀑布、幂等、emit 错误隔离
- `session-export.ts` — 会话 Markdown 渲染（TUI /export 与 HTTP 共用）
- 三层记忆：工作 / 情景（FTS5 + Intl.Segmenter + 每天 15% 衰减）/ 语义（MEMORY.md/USER.md 有界，互斥锁）
- **FTS5 MATCH 前清洗特殊字符** 防注入；token 估算 `Math.ceil(chars / 3.5)`

### Hook 与安全 `src/hooks/` + `src/security/`

- `hook-manager.ts` — 6 事件（onMessage/onToolCallPre/onToolCallPost/onTaskComplete/onError/onTelemetryRecord）；`config/hooks.json` 注册；**trigger 逐 hook fail-soft**（抛错记审计视为放行；权限用显式 `{proceed:false}`）
- `approval-service.ts` — 权限决策单点（ask/plan/auto 矩阵，**无确认通道默认拒绝 fail-closed**）；三个权限 hook 薄委托，index.ts 构造注入
- `danger-detector.ts` / `permission-model.ts` — 高危正则拦截 / 三模式（ask 只读、plan 每步确认、auto 高危确认）
- `sandbox.ts` — `config/sandbox.json` 策略：cwd 越界 fail-closed、denyCommands 子串匹配、sanitizeEnv 剥 KEY/TOKEN/SECRET；terminal_exec 全检查（含 cwd）、terminal_session 仅 deny+env；**强制层先于权限层**
- 确认/提问通道：provider 分发（CLI stdin / HTTP SSE+POST，30s 超时拒绝）；server 端 `runWithChannels(write, fn)` 统一注册

### 终端 TUI `src/terminal/`

- 帧缓冲：`screen.ts`（差分渲染 + CJK 宽 + SGR reset 防泄漏）/ `term.ts`（raw-mode 键解析，parseKeys 纯函数可测）/ `components.ts` / `tui.ts`（16ms 节流）
- InputLine 多行（Shift/Alt/Ctrl+Enter 换行，Enter 提交，动态高度 ≤8 行）
- `markdown.ts` — 行级渲染 + 表格对齐 + OSC 8 超链接（**wrap/截断须保持转义序列完整，未闭合 OSC8 会吞掉后续 ANSI 定位**，见 screen.ts resetLine 兜底）
- `--server` 跳过 TUI；CJK 用 `displayWidth()`/`padToWidth()`

### HTTP Server 与 Web UI

- `server.ts` — API 前缀 `/api/v1`（`apiUrl()` 注册端点）；静态托管排除 /api（路径穿越防护 + favicon 204）
- **WebSocket 总线**：`event-bus.ts` 单例 + `/api/v1/ws`（30s 心跳）；chat/plan/debate 的 write 闭包 **SSE + eventBus 双写**；会话变更广播 `session/update`；前端 `ws.svelte.ts` 消费（指数退避重连，仅处理同步事件避免双通道重复渲染）
- `/plan` SSE：plan → step_start → step_end → done；`/debate`：debate_start → done；经 `deps.coordinator`
- `/config` 端点：`getConfigState`/`setConfigField` 由 index.ts 注入（model/temperature/maxTokens/iterations/addModel/thinking/skillEvo/reset，持久化 runtime-config.json + models.json）
- `web/` — Svelte 5 + Vite 6；API 常量 `chat.svelte.ts` 的 `API`；vite proxy `/api → :3000`（`ws: true`）
- 组件：`SystemPanel.svelte`（context/logs/skills/mcp/plugins/apps/processes/schedule/config/trace 十 Tab）、`TracePanel`、`PlanStepsBlock`、`ConfirmCard`、`AskCard`、`FileDiffPanel`、`AppsPanel`（应用生命周期 + 销毁确认）、`ProcessesPanel`（Agent/App/Job 进程视图）、`JobsPanel`（后台任务）
- 前端 store：`apps.svelte.ts`（应用/进程列表 + WS `app/*` `process/*` 订阅）、`theme.svelte.ts`（暗色模式 localStorage + 跟随系统）
- `ChatPanel.handleSSE()` 直接 mutate `store.messages`；DOMPurify 消毒 marked 输出防 XSS

## 测试

- `test/helpers.ts`：`makeTestDir(name)` 独立 `data-test/<name>/`（防并行冲突）、`setupEnv`、`clearTools`
- **测试隔离**：读真实 `config/*.json` 一律注入 fixture（`test/fixtures/models.json`）；`terminal-session.test.ts` 用 `describe.skipIf(非 win32)`
- 端点测试 mock coordinator/agent + `listen(0)` 随机端口 + fetch；**WS 测试用 `ws` 客户端**（值导入 `WebSocket as WsClient`，Node 22 全局 WebSocket 无 `.on`）
- 关键文件：`agent-loop.test.ts`（超时/防循环/白名单/toolScope/迭代预算）、`tool-registry.test.ts`（作用域）、`server.test.ts`（端点+WS）、`plugin-manager.test.ts`、`sandbox.test.ts`、`approval-service.test.ts`、`package-installer.test.ts`（zip/.aw/裸格式/mcp）、`scheduler.test.ts`、`nl-schedule.test.ts`、`job-runner.test.ts`、`env-loader.test.ts`、`onboarding.test.ts`、`screen.test.ts`、`cli-commands.test.ts`、`app-manifest.test.ts`、`app-manager.test.ts`、`app-runtime.test.ts`（子进程能力桥/崩溃重启）、`process-manager.test.ts`、`apps-api.test.ts`（/apps /processes 端点）

## CLI 交互命令

```
/mode <ask|plan|auto>  切换权限模式
/plan <任务>             多专家 DAG 协作
/debate <话题>           双专家辩论
/app <list|info|install|start|stop|destroy>  AI OS 应用生命周期管理
/bg <任务>               提交后台任务（不阻塞交互）
/jobs [cancel <id>]     查看/取消后台任务
/schedule               定时任务（add 支持自然语言/remove/list，cron 5 字段）
/install <路径> [-f]    安装 .aw 包或裸格式（.md/.json/插件目录，自动识别）
/pkg export <类型> <名> 打包导出 .aw；--raw 裸格式；/pkg list
/setup                  重新运行首次引导
/skill <名称>            手动激活技能
/skills                  查看全部技能
/new                     新会话
/log                     监控日志
/context [查询]          上下文分层 token 占比
/plugins                 查看插件
/trace [序号]            会话轨迹时间线
/status                  运行状态
/config                  模型/温度/max-tokens/iterations/thinking/skill-evo/add-model/reset
/sessions /switch        浏览/切换会话
/export [序号]           导出会话为 Markdown
/copy                    复制最后回答
/help [命令]             帮助（/命令 --help 查看详细）
/exit                    退出
```

CLI 参数：`--dir <工作目录>`（默认 ./ai_default_project）`--data-dir` `--mode` `--show-thinking` `--server` `--port`
