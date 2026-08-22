# Sprint 30 — 定时调度 + 后台任务 + 首次运行引导

> 状态：**✅ 已实施**（2026-08-22，版本 0.5.0）
> 用户选择：1+3 合并批次 = 定时调度/后台任务（实用性）+ 首次运行引导（体验）

---

## 背景

- 无定时调度（对比报告点名 dsh-schedule 差距）；长任务阻塞 TUI 交互（prefillQueue 串行排队）
- WebSocket 实时总线（0.3.0）已就绪 → 后台任务完成可天然推送
- 无首次运行引导：DEEPSEEK_API_KEY 缺失只在横幅提示；无 .env 加载机制（key 只能走环境变量）
- `approval-service` 已实现"无确认通道默认拒绝（fail-closed）" → 后台任务不注册确认通道即可安全执行

## 功能 1：后台任务 + 定时调度

### 1a. JobRunner（`src/core/job-runner.ts`）
- `jobRunner.submit({ agentId, prompt, mode? }): string`（jobId；`job-<时间戳36>`）
- 状态机：`queued → running → done | failed`；字段：id / agentId / prompt / status / summary / error / startedAt / finishedAt / sessionId
- **并发上限 2**（`MAX_CONCURRENT`），超出排队（队列 FIFO）
- 执行：`agent.runStream(task, workingDir, minimalCallbacks)`——callbacks 仅收集 `onTextDelta` → summary（**不写 TUI**，避免与主循环抢渲染）；ask_user/confirm 不注册 provider → fail-closed
- 完成：结果写入独立会话（createSession + appendMessage）+ 审计（`action: job:done|failed`）+ `eventBus.broadcast({ type: "job/done", ... })`（Web WS 实时推送）
- 运行中状态在内存；会话历史可查（重启后运行中任务丢失，已注明）
- 单例 `jobRunner`（与 pluginManager 等一致）

### 1b. Scheduler（`src/core/scheduler.ts`）
- 依赖：`cron-parser`（npm registry 可达）
- `config/schedule.json`：`{ "jobs": [{ "id", "cron": "0 8 * * *", "prompt", "agentId"? }] }`（BOM 容错，缺失回退空）
- 每次启动注册所有任务；`setTimeout` 计算下次触发（cron-parser `nextDate()`）；到点 → `jobRunner.submit`
- 触发记录审计（`action: schedule:fire`）；任务执行失败 fail-soft（不影响其他任务）
- 单例 `scheduler`

### 1c. CLI 命令（新 `src/commands/jobs.ts`）
- `/bg <任务>`：提交后台任务（当前路由专家），立即返回 jobId
- `/jobs`：列出全部后台任务（id/状态/摘要/耗时）；`/jobs cancel <id>`：取消 queued 任务
- `/schedule`：列出定时任务；`/schedule add "<cron>" "<任务>" [agentId]`；`/schedule remove <id>`（写回 config/schedule.json）

### 1d. HTTP + Web
- `GET /api/v1/jobs`（列表）、`POST /api/v1/jobs`（提交 `{agentId, prompt}`）、`DELETE /api/v1/jobs/:id`
- `GET /api/v1/schedule`、`POST /api/v1/schedule`、`DELETE /api/v1/schedule/:id`
- Web SystemPanel 加 **Schedule Tab**（任务列表 + 新增/删除 + 后台任务状态）；WS `job/done` 事件驱动刷新

## 功能 3：首次运行引导

### 3a. .env 加载（`src/core/env-loader.ts`）
- 极简解析（零依赖，~20 行）：`KEY=VALUE` / 注释 `#` / 引号剥除；**不覆盖已有 process.env**
- `index.ts` 最顶部调用（任何配置读取前）
- 单测：解析/注释/引号/不覆盖

### 3b. 引导流程（`src/core/onboarding.ts`）
- 触发条件：TUI 模式 && `!process.env.DEEPSEEK_API_KEY` && `!exists(data/onboarding.json)`
- 三步交互（走 TUI prompt）：
  1. 输入 DEEPSEEK_API_KEY → 写入 `.env`（不存在则创建）
  2. 选择权限模式（ask/plan/auto）→ 写 `config/permissions.json` 的 `default_mode`
  3. 显示工作目录/数据目录（确认）
- 完成写 `data/onboarding.json`（`{ completedAt }`），之后不再触发
- `/setup` 命令随时重进引导（改写 .env / permissions）
- `--server` 模式跳过引导（横幅提示即可）；引导中可跳过（直接继续，之后仍可 /setup）

## 测试

- `job-runner.test.ts`：submit/状态机/并发上限排队/结果写会话/审计
- `scheduler.test.ts`：cron 解析下次触发/注册移除/到点 submit/fail-soft
- `env-loader.test.ts`：解析/注释/引号/不覆盖已有变量
- `onboarding.test.ts`：触发条件/写 .env/写 permissions/标记完成（mock prompt 输入）
- `cli-commands.test.ts`：/bg /jobs /schedule /setup 命令
- `server.test.ts`：/jobs /schedule 端点（含 WS job/done 广播）

## 文档

- README：特性区（后台任务/定时调度/首次引导）+ CLI 命令表（/bg /jobs /schedule /setup）+ 定时任务配置说明
- AGENTS.md：模块速览（job-runner/scheduler/env-loader/onboarding）+ 命令列表
- CHANGELOG：版本 **0.5.0** 段

## 实施顺序

3a（env-loader，前置）→ 3b（onboarding）→ 1a（JobRunner）→ 1b（Scheduler）→ 1c（CLI 命令）→ 1d（HTTP + Web Schedule Tab）→ 测试 → 文档 + 版本 → 全量验证 → 推送双远程

## 风险与对策

| 风险 | 对策 |
|---|---|
| 后台任务并发写 SQLite | better-sqlite3 同步单线程，不同 session 写入安全；JobRunner 串行化提交 |
| 后台任务与 TUI 渲染竞争 | 后台不写 TUI 消息区，仅横幅提示 + WS 推送 |
| ask/confirm 全局 provider 被后台任务覆盖 | 后台任务不注册 provider（fail-closed 自动拒高危） |
| cron 表达式错误 | cron-parser 解析失败 → 该任务跳过并记审计，不影响其他 |
| .env 权限/编码 | 引导写入 UTF-8；BOM 容错；不覆盖已有变量 |
