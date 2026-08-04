# Sprint 17: Web UI Svelte + Vite 重构

> 目标：将 web/index.html 单文件（402 行）迁移为 Svelte 5 + Vite 组件化架构，分离模板/样式/逻辑，为后续功能扩展打基础

## 文件变更

| 类型 | 路径 | 说明 |
|------|------|------|
| **新建** | `web/package.json` | Svelte + Vite 依赖 |
| **新建** | `web/vite.config.ts` | Vite SPA 配置 |
| **新建** | `web/tsconfig.json` | TypeScript 配置 |
| **新建** | `web/index.html` | Vite 入口 HTML（替换旧文件） |
| **新建** | `web/.gitignore` | 忽略 node_modules/, dist/ |
| **新建** | `web/src/main.ts` | Svelte 挂载入口 |
| **新建** | `web/src/App.svelte` | 根组件（三栏布局） |
| **新建** | `web/src/app.css` | 全局 CSS 变量 + 基础样式 |
| **新建** | `web/src/lib/stores/chat.ts` | 聊天状态（mode, agentId, chats, messages） |
| **新建** | `web/src/lib/stores/stream.ts` | 流式状态（sending, abort, SSE 连接） |
| **新建** | `web/src/lib/stores/diffs.ts` | 文件变更状态 |
| **新建** | `web/src/lib/stores/status.ts` | 服务器状态（model, tokens, dirs, skills） |
| **新建** | `web/src/lib/utils/markdown.ts` | marked + highlight.js 配置 |
| **新建** | `web/src/lib/utils/format.ts` | fmtN, basename, esc 工具函数 |
| **新建** | `web/src/components/TopBar.svelte` | 顶栏（Logo + ModeTabs + AgentSelect） |
| **新建** | `web/src/components/ModeTabs.svelte` | Ask/Plan/Craft 模式选项卡 |
| **新建** | `web/src/components/AgentSelect.svelte` | Agent 下拉选择 |
| **新建** | `web/src/components/Sidebar.svelte` | 侧栏（新对话 + 会话列表） |
| **新建** | `web/src/components/ChatPanel.svelte` | 主面板（消息列表 + 输入区） |
| **新建** | `web/src/components/MessageList.svelte` | 消息列表容器 |
| **新建** | `web/src/components/UserMessage.svelte` | 用户消息气泡 |
| **新建** | `web/src/components/AgentCard.svelte` | Agent 卡片（思考 + 工具 + 回答） |
| **新建** | `web/src/components/ThinkBlock.svelte` | 可折叠思考块 |
| **新建** | `web/src/components/ToolCard.svelte` | 单个工具调用卡片 |
| **新建** | `web/src/components/ToolsGroup.svelte` | 工具调用组（2+ 工具折叠） |
| **新建** | `web/src/components/AnswerBlock.svelte` | 回答块（Markdown 渲染 + 复制） |
| **新建** | `web/src/components/InputArea.svelte` | 输入区（textarea + 发送按钮） |
| **新建** | `web/src/components/DiffPanel.svelte` | 右侧文件变更面板 |
| **新建** | `web/src/components/StatusBar.svelte` | 底部状态栏 |
| **新建** | `web/src/components/ErrorBanner.svelte` | 错误横幅 |
| **修改** | `src/server.ts` | webDir 指向 web/dist/ |
| **删除** | `web/index.html` | 替换为 web/ 下 Svelte 构建产物 |

## 任务拆分

### T1: 项目脚手架（P0）

创建 `web/package.json`、`vite.config.ts`、`tsconfig.json`、`web/.gitignore`、`web/index.html`、`web/src/main.ts`。

```json
// package.json dependencies
{
  "svelte": "^5",
  "@sveltejs/vite-plugin-svelte": "^5",
  "vite": "^6",
  "marked": "^15",
  "highlight.js": "^11"
}
```

Vite 配置要点：
- `@sveltejs/vite-plugin-svelte` 插件
- `base: "./"` 确保资源路径相对（兼容 Node HTTP server 静态 serve）
- `server.proxy`：开发模式将 `/chat`、`/agents`、`/status`、`/sessions` 转发到 `http://localhost:3000`

```ts
// vite.config.ts 核心片段
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
      "/agents": "http://localhost:3000",
      "/status": "http://localhost:3000",
      "/sessions": "http://localhost:3000",
    },
  },
});
```

根目录 `package.json` 新增便捷脚本：
```json
"scripts": {
  "web:dev": "cd web && npx vite --port 5173",
  "web:build": "cd web && npx vite build"
}
```

### T2: 工具模块（P0）

| 文件 | 导出 |
|------|------|
| `lib/utils/format.ts` | `fmtN`, `basename`, `esc` |
| `lib/utils/markdown.ts` | `renderMarkdown(text): string`（集成 marked + hljs + target=_blank） |

### T3: Svelte Stores（P0）

| Store | 类型 | 内容 |
|------|------|------|
| `chat.ts` | writable | `mode`, `agentId`, `chats`, `activeChatId`, `messages` |
| `stream.ts` | writable | `sending`, `abortController` |
| `diffs.ts` | writable | `diffs[]` |
| `status.ts` | writable | `model`, `totalTokens`, `workingDir`, `projectDir`, `skills`, `online` |

### T4: 静态组件（P1，可并行）

无 SSE 依赖，纯展示 + 用户交互：

- `TopBar.svelte` + `ModeTabs.svelte` + `AgentSelect.svelte`
- `Sidebar.svelte`（会话列表 + 新对话按钮）
- `StatusBar.svelte`
- `DiffPanel.svelte`
- `InputArea.svelte`

### T5: 消息组件（P1，依赖 T4）

- `UserMessage.svelte`
- `ThinkBlock.svelte`（可折叠，Svelte 的 `#if` 替代 DOM class toggle）
- `ToolCard.svelte`（pending spinner / success / error 三态）
- `ToolsGroup.svelte`（`{#each}` + 折叠计数）
- `AnswerBlock.svelte`（Markdown 渲染 + 复制按钮）
- `ErrorBanner.svelte`
- `AgentCard.svelte`（组装 ThinkBlock + ToolCard + AnswerBlock）
- `ChatPanel.svelte`（MessageList 容器 + InputArea + EmptyState）

### T6: SSE 流式集成（P0）

- `stream.ts` store 中实现 `sendMessage(text)` 函数
- 通过 `fetch()` + `ReadableStream` 解析 SSE
- 每个事件类型直接 mutate Svelte store → 组件自动重渲染
- `text` 事件：直接 `+=` 到 `messages` 最后一项的 content，Svelte `$effect` 触发重新 renderMarkdown
- `done` 事件：刷新 status store，完成
- `error` 事件：追加 ErrorBanner

### T7: 集成 + 清理（P1）

- 修改 `src/server.ts`：`webDir` 从 `resolve(__dirname, "..", "web")` 改为 `resolve(__dirname, "..", "web", "dist")`
- 开发模式：`cd web && npx vite dev`（Vite HMR，代理 API 到 Node server）
- 生产构建：`cd web && npx vite build` → `web/dist/` → Node server 直接 serve
- 删除旧 `web/index.html`

## 依赖关系图

```
T1 (脚手架)
 ├── T2 (工具模块)
 │    └── T3 (stores) ── T6 (SSE 集成)
 ├── T4 (静态组件) ──────────┘      │
 │    └── T5 (消息组件) ────────────┘
 └── T7 (集成清理)
```

T2→T3→T6 是关键路径，T4→T5 也是关键路径，两条路径可并行。

## 验证标准

- `cd web && npm run build` 零错误
- `cd web && npx vite build` 输出到 `web/dist/`
- `npm start -- --server --port 3000` HTTP server 正常启动，访问 Web UI 功能不变
- 所有 SSE 事件类型正常工作（thinking/text/tool_call/tool_result/done/error/diff）
- 会话切换、新建会话、模式切换、Agent 选择正常
- 复制回答、复制代码正常
- `npx tsc --noEmit` 零错误（仅 src/ 目录，web/ 项目独立）
- `npx eslint src/` 零错误零警告
- `npm test` 92 项测试全绿

## 降级方案

- 若 Svelte 5 rune 兼容性有问题 → 降级使用 Svelte 4 store 语法
- 若 Vite 构建与 Node HTTP server 路径冲突 → 保留 `web/index.html` fallback，server.ts 优先检测 `web/dist/` 存在则 serve，否则 serve 旧文件

## 执行记录

| 日期 | 任务 | 说明 |
|------|------|------|
| 2026-08-03 | T1-T3 | 脚手架 + 工具模块 + Svelte $state stores |
| 2026-08-03 | T4-T5 | 15 个 Svelte 组件（TopBar→AgentCard→AnswerBlock） |
| 2026-08-03 | T6 | SSE 流式集成（$state rune 替代 writable store 引用 bug） |
| 2026-08-04 | T7 | server.ts webDir→dist + 静态资源 serve + logos |
| 2026-08-04 | 修复 | 滚动条隐藏 + thinking_start 响应 + DOMPurify XSS + diffText 解析 |
| 2026-08-04 | 主题 | 蓝紫科技风（基于 logo 色系） |
| 2026-08-04 | Code Review | 18 个问题修复（P0×3, P1×4, P2×8） |
| 2026-08-04 | 验证 | tsc/eslint 零错误，vitest 92/92，vite build 通过 |
