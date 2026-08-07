# Sprint 20 — HTTP API + Web UI 对齐 CLI + Server 测试覆盖

## 目标摘要

补齐 CLI 与 HTTP/Web 界面能力差：HTTP API 新增 `/plan` `/debate` 协作端点、会话持久化与管理端点；Web UI 会话接入 SQLite、新增管理面板；为 server.ts 补齐测试覆盖。

## 任务拆分

| # | 任务 | 优先级 | 预估改动文件 |
|---|------|--------|-------------|
| T1 | server.ts 增加 `/plan` `/debate` 协作端点（SSE 流式） | P0 | server.ts, index.ts, types.ts |
| T2 | server.test.ts 测试覆盖（现有端点 + 新端点） | P0 | test/server.test.ts(新建), test/helpers.ts |
| T3 | Web UI 会话接入 SQLite `/sessions` | P1 | chat.svelte.ts, server.ts |
| T4 | Web UI 管理面板（context/log/skills）+ 对应 GET 端点 | P1 | server.ts, SystemPanel.svelte(新建), TopBar/Sidebar |
| T5 | Web UI `/plan` `/debate` 流式交互面板 | P2 | ChatPanel.svelte, server.ts |

## 文件变更清单

**新建**
- `test/server.test.ts` — HTTP 端点测试（listen(0) 随机端口 + fetch）
- `web/src/components/SystemPanel.svelte` — 管理面板

**修改**
- `src/server.ts` — ServerDeps 增加 coordinator；POST /plan、/debate、GET /context、/logs、/skills；会话持久化支持
- `src/index.ts` — 传入 coordinator 到 startServer；pickDebateAgents 提取为共享函数
- `src/types.ts` — ChatRequest 增加 sessionId；SSE 事件类型扩展（plan/step）
- `web/src/lib/stores/chat.svelte.ts` — 会话与 SQLite 同步
- `web/src/components/ChatPanel.svelte` — plan/debate 事件渲染

## 依赖关系图

```
T1 (server /plan /debate 端点)
 ├─→ T2 (server.test.ts，依赖端点就绪)
 └─→ T5 (Web UI plan/debate 面板)
T3 (会话持久化 SQLite) ── 独立
T4 (管理面板 + GET 端点) ── 独立
```

T1/T3/T4 可并行，T2 依赖 T1，T5 依赖 T1。

## 验证标准

- **T1**: `tsc --noEmit` 通过；`curl -N POST /plan` 收到 SSE 事件序列（plan → step_start → step_end → done）
- **T2**: `npm test` 全绿，server.test.ts 覆盖：/status /agents /tools /sessions /chat(400/413) /plan /debate /404
- **T3**: Web UI 刷新后会话从 SQLite 恢复；`/sessions` 列表与 UI 同步
- **T4**: GET /context /logs /skills 返回有效 JSON；Web 面板正确渲染
- **T5**: Web 端发起 /plan 任务可见步骤进度流

## 风险与对策

- **pickDebateAgents 迁移**：从 index.ts 提取到 team-coordinator 或独立 util，保持 CLI 行为不变（回归测试验证）
- **SSE 事件兼容**：新增 plan/step 事件类型，前端按 `data.type` 分派，旧事件不受影响
- **会话 ID 冲突**：HTTP 会话用 `http-` 前缀与 CLI 区分，避免混淆
- **fetch 可用性**：Node 22 原生支持 fetch，vitest 环境无需额外 polyfill

---

## 执行记录 (2026-08-07)

### T1 — server.ts 协作端点 ✅
- `ServerDeps` 增加 `coordinator` / `getContextBreakdown` / `getSystemPrompt` 依赖
- 新增 `POST /plan`（SSE: plan → step_start → step_end → done）与 `POST /debate`（SSE: debate_start → done）
- `pickDebateAgents` 从 index.ts 提取到 team-coordinator.ts 导出（CLI/API 共用）
- `/chat` 支持 `sessionId` 持久化（ensureSession + appendMessage user/assistant）

### T2 — server.test.ts ✅
- 新建 `test/server.test.ts`（19 项）：/status /agents /tools /skills /sessions /chat(SSE/400/413/未知agent) /plan /debate /context /logs /404 /OPTIONS
- mock coordinator/agent 避免 LLM 依赖；listen(0) 随机端口 + fetch

### T3 — Web UI 会话接入 SQLite ✅
- chat.svelte.ts 新增 `syncServerSessions()`（合并 /sessions）+ `loadRemoteMessages()`（按需加载）
- `/chat` 请求携带 `sessionId`（chat id）；启动时同步服务器会话

### T4 — Web UI 管理面板 ✅
- 新增 `GET /context`（分层 token）/ `GET /logs`（最近 50 轮次）/ `GET /skills`
- 新建 `SystemPanel.svelte`（上下文/日志/技能三标签页），替换右侧面板技能区块

### T5 — Web UI plan/debate 面板 ✅
- ChatPanel 识别 `/plan `/`/debate ` 前缀分发到对应端点
- 新建 `PlanStepsBlock.svelte`（步骤状态机：pending/running/done/failed）；AgentCard 集成
- UIMessage 扩展 `_kind` / `_steps` / `_meta`

### 阶段 4 验证 ✅
- 154 项测试全绿（135 → 154，新增 19 项 server 测试）
- `tsc --noEmit` / `eslint src/ --max-warnings 0` / `web build` 零错误

### Code Review ✅
- P0/P1: 无
- P2×2 已修复：PlanRequest/DebateRequest 死字段 sessionId 删除；ChatPanel step_end timeline 空值加固

### 二次修复与重构 ✅
- **静态托管排除 bug**：新 GET 端点（/skills /context /logs）不在静态文件排除列表 → 被当成静态资源返回 404/HTML，管理面板空白。补回归测试
- **API 统一前缀**：全部 API 改为 `/api/v1` 前缀（`API_PREFIX` 常量 + `apiUrl()` 辅助），静态托管只需排除 `/api`，不再逐个添加；vite proxy 简化为 `/api → :3000`
- **SystemPanel 日志字段修复**：`toolCalls`/`failed` → 正确的 `toolCallsTotal`/`toolCallsFailed`
- **技能分组展示**：`/skills` 返回 `{name, description, expert}`；Web UI 按 expert 分组（与 TUI 一致）+ 2 行截断描述 + title 悬停
- **侧边栏宽度**：左侧 220→300px，右侧 240→400px
- Code Review 二轮：删除 fmtMs 死代码
- 验证：157 项测试全绿（新增 22 项 server 测试），tsc/eslint/build 零错误

### 第三次迭代（Web UI 交互与权限修正） ✅
- **权限模式透传**：`/chat` 的 `chatReq.mode` 原被丢弃 → 修复 `task.mode` 透传（BaseAgent.runStream 消费），Web UI 左上角 Ask/Plan/Craft 生效。补回归测试
- **协作入口**：按用户要求，Web UI 输入区上方新增「对话 / 智能体协作 / 双专家辩论」三模式按钮；选协作/辩论后 placeholder 提示、发送走 `/plan` `/debate`（兼容 `/plan xxx` `/debate xxx` 指令）
- **模式保持**：修复发送后选中态立即重置回「对话」的交互缺陷
- **文件变更功能移除**：右侧「文件变更」面板（DiffPanel）因链路复杂且未达预期，按用户要求移除。captureDiff 保留磁盘快照 + 审计 + CLI 输出，供将来重设计（单独 File Diff 区域可视化）
- **协作过程展示**：`/plan` `/debate` 原本无过程反馈（工具卡片被丢弃、阶段无提示），现：tool_call/tool_result 流式渲染工具卡片；live 标签显示「规划中/执行步骤 · research/辩论中 · financial · 第一轮分析」；debate 的 `phase` 阶段描述透传
- 验证：227 项测试全绿（含 starship 测试），tsc/eslint/build 零错误
