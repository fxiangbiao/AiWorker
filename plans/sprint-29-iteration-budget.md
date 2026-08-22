# Sprint 29 — 迭代预算优化（扩容 + 运行时可调 + 智能收敛）

> 状态：**✅ 已实施**（2026-08-22，版本 0.4.0）
> 用户选择：A+B = 各专家上限扩容 + `/config iterations` 运行时调节 + 预算感知收尾 + 空转强制终止 + 工具全失败提前结束

---

## 背景

- 每次迭代 = 一次 LLM 请求轮；复杂任务（游戏开发等）几十步工具调用即可打满上限
- 撞顶行为是硬切：直接返回 `"达到迭代上限"`，无进展摘要/收尾
- 现有防循环提醒（连续 ≥3 次相同调用注入 system 提醒）只提醒不终止
- maxIterations 来源：`config/agents/*.yaml`（6 个）覆盖 TS 硬编码；default 无 YAML 走 TS 默认 30
- `ModelRouter.applyOverrides` 忽略未知字段 → runtime-config.json 可安全增加 `iterations` 字段

## A. 扩容 + 运行时可调

### A1. 默认上限扩容（YAML + default TS）

| 专家 | 当前 | 新值 | | 专家 | 当前 | 新值 |
|---|---|---|---|---|---|---|
| default | 30 | **60** | | financial | 60 | **120** |
| coding | 50 | **100** | | data-analysis | 60 | **120** |
| product-ops | 40 | **80** | | game-dev | 70 | **140** |
| research | 80 | **160** | | | | |

改动：`config/agents/{coding,product-ops,financial,data-analysis,game-dev,research}.yaml` + `src/agents/default-agent.ts`

### A2. `/config iterations <n>` 运行时调节

- `BaseAgent` 加 `setMaxIterations(n)` / `getMaxIterations()`
- `/config iterations [n]`：无参显示当前专家上限；有参设置**当前路由专家**（复用 `routeToExpert("")` 语义），校验 10 ≤ n ≤ 1000
- 持久化：`data/runtime-config.json` 增加 `iterations: { <agentId>: n }` 字段（与 model overrides 并存，`applyOverrides` 忽略未知字段，旧文件兼容）
- 启动恢复（`index.ts`）：解析后先剥离 `iterations` 字段再 `applyOverrides(rest)`，然后逐个 `agents[id]?.setMaxIterations(n)`

## B. 智能收敛（`agent-loop.ts` 同步 + 流式两处同步改）

### B1. 预算感知收尾
- `BUDGET_WARN_AT = 5`：模型请求前若 `MAX_ITER - iterations <= 5` 且未提示过 → 注入 system 提示："剩余迭代预算不足（约 N 轮），请立即收敛：优先完成当前关键步骤并给出最终总结"
- **撞顶返回带进展**：循环外维护 `lastAssistantText`（每轮响应文本）；撞顶时返回 `[已达迭代上限 N 轮]` + 最后文本片段 + 建议"可继续追问或 /plan 拆分"，不再裸返回"达到迭代上限"

### B2. 空转强制终止
- 提取"连续相同 (tool, args) 计数"（从 `maybeInjectRepeatReminder` 抽出共用）
- ≥3 次：现有提醒逻辑不变；**≥6 次（`REPEAT_FORCE_STOP`）：强制终止**，返回进展 + "检测到重复循环调用，已强制终止"
- 防循环记录上限 RECENT_TOOL_CALLS_MAX=10 不变

### B3. 工具全失败终止
- `TOOL_FAIL_STREAK_MAX = 4`：连续 4 轮**所有**工具调用都失败 → 终止，返回进展 + "工具连续失败，已终止"
- 单轮内只要有一个工具成功即重置计数；与空转检测独立

## 测试

- `agent-loop.test.ts` 新增：
  - 预算收尾提示注入（remaining ≤ 5 时 system 消息出现且只注入一次）
  - 空转 ≥6 强制终止（返回 truncated + 说明）
  - 工具连续失败 4 轮终止（含"有成功则重置"）
  - 撞顶返回带进展文本（不含裸"达到迭代上限"）
- `cli-commands.test.ts` 新增：`/config iterations` 设置/校验（<10 / >1000 拒绝）/无参显示；`persistRuntimeConfig` 输出含 iterations 字段
- 回归：现有 348 全绿

## 文档

- AGENTS.md：agent-loop 条目补智能收敛（预算收尾/空转强停/失败终止）；`/config` 命令说明补 iterations
- README：`/config` 行 detail 更新
- CHANGELOG：版本 **0.4.0** 段（迭代预算管理：扩容 + 运行时可调 + 智能收敛）

## 实施顺序

A1（YAML+TS 扩容）→ A2（setMaxIterations + /config + 持久化/恢复）→ B1（收尾提示 + 撞顶带进展）→ B2（空转强停）→ B3（失败终止）→ 测试 → 文档 + 版本 → 全量验证 → 推送双远程

## 风险与对策

| 风险 | 对策 |
|---|---|
| 扩容后空转任务 token 浪费 | B2/B3 强制终止兜底 |
| runtime-config.json 兼容 | applyOverrides 忽略未知字段；恢复时剥离再应用 |
| YAML 与 TS 双处维护 | 本次统一改；AGENTS 注明 YAML 优先 |
| 收敛提示可能干扰正常任务 | 仅剩余 ≤5 轮时注入一次，措辞引导收尾 |
