# AiWorker Sprint 演进史

> 本文件由 `plans/` 下已完结的 Sprint 计划与设计文档压缩提炼而成（原文档已删除，git 历史可查）。
> 活文档保留在 `plans/` 顶层：[roadmap-next.md](roadmap-next.md)（路线图）、[sprint-52-background-subagents.md](sprint-52-background-subagents.md)（最近一期全案，含两轮 CR 台账）。
> 现行架构见 [docs/AiWorker架构.md](../docs/AiWorker架构.md)。

## 分期总览

| 阶段 | Sprint | 版本 | 主题 |
|---|---|---|---|
| 奠基 | 1~9 | 0.1 → 0.2.x | Agent 循环、Skills、7 专家、记忆、MCP、Team 协调器 |
| TUI/CLI 时代 | 10~12 | 0.2.x | 交互升级、多轮对话、技能自进化、API Server |
| Web 时代 | 13~22 | — | Web UI（单文件→Svelte 5）、TUI 引擎重写、权限确认通道 |
| 内核改造 | 23~28 | 0.3.0 | LLM seam、事件溯源、轨迹观测、DSH 对标、沙箱 + WS + CI |
| 工程纵深 | 29~33 | 0.4 ~ 0.6.6 | 迭代预算、调度、`.aw` 包、diff 提速、高危拦截修复 |
| AI OS | 34~42 | 0.7.0 → 1.0.0 | 应用/进程模型、AppFactory、语音视频、进化引擎三期、1.0 整合 |
| 可信与体验 | 43~51 | 1.1.0 → 1.8.0 | 离线 ASR/TTS、Token 口径、TUI 块视图、CI 门禁、headless、检查点、权限闭环、产物工作台、信息架构重构 |
| 并行纵深 | 52 | 1.9.0 | 后台子智能体 |

---

## 奠基（Sprint 1~9 · 0.1 → 0.2.x）

### Sprint 1 — Phase 2 启动：MCP + 真实 web_search + Research Agent（0.1 → 0.2）
- 交付：`src/mcp/mcp-manager.ts` + `connection-pool.ts`（stdio/HTTP 双传输、工具发现、缺依赖自动降级）、`agents/router.ts` 专家路由器、`research-agent.ts` + `config/agents/research.yaml`、`builtin.ts` web_search 接真实 API、agent-loop 补 onError hook 触发、compressor 写 MEMORY.md
- 关键决策：内置工具不走 MCP（同进程直调，走 MCP 徒增 ~10-20ms IPC 开销）；MCP 留给真正的外部服务
- 遗留/后续：其余 5 个专家待 Sprint 3/4

### Sprint 2 — Skills 技能系统（0.2.x）
- 交付：`core/skill-registry.ts` 单例（loadFromDir 递归加载 SKILL.md、match 正则匹配、getAvailableSkills 依赖过滤、getInjectedPrompt 注入文本）；首批 6 个 SKILL.md（common/file-organization + research 五技能）；context-manager 加 agentId 参数与技能注入
- 关键决策：SKILL.md = YAML frontmatter（name/version/description/triggers/expert）+ Markdown 正文工作流；零数据库、纯文件
- 遗留/后续：技能自进化（自动沉淀）留 Phase 4

### Sprint 3 — Coding 编码智能体（0.2.x）
- 交付：`coding-agent.ts`（全栈工程师人设、模型偏好 coding、maxIterations 50、白名单 fs_read/fs_write/fs_list/terminal_exec/web_search）+ `coding.yaml` + 3 技能（code-review/debug/test-generation）+ 路由规则
- 关键决策：操作前先确认文件状态与依赖关系；保持项目现有代码风格
- 遗留/后续：—

### Sprint 4 — 剩余 4 个专家智能体（0.2.x）
- 交付：data-analysis / product-ops / financial / game-dev 四 Agent + 28 个 SKILL.md + 路由规则 + 注册
- 关键决策：一次性交付完成六大专家全部就位；数据分析 HIGH 安全级（执行 Python），deniedTools 默认限制危险命令
- 遗留/后续：Phase 2 缺口（压缩器 LLM 化、YAML 加载等）→ Sprint 6

### Sprint 5 — 终端交互体验升级（0.2.x）
- 交付：Streaming 逐 token 输出 + "思考中"提示、底部常驻状态栏（模型/模式/上下文占用/快捷命令）、用户输入软排队（运行期捕获、完成后预填确认）
- 关键决策：不用 inquirer/blessed/ink（零 UI 库依赖，纯 ANSI 转义码）；不用 alternate screen buffer（保留 scrollback）；新增 completeStream() 与 completeWithProfile() 并行存在不破坏调用方
- 遗留/后续：Token 计数精确化、语法高亮、工具输出截断优化列为 P1 打磨项

### Sprint 6 — 补全 Phase 2 四个缺口（0.2.x）
- 交付：ContextCompressor 集成 LLM（ModelProvider 回调注入，移除硬编码 gpt-4o-mini）、`agent-config-loader.ts`（config/agents/*.yaml → AgentConfig）、MCP 连接池健康检查、`config/hooks.json` + `hook-config-loader.ts` + `handlers.ts`（6 核心 handler + 5 stub）声明式 Hooks
- 关键决策：Hooks 从 index.ts 硬编码抽出为配置驱动；~15 个文件小步快改
- 遗留/后续：5 个 stub handler 待实现

### Sprint 7 — Team Coordinator 多智能体动态编排（0.2.x）
- 交付：`team-coordinator.ts`——plan()（模板匹配预设 DAG 零 LLM 成本 → 无匹配时 LLM 生成结构化 JSON 执行计划）、validatePlan() 环检测、execute() 按拓扑序调度（无依赖步骤并发、非关键步骤失败容忍）、synthesize() 汇总；CLI `/plan` + 复杂任务自动检测进入协调器
- 关键决策：放弃固定 Pipeline/Parallel/Debate 三模式的僵化设计，改 LLM 动态 DAG 编排
- 遗留/后续（第二期开放问题）：辩论模式、用户修改计划、技能感知规划、流式步骤输出、按步骤配模型

### Sprint 8 — 记忆系统增强：FTS5 中文检索 + 有界记忆（0.2.x）
- 交付：session-store `Intl.Segmenter` 中文分词 + 三阶段查询 + 时间衰减排序（decayFactor，7 天过滤）；compressor 自适应 KEEP_RECENT（10 条→4、100 条→20）；MEMORY.md 双段结构（项目信息段不受会话历史冲刷）+ USER.md 自动更新
- 关键决策：不用 2-gram（词级语义丢失）也不引入 jieba-js（额外依赖），选 Node 内置 Intl.Segmenter 零依赖
- 遗留/后续：向量检索作为增强层按需启用（未做）

### Sprint 9 — MCP 服务器配置端到端打通（0.2.x）
- 交付：`src/mcp/builtin-server.ts` 轻量 MCP stdio 服务器（math_eval/uuid_gen/json_format/timestamp_convert 四工具）；`config/mcp.json` 配置 builtin 服务器 + 外部模板；index.ts 启动 loadConfig + MCP 状态展示
- 关键决策：内置能力不进 MCP（见 Sprint 1 原则），此服务器只放内置没有的小工具，兼作 MCP 管道的端到端验证
- 遗留/后续：外部 MCP 服务接入实例待用户配置

### Sprint 10 — TUI 交互全面升级（0.2.x）
- 交付：T1 reasoning_content 思考可视化（DeepSeek R1 类模型的推理流不再丢弃）+ `--show-thinking`/`/thinking`；T2 Plan 执行步骤进度实时更新；T3 常驻状态栏（流式期间 token 实时刷新、工具调用显示工具名）；T4 结构化帮助表；T5 Token 成本分项（models.json 价格表）；T6 文件 diff 摘要行 `📄 path (+N -M)`
- 关键决策：对标 Claude Code/Cursor/Codex/OpenCode 补齐三大缺口（思考展示、进度可视化、实时状态栏）；改动集中在 types/model-router/agent-loop/renderer/index，0 新建文件
- 遗留/后续：回归基线 85 测试

### Sprint 11 — 多轮对话 + Skill 自进化 + 目录感知 + 监控日志（0.2.x）
- 交付：M1 多轮对话（session 复用、messages 不销毁、`/new` 开新会话）；M2 `skill-evolution.ts` 自动沉淀（复杂任务完成后评分、4★ 以上落盘 `skills/{expert}/`，低质进 pending/）；M3 `project-profiler.ts` 目录智能感知（启动识别技术栈注入上下文）；M4 turn_logs 对话监控（`/log` 轮次摘要表 + 导出）；M5 上下文透明度（`/context` 分层 token 占比）
- 关键决策：多轮对话是"每次输入都创建新任务"这一根本缺陷的修复；首次对话直接引用项目结构省掉 fs_list 探索轮
- 遗留/后续：M2.1 技能自进化 v2（LLM 知识提取）当时仍是空壳 → Sprint 12

### Sprint 12 — 技能自进化 v2 + 工程化 + API Server（0.2.x）
- 交付：T1 ESLint + Prettier（先做，影响所有后续代码）；T2 M2.1 技能自进化 v2——LLM 从成功会话提取可复用知识生成 SKILL.md；T3 SkillEvolution 单测 7 例；T4 `src/server.ts` HTTP API 模式（node:http，POST /chat SSE、GET /status、GET /tools，`--server/--port`）；T5 低优修复项评估（结论：已自然解决或放弃）
- 关键决策：全项目扫描零 TODO/FIXME/HACK、零生产 console；每个请求独立 Agent session
- 遗留/后续：Web UI 由此端点起步（Sprint 13）；测试 85→92

---

## Web 时代（Sprint 13~22）

### Sprint 13 — Web UI 设计方案（首版单文件静态页面）
- 交付：`web/index.html` 单文件 SPA（~550 行，零 npm 依赖，marked.js CDN）；组件树 TopBar/ModeTabs(ask·plan·craft)/AgentSelector/ChatList/MessageList/RightSidebar(FileDiffPanel·SkillPanel·ContextPanel)/StatusBar；SSE 复用 `POST /chat`；`src/server.ts` 新增 `GET /`、`GET /agents`；localStorage 三级 key
- 关键决策：视觉三改 Tokyo Night → AI-Native 靛紫 → Claude 浅色系（用户反馈"太丑"）；不用气泡用色彩编码角色；工具合并改为 timeline[] 保留交错顺序；全等宽改 Inter + JetBrains Mono
- 遗留/后续：`GET /sessions`、`GET /sessions/:id/messages` 未实现（纯 localStorage）；ContextPanel 仅手动触发

### Sprint 14 — TUI 终端升级（流式渲染 + 交互补齐）
- 交付：`markdown.ts`、`output.ts`(StreamOutputRenderer)、V2 工具紧凑行、V3 常驻状态栏含 iter、V4 diff 正文、T1 Ctrl+C 连按中断、T2 `history.ts`(~/.aiworker_history 500 条)、T3 Tab 补全、T4 `/sessions`+`/switch`、T6 Web 复制按钮 + TUI `/copy`
- 关键决策：三轮审阅 12 项修正——放弃两阶段改流式直接渲染；放弃跨行卡片改单行紧凑（Promise.all 并发）；放弃 Esc 只留 Ctrl+C（`\x1b[A` 冲突）；不新建第二套状态栏而复用 liveStatus；协议扩展 `onToolResult(id?)`/`onIterationStart?`/`onFileDiff(diffText?)` 全可选；`fs_edit` 更正为 `fs_write`（当时不存在）；实测纠正 D1 误判
- 遗留/后续：V5 全屏交替缓冲 + 回看移出本 Sprint

### Sprint 15 — Markdown 视觉优化（终端语法高亮）
- 交付：`highlight.ts` 自研逐行 tokenizer（注释/字符串/数字/关键字/布尔/函数名着色），接入 output.ts emitLine 与 markdown.ts renderMarkdown；表格轻量美化 renderTableRow；标题层级强化 + 行内代码 bgBlack.dim
- 关键决策：选自研 tokenizer，不用 highlight.js/shiki（HTML 转换层 + 重依赖）；字符串/注释先占位保护；不做跨行对齐；正则限定 ASCII 避干扰 CJK
- 遗留/后续：全屏交替缓冲 TUI 明确放弃（成本高收益低）

### Sprint 16 — Web UI 增强（浏览器原生能力补课）
- 交付：`web/index.html` P0 语法高亮(hljs CDN)、流式性能修复（增量 DOM 替代全量 innerHTML）、thinking_start 指示器；P1 工具 spinner、target=_blank、server 接入 onFileDiff SSE；P2 Plan 按钮真正触发 team coordinator、GET /sessions + GET /sessions/:id
- 关键决策：P0/P1/P2 分层而非一次做完；改动按行数预估；仍维持单文件形态
- 遗留/后续：会话持久化与 Plan 协调排 P2；单文件可维护性由 Sprint 17 解决

### Sprint 17 — Web UI 迁移 Svelte 5 + Vite
- 交付：脚手架(package.json/vite.config/tsconfig/main/App/app.css)；4 stores(chat/stream/diffs/status)；utils(format/markdown)；15 组件(TopBar→AnswerBlock→ErrorBanner)；fetch+ReadableStream 解析 SSE mutate store；server.ts webDir→`web/dist/`，删旧单文件
- 关键决策：Vite `base: "./"` 兼容 Node 静态 serve；dev server.proxy 转发；根 package.json 加 web:dev/web:build；双降级（rune→Svelte 4 store；dist 优先 + 旧 index.html fallback）；实际以 `$state` rune 修 writable 引用 bug
- 遗留/后续：执行记录含后续修复轮（DOMPurify XSS、diffText 解析、蓝紫主题、Code Review 修 18 项）

### Sprint 18 — TUI 引擎重写（帧缓冲 + 差分渲染）
- 交付：`screen.ts`(Screen 帧缓冲/只写变化行/SGR 重置/displayWidth CJK)、`term.ts`(raw mode + CSI-u 与经典 CSI 双协议 + bracketed paste + SIGWINCH)、`components.ts`(MessageList/InputLine/StatusBar)、`tui.ts`(16ms 节流/prompt/start-endAgentSession)；renderer.ts 薄封装保兼容导出；index.ts 集成
- 关键决策：零新依赖自研；状态栏消失根因定为光标竞争，解法全帧渲染使状态栏"物理上不消失"；废弃 readline（50ms hack）；Esc 歧义用 10ms 超时判定；分步 T1~T4 独立可测再集成；server 模式跳过 TUI
- 遗留/后续：IME 仅 CURSOR_MARKER 方案；测试 92→111

### Sprint 19 — TUI 布局修复 + CLI 增强 + 测试重构
- 交付：T1 修输入行/分隔线消失（append 空行不覆盖流式 partial、appendInline 拆分、wrapLines 防御）；T2 SkillDef.description + 38 个 SKILL.md + `/skills` 分组；T3 getRecentTurnLogs + 真实耗时/token 增量 + `/log` 动态列宽；T4 `/config` 运行时模型配置持久化 `data/runtime-config.json`、thinking 经 extra_body；T5 `test/` 9 文件 + helpers 删 smoke-test.ts；T6 DeepSeek 配置修正
- 关键决策：maxTokens 4096→16384、default 启用 thinking（temperature 无效）；makeTestDir 独立目录防并行冲突；runtime-config 兼容 profile+model 双字段旧格式；turnLogger 挂 onMessage；子 agent 独立 sessionId + 基线
- 遗留/后续：CR 修 1 P1（`/config model lite` provider 未切换）+ 3 P2；测试 92→135

### Sprint 20 — HTTP API 与 Web 对齐 CLI + Server 测试
- 交付：server 新增 POST /plan、/debate、GET /context、/logs、/skills，ServerDeps 扩 coordinator 等，/chat 支持 sessionId 持久化；pickDebateAgents 提到 team-coordinator.ts；新建 test/server.test.ts(19 项, listen(0)+fetch)；Web chat.svelte.ts syncServerSessions/loadRemoteMessages、SystemPanel.svelte、PlanStepsBlock.svelte
- 关键决策：全部 API 统一 `/api/v1` 前缀（起因：GET 端点被当静态资源 404）；HTTP 会话 `http-` 前缀；SSE 按 data.type 分派不动旧事件；Node 22 原生 fetch；DiffPanel 按用户要求移除（captureDiff 保留快照+审计+CLI）；修 `chatReq.mode` 丢弃使权限模式生效；输入区加「对话/协作/辩论」三模式按钮
- 遗留/后续：文件 Diff 可视化推至 Sprint 21；测试 135→154→157→227

### Sprint 21 — Web 权限模式修复 + 确认通道 + Diff 重设计
- 交付：T1 craft→auto 37 处重命名；T2 permissionCheck 读请求级 `ctx.data.permissions` + allowsToolCallsFor(mode)；T3 `hooks/confirm-channel.ts`（CLI stdin / HTTP SSE 挂起、confirmId 精确路由、30s 超时）+ ConfirmCard.svelte；T4 `GET /api/v1/diffs` 扫 snapshots 解析 add/del/ctx + FileDiffPanel.svelte；UI 系统弹窗、双侧边栏折叠
- 关键决策：Plan 全工具确认、Auto 仅高危；ask 传全部工具定义由 permissionCheck 拦截产生 `tool_blocked` 告警（配 readOnly:true）；7 agent 补「必须结构化 tool_calls」；DANGEROUS_PATTERNS 补单文件删除；chcp 65001 + encoding buffer 修乱码；快照首行 `# path:` 记原始路径；tool_blocked 独立 errors 数组不污染消息流
- 遗留/后续：并发 /chat confirm provider 全局覆盖为已知限制（runWithConfirm() 统一收口）；测试 162→169→171

### Sprint 22 — Web 日常使用闭环打磨 + MCP 可视化
- 交付：会话管理三件套（deleteSession/renameSession/getSessionMessages + DELETE/POST rename/GET export(Markdown) 端点 + Sidebar hover 菜单 + ConfirmModal）；重试能力（「重新生成」失败恢复旧消息、ToolCard 失败工具「重试」、抽取 streamChatRequest）；MCP 配置面板（`/mcp` 端点 + SystemPanel MCP Tab）；FileDiffPanel 节流；TUI `/mcps`、`/config` 整合 thinking/skill-evo
- 关键决策：不新建组件文件、端点在 server.ts 内扩展；工具重试仅对单个失败工具续问不做全链路重放；显式 DELETE messages+sessions 两表；permissions.json 真正生效（default_mode + denied_patterns + strip BOM）、ask 放行 mcp_builtin_*；侧边栏标题用 firstUserMsg 与 TUI 一致
- 遗留/后续：修 GET /sessions/:id 拦截 /export、前端无条件更新本地容忍 404、MCP 加载竞态消除；测试 176→184

---

## 内核改造（Sprint 23~28 · 0.3.0）

### Sprint 23 — LLM Provider Seam 改造
- 交付：`src/core/llm/llm-adapter.ts`（LlmConnection/LlmAdapter 契约）、`llm-error.ts`（LlmError + classifyError/isRetryable/isQuotaExceededError）、`adapter-registry.ts`（单例注册表）、`openai-compatible.ts`（从 model-router 整体迁入：thinking extra_body 透传、reasoning_content 流式、retryable 指数退避 ≤3 次）；`model-router.ts` 门面化；`config/models.json` 增可选 `adapter`
- 关键决策：ModelRouter 公开 API 与 8 个调用方零改动；计量留在门面（避免多 adapter 漂移）；错误分类下沉 adapter；网络层重试与 hook 业务级重试分层不重叠；未知 adapter id 降级 openai-compatible，旧配置零迁移
- 遗留/后续：Anthropic/Ollama 等真实 provider 适配器仅留接口未实现；验证 198 测试通过

### Sprint 24 — 会话事件溯源（Event Sourcing）
- 交付：`src/types.ts` SessionEventMap（9 类事件）；`session-store.ts` 新增 `session_events` 表 + appendEvent/getEvents/replayEvents/verifyProjection，写入点收敛到既有方法内部；`agent-loop.ts` step/start-end、tool/call-result 事件；`handlers.ts` turn/start-end；`test/session-events.test.ts`
- 关键决策：渐进三阶段（P0 双写 → P1 回放派生 → P2 投影瘦身），本批读取仍走 messages 表；事件与投影同事务写入；session_events 不设外键（审计真源可先于会话存在）；压缩只改投影、事件日志保留原始
- 遗留/后续：P1/P2 未做；存量会话无事件仅告警，backfillEvents 未实现；212 测试通过

### Sprint 25 — 轨迹观测与遥测导出
- 交付：`src/core/trace.ts`（projectTrace 时间线 + computeSessionStats）、`src/memory/telemetry.ts`（TelemetrySink seam + JSONL Sink + 幂等去重/错误隔离）、`trace-view.ts` 树形渲染、`TracePanel.svelte`、三个端点（/trace/:id、/stats、/telemetry/:id）、CLI `/trace [--json]`、createTelemetryRedact + hooks.json `onTelemetryRecord`
- 关键决策：观测只读事件日志永不改写，脱敏仅作用导出副本；工具耗时由 result.at−call.at 投影聚合；assistant/message 只发组装后消息不发流块；默认本地 JSONL、不引入新依赖；轮次结算时批量 capture 避免热路径开销
- 遗留/后续：OTel/OTLP 后端只留 seam 未实现；telemetry.jsonl 归档策略待观察

### Sprint 26 — DSH 对比改进第二批（7 项）
- 交付：`src/tools/spill.ts`（超 8000 字符落盘 + 定位符，接 fs_read/terminal_exec）、withTimeout 统一工具超时（默认 60s）、`ask-channel.ts` + ask_user 工具 + AskCard + /api/v1/ask、`terminal-session.ts` 持久 shell + terminal_session 工具、防循环提醒（连续 ≥3 相同注入 system）、appendMessage 自动标题、pruneOversizedToolMessages、`approval-service.ts` 决策矩阵 + fail-closed
- 关键决策：不引入 node-pty（cmd.exe /Q + marker 分隔符），超时即销毁进程防缓冲区错位；自动标题模板截断 ≤24 字符不调 LLM；权限 hook 改薄委托 ApprovalService；ask_user 加入 READONLY_TOOLS
- 遗留/后续：非 Windows 平台持久终端仅回退说明；修复旧子进程 exit 迟到事件竞态；266 测试通过

### Sprint 27 — 插件契约 + scoped 工具注册
- 交付：`tool-registry.ts` scopes + ToolScopeView（同名遮蔽全局、回退全局）、`agent-loop.ts` toolScope + filterVisibleTools 白名单、BaseAgent 以 config.id 作 scope、`plugin-manager.ts`（loadFromDir/PluginContext/registerTool/registerHook/fail-soft/幂等）、`/plugins` 命令、`GET /api/v1/plugins`
- 关键决策：不上 Cordis，轻量契约 = `config/plugins/<name>/plugin.ts|js` 默认导出 setup(ctx)；单插件失败不阻断启动；白名单为空则全部可见（4 个 agent 零变化），MCP 工具保持全局可见；回退方式=清空 YAML tools
- 遗留/后续：Web 插件列表 UI 列二期；编译后 dist 仅 .js 插件可用；实机修复插件工具被白名单误滤 → isPluginTool 豁免；322 测试通过

### Sprint 28 — 执行沙箱 + WebSocket 总线 + CI（提交 f392bbf）
- 交付：`config/sandbox.json` + `src/security/sandbox.ts`（checkCommand cwd 约束 + denyCommands + sanitizeEnv）、`event-bus.ts` + `/api/v1/ws`（noServer + upgrade + 心跳）、chat/plan/debate 双写 SSE+广播、session/update 推送、前端 ws store、`.github/workflows/ci.yml`（windows+ubuntu matrix / web-build）、cross-env 化 scripts、models.json fixture 化
- 关键决策：明确不做 OS 级进程沙箱（bwrap/Seatbelt/restricted token），采用声明式策略 + 环境清理 + 现有纵深；denyCommands 子串匹配（防 echo rm -rf 绕过，安全优先）；terminal_session 不做 cwd 约束（有状态 cd 无法可靠追踪）；前端 WS 只消费同步事件，SSE 保持发起标签页唯一事实源
- 遗留/后续：OTel 导出不在本批；运行中任务状态仅内存（重启丢失）；测试 332→345

---

## 工程纵深（Sprint 29~33 · 0.4 ~ 0.6.6）

### Sprint 29 — 迭代预算优化（0.4.0）
- 交付：6 个 `config/agents/*.yaml` + `default-agent.ts` 上限翻倍（default 30→60、coding 50→100、research 80→160、game-dev 70→140 等）；BaseAgent setMaxIterations + `/config iterations [n]`（校验 10~1000）+ runtime-config `iterations` 字段与启动恢复；BUDGET_WARN_AT=5 收尾提示、撞顶返回带进展、REPEAT_FORCE_STOP≥6 强制终止、TOOL_FAIL_STREAK_MAX=4 全失败终止
- 关键决策：扩容必须配空转/失败强停兜底防 token 浪费；收敛提示仅在剩余 ≤5 轮注入一次；iterations 字段利用 applyOverrides 忽略未知字段保证旧文件兼容
- 遗留/后续：YAML 与 TS 双处维护上限（YAML 优先）；回归基线 348 测试

### Sprint 30 — 定时调度 + 后台任务 + 首次运行引导（0.5.0）
- 交付：`job-runner.ts`（submit/queued→running→done|failed、MAX_CONCURRENT=2、结果写独立会话 + 审计 + job/done 广播）、`scheduler.ts`（cron-parser + `config/schedule.json` + schedule:fire 审计）、`/bg /jobs /schedule` 命令、`/api/v1/jobs` 与 `/api/v1/schedule`、Web Schedule Tab、`env-loader.ts` 极简 .env、`onboarding.ts` 三步引导 + `/setup`
- 关键决策：后台任务不注册 ask/confirm provider，复用 approval-service 无通道即 fail-closed；callbacks 只收集文本不写 TUI（避免抢渲染）；env-loader 零依赖且不覆盖已有 process.env；cron 解析失败该任务跳过不影响其他
- 遗留/后续：运行中任务状态在内存，重启后丢失（已注明）；新增依赖 cron-parser

### Sprint 31 — 技能/MCP/插件统一 `.aw` 导入包（0.6.0）
- 交付：`zip.ts`（零依赖 zip 解析，store/deflate via inflateRawSync）、`package-installer.ts`（manifest 校验 formatVersion/type/包名/版本/minAppVersion + install 落盘类型专项校验 + listInstalled 单例）、`/install <path> [-f]`、`scripts/pack-aw.mjs`；三类资产落盘 skills/、合并 config/mcp.json、config/plugins/
- 关键决策：放弃 `.aiworker` JSON 单文件方案，仅保留 `.aw`（zip+manifest）；插件/MCP 导入前红色警告需用户确认（信任模型=用户自行判断）；路径穿越 relative 检查拒绝 `..`/绝对路径；同名冲突默认拒绝需 force；失败回滚删除已写目录
- 遗留/后续：`/pkg export`、HTTP packages 端点、Web 导入导出 UI 列入待办（0.6.1~0.6.4 补齐裸格式与导出）；正式 package-installer 测试后补

### Sprint 32 — 文件变更检测提速 + terminal_exec 用途明确（0.6.5）
- 交付：`handlers.ts` 写工具白名单 MAY_WRITE_TOOL（terminal_exec/terminal_session/mcp_*/plugin_*）才触发指纹扫描 + SKIP_DIRS 分层（.godot/node_modules/dist/build…）+ 快照分级（文本行级 diff / 二进制仅元信息不 base64）+ 会话级 2s 节流；`/diffs` 目录签名缓存（TTL 30s）；FileDiffPanel 二进制占位；terminal_exec/fs_write 描述重写 + 4 个 agent prompt 补充
- 关键决策：根因实测（17992 文件、16484 噪音快照，其中 .godot 9120）后选择"三级检测 + 分层快照"而非 fs.watch——Windows 原子替换/事件丢失不可靠，过滤后全量扫描已毫秒级；用户资产（.glb/.png）变更仍可见但降级展示；fs_write 精确通道不动
- 遗留/后续：存量噪音快照清理范围需用户确认；基线 445 测试

### Sprint 33 — 高危拦截缺陷修复 + 工具错误展示/重试优化（0.6.6）
- 交付：`danger-detector.ts` 正则加固（rm -rf 匹配任意非空目标含相对/引号路径、全部加 i 修大小写绕过、del 的 /s /q 任意顺序、rd/rmdir 别名覆盖）+ 加固用例；ToolCard 按关键词区分"⚠ 操作被拦截 / ⚠ 执行失败"；ChatPanel retryTool 修复 stream.sending 静默 return；terminal_exec 描述补 Windows cmd 与 PowerShell 包裹提示
- 关键决策：实测确认 `rm -rf ./dist`、`node_modules`、`../secrets`、`"my folder"` 均放行属严重漏洞；checkCommandBlock 语义判定为设计意图正确（ask 直拦、plan/auto 交 confirm，无通道 fail-closed）；UI 侧根因是把执行失败误标为"被拦截"误导重试
- 遗留/后续：重试仍是"重发用户消息 + 附注"让 LLM 重新生成，非真正重放单个工具调用

---

## AI OS（Sprint 34~42 · 0.7.0 → 1.0.0）

### Sprint 34 — AI OS 内核：应用模型 + 进程模型（0.7.0）
- 交付：`app-manifest.ts`（manifest schema 校验）、`app-manager.ts`（installed→starting→running→stopping→stopped/destroyed 状态机 + state.json 持久化 + autostart + destroy 幂等）、`app-runtime.ts`（子进程 + 行分隔 JSON-RPC 能力桥、256MB V8 堆上限、60s 工具超时、15s 心跳、崩溃指数退避重启 1s/2s/4s ≤3 次）、`app-sandbox.ts` + `checkAppCapability`、`process-manager.ts`（Agent/App/Job 三类注册表）、CLI `/app`、`/api/v1/apps`+`/processes`、Web AppsPanel/ProcessesPanel + 暗色模式/lucide 图标/细滚动条/`:focus-visible`/空状态启动台/左侧 OS 导航
- 关键决策：应用能力**无 terminal**（schema 直接拒绝该权限值）；不进程内加载插件而是子进程隔离；plugin-manager 零改动，仅在 `app-manager.list()` 做视图合并保生态兼容；预算只做注册表 + 优先级标记（front>bg>app），配额执行推后
- 遗留/后续：webapp 类型与窗口体系、文档工作台推给 Sprint 35；`.aw` 打包规范待 35 定；主路径为目录安装（测试 +35，全量 492 绿）

### Sprint 35 — 应用工厂 v2：一句话生成应用 + 窗口体系（0.8.0）
- 交付：`core/app-factory.ts` 重写为 agent-loop 生成管线（临时"生成 agent"，tools 白名单 fs_write/fs_list/fs_read，maxIterations=30）+ 校验器把关与反馈自查循环（≤2 轮）；`generator-queue.ts`（jobId 即返、取消排队、gen/* 事件）；`app-bridge.ts` 宿主注入 `window.__AIWORKER_BRIDGE__` + `/apps/:id/bridge`；三形态窗口（panel/float/widget 透明悬浮）+ 拖拽/缩放/全屏/置顶/最小化/位置持久化 + iframe 沙箱；GenWizard 进度轨迹；文档工作台（目录/Markdown/导出/data.json 图表）
- 关键决策：v1"LLM 直出文件 + 分块续写拼接"因单次输出上限导致截断与语法错误而整体废弃，改走已成熟的工具调用写文件路径（长代码由多轮迭代自然解决）；框架管 chrome/骨架/manifest/桥接，模型只管 app.js/style.css 且**无行数限制**；不做生成总耗时限制（用户拍板防误杀）；生成任务不注册 ask/confirm（fail-closed 拒高危，沙箱内 fs 直接允许）
- 遗留/后续：P2 并行生成/预生成缓存留后续；`.aw` 的 app 打包规范实至 1.0.0 才补

### Sprint 36 — 语音/视频收敛为多模态图片 + 后端媒体通道（0.9.0）
- 交付：多模态图片上传——粘贴/选择/拖拽 → base64 → `Message.content` 联合类型数组组装 + `models.json` profile 的 `vision: true` 能力门控；后端保留 `src/media/tts-provider.ts`（edge-tts 自实现 WS 客户端 + sherpa 探测降级）、`media-server.ts` 的 `/api/v1/audio` WS 通道（reqId 并发多路）、download-manager 框架、types/content/agent-loop/server 多模态链路
- 关键决策：**语音输入（ASR）放弃**（用户实机拍板）——Chrome Web Speech API 依赖 Google 云端不可达、edge-tts 微软接口 403、speech-asr WASM 模型部署成功但识别器始终无输出，本地链路无法闭环；TTS 默认改浏览器 speechSynthesis；不做实时视频通话/摄像头流、TUI 实时语音。0.9.x 后续迭代并入应用工坊二期与智能体管理
- 遗留/后续：语音闭环留待环境可行时重启（后由 Sprint 43 离线 ASR 补完）

### Sprint 37 — Web 对话技能模式与技能检索（0.9.1）
- 交付：`Task.explicitSkill` 经 agent-loop deps → `context-manager.assembleContext` 把技能正文拼入 fullSystemPrompt，base-agent run/runStream 透传；`server.ts` `resolveSkillInstruction`（匹配 `^/name`，兼容 `/skill <名称>`）+ SSE `skill_activated`/`skill_not_found`；前端 InputArea `/` 触发技能选择器（过滤 + ↑↓/Tab/Esc）、AgentCard `⚡ 技能名` 徽标、SystemPanel 技能 Tab 搜索框
- 关键决策：审核否决初版"把技能正文拼进 instruction"（污染会话历史、触发词二次注入、刷新后重复），改为**系统提示注入且指令保持原始输入**（仅当轮、无持久化）；顺带修复预存缺陷——`/chat` 用户消息被 server.ts 与 base-agent 双写（turnCount 翻倍），持久化唯一入口收敛到 base-agent；未知 `/xxx` 明确报错而非交给智能体乱答
- 遗留/后续：前端列表与后端热加载短暂不一致，以后端校验为准（548 绿）

### Sprint 38 — 文档预览纳入工作目录项目文档（0.9.2）
- 交付：`/api/v1/docs` 返回 `{roots, docs[{root,path,title,size,mtime}]}`（root ∈ session|project）；`/docs/content?root=` 双 root 各自 resolve + `relative()` 穿越校验；project 扫描规则（排除 node_modules/.git/dist/build 等，深度 ≤4、.md ≤200、单文件 ≤1MB、mtime 降序）；前端 docViewer 改 `session:<rel>`/`project:<rel>` 前缀 key、分节 chips + `session/update` 自动刷新
- 关键决策：只读浏览不做编辑（fs_write/agent-loop/文档生成链路零改动）；每个 root 独立校验以保安全不降级；**图表 sidecar（data.json）仅 session root 加载**，避免误读项目业务 JSON；项目文档 title 用相对路径（比文件名更有辨识度）
- 遗留/后续：项目内非 AI 生成的历史 .md 属噪音，靠 mtime 降序 + 分组隔离容忍（556 绿）

### Sprint 39 — 进化引擎第一期：观察 + 提议（0.10.0）
- 交付：`evolution-observer.ts`（工具成功率/耗时/失败 top、任务完成率、重复任务聚类、干预频率、生成统计，全部从 session_events/audit 派生，不新增存储）、`evolution-proposer.ts`（meta-agent → 六类结构化提案 new-skill/new-tool/new-app/config-change/tool-fix/prompt-fix，落盘 `data/evolution/proposals/` + ledger）、`evolution-engine.ts`（observe/propose/list/adopt/apply/reject）、六个 evolution 端点 + `evolution/*` WS 事件、Web「进化」Tab、CLI `/evo`
- 关键决策：护栏——默认仅建议、需用户确认，每日 ≤3 条限频，全审计；**两段式确认** adopt 只返回写入预览、apply 才真正执行；new-skill 由 meta-agent 直接产出 SKILL.md 再复用 validate/register；空观察短路跳过 LLM；tool-fix/prompt-fix 本期仅记录建议
- 遗留/后续：强制限额、A/B 评测、黄金用例、快照回滚全部推到第二三期；顺手修 web tsc 3 个存量错误（首次 0 错误）（602 绿）

### Sprint 40 — 进化引擎第二期：补丁生效 + 快照回滚（0.11.0）
- 交付：`evolution-snapshot.ts`（apply 前 capture 受影响目标 → `data/evolution/snapshots/<id>.json`，content=null 表原不存在；restore 联动 reloadSkill/unloadSkill/reloadAgent/重注册工具）、`skill-registry.unloadSkill(name)`、`evolution-diff.ts`（before=快照 + after=action，零依赖行级 LCS diff）、rollback 端点 + `/evo rollback` + Web「回滚」按钮、ledger 台账视图、tool-fix 的 `patchToolDescription` 与 prompt-fix 的 `applyPromptFix` 依赖注入回调、gen/done|failed 按 jobId 回写 ledger
- 关键决策：回滚是"硬能力"必须与写入同时到位，状态机加 `rolled_back` 终态（再改需重新 propose）；**不改内置工具 handler**（编译期代码是安全边界），tool-fix 只热覆盖 description 且仅本次运行生效、重启天然回退；prompt-fix 复用 `saveAgentConfig` + `reloadAgent` 既有管线；new-tool/new-app 无快照（生成物去应用 Tab 销毁）
- 遗留/后续：自动回滚阈值、A/B 对比、黄金用例留第三期；config-change 回滚后需重启生效；快照写盘失败不阻断 apply 仅记 warning（647 绿）

### Sprint 41 — 进化引擎第三期：测试 + 推广（0.12.0）
- 交付：`evolution-cases.ts`（黄金用例库，按 turn 提取——`turn/end reason=stop` 取末条用户消息为 input、末条助手消息截断 200 字符为 expected，完全一致去重，手工补录 addCase）、`evolution-eval.ts`（`runEval({before,after,cases,scoreCase})` 纯函数编排 + EvalReport 成功率/Δ/verdict）、engine 扩展 eval/verify 与 `doRollback(id, source)` 单路径、cases 四端点 + `/proposals/:id/eval|verify`、CLI `/evo case …|eval|verify`、Web「评测」「推广验证」按钮
- 关键决策：裁判（scoreCase）**注入**，engine 不碰 LLM；护栏 `MAX_EVAL_CASES=5`，裁判异常按用例 skipped 不计分母；**耗时仅报告不裁决**；regress 判定保守（相对 -20% 严格小于，或绝对 <50% 且 ≥2 用例）；before 选源按 status 而非快照文件存在性（防 apply 失败残留快照误用）；自动回滚仅限有快照的四类
- 遗留/后续：不做隔离子进程试运行评分、独立 token 预算配额、自动每日用例沉淀（留第四期）；修复"从会话提取"崩溃（旧夹具形状错误致漏测）（694 绿）

### Sprint 42 — AI OS 1.0 整合 + 每会话项目目录（1.0.0）
- 交付：每会话工作目录（sessions 表 `working_dir` 列 + 旧库 ALTER 迁移、`getWorkingDir/setWorkingDir`、`/chat` 透传 `task.workingDir`、`GET/POST /sessions/:id/working-dir`、CLI `/dir`、`/docs?sessionId=` 项目根跟随、Web 📁 徽标 + 编辑器 + 服务端只读 `GET /api/v1/dirs` 目录浏览弹窗、StatusBar 移除全局 💻 项）；审计 Tab（`AuditLog.queryRecent` + `GET /api/v1/audit`）；设备 Tab（`src/media/status.ts` 汇总 ASR/TTS/media-server + vision 能力）；进程资源仪表（token 占用条）；`examples/` 三示例（番茄钟 webapp、批量替换 tool、待办 service）+ `.aw` 扩展 app 类型与 `/pkg export app`；正式文档 `docs/ai-os-architecture.md`（现已并入本文档体系）
- 关键决策：先做跨切面基础——核实 `Task.workingDir` 与 base-agent 优先逻辑已在，故 **agent 层零改动**，只在 server /chat 与 store 单点注入；目录校验为绝对路径 + 存在 + 是目录 + 拒绝指向 dataDir（防套娃），其余"用户显式选择即授权"（与 `--dir` 同权）；浏览器拿不到本机绝对路径，故目录浏览走服务端只读端点；StatusBar 去掉全局工作目录项（会话化后放全局会误导）
- 遗留/后续：job-runner / 团队协作 / 语音仍走全局目录；不做跨会话继承；审计表不做清理/导出（735 绿）

---

## 可信与体验（Sprint 43~51 · 1.1.0 → 1.8.0）

### Sprint 43 — 离线语音输入（ASR）+ TTS 补齐（1.1.0）
- 交付：`src/media/model-manager.ts`（模型就绪探测 + hf-mirror 一键下载）、`asr.ts`（SherpaAsrProvider，paraformer-zh 非流式）、`tts-provider.ts` 填真 sherpa vits-zh-ll、`media-server.ts` 扩展 `/api/v1/audio` ASR 协议、Web InputArea 🎤 按住说话 + VoiceBar 回填、设备 Tab 状态真实化、CLI `/media status|download`
- 关键决策：选 sherpa-onnx 而非 transformers.js（全离线、中文实测最优），版本锁定 1.10.46（1.13.7 流式路径原生崩溃）；只做非流式整段上传（≤60s base64 PCM），前端降采样 + 后端 LinearResampler 双保险；识别结果回填不直接发送；下载不做断点续传
- 遗留/后续：流式帧上行、更小模型、非 win-x64 平台实测

### Sprint 44 — Token 统计与上下文窗口真实化，移除计费（1.2.0）
- 交付：`config/models.json` 增 `contextWindow`（provider/model/profile 三级 + 内置兜底表）、`ModelRouter.getContextWindow()` 与 sessionScopes 会话账本、compressor 预算窗口独立、共享估算 `estimateText`（CJK 1字/token、ASCII 4字符/token）、getContextBreakdown 用 replayEvents 含 tool 消息、TUI footer 本轮化、Web SSE done 下发 turnUsage、StatusBar 改「全局 tok」
- 关键决策：**统一移除全部费用统计**（价格多变、应用端计价无意义，费用去平台核对）；压缩触发阈值与模型物理窗口分离（否则 1M 窗口下压缩失效）；摘要 fire-and-forget 只计进程全局；本地实测窗口优先于官方口径
- 遗留/后续：按模型窗口压缩的可配置项、Ollama 运行时探测、plan/debate 的 turnUsage、占比流式实时更新

### Sprint 45 — TUI 块式会话视图（思考/工具可折叠）（1.3.0）
- 交付：`src/terminal/turn-view.ts`（TurnView + thinking/tool/ask/text/note 五类块）、MessageList 条目化（line/turn）+ 惰性 wrap 与行预算、output.ts 回合句柄注入（fence/table 状态机回合级 reset）、tui.ts startTurn/finishTurn(interrupted)、渲染层 gutter 竖线逐段重放
- 关键决策：采用块式视图对齐 Web timeline；thinking 默认折叠但标题摘要实时刷新；running turn 为消息区唯一活条目，外部输出进 rawLines；键位取消空闲期裸字母与 Space/Enter，改 ←/→/Enter/Esc 焦点导航态
- 遗留/后续：`/plan` `/debate` 仍静态行（v2 命令回合化）、可选运行中动画、内联图片不做

### Sprint 46（设计：preview-artifacts-design）— 工具产物预览 Artifact/Preview（1.4.0）
- 交付：`ToolArtifact`（file/link/diff）+ `ToolResult.artifacts`、`src/core/preview.ts`（mimeFromPath/kindFromMime）、fs/web handler 填充、onToolResult 与 server 三处 WS `tool_result` 写出点透传、`GET /api/v1/files` 二值端口（session 绑定 + 根白名单 + realpath + Range + 审计）、Web ToolCard chips + FilePreview.svelte（图片/视频/PDF/Office mammoth+SheetJS/彩色 diff）、TUI ToolBlock.artifacts + OSC 8 链接
- 关键决策：产物元数据由工具 handler 权威填充（不靠 UI 猜、不靠 LLM 编）；二进制不进 content 只给 artifact 点击才拉字节；`.md` 复用 DocRenderer 不造第二套渲染；fs_read 先 sniff 再决定读法
- 遗留/后续：明确不做服务端 LibreOffice/ffmpeg、pptx 仅下载兜底、TUI 内联图片、app 沙箱内预览、预览原地编辑；WS `tool_result` 缺 callId 导致按位置匹配

### Sprint 47 — 可信基线：CI 门禁 / svelte-check / 权限规则化 / Windows 最小沙箱（1.5.0）
- 交付：`.github/workflows/ci.yml`（backend + web 双 job）+ `check:web` / `verify` 脚本、62 个 svelte-check 错误清零、`permission-model.ts`/`approval-service.ts` 的 `Tool(specifier)` deny→ask→allow 规则与 never_auto_approve/protected_paths、sandbox 可写根约束（重定向与写入类命令目标解析）、flaky 用例改独立 sessionId、CI 首跑修 SQLite 目录缺失
- 关键决策：无确认通道一律 fail-closed；allow 不能绕过只读模式、never_auto_approve 与受保护路径；Windows 沙箱诚实标注为启发式多层防御而非 OS 隔离替代；不用 `as any`/`@ts-ignore`；受保护路径按路径段匹配（不再误伤 .gitignore/.github）；规则字段校验失败即丢弃告警防静默失效
- 遗留/后续：headless 与检查点/rewind（S48）、权限记忆 allow-always、fs 写路径统一（S49）

### Sprint 48 — headless 一次性运行 + 检查点与 /rewind（1.6.0）
- 交付：`src/core/bootstrap.ts`（createRuntime 装配层，index.ts 收敛为 interactive/server/headless 三层壳）、`headless-runner.ts`（`-p` + text/json/stream-json NDJSON、退出码 0/1/2/3/4/130、日志全改 stderr）、`checkpoint-store.ts`（manifest + blob，每会话保留 20 轮）、turn-registry、`rewind/applied` 事件与 replayEvents/rewindMessages、`/rewind` 命令（列表/三档范围/--dry-run/--force + 哈希冲突检测）、HTTP checkpoints/rewind 端点 + RewindPanel.svelte
- 关键决策：只做 P0-5+P0-6；headless 注册立即拒绝的确认通道且 `--yes` 不新开旁路；terminal_exec 变更仅记录不回滚、不做目录级快照；事件日志保持仅追加；不 `process.exit()` 硬杀避免丢 WAL；单测不 spawn 子进程
- 遗留/后续：多轮 headless 编排/SDK、检查点跨机同步；实施偏离三处已在文内更正

### Sprint 49 — 权限闭环与路径策略单点（1.7.0）
- 交付：`src/security/path-policy.ts`（resolveRealPath 逐级组件真实路径解析、读根/写根、受保护路径）、fs 四件套接入 + `allowReadDirs`、`permission-memory.ts`（项目级/会话级来源 + 原子写回 + 撤销）、确认第三选项「始终允许」、`/permissions` 命令、`GET/POST /api/v1/permissions` + PermissionsPanel.svelte、`permission:rule-added/removed` 审计；三轮审查修复（悬空链接/junction 绕 deny、跨站+token 写入门、mtime 懒重载、链接能力探测 + `AIW_NO_LINKS`）
- 关键决策：只做 P1-4+P1-7（后台子智能体需预授权规则故为其前置）；规则默认落项目级；读边界默认收紧到读根（行为变更）；策略层只答"越界没有"、审批层答"要不要问"；fs 边界不受 `sandbox.enabled` 影响；「始终允许」仅在 auto 高危确认提供；不做 OS 级沙箱、角色体系、参数级 ACL
- 遗留/后续：其余写接口（/config、/pkg/import、/apps）信任模型未收紧；符号链接测试在受限机器跳过覆盖

### Sprint 50（设计：artifacts-workspace-design）— Web 产物工作台
- 交付：`src/core/artifacts.ts` 纯函数合并（ArtifactItem，去重键 root:rel、多来源 sources、deleted 保留、degraded 标记）、`docs-index.ts`、`GET /api/v1/artifacts`、右栏收敛为产物/应用 2 tab（ArtifactsPanel/ArtifactList/ArtifactDetail/DiffView/TimelineStrip，删 FileDiffPanel/DocPreviewPanel/RewindPanel）、对话流「从这里重新开始」、trace 投影带 artifacts；后续九轮用户实测反馈修复（doc key 前缀、锚点、HtmlPreview sandbox + CSP）
- 关键决策：回滚是时间轴操作而非第四种产物；仅对话回滚移到对话流；聚合端点只读元数据不读字节；时间线默认「仅代码」；非本会话变更显示但打文件系统快照标；HTML 必须 sandbox 不给 allow-same-origin（同源可窃取 token）
- 遗留/后续：媒体内联（音频/PDF）、`.svgz` 未入表、多文件站点路径式路由、P2 的 callId 精确联动与 `.aw` 批量导出

### Sprint 51（计划：web-ia-restructure）— Web 信息架构重构：设置 / 控制台分离（1.8.0）
- 交付：`SettingsPanel.svelte` + settings/{Model,Security,Workspace,Interaction,About}Settings、`shell.svelte.ts` 入口与深链、`settings.svelte.ts`（/config 与 /sandbox 唯一实现）、`GET/POST /api/v1/sandbox`、`/permissions` 扩展 set-protected-paths/set-never-auto-approve、`json-file.ts` 原子写、`/config` 补写入门、SystemPanel 分组左导航（只搬不改）、右栏 3→2 tab + StatusBar 权限徽章
- 关键决策：设置="我改它"（写配置）、控制台="我只想看"；13 个 tab 逐条映射零丢失；新增写面必须凑齐写面三件套（跨站 403→token 401→参数 400）+ 原子写 + 生效时机说明；写路径始终跟随 `--dir`；死配置 `allowed_dirs` 不做 UI；不加权限模式运行时切换
- 遗留/后续：`/diffs` 快照可能混入非本会话改动；其他写接口沿用原信任模型

---

## 并行纵深（Sprint 52 · 1.9.0）

### Sprint 52 — 后台子智能体：可续接、可控制、可观测、可撤销（1.9.0）
- 交付：`subagent-runner.ts`（queued/running/idle/failed + abortRequested/pending≤5，MAX_CONCURRENT=4）、控制面 4 工具 `subagent-tools.ts` + `subagent-rules.ts`（无依赖常量模块防循环导入）、`filterVisibleTools` restricted 标记 + `executeToolInner` 执行层硬校验、`ToolContext.signal` 贯通 + `terminal_exec` 进程树 kill（win32 taskkill /T /F）、`subagent-ownership.ts` 回滚归属 B 路线、`/api/v1/subagents` 四端点（写门禁）、审计 actor_session_id 与父子 token 聚合、`BaseAgent.fork()`、`/subagents` TUI、诊断用例 `sprint-52-diagnosis.test.ts`（收工 1120 例/74 文件）
- 关键决策：并发 4、回滚走注册表路线 B（子写登记父 spawn turn manifest）、spawn 默认只读闭集、深度 1 执行层硬拒、`list_agents` 仅主智能体可见（防枚举兄弟 sessionId）、mode 只收窄不放宽、fail-closed 拒绝带 `reason:"no-channel"`、fs_edit 补入 DANGER_TOOLS（路径判定）；两轮 CR + 两轮测试修复
- 遗留/后续：fork 与持久目标 P1-2 拆到 S53；T6b 子智能体面板按"可砍"未做（仅进程面板加 subagent kind）；`never_auto_approve` 无"始终允许"路径；headless 下 spawn 不可用；无 worktree 隔离（并发写同一文件会互相覆盖）；插话只在轮边界送达

---

## 附：路线图要点（plans/roadmap-next.md，仍为活文档）

- **P0 可信基线**（已全部落地，S47/S48）：CI、svelte-check、权限规则化、Windows 最小沙箱、headless、检查点/rewind、测试确定性
- **P1 长程与工具纵深**：P1-1 后台子智能体 ✅S52、P1-2 目标驱动 →S53、P1-3 工具面扩展、P1-4 权限记忆 ✅S49、P1-5 压缩与成本、P1-6 会话体验、P1-7 fs 写路径统一 ✅S49
- **P2 场景与生态**：Office 交付物写出、移动端 + Tauri 桌面壳、插件市场、OTel/审计导出、i18n、团队共享记忆
- **原则**：先补可信底线 → 再补能力纵深 → 最后场景生态；守住"本地优先、离线可用、中文优先、单体可读"
- **明确不做**：通用编码 IDE、自建云沙箱/训练模型、企业办公生态、为并发而并发
