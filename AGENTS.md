# AGENTS.md — AiWorker

多智能体个人 AI Agent 助手（AI OS）：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆 + 应用即时生成。TUI 终端 + Web UI 双界面。

## 命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 直接运行 CLI（tsx，无需编译） |
| `npm run build` / `npm run start` | tsc → dist/；生产运行（需先 build） |
| `npm test` / `npm run lint` | vitest（test/）/ ESLint |
| `npm run web:dev` / `npm run web:build` | Web 开发 :5173（API 代理 3000，ws）/ 构建 → web/dist/ |

环境：Node >= 22；`DEEPSEEK_API_KEY` 必需，`OPENAI_API_KEY` 可选。

## 开发工作流

1. 改动后跑 `npm run build && npm run lint && npm test && npm run web:build`，全绿再提交
2. 升版本：`package.json` → `CHANGELOG.md` → README 徽章
3. 改 README/docs 里的 Mermaid 图后，用 `mmdc -i <file>.mmd -o out.png -b white -w 900` 本地渲染确认（子图 `direction` 在有跨组连线时会被忽略，只看源码判断不了；`-w 900` 模拟 GitHub 内容区宽度）
4. 提交：中文信息（**全角标点**），分支 `dev`，push 全部已配置远端，结束时工作树干净

## 关键约束（违反会直接出错）

- **ESM**：相对导入必须带 `.js` 扩展名（tsx 宽容，dist/ 报错）
- **单例**：ToolRegistry / HookManager / McpManager / SkillRegistry / pluginManager / jobRunner / subagentRunner / scheduler / packageInstaller 经 `.getInstance()` 或导出常量访问，不要 `new`
- **kebab-case** 文件名；领域类型集中 `src/types.ts`（`import type`）
- **不添加注释**，除非绝对必要
- `ToolResult` = `{ success, content, error? }`；`HookResult` = `{ proceed, modifiedData?, message? }`
- 智能体配置**唯一来源** `config/agents/<id>.yaml`（内置 TS 默认 + YAML 覆盖，无运行时覆盖层）
- **Svelte 5**：改 `store.messages` 元素必须经 store 取代理引用回写（直接改局部对象不触发更新，见 apps.svelte.ts spawnGenCard）
- 沙箱 iframe origin 为 `"null"`：宿主回发 postMessage 的 **targetOrigin 必须 `"*"`**（web/src/lib/app-bridge.ts）
- cron-parser v5 为 **6 字段**（5 字段自动补秒前缀）；`endStep()` 必须先于 `iterations++`

## 架构速览

- **后端** `src/`：核心 `core/`（agent-loop / model-router / context-manager / app-factory 应用即时生成 / tool-registry / event-bus）；唯一正式架构文档 `docs/AiWorker架构.md`，逐期演进见 `plans/sprint-history.md`，活计划在 `plans/`（roadmap-next + 当前 sprint）
- **智能体** `src/agents/`：7 内置专家（TS 默认 + YAML 覆盖）+ 自定义（GenericAgent）；`reloadAgent(id)` 热重载免重启；工具白名单 `filterVisibleTools`（mcp 前缀匹配 + strictTools 关豁免；受限工具需显式列出**或**由 `subagents: true` 开关放行；`readOnly` 走闭集）
- **子智能体** `src/core/subagent-runner.ts`（Sprint 52）：`queued→running→idle|failed`，可续接/中断/观测；控制面 4 工具（`spawn_agent`/`send_message`/`list_agents`/`interrupt_agent`，受限工具+深度 1 双层校验，由智能体 `subagents: true` 开关放行）；`subagent-rules.ts` 放常量（**无依赖模块**，避免 runner↔tools 循环导入）；`subagent-ownership.ts` 记归属供父 `/rewind` 连带回滚；执行层硬校验见 `agent-loop.ts` 的 `executeToolInner`（可见集合不匹配即拒绝）；**确认通道用 `hooks/channel-scope.ts` 异步作用域隔离**（子智能体侧 fail-closed，绝不替换全局 provider，否则会顶掉父会话通道）；**工具可见 ≠ 模型会调**——触发条件写在 `spawn_agent` 描述与 `research`/`default` 的 systemPrompt 里，属概率性引导
- **后台执行只有一套**（1.9.1 起）：`/bg`、`POST /jobs`、`/jobs`、scheduler 全部落到 `subagentRunner`，`job-runner.ts` 是**兼容视图**（状态映射 `idle↔done`，超配额抛错而非排队）；触发子智能体的四条路 = 工具 `spawn_agent` / TUI `/bg` / `POST /api/v1/subagents` / 定时任务
- **工具** `src/tools/` + `src/mcp/`：9 内置（fs_read / fs_write / fs_edit / fs_list / terminal_exec / terminal_session / web_search / web_fetch / ask_user）；MCP 工具 `mcp_{server}_{tool}`；插件 `setup(ctx)` fail-soft；.aw 资产包（zip+manifest）；`ToolContext.signal` 供工具响应中断（`terminal_exec` 按进程树杀：win32 `taskkill /T /F`、posix 进程组）
- **记忆** `src/memory/`：SQLite(WAL)+FTS5；事件溯源 `session_events` 仅追加；三层记忆（工作/情景/语义）
- **安全** `src/security/` + `hooks/`：ask/plan/auto 权限矩阵（**无确认通道 fail-closed**）；沙箱策略 `config/sandbox.json`；应用能力强制层（**无 terminal**）
- **Web** `web/`：Svelte 5 + Vite；API 前缀 `/api/v1`；WS 总线 `/api/v1/ws`（chat SSE + eventBus 双写）；store 在 `lib/stores/`
- **TUI** `src/terminal/`：自研帧缓冲（screen.ts 差分渲染 + CJK 宽；markdown.ts 的 OSC8 超链接 wrap 须保持转义序列完整）

## 测试

- `makeTestDir(name)` 独立 `data-test/`；读真实 config 注入 fixture；config/agents 读写用 `saveAgentConfig(id, cfg, dir)` 临时目录；端点测试 mock deps + `listen(0)` + fetch；WS 测试用 `ws` 客户端（Node 22 全局 WebSocket 无 `.on`）
- **需要链接权限的用例必须走 `helpers.ts` 的能力探测**：`makeDirLink`（Windows 用 junction）/ `makeFileLink` / `makeDanglingLink` + `DIR_LINK_SUPPORTED` / `FILE_LINK_SUPPORTED` / `DANGLING_LINK_SUPPORTED`，配 `it.skipIf`；**不要**直接 `symlinkSync(..., "file")`——无开发者模式的 Windows 会 EPERM，用例会硬失败而不是跳过。`AIW_NO_LINKS=1`（无任何链接能力）/ `AIW_NO_FILE_LINKS=1`（仅文件符号链接失败，即无开发者模式的 Windows）可复现受限环境

## CLI

```
/mode /plan /debate         权限模式 / DAG 协作 / 辩论
/app /bg /subagents /jobs /schedule   应用生命周期+生成 / 后台子智能体 / 子智能体列表·追问·中断·关闭 / 后台任务兼容视图 / 定时（自然语言 cron）
/install /pkg               安装 .aw 或裸格式 / 打包导出
/permissions                权限规则：列出（含来源）/ 写项目级 / 撤销 / 清空
/skill(s) /setup /new /sessions /trace /config /export /rewind /help /exit
```

CLI 参数：`--dir`（默认 ./ai_default_project）`--data-dir` `--mode` `--show-thinking` `--server` `--port`
