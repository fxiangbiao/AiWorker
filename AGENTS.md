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
4. 提交：中文信息（**全角标点**），分支 `dev`，push `origin` + `gitee` 两个远端，结束时工作树干净

## 关键约束（违反会直接出错）

- **ESM**：相对导入必须带 `.js` 扩展名（tsx 宽容，dist/ 报错）
- **单例**：ToolRegistry / HookManager / McpManager / SkillRegistry / pluginManager / jobRunner / scheduler / packageInstaller 经 `.getInstance()` 或导出常量访问，不要 `new`
- **kebab-case** 文件名；领域类型集中 `src/types.ts`（`import type`）
- **不添加注释**，除非绝对必要
- `ToolResult` = `{ success, content, error? }`；`HookResult` = `{ proceed, modifiedData?, message? }`
- 智能体配置**唯一来源** `config/agents/<id>.yaml`（内置 TS 默认 + YAML 覆盖，无运行时覆盖层）
- **Svelte 5**：改 `store.messages` 元素必须经 store 取代理引用回写（直接改局部对象不触发更新，见 apps.svelte.ts spawnGenCard）
- 沙箱 iframe origin 为 `"null"`：宿主回发 postMessage 的 **targetOrigin 必须 `"*"`**（web/src/lib/app-bridge.ts）
- cron-parser v5 为 **6 字段**（5 字段自动补秒前缀）；`endStep()` 必须先于 `iterations++`

## 架构速览

- **后端** `src/`：核心 `core/`（agent-loop / model-router / context-manager / app-factory 应用即时生成 / tool-registry / event-bus）；设计文档见 `docs/`（个人AI-Agent助手设计方案.md、AIOS-架构升级方案.md），sprint 计划在 `plans/`
- **智能体** `src/agents/`：7 内置专家（TS 默认 + YAML 覆盖）+ 自定义（GenericAgent）；`reloadAgent(id)` 热重载免重启；工具白名单 `filterVisibleTools`（mcp 前缀匹配 + strictTools 关豁免）
- **工具** `src/tools/` + `src/mcp/`：9 内置（fs 四件套 / terminal_exec / web / ask_user）；MCP 工具 `mcp_{server}_{tool}`；插件 `setup(ctx)` fail-soft；.aw 资产包（zip+manifest）
- **记忆** `src/memory/`：SQLite(WAL)+FTS5；事件溯源 `session_events` 仅追加；三层记忆（工作/情景/语义）
- **安全** `src/security/` + `hooks/`：ask/plan/auto 权限矩阵（**无确认通道 fail-closed**）；沙箱策略 `config/sandbox.json`；应用能力强制层（**无 terminal**）
- **Web** `web/`：Svelte 5 + Vite；API 前缀 `/api/v1`；WS 总线 `/api/v1/ws`（chat SSE + eventBus 双写）；store 在 `lib/stores/`
- **TUI** `src/terminal/`：自研帧缓冲（screen.ts 差分渲染 + CJK 宽；markdown.ts 的 OSC8 超链接 wrap 须保持转义序列完整）

## 测试

- `makeTestDir(name)` 独立 `data-test/`；读真实 config 注入 fixture；config/agents 读写用 `saveAgentConfig(id, cfg, dir)` 临时目录；端点测试 mock deps + `listen(0)` + fetch；WS 测试用 `ws` 客户端（Node 22 全局 WebSocket 无 `.on`）

## CLI

```
/mode /plan /debate         权限模式 / DAG 协作 / 辩论
/app /bg /jobs /schedule    应用生命周期+生成 / 后台任务 / 定时（自然语言 cron）
/install /pkg               安装 .aw 或裸格式 / 打包导出
/skill(s) /setup /new /sessions /trace /config /export /help /exit
```

CLI 参数：`--dir`（默认 ./ai_default_project）`--data-dir` `--mode` `--show-thinking` `--server` `--port`
