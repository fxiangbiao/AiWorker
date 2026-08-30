# AGENTS.md — AiWorker

多智能体个人 AI Agent 助手（AI OS）：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆 + 应用即时生成。TUI 终端与 Web UI 双界面。

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
- **单例模式**：ToolRegistry / HookManager / McpManager / SkillRegistry / pluginManager / jobRunner / scheduler / packageInstaller 等经 `.getInstance()` 或导出常量访问，不要直接 `new`
- **kebab-case** 文件名；领域类型集中 `src/types.ts`（`import type`）
- `ToolResult` = `{ success, content, error? }`；`HookResult` = `{ proceed, modifiedData?, message? }`
- **不添加注释**，除非绝对必要
- `coerceToolArgs`：数字字符串转换前校验合法数字；`"true"/"false"` 优先于数字判断
- 版本单一来源：`package.json`（经 `src/core/version.ts` 读取），改动同步更新 `CHANGELOG.md` 与 README 徽章
- **智能体配置唯一来源**：`config/agents/<id>.yaml`（内置 TS 默认 + YAML 覆盖；迭代上限/权限/技能/MCP/插件绑定统一在此，**无运行时覆盖层**）
- **Svelte 5 深响应**：修改 `store.messages` 元素必须经 store 取代理引用回写（直接改局部对象不触发更新，见 apps.svelte.ts spawnGenCard 注释）
- 设计文档：`docs/个人AI-Agent助手设计方案.md`、`docs/AIOS-架构升级方案.md`；实施按 `plans/` 下 sprint 计划推进

## CLI 命令系统（`src/commands/`）

- 注册表：`commands/types.ts` 的 `CliCommand`（name/aliases/usage/description/detail/handler），handler `(ctx, arg, line) => Promise<"continue"|"exit">`
- **新增命令**：在对应分组文件注册（collab.ts/config.ts/session.ts/skills.ts/plugins.ts/jobs.ts/package.ts/misc.ts），`/help` 表格与 Tab 补全自动生成；数组顺序 = 匹配优先级
- 命令级帮助：`/<命令> --help|-h|help`；必选参数命令无参数自动显示帮助（`hasRequiredArgs`：usage 中 `<` 在 `[` 之前）；`/help` 两列
- `CommandContext` 由 index.ts 组装注入（会话状态/服务/输出抽象），handler 可独立单测

## 模块速览

### 核心 `src/core/`

- `agent-loop.ts` — `runAgentLoop` / `runAgentLoopStream`。空响应 3 次断路器；工具超时 60s（`deps.toolTimeoutMs`）；迭代预算（剩 ≤5 收敛提示、相同 (tool,args) ≥3 提醒/≥6 强停、连 4 轮工具全失败终止、撞顶返进展）；token 压缩 75%；发 `step/start`/`step/end`（**`endStep()` 先于 `iterations++`**）与 `tool/call`/`tool/result`；每轮 `assistant(tool_calls)` 经 appendMessage 持久化；**工具白名单** `filterVisibleTools`（`config.tools` 精确/`mcp_<server>_` 前缀匹配 + 默认豁免 mcp_/插件工具，`strictTools` 关闭豁免）
- `model-router.ts` — 多 profile（`config/models.json`，`${ENV}` 引用）；thinking 时 temperature 失效（extra_body）；流式 usage 循环外一次性 `+=`；`addProfile` 运行时加 profile
- `context-manager.ts` — `assembleContext` + 压缩 + `getContextBreakdown`；`freezeSnapshot` 前缀缓存；历史源 `replayEvents`；工具结果 >20K 剪枝；技能按 agentId 注入（`getInjectedPrompt`）
- `team-coordinator.ts` — DAG 编排（Kahn 环路/死锁检测；非关键失败跳过、关键中止）；导出 `pickDebateAgents`
- `tool-registry.ts` — 注册/可用性；作用域视图 `getScope(scopeId)`（同名遮蔽 + 全局回退；agent-loop 传 `toolScope: agentId`）
- `plugin-manager.ts` — `config/plugins/<name>/` 默认导出 `setup(ctx)`；fail-soft + 幂等；同名冲突警告；工具全局可见或 `{scope}` 限定
- `agent-config-loader.ts` — `config/agents/*.yaml` 读写（`saveAgentConfig`/`deleteAgentConfig`/`hasAgentConfig`/`loadAgentConfigFromDir`）；`VALID_MODELS` 白名单；skills/plugins/strictTools 字段
- `zip.ts` / `package-installer.ts` — 零依赖 zip；.aw 资产包（manifest 校验/防穿越/回滚）三类型路由（plugin/skill/mcp）；`installAny` 裸格式（.md/.json/插件目录）；`exportPackage`/`exportRaw`/`copyPluginDir`；导出 `parseSkillMeta`
- `app-manifest.ts` — 应用 manifest 校验（**terminal 权限 schema 级拒绝**、fs 限 `data/apps/<id>/` 内、entry 防穿越、BOM 兼容）
- `app-manager.ts` — 应用生命周期状态机 + `data/apps/state.json` 持久化 + **autostart 恢复** + destroy 幂等 + 插件兼容视图；`handleBridge` 能力桥入口
- `app-runtime.ts` — 子进程能力桥（`--max-old-space-size=256` + 行分隔 JSON-RPC）；能力 storage/notify/llm/fs/http（**无 terminal**）；60s 工具超时/15s 心跳/崩溃指数退避（1s/2s/4s ≤3 次）；`httpFetch` 10s 超时
- `app-factory.ts` / `generator-queue.ts` — 即时生成：appgen agent（tools=[fs_write,fs_edit,fs_list,fs_read]，30 轮）多轮写文件 + 校验反馈（≤2 轮）；doc 落 `data/docs/`；队列 jobId 即返 + `gen/*` 事件 + 完成态保留 20 条
- `app-bridge.ts` — `APP_BRIDGE_SNIPPET` 宿主注入 iframe（storage/notify/llm/fs/http）；iframe 侧 `ev.source === window.parent` 校验 + 30s 超时
- `app-sandbox.ts` / `process-manager.ts` — 路径防护（safeResolve/isInsideDir）；Agent/App/Job 统一进程注册表 + `process/*` 事件
- `security/sandbox.ts` — `checkAppCapability`：应用能力强制层（storage 自动允许，其余静态声明命中，未命中 ask 通道 fail-closed）
- `job-runner.ts` — 后台任务（jobId 即返；并发 2；fail-closed 拒高危；完成写会话+审计+`job/done`）
- `scheduler.ts` / `nl-schedule.ts` — cron 任务（**cron-parser v5 为 6 字段，5 字段自动补秒前缀**）；自然语言→cron（每N分钟/小时、每天/每晚、每周X、每月X号、时间词+12h）
- `env-loader.ts` / `onboarding.ts` — .env 加载（入口最先调用）；首次引导三步（key/模式/标记），`/setup` 重进
- `llm/` — Provider Seam + adapter 注册表（未知 id 降级 openai-compatible）；唯一接触 openai SDK 的模块（**流式已产出 chunk 后失败不重试**）

### 智能体与路由 `src/agents/`

- BaseAgent：**构造拷贝 config**（不污染内置模块级共享默认）；`applyDeclaredSkills()` 每次 run 前按 `config.skills` 以 marker（`-- 绑定技能 --`…`-- 绑定技能结束 --`）定位注入，防重复/防 YAML 固化
- 内置 7 专家（TS 默认 + YAML 覆盖，`loadAgentConfig(id) ?? 默认`）；**`GenericAgent` 承载自定义智能体**（纯 YAML，与内置同等待遇：执行专家下拉/对话/协作/jobRunner 可用）
- **热重载**：index.ts `reloadAgent(id)` 重建实例（智能体 Tab / `/config iterations` 保存即生效，免重启）；保存时展开 mcp/插件工具进白名单并剥离技能段
- router 正则（带权重）→ LLM 语义兜底；优先级 coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)
- run/runStream 完成 `result.messages` 清空防内存膨胀

### 工具与 MCP `src/tools/` + `src/mcp/`

- `builtin.ts` — 9 内置工具（fs_read / fs_write / **fs_edit** / fs_list / terminal_exec / web_search / web_fetch / ask_user / terminal_session）。fs 基准 `workingDir`（写路径防穿越）；`fs_edit` 文本唯一匹配或行号区间（1-based）双模式；超长结果 >8000 字符 spill 落盘 `data/spills/`；terminal_exec 过沙箱
- `ask-channel.ts` — ask_user：TUI 输入行 / HTTP SSE 挂起 + POST /ask；只读白名单
- `terminal-session.ts` — 持久终端（cmd.exe /Q 或 /bin/sh，marker 分隔）；超时销毁；exit 清理孤儿
- `mcp-manager.ts` — stdio/HTTP 双传输，工具 `mcp_{server}_{tool}`；指数退避重连（≤5 次）；Windows spawn 需 `shell: true`
- `builtin-server.ts` — 内置 4 工具（math_eval 沙箱 new Function + Math 白名单等）

### 记忆与上下文 `src/memory/`

- `session-store.ts` — SQLite（WAL）+ FTS5；turn_logs/tool_call_logs 显式字段映射；**事件溯源** `session_events` 仅追加（appendEvent/getEvents/replayEvents/verifyProjection）；`appendMessage` 单点同事务双写；自动标题（≤24 字符）
- `telemetry.ts` — TelemetrySink seam + JSONL；脱敏瀑布、幂等、emit 错误隔离
- `session-export.ts` — 会话 Markdown 渲染（TUI /export 与 HTTP 共用）
- 三层记忆：工作 / 情景（FTS5 + Intl.Segmenter + 每天 15% 衰减）/ 语义（MEMORY.md/USER.md 有界，互斥锁）；**FTS5 MATCH 前清洗特殊字符**

### Hook 与安全 `src/hooks/` + `src/security/`

- `hook-manager.ts` — 6 事件（onMessage/onToolCallPre/onToolCallPost/onTaskComplete/onError/onTelemetryRecord）；`config/hooks.json` 注册；trigger 逐 hook fail-soft（权限用显式 `{proceed:false}`）
- `approval-service.ts` — ask/plan/auto 权限决策单点（**无确认通道默认拒绝 fail-closed**）
- `danger-detector.ts` / `permission-model.ts` — 高危正则拦截 / 三模式（ask 只读、plan 每步确认、auto 高危确认）
- `sandbox.ts` — cwd 越界 fail-closed、denyCommands 子串匹配、sanitizeEnv 剥 KEY/TOKEN/SECRET；terminal_exec 全检查（含 cwd）、terminal_session 仅 deny+env；**强制层先于权限层**
- 确认/提问通道：CLI stdin / HTTP SSE+POST（30s 超时拒绝）；server 端 `runWithChannels(write, fn)` 统一注册

### 终端 TUI `src/terminal/`

- 帧缓冲：`screen.ts`（差分渲染 + CJK 宽 + SGR reset 防泄漏）/ `term.ts`（raw-mode 键解析，parseKeys 纯函数可测）/ `tui.ts`（16ms 节流）
- InputLine 多行（Shift/Alt/Ctrl+Enter 换行，Enter 提交，动态高度 ≤8 行）
- `markdown.ts` — 行级渲染 + 表格对齐 + OSC 8 超链接（**wrap/截断须保持转义序列完整，未闭合 OSC8 会吞掉后续 ANSI 定位**）
- `--server` 跳过 TUI；CJK 用 `displayWidth()`/`padToWidth()`

### HTTP Server 与 Web UI

- `server.ts` — API 前缀 `/api/v1`（`apiUrl()`）；静态托管排除 /api；`/apps/` 沙箱静态路由（widget 透明注入、缺失 .css 返空、no-cache）；`/apps/gen` 列表端点；**`/agents` 完整配置 + `/agents/meta` 表单选项 + `/agents/<id>/config|reset|delete`**（校验：id 格式/长度、modelPreference 白名单、defaultMode 白名单）
- **WebSocket 总线**：`event-bus.ts` + `/api/v1/ws`（30s 心跳）；chat/plan 的 write 闭包 **SSE + eventBus 双写**；前端 `ws.svelte.ts` 指数退避重连（仅处理同步事件避免双通道重复渲染）
- `/chat` 多模态（images + vision 门控）；`/plan`：plan → step_start → step_end → done；`/debate`：debate_start → done
- `/config` 端点：getConfigState/setConfigField（model/temperature/maxTokens/thinking/skillEvo/reset；**迭代上限已归智能体配置**，不在此）
- `web/` — Svelte 5 + Vite 6；vite proxy `/api → :3000`（`ws: true`）
- 组件：SystemPanel（context/agents/skills/mcp/plugins/apps/processes/schedule/config/trace 十 Tab）、AgentsPanel（智能体编辑/自定义/技能-MCP-插件绑定）、TracePanel（**最近活动列表 + 会话轨迹联动**）、AppsPanel、AppPreviewPanel/DocPreviewPanel、GenCard（生成状态卡片）、FileDiffPanel、ProcessesPanel、JobsPanel、InputArea（任务类型：对话/智能体协作/应用工坊）
- 前端 store：`apps.svelte.ts`（应用/进程/窗口 + **spawnGenCard/syncGenCard/loadGenJobs** 生成卡片链路）、`chat.svelte.ts`（inputMode 含 forge；UIMessage `_genJobId/_genStatus/_genResult` 生成终态持久化）、`theme.svelte.ts`
- **能力桥宿主侧**（web/src/lib/app-bridge.ts）：`ev.source === iframe.contentWindow` 校验；**回发 targetOrigin 必须 `"*"`**（沙箱 iframe origin 为 "null"，传宿主 origin 会被浏览器静默丢弃）
- ChatPanel.handleSSE 直接 mutate `store.messages`；DOMPurify 消毒 marked 输出防 XSS

## 测试

- `test/helpers.ts`：`makeTestDir(name)` 独立 `data-test/<name>/`、`setupEnv`、`clearTools`
- **隔离**：读真实 `config/*.json` 注入 fixture；config/agents 读写用 `loadAgentConfigFromDir`/`saveAgentConfig(id, cfg, dir)` 注入临时目录；端点测试 mock deps + `listen(0)` + fetch；WS 测试用 `ws` 客户端（Node 22 全局 WebSocket 无 `.on`）；`terminal-session.test.ts` 用 `describe.skipIf(非 win32)`
- 关键：agent-loop（超时/防循环/白名单/toolScope/迭代预算）、tool-registry、server、apps-api、app-factory、app-manager、app-runtime（子进程桥/崩溃重启）、process-manager、agents-api、agent-config-loader、generic-agent（技能注入）、plugin-manager、package-installer、scheduler、nl-schedule、job-runner、sandbox、approval-service、screen、cli-commands、media

## CLI 交互命令

```
/mode <ask|plan|auto>     切换权限模式
/plan <任务>               多专家 DAG 协作
/debate <话题>             双专家辩论
/app <list|info|install|start|stop|destroy|new|update|focus|close>  AI OS 应用生命周期/即时生成
/bg <任务>                 后台任务（不阻塞交互）
/jobs [cancel <id>]       查看/取消后台任务
/schedule                 定时任务（自然语言/remove/list，cron 5 字段）
/install <路径> [-f]      安装 .aw 包或裸格式（.md/.json/插件目录）
/pkg export <类型> <名>   打包导出 .aw；--raw 裸格式
/setup                    重新运行首次引导
/skill <名称> /skills     技能查看/激活
/new /sessions /switch    会话
/log /context /plugins /trace /status
/config                   模型/温度/max-tokens/iterations/thinking/skill-evo/add-model/reset（iterations 持久化到 config/agents/*.yaml）
/export [序号] /copy      导出 Markdown / 复制最后回答
/help [命令] /exit        帮助 / 退出
```

CLI 参数：`--dir <工作目录>`（默认 ./ai_default_project）`--data-dir` `--mode` `--show-thinking` `--server` `--port`
