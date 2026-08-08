# Sprint 21 — Web 权限模式与确认通道 + 文件 Diff 重设计

## 目标摘要

修复 Web 端权限模式失效（Ask/Plan 不拦截），craft→auto 重命名；新增对话区确认卡片（替代弹框/stdin 确认）；重设计文件 Diff 面板（右侧栏入口 + 树形列表 + 高亮变更行）。

## 任务拆分

| # | 任务 | 优先级 | 预估改动文件 |
|---|------|--------|-------------|
| T1 | craft→auto 重命名 + PermissionMode 更新 | P0 | types.ts, index.ts, 5 agents, builtin.ts, handlers.ts, danger-detector.ts, team-coordinator.ts, terminal(components/renderer), web(store/ModeTabs), config/*.yaml, permissions.json, 4 测试文件 |
| T2 | permissionCheck 读请求级 mode（Ask 拦截） | P0 | handlers.ts, agent-loop.ts(确认 ctx), index.ts |
| T3 | 确认通道：SSE confirm_request/response + 对话区确认卡片 | P1 | server.ts, handlers.ts, types.ts, ChatPanel.svelte, ConfirmCard.svelte(新建) |
| T4 | 文件 Diff 重设计：GET /api/v1/diffs + 右侧栏 Diff 面板 | P1 | server.ts, index.ts, FileDiffPanel.svelte(新建), Sidebar/App.svelte |
| T5 | 测试更新 + 全量验证 | P0 | 各测试文件 + server.test.ts |

## 文件变更清单

**新建**
- `web/src/components/ConfirmCard.svelte` — 对话区确认卡片（问题 + 选项按钮）
- `web/src/components/FileDiffPanel.svelte` — Diff 面板（树形列表 + 高亮变更行）

**修改（核心）**
- `src/types.ts` — PermissionMode: `"ask" | "plan" | "auto"`；HookContext 增 confirm 相关
- `src/hooks/handlers.ts` — permissionCheck 读请求级 mode；interactiveConfirm 改为回调通道
- `src/server.ts` — SSE confirm_request/confirm_response 事件；GET /api/v1/diffs
- `web/src/components/ChatPanel.svelte` — 确认卡片渲染 + confirm_response 发送
- `web/src/lib/stores/chat.svelte.ts` — 确认队列 + mode 默认 auto

**修改（rename 波及）**
- `src/index.ts` / `src/agents/*.ts` / `src/tools/builtin.ts` / `src/security/danger-detector.ts` / `src/core/team-coordinator.ts` / `src/terminal/*` / `config/*.yaml` / `config/permissions.json` / 测试文件

## 依赖关系图

```
T1 (rename，阻塞 T2/T3/T5 中所有 craft 引用)
 └─→ T2 (permissionCheck 读请求级 mode)
      └─→ T3 (确认通道，依赖权限拦截生效)
T4 (文件 Diff，独立)
T5 (测试，依赖 T1-T4 完成)
```

## 验证标准

- **T1**: `tsc --noEmit` 通过，全库无 `craft` 残留；`/mode auto` 生效
- **T2**: Web 选 Ask 后工具调用被拦截（SSE 返回 blocked 提示）
- **T3**: Plan/高危操作时对话区出现确认卡片，点「允许/拒绝」后继续/中断
- **T4**: 右侧栏 Diff 入口默认折叠；展开显示树形文件列表 + 选中文件高亮变更行
- **T5**: 全量测试绿 + tsc/eslint/build 零错误

## 风险与对策

- **rename 波及广**：37 处 craft 引用，用全局替换 + tsc 验证；config YAML 的 defaultMode 同步改
- **确认通道挂起风险**：SSE 挂起等待响应需超时（如 30s 自动拒绝）+ AbortSignal 处理
- **权限判断兼容**：danger-detector 与 confirmHighRisk 的 `permissions !== "craft"` 需改 `"auto"`
- **Diff 数据源**：snapshots 目录可能为空或会话路径含特殊字符，端点需容错

---

## 执行记录 (2026-08-08)

### T1 — craft→auto 重命名 ✅
- `PermissionMode`: `"ask" | "plan" | "craft"` → `"ask" | "plan" | "auto"`
- 37 处引用全量替换（types/agents/builtin/danger-detector/team-coordinator/terminal/config yaml/permissions.json/测试）
- 前端 ModeTabs 显示 Ask/Plan/Auto；状态栏 label auto→"自动"
- `config/agents/*.yaml` defaultMode craft→auto

### T2 — 权限模式请求级生效 ✅
- `permissionCheck` 改为读 `ctx.data.permissions`（请求级 mode）而非全局 `permissionModel.allowsToolCalls()`
- 新增 `PermissionModel.allowsToolCallsFor(mode)`
- Web 选 Ask → 工具调用被拦截（SSE 提示）

### T3 — 确认通道（对话区确认卡片）✅
- 新建 `src/hooks/confirm-channel.ts`：统一确认接口，CLI 走 stdin、HTTP 走 SSE 挂起
- `createHttpConfirmProvider` + `confirmResponse`：SSE 发 `confirm_request`，前端 POST `/api/v1/confirm` 响应，confirmId 精确路由，30s 超时
- `confirmHighRisk`：Plan 模式所有工具需确认；Auto 模式仅高危确认
- 前端 `ConfirmCard.svelte`：对话区确认卡片（问题 + 允许/拒绝按钮），done/error 清理
- 删除旧 `interactiveConfirm`（stdin 专用）

### T4 — 文件 Diff 重设计 ✅
- 新建 `GET /api/v1/diffs`：扫描 `data/snapshots/`，解析 diff 为结构化行（add/del/ctx），按会话分组
- 新建 `FileDiffPanel.svelte`：左右分栏（文件列表 + 高亮变更行），列表 1:4 默认 + 拖拽调整

### UI 优化 ✅
- 右侧栏：系统/文件变更 Tab → 系统改顶部导航弹窗（50vw × 75vh，内容滚动）
- 右侧栏拖拽调整宽度（默认 40% = 3:2），方向修正
- 左右侧边栏隐藏/展开（按钮在侧边栏区域，TopBar 显示展开入口）
- 对话区加宽（88%→96%，max-width 1400px）

### 阶段 4 验证 ✅
- 162 项测试全绿（新增 confirm-channel、/diffs、/confirm 测试）
- tsc/eslint/build/web build 零错误

### Code Review ✅
- P0/P1: 无
- P2×2 已修复：done/error 后确认卡片残留清理；并发 /chat 时 confirm provider 全局覆盖（确认 id 精确路由缓解，记录为已知限制）

### 二次迭代（UI 优化 + 修复） ✅
- **系统弹窗**：Tab 栏固定（仅内容区滚动）；技能改分组 + 小卡片（名称/版本/描述），点击进详情展示完整 SKILL.md 原文（SkillDef 新增 `raw` 字段）
- **文件 Diff 路径修正**：captureDiff 写快照首行 `# path: <原始路径>`，/diffs 优先读取（旧快照 fallback decodeDiffPath）
- **文件变更 Tab 居左**：flex:none，为扩展新 Tab 预留
- **确认通道 P1 修复**：/plan /debate 原未设置 confirm provider（协作中高危确认走错误通道）→ 提取 `runWithConfirm()` helper，chat/plan/debate 统一使用
- Code Review 二轮：1 P1（confirm provider）+ 3 P2（技能详情残留、scanDiffs 格式、技能完整内容）

### 三次迭代（权限/拦截/乱码修复） ✅
- **ask 只读工具**：ask 模式 `allow_tool_calls: true` + `readOnly: true`，仅放行只读工具（fs_list/fs_read/web_search 等），拦截写工具
- **ask 工具定义传递**：agent-loop 的 `tools` 在 ask 模式从 `undefined` 改为传只读工具定义（模型能真正结构化调用，而非输出 Markdown 文本模拟）
- **agent 工具调用提示**：7 个 agent 的 systemPrompt 统一补充「工具调用规则」（必须用 tool_calls 结构化调用，禁止 Markdown 代码块模拟）
- **拦截提示**：server 端拦截失败时发 `tool_blocked` SSE 事件，前端显示醒目错误横幅
- **高危命令拦截增强**：DANGEROUS_PATTERNS 补充单文件删除（`rm <file>` / `del <file>` / `Remove-Item <file>`，含引号路径），auto 模式删除操作需确认
- **cmd 乱码修复**：Windows 下命令前缀 `chcp 65001` 强制 UTF-8 + `encoding: "buffer"`
- 验证：169 项测试全绿（新增 4 项 danger 拦截 + 3 项权限 + 2 项 confirm 测试）

### 四次迭代（高危确认 + 拦截告警 + 交互完善） ✅
- **高危操作确认放行**：`dangerousCommandBlock` 按模式分流——ask 直接拦截（只警告），plan/auto 放行给 `confirmHighRisk` 弹确认卡片（允许/拒绝）；builtin terminal_exec 工具层拦截改为仅 ask
- **Ask 红色告警**：ask 模式改为传全部工具定义给模型（非只读工具由 permissionCheck 拦截），产生 `tool_blocked` 红色告警而非静默文本
- **拦截告警会话隔离**：tool_blocked 写 errors 数组（切会话清空），不污染消息流；新增 server 测试验证 tool_blocked 事件
- **思考转圈修复**：done/error 事件复位 `_thinkingActive`（拒绝高危后停止转圈）
- **停止按钮**：发送中显示红色停止按钮，abort 中断当前请求（SSE close）
- 验证：171 项测试全绿
