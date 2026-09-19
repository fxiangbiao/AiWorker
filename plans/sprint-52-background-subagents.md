# Sprint 52 — 后台子智能体（P1-1 / 报告差距 4.3-#9）

> 依据：`plans/roadmap-next.md` P1-1；`docs/主流Agent产品对比分析报告.md` 差距 **4.3-#9**（报告标为 **P0**）、§7.3 P1 表
> 版本：1.8.0 → **1.9.0（已升版）**
> 状态：**全部任务已落地，未提交**（T0/T0.5/T1a/T1b/T2/T3/T5/T6a/T7/T8 完成；T6b 面板按"可砍"未做，进程面板已补 `subagent` 类型）。经**两轮独立 CR + 两轮验证**修复后：1117 例 / 74 文件全绿，`npm run verify` exit 0，svelte-check 0 错
> 裁定：Q1 并发 4 / Q2 回滚走 B（注册表路线）/ Q3 spawn 默认只读 / Q6 中断分层承诺（**已实现工具级真中断**）/ Q7、Q8 已纳入并落地 / **Q4 fork 拆到 S53** / **Q5 `list_agents` 仅主智能体可见**
> 前置：P1-4 权限记忆（S49 ✅）；S50/S51 产物工作台与 IA 重构（1.8.0 ✅）
> 审核记录：四轮计划审核见附录 B；**两轮代码 CR 结论**见 CHANGELOG 1.9.0「代码审查修复」节

---

## 〇、一句话目标与判据

**一句话**：把"一次协作一条链"变成"**可续接、可控制、可观测、可撤销**的后台子智能体"——主业是调研/并行分析。

判据（**五条**，缺一不算完成）：

1. **可续接**：同一子智能体可被追问多轮，上下文连续；
2. **可控制（分层）**：`interrupt` 能中断运行中的子智能体、中断后可继续追问（**必达**）；工具级真中断（`ToolContext.signal` → 杀进程树）**以 Windows 实测为准**：通过则写进承诺与 CHANGELOG，不通过则退为"轮边界中断 + 延迟上界 = min(工具剩余时间, 60s)"，并同步改反例 4 口径；
3. **可观测**：`list_agents` 能回答"谁在跑、第几轮、花了多少 token、改过哪些文件、属于哪个父会话"；
4. **不降级安全**：子智能体无确认通道（fail-closed）、禁止再生成子智能体（深度 1，**执行层硬校验**）、写路径沿用 `path-policy`、跨会话控制类工具**仅主智能体可见**（子智能体不可见，防侦察半环）；
5. **可撤销**：父 `/rewind N` 能一次回滚父 + 子全部改动，与 §2.4 B 逐字一致；父空闲 spawn 时 `/rewind` 会连带回滚父自己的改动（B 的固有代价，CHANGELOG 明示）。

---

## 一、现状诊断

### 1.1 已有基础

| 能力 | 位置 | 事实 |
|---|---|---|
| 后台执行 | `job-runner.ts` | 状态机 `queued→running→done\|failed`；`MAX_CONCURRENT=2`；每次 `submit` 新建会话（`:113`）；`cancel` 仅排队中（`:74-84`）；无 AbortSignal |
| fail-closed 通道 | `job-runner.ts:116-138` | 显式装 deny-provider，结束后恢复。**注意**：save/restore 是进程级单例（`confirm-channel.ts:15`），并发下会失效（审核 F3） |
| 可中断循环 | `base-agent.ts:187-192`、`agent-loop.ts:916-925` | `runStream` 支持 signal 并透传；但**工具执行期间 signal 不被观察**（`:455-457` 裸 `Promise.all`） |
| 可续接会话 | `session-store.ts:185/203/233` | 传入既有 sessionId → `ensureSession` + 追加消息 |
| 子会话隔离 | `session-store.ts:34/474-478` | `wk-` 前缀被 `listSessions` 过滤 |
| 工具白名单 | `agent-loop.ts:834-847` | **白名单为空 → 返回全部工具**（`:839`）；MCP/插件额外豁免（`:847`） |
| HTTP/Web/TUI | `server.ts:1863-1898`、`JobsPanel.svelte`、`SystemPanel.svelte:351`、`commands/jobs.ts` | 已有 jobs CRUD + 面板 |
| 审计与成本 | `job-runner.ts:145-165`、`base-agent.ts:232-238` | `job:done/failed` 已进审计；usage 随子会话落库，但**父子不汇总** |

### 1.2 缺口

| # | 缺口 | 现状 |
|---|---|---|
| G1 | 无子智能体概念 | `grep "subagent\|send_message\|interrupt_agent" src/` → 0 |
| G2 | 不可续接 | 每次 submit 新开会话，跑完即 done |
| G3 | 不可真中断 | cancel 仅排队中；signal 不透传到工具 |
| G4 | 智能体不能调用 | 只能用户 `/bg` 或 POST /jobs |
| G5 | 无持久目标 | 仅 team-coordinator.plan.goal |
| G6 | 上限过小 | 并发 2、MAX_STEPS=8 |
| **G7** | **执行层不校验可见性**（审核 F1） | `agent-loop.ts:775` 直接 `getHandler(toolName)`，无可见性检查；`filterVisibleTools` 只影响发给模型的数组 |
| **G8** | **默认配置零规则即可写盘**（审核 F2） | `fs_write` 普通路径恒 safe 即放行；`fs_edit` 不在 DANGER_TOOLS |
| **G9** | **`/agents/:id/config` 无写入门**（审核 F4） | `server.ts:721-778` 无跨站/token 校验，`reloadAgent` 免重启生效 |

> **本节为开工时的基线快照**（用于说明改动起点）。G1–G9 **均已闭合**：G1/G2/G4 由 `subagent-runner.ts` + 控制面 4 工具交付；G3 由 `ToolContext.signal` 贯通 + 进程树 kill 交付；G5 明确不做（P1-2 → S53）；G7 由执行层硬校验闭合；G8 由 `fs_edit` 补 `DANGER_TOOLS` + 危险检测输入改路径收敛（仍诚实标注"零规则即可写非受保护路径"，收紧需 `ask` 规则）；G9 由三路统一写面三件套闭合。

### 1.3–1.5 诊断结论

> 详见按模块并入的 T0 诊断用例（`agent-loop` / `checkpoint` / `tools` / `process-tree` / `llm-adapter` / `memory` / `trace`）+ 附录 A。关键结论：
> - D2：abort 后 `runStream` 返回不抛（`truncated:true`），但**轮边界中断**；`ToolContext` 无 signal 字段
> - D3：续接成立；既有缺陷"用户消息注入两次"已由 T0.5 修复
> - D4：B 可行（注册表路线 3 处）；`pendingTurn` 回填已由 T0.5 修复
> - D6：受限工具标记必需（两条空白名单入径已证实）
> - **审核新增**：执行层无可见性校验（F1）、零规则即可写（F2）、confirm-channel 并发失效（F3）、`/agents/:id/config` 无门（F4）

---

## 二、设计

### 2.1 运行模型

`job-runner.ts` 演进为 `src/core/subagent-runner.ts`（保留 `jobRunner` 导出兼容 `scheduler`）：

```ts
interface SubagentHandle {
  id: string;                    // sub-<ts36>-<rand4>
  agentId: string;
  sessionId: string;             // wk-<uuid>
  parentSessionId: string | null;
  status: "queued" | "running" | "idle" | "failed";
  abortRequested: boolean;       // 区分用户中断 vs 迭代用尽（审核 F3）
  rounds: number;
  pending: string[];             // 上限 MAX_PENDING=5
  summary: string;
  usage: { prompt: number; completion: number };
  lastError?: string;
  startedAt?: number; finishedAt?: number;
}
spawn(agentId, prompt, opts?: { parentSessionId?, readOnly?, mode? }): string
send(id, message): boolean       // running → 入 pending（上限拒绝）；idle → 起新轮
interrupt(id): boolean           // abort + 清 pending + idle（审核 F4）
list(parentSessionId?): SubagentHandle[]  // 按父会话过滤
```

- **`done` → `idle`**：语义变更。波及面以开工时 `grep -n '"done"' test/job-runner.test.ts` 为准（当前 9 处）+ 3 处界面分支（`JobsPanel:13/36-42`、`SystemPanel:880`、`commands/jobs.ts:92-95`）。**不再声称"旧面板不改也能显示"**——status 值变了，面板必须同步更新。`types.ts:827` OsProcess 联合需补 `idle`。
- **`abortRequested`**：per-handle 标记，用户中断 → `true` → status=`idle`；其他 truncated → status=`failed`。解决审核 F3（`truncated` 同值导致 interrupt 得到 failed）。
- **interrupt 语义**：中止当前轮 + **清空 pending** + idle（审核 F4）。不自动起新一轮。
- **模式来源**（审核 F7）：spawn 时以**父会话当前模式**为基准，`readOnly:true` 强制 ask 语义，**只允许收窄不允许放宽**。`job-runner.init` 的 `mode` 改为动态读取而非启动时钉死。
- **并发与预算**：`MAX_CONCURRENT` 可注入（默认 4）；`MAX_PENDING=5`；每父会话 spawn 配额 ≤4、全局 ≤8；超限返回错误而非排队（审核 F5）。

### 2.2 控制面：4 个工具 + 4 个端点

| 工具 | 语义 | 默认可见性 |
|---|---|---|
| `spawn_agent` | 起后台子智能体 | **否**（受限工具，仅主智能体可见） |
| `send_message` | 追加一轮 | **否**（同上） |
| `list_agents` | 列出子智能体 | **仅主智能体可见**（审核 F1：子智能体不可见，防枚举兄弟 sessionId） |
| `interrupt_agent` | 中断并保留会话 | **否**（受限工具） |

端点（写面三件套：跨站 403 → token 401 → 参数 400）：

```
GET    /api/v1/subagents                  列表（按 parentSessionId 过滤）
POST   /api/v1/subagents                  { agentId, task, readOnly?, mode? } → spawn
POST   /api/v1/subagents/:id/messages     { message } → send
DELETE /api/v1/subagents/:id              interrupt
```

TUI：`/subagents` 列表/send/stop。`/bg` 保留为 spawn 等价物，id 统一 `sub-` 前缀，`/jobs` 作为兼容视图。

**`POST /api/v1/agents/:id/config` 必须补写面三件套**（审核 F4）：与 T2/T3 同批，否则受限工具的 opt-in 通道本身可被跨站打开。

### 2.3 安全模型

1. **执行层硬校验**（审核 F1，**本轮最关键的安全修复**）：把本轮可见工具集合传进 `executeToolInner`，在 `agent-loop.ts:775` 之前加 `!visible.has(toolName)` → 拒绝 + 审计（`result:"blocked"`）。`spawn_agent` handler 内再按 `WORKER_SESSION_PREFIX` 拒绝一次（纵深防御，审核 F5）。**这使 `readOnly`、深度 1、受限工具从"劝告"变成"边界"**。
2. **无确认通道**：子智能体 confirm/ask 立即拒绝。**改进**（审核 F10）：无通道时返回带 `reason: "no-channel"` 的可判别失败，审计 detail 带该原因，用户文案区分"无通道自动拒绝"与"用户点拒绝"。
3. **权限口径对齐**（审核 F2）：§2.3 原文"必须预先授权才能写"是**错的**——现有模型下零规则即可写非受保护路径。**修正**：子智能体在 auto 模式下可写非受保护路径、执行非危险命令；要收紧需用 `ask` 规则（`{"tool":"fs_write","action":"ask"}` → 无通道 → 硬拒）。**`fs_edit` 补进 `DANGER_TOOLS`**（`:257`）。
4. **深度 1**：子智能体工具面不含 `spawn_agent`/`send_message`/`interrupt_agent`。**执行层硬校验**（不只是可见性）：handler 内按 `ctx.sessionId.startsWith(WORKER_SESSION_PREFIX)` 拒绝递归 spawn。
5. **受限工具标记**：`RegisteredTool` 加 `restricted: boolean`；`filterVisibleTools` 对受限工具要求**显式列出**（不参与空白名单全放行）。**绝不按 `mcp_` 前缀推断只读**（审核 F6）。
6. **`never_auto_approve` 诚实标注**（审核 H2）：清单内工具**不存在"始终允许"路径**（`permission-model.ts:169-171` 拒绝写入 allow 规则；`approval-service.ts:137` 含 `!never`；`:157-159` confirm 不传 remember）。headless 下 `spawn_agent` **不可用**——写进工具描述与 CHANGELOG。注：该清单当前为 `[]`（`config/permissions.json:33`），报告 §7.3 的建议非已实现状态。
7. **`readOnly` 闭集**（审核 F6/H4）：`config.tools ∩ {fs_read, fs_list, web_search, web_fetch}`。**本期无"只读 MCP"**（注册项无只读元数据、MCP 无 annotations）。长期方案：`RegisteredTool` 加显式 `readOnly: boolean`，缺省 false。T2 用例钉"写型 MCP 在 readOnly 下不可见"。
8. **工作目录共享**：不做 worktree/副本隔离。多子智能体同时写同一文件会互相覆盖——诚实标注。
9. **BaseAgent 单例问题**（审核 F6）：`bootstrap.ts:545` 按 agentId 复用实例，`setMode` 写回实例 → 同名并发 mode 互踩。**修法**：per-spawn 克隆 config 或 per-call mode 传递；正例补"4 个同名并发"。

### 2.4 回滚归属（Q2 已裁定走 B）

**B 的实现**：注册表模块存 `childSessionId → { parentSessionId, parentTurnAtSpawn }`；`handlers.ts:410/523/564` 三处改问 `owner(ctx.sessionId)`。

**B 的三个前提 + 审核新增的第四个**：

1. **父 turn 号在 spawn 时钉住**（`parentTurnAtSpawn`），不现算。
2. **父空闲 spawn 的代价**：子改动并入父下一回合，`/rewind` 该回合连带回滚父改动。写进判据 5 与 CHANGELOG。
3. **`pendingTurn` 可信性**：T0.5 已修（回填 + resetTurns 接线）。
4. **登记前验 manifest 存在**（审核 F1/D1）：`capture` 落到父 turn 时，若 manifest 不存在 → **拒绝登记**（禁隐式建盘）+ 审计 + 事件。否则 `ensureManifest` 会复活已 prune 的回合（无 `messageSeqBefore` → `/rewind` blocker → `ok:false`；且 prune 多删一个合法回合）。**T7 补 >20 回合夹具**，否则此路径永远测不到。

**T7 必须复用 T0.5 口径**：`parentTurnAtSpawn = pendingTurn(parentSessionId)`，禁读 checkpoint 目录（两口径已实测分叉：`listTurns=[1]` vs `getLastTurnSeq=0`）。

**并发写同一文件**：manifest 按 absPath 记录，以父会话最早一次的旧内容为准。T7 专门用例。

### 2.5 可观测与成本

- **`list_agents`**：按父会话过滤；回答状态/轮次/token/文件/摘要。
- **控制台「子智能体」tab**：「资源」分组，只读为主。
- **WS 事件**：`subagent/spawned|message|round-done|done|failed`；`job/done` 保持兼容。
- **审计**（审核 F9）：`audit_log` 加 `actor_session_id` 列 + 索引；`subagent:*` 带 `trigger: tool|http|cli|scheduler`；`queryBySession` 支持沿父边展开。
- **成本可见**（P1-5 提前交付）：父子归属字段 + 聚合查询先于面板。面板/TUI/WS 标为超期时可砍。

### 2.6 与 DSH/Claude Code 的差异

| 能力 | DSH / Claude Code | AiWorker 本轮（计划） |
|---|---|---|
| 后台子智能体 + 控制面 | ✅ | 待实施（T2–T6） |
| 续接与中断 | ✅ | ⚠ 轮边界中断必达；工具级待 Windows 实测 |
| 运行中插话注入点 | 步边界 | **仅轮边界** |
| 嵌套 | 3 层 | **1 层** |
| 隔离 | `isolation: worktree`（Claude Code） | **无隔离** |
| 并发 | 20 / 16 | **4** |
| fork | ✅ | 拆到 S53（Q4 裁定） |

### 2.7 并发/资源/生命周期护栏（审核 F3/F5/F8 + H5）

- **`pending` 上限**：MAX_PENDING=5，超限返回错误。
- **`jobs` Map 淘汰**：保留最近 N 条已完成（N=50）。
- **deny-provider 引用计数**（审核 F3）：`SubagentRunner` running 计数 0→1 时装、1→0 时卸；恢复前身份校验（仅当当前 provider 仍是自己装的才恢复）。补并发用例。
- **spawn 配额**：每父会话 ≤4、全局 ≤8。
- **token/轮次预算熔断**：单子智能体与每父会话总 token 上限，超限暂停。
- **`wk-` 会话清理**：`checkpointStore.deleteSession` + spills/snapshots/telemetry 按会话清理接进会话删除路径。
- **shutdown**：终止在跑子智能体 + 写审计 + 孤儿回收（遗留 running → interrupted）。
- **`failed` 可续**（审核 F11）：提供显式 `retry(id)`，或 CHANGELOG 写明偏差。

---

## 三、任务拆分

| 步 | 内容 | 交付物 | 验证 |
|---|---|---|---|
| **T0** | 诊断 D1–D6 | ✅ 已完成（16 例，见附录 A） | verify exit 0 |
| **T0.5** | 既有缺陷 ① 消息双注 ② pendingTurn 回填 | ✅ 已完成 | 消息序列无重复；重启后 turn 正确 |
| **T1a** | Runner 状态机：idle/abortRequested/pending 上限/interrupt 语义/mode 来源/per-spawn 实例 | ✅ `subagent-runner.ts`（+`job-runner.ts` 兼容层） | 续接、中断后 idle、pending 上限、同名并发 mode 不互踩 |
| **T1b** | Windows 杀进程树（探针定分支→已实现） | ✅ `ToolContext.signal` 贯通 + `taskkill /T /F`（posix 进程组） | 副作用探针：abort 后命令完成标记文件确未被写出 |
| **T2** | 工具面 4 个 + 受限标记 + **执行层硬校验** + readOnly 闭集 | ✅ `subagent-tools.ts`、`subagent-rules.ts`、`agent-loop.ts` 执行层校验、`filterVisibleTools` 规则 | 受限工具空白名单不可见；readOnly 子智能体手工注入 fs_write → 拒绝+审计；写型 MCP 不可见 |
| **T3** | 安全接线：权限口径对齐 + fs_edit 补 DANGER_TOOLS（检测输入改路径）+ 审计 actor_session_id + never_auto_approve 诚实标注 + `/agents/:id/{config,reset,delete}` 三路统一写面三件套 | ✅ `permissions.json`、`audit-log.ts`、`approval-service.ts`、`server.ts` | 子智能体写盘 → 可判别拒绝；跨站/缺 token POST agents 三路 → 403/401 |
| **T5** | 端点 4 个 + 写面三件套 + `?purge=1` | ✅ `server.ts` | 403/401/400/200（11 例） |
| **T6a** | 父子归属字段 + 聚合查询（P1-5 提前交付） | ✅ `audit-log.ts` schema（含老库迁移） | 逐子智能体与父会话 token 合计可核对 |
| **T6b** | 面板 + TUI + WS（**可砍**） | ⏭ 未做；仅补进程面板 `subagent` 类型 + WS `subagent/*` 事件 | svelte-check 0 错 |
| **T7** | 回滚 B：注册表 + 钉住 + 拒绝登记 + >20 回合夹具 + 并发同文件 | ✅ `subagent-ownership.ts` + `handlers.ts` 三处接线 + `checkpoint-store` 禁隐式建盘 | 父 `/rewind` 回滚父子全部；>20 回合后子写入被拒+审计（端到端用例） |
| **T8** | 文档/版本/AGENTS.md | ✅ 1.9.0 | verify 全绿 |

**顺序**：T0 ✅ → T0.5 ✅ → T1a ✅ → T1b ✅ → T2/T3/T5 ✅ → T6a ✅ → T7 ✅ → T6b ⏭ → T8 ✅。

**已拆出**：T4 fork → S53（Q4 裁定）；T6b 按"可砍"未做（核心承诺不依赖它）。

---

## 四、测试与反例清单

**正例**：续接两轮；readOnly 子智能体无写工具（**执行层校验**）；4 个**同名**并发各自独立 mode；list_agents 字段完整；中断后 idle 可续接。

**反例**：

1. 子智能体调 `spawn_agent` → **执行层拒绝** + 审计（深度 1 硬校验）；
2. 子智能体触发确认 → 立即拒绝 + `reason:"no-channel"` + 审计（可判别）；
3. 白名单为空 → `spawn_agent` **不可见**（受限标记）；
4. **两支断言**：① Windows 探针通过 → 子进程树不再存活；② 探针不通过 → abort 后本轮工具跑完即返回，CHANGELOG 标注；
5. 运行中 send 两条 → 按序消费（pending ≤5）；第六条 send → 返回错误；
6. 向 failed 子智能体 send → 明确拒绝（或 retry 接口）；
7. 跨站 POST /subagents → 403；缺 token → 401；agentId 不存在 → 400；
8. 父 `/rewind` 回滚父子全部改动（B 断言）；
9. **>20 回合后子写入** → 拒绝登记 + 审计（prune 时序）；
10. **2 子同写一文件** → 父 manifest 单 entry，hashBefore = 轮首，一次恢复轮首；
11. **readOnly 子智能体手工注入 fs_write tool_call** → 执行层拒绝 + 审计（F1 核心反例）；
12. **两个并发任务重叠期间** deny-provider 恒为 deny（F3 并发用例）；
13. **interrupt 后 pending 为空** + 500ms 后 rounds 不再增长（F4）。

---

## 五、验收标准

1. `npm run verify` exit 0，测试数不低于**开工时实测基线**（开工 1052 例 / 69 文件 → 收工 **1117 例 / 74 文件**）；
2. 五条判据逐条有可当场演示的证据；
3. 既有消费方无回归（`done→idle` 波及面以 grep 为准）；
4. CHANGELOG 记录诚实边界：无隔离、轮边界插话、中断延迟上界（或工具级真中断）、深度 1、无确认通道、headless 下 spawn 不可用、父空闲 spawn 连带回滚、`never_auto_approve` 无始终允许路径；
5. 提交前经用户同意。

---

## 六、裁定记录

| ID | 问题 | 裁定 |
|---|---|---|
| Q1 | 并发上限 | ✅ **4**（可配置） |
| Q2 | 回滚归属 | ✅ **B**（注册表路线，3 处） |
| Q3 | readOnly 默认 | ✅ **默认只读** |
| Q4 | fork 本轮 | ✅ **拆到 S53**（与判据 1-4 无关，减少体量） |
| Q5 | list_agents 可见范围 | ✅ **仅主智能体可见**（审核 F1：子智能体不可见，防枚举兄弟 sessionId；原建议"默认可见"被安全轮推翻） |
| Q6 | 中断层次 | ✅ **分层承诺已兑现**：轮边界中断必达 + **工具级真中断已实现**（`ToolContext.signal` 贯通，`terminal_exec` 按进程树 kill）。探针结论（2026-09-12）：`exec+signal` 对孙进程杀伤力不可靠；`taskkill /T /F` 可靠杀树 → 采纳后者 |
| Q7 | 消息双注缺陷 | ✅ **已修（T0.5）** |
| Q8 | pendingTurn 回填 | ✅ **已修（T0.5）** |

---

## 七、不做

- 不做嵌套（深度 1，执行层硬校验）；
- 不做进程池 / worker_threads；
- 不做 worktree 隔离；
- 不做动态 workflow 编排；
- 不做运行中步边界注入；
- 不做目标驱动（P1-2 → S53）；
- 不改协作 MAX_STEPS/MAX_PARALLEL；
- **不做"只读 MCP"推断**（无元数据，闭集实现）；
- **不做 `never_auto_approve` 的始终允许路径**（机制不支持，诚实标注）。

---

## 八、后续

| Sprint | 主题 | 要点 |
|---|---|---|
| S53 | 持久目标（P1-2）+ fork | 目标跨轮存活 + 自动续跑；fork 从 S52 拆入 |
| S54 | 压缩与成本（P1-5） | 阈值可调 + 剪枝 + 单价估算。**依赖 S52 的 token 聚合** |
| S55 | 会话体验（P1-6） | 搜索/分组/归档；`wk-` 按需可见；清理策略 |
| 待定 | 工具面扩展（P1-3） | LSP / 浏览器 / Notebook / 图像理解 |

---

## 附录 A：T0 诊断证据摘要

> 完整探针已按模块并入：`agent-loop`（D2/D3/T0.5①）、`checkpoint`（D4/T0.5②）、`tools`（D2-d）、`process-tree`（Q6）、`llm-adapter`（D5-a 去重并入）、`memory` + `trace`（D5-b 拆分）。
> 复现：`npx vitest run test/agent-loop.test.ts test/checkpoint.test.ts test/tools.test.ts test/process-tree.test.ts test/llm-adapter.test.ts test/memory.test.ts test/trace.test.ts`

| 项 | 结论 | 关键证据 |
|---|---|---|
| D2 | abort 后 `runStream` 返回不抛（`truncated:true`），但**轮边界中断**；`ToolContext` 无 signal 字段 | `agent-loop.ts:325/417/563`；`:455-457` 裸 `Promise.all`；`types.ts:175-183` |
| D3 | 续接成立；消息双注已由 T0.5 修复（按事件 seq 边界剔除） | `base-agent.ts:213` → `context-manager.ts:302-309` |
| D4 | B 可行（注册表 3 处）；pendingTurn 回填已修（turn_logs 为真源） | `handlers.ts:877/906`；`bootstrap.ts:243` |
| D5 | 子会话 token 已进账本，父子归属/聚合/面板全缺 | `session-store.ts:736-742` |
| D6 | 受限标记必需：两条空白名单入径 + MCP 豁免 | `agent-config-loader.ts:45`、`server.ts:340`、`agent-loop.ts:847` |
| Q6 | exec+signal 不可靠；taskkill /T /F 可靠杀树 | 探针实测（win32/Node v24） |

### T0.5 实施要点

- **缺陷①**：`appendMessage` 返回事件 seq → `historyBeforeEventSeq` 传入 → `assembleContext` 只回放 `seq < boundary`。受影响既有断言：零处。
- **缺陷②**：`setCompletedTurnsResolver` 同步注入+缓存；口径选 turn_logs（非 manifest，因异常回合也有目录会跳号）。`resetTurns` 接 `DELETE /sessions/:id`。剩余风险：`createTurnLog` 在 try/catch 内，写失败少算一号。

---

## 附录 B：四轮审核要点

> 安全轮 / 可行性轮 / 诚实性轮 / 父会话自查。以下为已采纳并改写进计划的发现。

| 来源 | 发现 | 修复位置 |
|---|---|---|
| 安全 F1 | 执行层不校验可见性 | §2.3-1 硬校验 |
| 安全 F2 | 零规则即可写；fs_edit 不在 DANGER_TOOLS | §2.3-3 |
| 安全 F3 | confirm-channel 并发失效 | §2.7 引用计数 |
| 安全 F4 | /agents/:id/config 无写入门 | §2.2 + T3 |
| 安全 F7 | mode 静默降级 | §2.1 |
| 安全 F10 | fail-closed 不可判别 | §2.3-2 |
| 可行 F1 | B 路线 prune 时序漏洞 | §2.4 前提 4 |
| 可行 F3 | truncated 同值 | §2.1 abortRequested |
| 可行 F4 | 状态机未定义组合 | §2.1 interrupt 清 pending |
| 可行 F6 | BaseAgent 单例 mode 互踩 | §2.3-9 |
| 诚实 H2 | never_auto_approve 无始终允许 | §2.3-6 |

**范围调整**：T4→S53；T1 拆 T1a/T1b；T6 拆 T6a/T6b（可砍）；T2/T3/T5 同批；Q5 改为仅主智能体可见。

**复核**：亲自确认执行层无校验、agents config 无门、审批语义、never_auto_approve、exec 无 signal、seq 同源、done 断言 9 处等。驳回 1 条（default.yaml 行号误报）。
