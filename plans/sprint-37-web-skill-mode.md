# Sprint 37 — Web 对话技能模式（0.9.1）

> 状态：**✅ 开发完成（548 测试全绿，待提交）**
> 需求：WEB UI 对话输入支持技能模式——通过 `/技能名` 触发技能，并支持检索技能
> 现状：CLI 支持 `/skill <名称>` 与 `/技能名` 直接激活；Web 仅靠 context-manager 按触发词正则被动注入，无法显式激活，也无技能检索入口
> 前置：Sprint 36（0.9.0）已提交（b3ac878）

## 一、目标

1. **技能模式**：Web 输入 `/code-review 修复xx` 等价 CLI `/code-review`——技能正文注入本轮上下文，会话历史只存原始输入
2. **技能检索**：输入框输入 `/` 弹出技能选择器（按名称/描述/专家实时过滤，点击/Tab 插入）；系统设置「技能」Tab 增加搜索框
3. **可视化**：激活技能时助手消息顶部显示技能徽标；未知 `/xxx` 明确提示可用技能（不再被智能体当普通文本乱答）

## 二、设计（审核后修正版）

### 1. 技能正文注入方式（**修正**：不改写 instruction）

初版方案「把技能正文拼进 task.instruction」经审核发现 3 个问题：
- 会话历史会存下技能正文（server.ts 与 base-agent 各 append 一次用户消息，改写后两者内容不同）
- 触发词匹配会二次注入（正文进了用户消息，context-manager 又按触发词注入一次）
- 刷新会话后（清 localStorage 缓存）用户会看到带技能正文的重复消息

**修正：技能正文走系统提示注入**，指令保持原始输入：
- `src/types.ts`：`Task` 增加 `explicitSkill?: { name: string; body: string }`
- `src/core/agent-loop.ts`：`AgentLoopDeps` 透传 `explicitSkill` → `assembleContext`
- `src/core/context-manager.ts`：`assembleContext` 增加可选参数，技能段拼入 `fullSystemPrompt`（`-- 用户显式激活技能：<name> -- ... -- 技能结束 --`，仅当轮，随消息数组丢弃，无持久化、无共享状态竞态）
- `src/agents/base-agent.ts`：run / runStream 透传 `task.explicitSkill`

### 2. 后端 `/api/v1/chat` 技能模式解析（src/server.ts）

- 新增 `resolveSkillInstruction(message, skills)`：匹配 `^/([a-zA-Z0-9][\w-]*)(?:\s+|$)`；兼容 `/skill <名称>` 形式；返回 `{skill} | "not_found" | null`
- **命中** → 不建会话即可执行：SSE 先发 `{type:"skill_activated", name, description}`，task 带 `explicitSkill`
- **未命中** → SSE 发 `{type:"skill_not_found", name, available:[...]}` 并结束（不建会话、不跑智能体、不落库）
- 非 `/` 开头 → 原样走 chat（不受影响）
- 技能来源 `deps.getSkills?.()`（server.ts 不直接依赖 skillRegistry，保持可测）

### 3. **修复预存缺陷：/chat 用户消息双写（审核发现）**

- 现状：server.ts `/chat` 先 `appendMessage(user, chatReq.message)`，base-agent `runStream` 又 append 一次 → 服务端会话每条用户消息存 2 份（`turnCount` 翻倍；清 localStorage 缓存后刷新可见重复）
- 修正：删除 server.ts 侧 append（保留 `ensureSession` + `session/update` 广播），持久化唯一入口收敛到 base-agent；会话标题仍取原始指令（首条用户消息自动生成），不受影响

### 4. 前端输入框技能选择器（web/src/components/InputArea.svelte）

- 挂载时 `GET /api/v1/skills` 拉取技能列表（name/description/expert/triggers）
- 仅 chat 模式：输入以 `/` 开头弹出下拉，按 token 过滤（名称/描述/专家/触发词），空 token 显示全部
- 点击 / Tab 插入 `/名称 ` 并保持焦点；↑↓ 移动高亮；Esc 关闭；Enter 仍直接发送（后端校验兜底）
- 配置条新增「技能」按钮（一键唤起选择器）；无匹配显示「无匹配技能」

### 5. 前端 SSE 事件（web/src/components/ChatPanel.svelte + chat.svelte.ts）

- `UIMessage` 增加 `_skills?: { name; description? }[]`
- `skill_activated` → 写入最后一条助手消息 `_skills`
- `skill_not_found` → 移除刚推入的空助手消息 + 错误横幅（含可用技能列表）

### 6. 助手消息技能徽标（web/src/components/AgentCard.svelte）

- `msg._skills` 非空时渲染 `⚡ 技能名` 徽标行（title 显示描述）

### 7. 系统设置技能检索（web/src/components/SystemPanel.svelte）

- 技能 Tab 增加搜索框（名称/描述/专家/触发词过滤），按分组展示过滤结果

### 8. 测试

- `test/server.test.ts`：
  - `/chat /技能名 激活`：`skill_activated` 事件 + `capturedTask.explicitSkill` 正确 + `instruction` 保持原始
  - `/chat 未知技能`：`skill_not_found` 事件 + 无 text/done + runStream 未被调用
  - `/chat /skill <名称>` 形式
  - `/chat 非斜杠消息` 不受影响
  - **双写回归**：真实 SessionStore + 模拟 base-agent 持久化的 stub，断言用户消息只落 1 条
- 验证链：`npm run build && npm run lint && npm test && npm run web:build`

## 三、版本

0.9.1：`package.json` → `CHANGELOG.md` → README 徽章（提交时同步）

## 四、影响范围

| 层 | 文件 | 改动 |
|----|------|------|
| 后端 | src/server.ts | /chat 技能解析 + 移除双写 |
| 后端 | src/types.ts | Task.explicitSkill（可选） |
| 后端 | src/core/agent-loop.ts | deps 透传 |
| 后端 | src/core/context-manager.ts | assembleContext 参数 + 注入 |
| 后端 | src/agents/base-agent.ts | run/runStream 透传 |
| 前端 | web/src/lib/stores/chat.svelte.ts | UIMessage._skills |
| 前端 | web/src/components/ChatPanel.svelte | SSE 事件 |
| 前端 | web/src/components/InputArea.svelte | 技能选择器 |
| 前端 | web/src/components/AgentCard.svelte | 技能徽标 |
| 前端 | web/src/components/SystemPanel.svelte | 技能搜索框 |
| 测试 | test/server.test.ts | +5 用例 |
| 文档 | CHANGELOG.md / README.md | 0.9.1 |

**不涉及**：CLI（已支持）、技能文件本身、session-store、event-bus、/plan /debate 端点、应用工坊

## 五、风险

- 消息以 `/` 开头但非技能（如 `/help`）→ 「未找到技能」提示而非交给智能体（与 CLI 行为一致，可接受）
- 前端技能列表与后端短暂不一致（热加载后）：以后端校验为准，选择器仅作便捷入口
- 移除双写后：清缓存刷新历史不再出现重复用户消息（行为修正，turnCount 恢复正常）
