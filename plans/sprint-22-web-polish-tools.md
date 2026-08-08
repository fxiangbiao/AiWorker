# Sprint 22 — Web 打磨 + 工具能力增强

## 1. 目标摘要

补齐 Web 端会话管理与工具调用的关键体验缺口：支持会话删除/重命名/导出，工具调用失败可手动重试，为 MCP 工具提供可视化配置面板。目标：让 Web UI 的日常使用闭环完整，减少对 CLI 的依赖。

## 2. 任务拆分

| 优先级 | 任务 | 预估改动 |
|--------|------|----------|
| P0 | 会话管理：删除 + 重命名 + 导出 Markdown | server 端点 + store + Sidebar UI |
| P1 | 重试：当前提问重新生成 + 失败工具单点重试 | AgentCard/InputArea + 复用 /chat |
| P1 | MCP 工具配置面板（系统弹窗内） | server /mcp 端点 + SystemPanel UI |
| P2 | 多轮对话内 diff 自动刷新频率优化 | FileDiffPanel 节流 |

## 3. 文件变更清单

**新建**：
- `src/server.ts` 端点扩展（会话删除/重命名/导出，均在现有 server.ts 内实现，不新建文件）
- `web/src/components/` 无新组件（复用 Sidebar/SystemPanel）

**修改**：
- `src/memory/session-store.ts` — 新增 `deleteSession(id)`、`renameSession(id, title)`、`getSessionMessages(id)`
- `src/server.ts` — 新增 `DELETE /api/v1/sessions/:id`、`POST /api/v1/sessions/:id/rename`、`GET /api/v1/sessions/:id/export`
- `web/src/lib/stores/chat.svelte.ts` — 新增 `deleteChat`、`renameChat`、`exportChat`、`retryCurrent` 方法
- `web/src/components/Sidebar.svelte` — 每项 hover 显示操作菜单（删除/重命名/导出）
- `web/src/components/InputArea.svelte` — 回答完成后显示「重新生成」按钮（重发当前提问）
- `web/src/components/AgentCard.svelte` + `ToolCard.svelte` — 失败工具调用显示「重试」按钮
- `web/src/components/SystemPanel.svelte` — 新增 MCP 配置 Tab
- `web/src/components/FileDiffPanel.svelte` — 节流刷新

## 4. 依赖关系图

```
会话管理 (P0) ──→ Sidebar 操作菜单
                    ├─→ store.deleteChat/renameChat/exportChat
                    └─→ server 新端点 → session-store 新方法

重试能力 (P1) ──→ InputArea「重新生成」按钮（重发当前提问，走 /chat）
                 └─→ AgentCard/ToolCard 失败工具「重试」按钮（携带工具上下文续问）

MCP 面板 (P1) ──→ server /mcp 端点（读 config/mcp.json）
                    └─→ SystemPanel MCP Tab
```

## 5. 验证标准

- 会话删除：DELETE 后 /sessions 不再返回该 id，前端列表移除，SQLite 中 sessions/messages 级联删除
- 会话重命名：POST rename 后 title 更新，刷新后保持
- 会话导出：GET export 返回 Markdown（含用户/助手消息 + 工具调用摘要），可下载
- 提问重新生成：回答完成后「重新生成」按钮重发当前 user 消息，新回复替换旧回复
- 工具重试：失败工具卡片出现「重试」按钮，点击重新发起同一工具调用的上下文继续
- MCP 面板：展示 config/mcp.json 中服务器的名称/传输方式/启用状态/工具数
- 回归：176 测试保持全绿 + 新增端点测试；tsc + eslint + web build 通过

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 会话删除误删 | 前端二次确认弹窗；DELETE 前校验 sessionId 存在 |
| 提问/工具重试上下文复杂 | 重发走 /chat 端点：提问重试重发同一 user 消息；工具重试仅对单个失败工具续问，不做全链路重放 |
| 会话级联删除 SQLite 外键 | 显式 DELETE messages + sessions 两表（按 session_id） |
| MCP 面板实时状态 | 复用 McpManager.getStatus() 已有接口，无状态轮询开销 |
