# Sprint 41 — 进化引擎第三期：测试 + 推广（0.12.0）

> 状态：✅ **开发完成（694 测试全绿，待用户验收，未提交）**
> 需求：设计文档 4.6「Test 测试 / Promote-Rollback」——黄金用例评测 + A/B 对比 + 表现下滑阈值回滚
> 现状：第二期（0.11.0）已打通 观察→提议→两段式确认→写入生效→快照回滚→变更对比，但写入前后**无量化验证**——tool-fix/prompt-fix 改完是否真的更好，靠人肉判断
> 前置：0.11.0（f8d8fce）

## 一、目标

1. **黄金用例库**（`data/evolution/cases/`）：成功会话轨迹沉淀为评测用例（自动提取）+ 手工补录（CLI/API），去重、可查可删
2. **量化评测（A/B）**：tool-fix/prompt-fix 在用例集上对比「旧文本 vs 新文本」→ 成功率 + 通过/回归裁决（`/evo eval`）
3. **推广后验证 + 阈值回滚**：applied 提案跑 `verify`（完整 A/B）→ 表现下滑超阈值 → **自动回滚上一快照**（审计 + 广播全记录）
4. 全链路可 mock 单测（评测裁判注入，不真调 LLM）；护栏：每次评测用例数上限、无快照不自动回滚

## 二、设计

### 1. 黄金用例（src/core/evolution-cases.ts，新增）

```
data/evolution/cases/<caseId>.json
{ id, input, expected?, source: "manual" | "session", sessionId?, createdAt }
```

- **自动提取** `extractCases(deps, now)`：复用观察器同形 deps（`listSessions(500)` + `getEvents` + 7 天窗口）
  - **按 turn 提取**：取窗口内每条 `turn/end reason=stop` 的 turn → 该 turn 内最后一条 `user/message` 文本为 input（复用 `messageText`，兼容 content 为 string/parts 数组）、该 turn 最后一条 `assistant/message` 文本为 expected（截断 ≤200 字符）；多轮会话产出多个用例
  - **去重**：`normalizeTaskText` 完全一致跳过（记 skipped 计数）；**不做前缀聚类**（那是观察层「重复任务检测」的语义，与用例去重无关）
- **手工补录** `addCase({input, expected?})`：CLI `/evo case add <任务> [期望]` + API POST；期望参数为**剩余参数 join**（对齐现有 CLI 多词参数惯例）
- `listCases(limit)` / `deleteCase(id)` / `getCase(id)`；**CasesStore 接口**（仿 ProposalStore 模式：engine 内部默认实现 + 测试注入 mock），存储目录注入（测试用临时目录）
- 触发：`/evo case extract` + API `POST /evolution/cases/extract`（手动，确定性；自动每日沉淀留后续）

### 2. 评测器（src/core/evolution-eval.ts，新增）

```ts
interface EvalCaseResult { caseId: string; beforeOk: boolean; afterOk: boolean; reason?: string }
interface EvalReport {
  total: number; skipped: number; passed: number;
  baselinePassRate: number; candidatePassRate: number; deltaRate: number;
  beforeLatencyMs?: number; afterLatencyMs?: number;   // 仅报告，不参与裁决（裁判调用耗时，非工具执行耗时）
  verdict: "pass" | "regress" | "unknown";
  results: EvalCaseResult[];
}
```

- `runEval({ before, after, cases, scoreCase })`：纯函数式编排；每用例对 before/after 各调一次裁判
  - 裁判签名 **`scoreCase(task, text, expected?) → { ok, reason?, latencyMs? }`**（修正：expected 不是摆设——生产实现把它作为「达成目标」参考带进判断 prompt；测试 mock 忽略）
  - **total = 成功计分用例数（排除 skipped）**（修正）
  - **before=undefined（无基线）时该用例只调 after 一次**（修正：裁判调用次数 = 有基线 用例×2 + 无基线 用例×1）
- **裁判注入**（index.ts 闭包，engine 不碰 LLM）：生产实现 = 模型路由一次调用「该任务（+期望）下此描述/提示词是否足以让智能体正确完成」→ ok/原因；测试注入固定 mock
- **裁判异常降级**：单用例 `scoreCase` 抛错/返回 error → 该用例记 skipped（不计入分母），不拖垮整次评测；报告注明 skipped 数
- **before 提取（修正：复用现成逻辑 + 按 status 选源）**：
  - **选源规则按 status 而非快照文件存在性**（修正：apply 失败会残留快照文件，但 status 仍 confirmed——此时应取实时定义）：`status=applied` → 快照 `extractBefore(snap, action)`（evolution-diff.ts **现成函数**，不另写提取逻辑）；否则 → 实时定义
  - **实时定义**（pending/confirmed，新 deps 注入）：tool-fix → `getToolDescription(toolName)`；prompt-fix → `getAgentSystemPrompt(agentId)`；两者皆无 → before=undefined → 无基线（仅绝对线）
  - **实时定义语义 = 当前生效状态**（三审确认）：多提案串改同一目标时（A applied、B pending），B 的 before 取当前（已含 A 改动）——对比基线就是「当前生效 vs 本提案新值」，语义正确
- **适用范围**：tool-fix / prompt-fix；其他类型（new-skill/config-change/new-tool/new-app）→ `{ verdict:"not-evaluable", reason }`（config 无文本可比、new-skill 已 apply 时解析校验、new-tool/new-app 生成期已过 AppFactory 静态校验）
- **护栏**：`MAX_EVAL_CASES = 5`（预算内试运行，超限取最近 5 条）
- **报告持久化**（修正）：results 明细**不落盘**（仅当次响应返回；刷新重跑即得）；ledger 只追加摘要 `{ event:"eval", verdict, total, passRates }`

### 3. 阈值裁决 + 自动回滚（src/core/evolution-engine.ts 扩展）

```
regress 判定（成功率驱动；耗时仅报告不裁决——裁判调用耗时≠工具执行耗时）：
  A. baselinePassRate > 0 且 candidatePassRate < baselinePassRate - 0.2   （严格小于，恰等于 -0.2 不算——「超阈值」语义）
  C. 绝对线：total ≥ 2 且 candidatePassRate < 0.5
其余（含 unknown）→ 不触发回滚
```

- `POST /evolution/proposals/:id/eval`：仅评测返回报告，**不动作**（pending/confirmed/applied 可调；rolled_back/rejected → 错误「请重新提议」）
- `POST /evolution/proposals/:id/verify`：仅 `applied` 可调 → **完整 A/B（同 eval 逻辑，不另写评测代码）** → verdict=regress 且快照存在 → 自动回滚；pass/unknown → 记 `verified` 不动作（不重复记 rolled_back 事件——doRollback 内部已记）
- **自动回滚单路径 `doRollback(id, source)`**（修正：rollback() 与 verify() 共用内部实现，不双份 restore 逻辑）——restore 快照 + 状态 rolled_back + 审计/广播按 source 区分：manual → `evolution:rollback` / `evolution/rolled_back`（现状不变）；auto → `evolution:auto_rolled_back` / `evolution/auto_rolled_back`（detail 含报告摘要）；幂等由状态机守卫（rolled_back 终态，并发 verify 第二次自然拒绝）
- 自动回滚护栏（与用户确认原则的平衡点）：**回滚是撤销已生效变更、恢复上一快照，不是新变更**；仅限有快照的 4 类（tool-fix/prompt-fix/config-change/new-skill）；必须真的跑出 ≥1 条候选分；全程审计 + WS 广播可追溯；用户可随时重新 apply

### 4. API（src/server.ts）

```
GET    /api/v1/evolution/cases?limit=50          → { cases: [...] }
POST   /api/v1/evolution/cases                   → { ok, case }        （手工补录）
POST   /api/v1/evolution/cases/extract           → { ok, added, skipped }
DELETE /api/v1/evolution/cases/:id               → { ok }
POST   /api/v1/evolution/proposals/:id/eval      → { ok, report? }
POST   /api/v1/evolution/proposals/:id/verify    → { ok, report?, rolledBack?, detail? }
```

- ServerDeps/engine deps 注入（index.ts 闭包）：`scoreCase`、`CasesStore`（list/add/delete/extract）、`getToolDescription`、`getAgentSystemPrompt`；verify 自动回滚走 `doRollback(id,"auto")` 单路径
- **路由插入点（三审确认，server.ts 现有结构零改造）**：`/evolution/cases` 三例加在 proposals/:id 块之前（extract 精确匹配在 POST /cases 之前）；`/eval` `/verify` 在 proposals/:id 块内各加一行（POST-only，沿用 405 模式）
- POST-only 端点非 POST → 405（沿用现有模式）

### 5. CLI `/evo`（src/commands/evolution.ts）

- `case add <任务> [期望]`（期望=剩余参数 join）/ `case list` / `case delete <id>` / `case extract`
- `eval <id>`：打印 A/B 报告（旧 vs 新成功率条、verdict 徽标、skipped/无基线标注 + 每用例明细）
- `verify <id>`：打印报告 + 是否自动回滚

### 6. Web「进化」Tab（EvolutionPanel.svelte）

- 提案卡片新增「**评测**」按钮（pending/confirmed/applied）→ 展开 A/B 结果：旧/新成功率对比条 + verdict 徽标（✅通过 / 🔻回归 / ⚠️未知 / ⛔不可评测）+ 无基线/skipped 标注；报告仅当次展示（重跑即刷新）
- applied 卡片「**推广验证**」按钮 → 结果区展示：回归自动回滚提示（已回滚 + 原因）或通过记录
- 台账时间线补 eval / verified / auto_rolled_back 事件；WS 监听 `evolution/auto_rolled_back` 刷新
- 新增「黄金用例」折叠卡：列表 + 手工补录输入框 + 提取按钮 + 删除

### 7. 排除（范围控制）

- **不做**：隔离子进程沙箱试运行评分（new-tool/new-app 真跑用例）——生成期已有 AppFactory 静态校验 + ≤2 轮自查修复，试运行评分留用户试用
- **不做**：配置变更临时实例试跑（成本高、收益低）；独立 token 预算配额（设计 v0.5 项，留后续）；自动每日用例沉淀（手动触发保确定性）；eval 结果反向驱动自动 re-propose（闭环留第四期）

## 三、测试

- `evolution-cases`：按 turn 提取（多轮会话多用例、stop/error/aborted 过滤、messageText 兼容 parts、expected 截断）、去重 skipped 计数、add/list/delete、临时目录隔离
- `evolution-eval`：runEval 编排（**裁判调用次数：有基线 用例×2 / 无基线 ×1**、skipped 不计入分母、用例超限取最近 5）、四类不可评测、unknown 边界（0 用例）、latency 仅报告不裁决、expected 传入裁判
- `evolution-engine`：**before 按 status 选源**（applied 走快照 extractBefore / pending 走实时定义 / apply 失败残留快照但 confirmed 仍取实时 / 旧数据无基线）；eval 仅评测不动作 + ledger 摘要追加；verify 三态（regress 自动回滚走 doRollback(auto) → rolled_back + 审计/广播 mock 区分 source；pass 仅记 verified；unknown 不动作）；非 applied verify 拒绝、rolled_back/rejected eval 拒绝；无快照 regress 不自动回滚（明确报错）；阈值 A/C 判定
- 端点：cases 四例 + eval/verify 全链路（mock deps + listen(0)）
- CLI：case 四命令（含多词期望参数）+ eval/verify 解析分发
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build` + web tsc 0 错误

## 四、风险

- 裁判 LLM 调用有成本 → MAX_EVAL_CASES=5（≤10 次调用/评测）；裁判失败按用例跳过降级，避免误判
- 自动回滚误伤（评测噪声）→ 阈值保守（-20% 或绝对 <50% 且 ≥2 用例）+ 全程审计广播；回滚后可重新 apply
- 自动提取可能把「用户不满意但会话正常结束」的 turn 当成功 → 保守条件（turn/end stop + 有助手回复）+ expected 取自末条助手消息；手工补录兜底
- 旧提案无快照 → before 缺失按「无基线」处理，verify 仅绝对线 C
- 裁判是启发式而非黄金真值 → 报告明示「评测仅供参考」，最终采纳权在用户（两段式确认不变）
- **用例含会话原文**（input/expected 来自轨迹，可能含敏感信息）→ 仅落盘本地 `data/evolution/cases/`，与 proposals 同权限管理；不参与任何对外输出（修正补充）

## 五、版本

0.12.0：package.json → CHANGELOG.md → README 徽章（提交时同步）
