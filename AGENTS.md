# AGENTS.md — AiWorker

多智能体个人 AI Agent 助手：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆。TUI 终端与 Web UI 双界面。

## 常用命令
```bash
npm run dev            # tsx 直接运行 CLI（无需编译）
npm run build          # tsc → dist/
npm test               # vitest run（test/ 目录）
npx tsc --noEmit       # 仅类型检查
npx eslint src/        # ESLint 检查
npm run web:dev        # Web UI 开发 :5173（API 代理 3000）
npm run web:build      # Web UI 构建 → web/dist/
```

## 环境要求
- `DEEPSEEK_API_KEY`（默认模型，必需）；`OPENAI_API_KEY`（lite 本地模型 localhost:8000，可选）
- Node >= 22.0.0

## 关键约定（违反会直接出错）
- **ESM + `.js` 导入扩展名**：所有相对导入必须带 `.js`，即使源文件是 `.ts`。`tsx` 宽容但编译后 `dist/` 会报错：
  `import { toolRegistry } from "./core/tool-registry.js";`（`./core/tool-registry` 运行失败）
- **单例模式**：`ToolRegistry` / `HookManager` / `McpManager` / `AuditLog` / `SkillRegistry` 通过 `.getInstance()` 或导出常量访问，不要直接 `new`
- **kebab-case** 文件名；领域类型集中在 `src/types.ts`（`import type { ... }`）
- `ToolResult` = `{ success: boolean, error?: string }`；`HookResult` = `{ proceed: boolean }`
- **不添加注释**，除非绝对必要
- `coerceToolArgs`：数字字符串转换前校验合法数字（含科学计数法），排除 NaN/Infinity；`"true"/"false"` 优先于数字判断
- 设计文档：`个人AI-Agent助手设计方案.md`

## 模块速览

### 核心引擎 `src/core/`
- `agent-loop.ts` — `runAgentLoop`（同步）/ `runAgentLoopStream`（流式 + AbortSignal）。空响应 3 次断路器；token 压缩阈值 75%，保留最近 3-8 轮
- `model-router.ts` — 多 profile（`config/models.json`，支持 `${ENV}`）。**思考模式**：`thinking: true` 时 temperature 失效，经 `extra_body` 传递；流式 usage 只在循环外一次性 `+=`（防多 chunk 计数膨胀）
- `context-manager.ts` — `assembleContext()` 组装 + 压缩 + `getContextBreakdown()` 分层统计；`freezeSnapshot()` 捕获记忆快照保证前缀缓存
- `team-coordinator.ts` — DAG 编排：Kahn 环路检测 + 死锁检测；4 模板；非关键步骤失败跳过，关键失败中止
- `skill-registry.ts` / `skill-evolution.ts` — 递归加载 SKILL.md；自进化阈值 `iterations>=3 && toolCalls>=3`，Jaccard 0.5 去重，评分 >=3★ 注册，默认关闭（`skills/pending/` 存候选）
- `project-profiler.ts` — 启动扫描工作目录，注入 system prompt
- `tool-registry.ts` — 工具注册 + 运行时可用性检查

### 智能体与路由 `src/agents/`
- `BaseAgent` 子类 ×7；`router.ts` 正则路由（带权重）→ LLM 语义兜底
- 优先级：coding(90) > financial(85) > research(80) > data-analysis(70) > game-dev(65) > product-ops(60) > default(0)
- TS 硬编码 + YAML 覆盖（`config/agents/*.yaml`）；`modelPreference` 白名单校验，无效降级 `default`
- `run()`/`runStream()` 的 `onTaskComplete` 传入 `data.messages`；完成后 `result.messages` 清空防内存膨胀

### 工具与 MCP
- `src/tools/builtin.ts` — 6 内置工具。`fs_read`/`fs_list` 基准 `workingDir`；`fs_write` 基准 `projectDir` + 路径遍历防护（`path.relative` 检查）
- `src/mcp/mcp-manager.ts` — stdio/HTTP 双传输，`config/mcp.json` 配置，工具命名 `mcp_{server}_{tool}`，连接失败优雅降级
- `builtin-server.ts` — 内置 4 工具：math_eval（沙箱 `new Function()` + Math 白名单）/ uuid_gen / json_format / timestamp_convert
- **重连**：统一 `scheduleReconnect` 防风暴；指数退避 `min(1000*2^n, 30000)` 最多 5 次；Windows `spawn` 需 `shell: true`

### 记忆与上下文
- `src/memory/session-store.ts` — SQLite（WAL）+ FTS5；`turn_logs`/`tool_call_logs` 表，snake_case → camelCase 显式映射
- 三层记忆：工作（消息历史）/ 情景（FTS5 + `Intl.Segmenter` 分词 + 每天 15% 时间衰减）/ 语义（MEMORY.md ≈2200 字 + USER.md ≈1375 字，段落安全截断 + 互斥锁防 lost-update）
- **FTS5 MATCH 查询前清洗特殊字符**（`*` `AND` `OR` 等）防注入
- token 估算统一 `Math.ceil(chars / 3.5)`

### Hook 与安全
- `src/hooks/hook-manager.ts` — 5 事件：onMessage / onToolCallPre / onToolCallPost / onTaskComplete / onError；`config/hooks.json` 注册 14 handlers，支持 `enabled: false`
- `permissionCheck` 仅 onToolCallPre 生效；`turnLogger` onMessage 记基线 + onTaskComplete 结算增量 + onError 清理防泄漏
- 权限三模式：ask（只读工具，写/高危被 permissionCheck 拦截产生红色告警）/ plan（每步确认）/ auto（自动，高危仍确认）；`danger-detector.ts` 正则拦截高危操作（含单文件删除 rm/del/Remove-Item）
- 确认通道 `confirm-channel.ts`：统一确认接口——CLI 走 stdin，HTTP 走 SSE `confirm_request` 挂起 + POST `/api/v1/confirm` 响应（30s 超时自动拒绝）；`runWithConfirm(write, fn)` 统一 chat/plan/debate
- `dangerousCommandBlock` 按模式分流：ask 直接拦截，plan/auto 放行给 confirmHighRisk 弹确认卡片
- ask 模式 agent-loop 传全部工具定义（模型可尝试调用），非只读工具由 `permissionCheck`（`allowsToolFor`）拦截
- 拦截失败时 server 发 `tool_blocked` SSE 事件，前端显示红色告警横幅（errors 数组，切会话清空）
- Windows 下 terminal_exec 前缀 `chcp 65001` 强制 UTF-8 防 cmd 中文乱码

### 终端 TUI `src/terminal/`
- **帧缓冲引擎**：`screen.ts`（差分渲染 + CJK 宽 + SGR reset 防泄漏）/ `term.ts`（raw-mode 键解析，10ms 超时防 Esc 歧义，parseKeys 纯函数可测）/ `components.ts`（MessageList/InputLine/StatusBar）/ `tui.ts`（组合三组件 + 16ms 节流 + 接管 stdout）
- `renderer.ts` 薄封装保留兼容导出；`markdown.ts` 行级渲染 + 表格块对齐 + OSC 8 超链接；`highlight.ts` 自研 tokenizer 零依赖
- `--server` 模式跳过 TUI；CJK 用 `displayWidth()`/`padToWidth()` 对齐

### HTTP Server 与 Web UI
- `src/server.ts` — **所有 API 统一 `/api/v1` 前缀**（`API_PREFIX` 常量 + `apiUrl()` 辅助）；静态资源托管仅排除 `/api`，新增端点用 `apiUrl("/xxx")` 注册即自动生效
- 端点：GET `/api/v1/agents` `/status` `/tools` `/sessions`(+/:id) `/context` `/logs` `/skills` `/diffs`；POST `/api/v1/chat` `/plan` `/debate` `/confirm` SSE 流式；托管 `web/dist/`
- `/plan` SSE 事件序列：plan → step_start → step_end → done；`/debate`：debate_start → done；两者均经 `deps.coordinator`（ServerDeps 依赖注入）
- `pickDebateAgents` 在 `src/core/team-coordinator.ts` 导出，CLI 与 HTTP 共用
- `/chat` 接受 `sessionId`：Web UI 用 chat id 作为 sessionId 持久化到 SQLite
- `web/` — Svelte 5 + Vite 6，独立 package.json；API 常量在 `chat.svelte.ts` 导出 `API = "/api/v1"`（fetch 统一走该常量）；vite proxy 为 `/api → :3000`
- `ChatPanel.handleSSE()` 直接 mutate `store.messages` 触发重渲染；`DOMPurify` 消毒 `marked.parse()` 输出防 XSS；`store.inputMode` 控制输入模式（chat/plan/debate），协作/辩论复用 `handleCollabSSE` 渲染步骤/工具/阶段提示
- `SystemPanel.svelte`（context/logs/skills 管理面板，顶部导航弹窗）、`PlanStepsBlock.svelte`（/plan 步骤状态机）、`ConfirmCard.svelte`（确认卡片）、`FileDiffPanel.svelte`（/diffs 左右分栏）
- `/chat` 透传 `task.mode`（权限模式），BaseAgent.runStream 消费；`permissionCheck` 读请求级 `ctx.data.permissions`（Ask 拦截）；`captureDiff` 写磁盘快照（`data/snapshots/`，首行 `# path:` 记录原始路径）+ 审计，`/diffs` 读取展示
- `runWithConfirm(write, fn)`：chat/plan/debate 三端点统一包装，hook 内 `requestConfirm` 走 SSE 挂起等待前端确认卡片
- `/skills` 返回 `{name, version, description, expert, triggers, body, raw}`（raw 为完整 SKILL.md 原文）

## 测试
- `test/` + `helpers.ts`：`makeTestDir(name)` 创建独立 `data-test/<name>/`（防并行 worker 冲突），`setupEnv` 注册内置工具 + 审计
- `server.test.ts`：HTTP 端点覆盖（mock coordinator/agent + listen(0) 随机端口 + fetch，避免真实 LLM）
- vitest 配置在 `vitest.config.ts`（include `test/**/*.test.ts`）

## CLI 交互命令
```
/mode <ask|plan|auto>  切换权限模式
/plan <任务>             多专家 DAG 协作
/debate <话题>           双专家辩论
/skill <名称>            手动激活技能
/skills                  查看全部技能（分组+描述）
/new                     新会话
/thinking                切换思考展示
/log                     监控日志（轮次/耗时/token）
/context [查询]          上下文分层 token 占比 + MCP 工具列表
/status                  运行状态
/config                  模型/温度/max-tokens（持久化 data/runtime-config.json）
/skill-evo               技能沉淀开关
/sessions                浏览会话
/switch <序号>           切换
/copy                    复制最后回答 Markdown
/help                    帮助
/exit                    退出
```
CLI 参数：`--dir <工作目录>` `--data-dir` `--project-dir`（输出隔离）`--mode` `--show-thinking` `--server` `--port`
