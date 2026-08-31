# Sprint 39 — 进化引擎第一期：观察 + 提议（0.10.0）

> 状态：**✅ 开发完成（602 测试全绿，两段式确认已落地，待提交）**
> 需求：自进化闭环（设计文档 4.6）第一期——「观察 → 提议 → 用户确认」，完成 AI OS 愿景最后一块核心拼图
> 现状：进化只完成 2/5 层（技能自沉淀 ✅、记忆自组织 ✅）；工具自优化 ❌、能力自生长 ❌、配置自调优 ❌
> 前置：0.9.2（53c1984）

## 一、目标

1. **观察**：从现有数据聚合进化指标（工具成功率/耗时/失败 top、任务完成率、重复任务模式、用户干预频率、生成统计）——不新增存储，全部从 session_events / telemetry / audit 派生
2. **提议**：meta-agent 分析观察数据 → 结构化提案（new-skill / new-tool / new-app / config-change / tool-fix / prompt-fix）
3. **采纳/拒绝**：Web「进化」Tab + CLI `/evo`；采纳后按类型执行（技能 → skill-evolution 校验注册、工具/应用 → AppFactory、配置 → setConfigField）
4. **护栏**（v0.5 已拍板）：提案**默认仅建议、用户确认**；每天 ≤3 条；全审计；`evolution/*` 事件广播
5. **顺手清理**：web tsc 3 个存量错误（chat.svelte.ts、markdown.ts ×2）

## 二、设计

### 1. 观察层（src/core/evolution-observer.ts，新增）

纯函数 + 数据源注入，输出 `EvolutionObservation`（可单测）：

```ts
interface EvolutionObservation {
  windowStart: number; windowEnd: number;          // 最近 7 天
  toolStats: { name: string; calls: number; failed: number; successRate: number; avgDurationMs: number; topErrors: { err: string; count: number }[] }[];
  completion: { sessions: number; ok: number; rate: number; avgTurns: number };  // turn/end reason==="stop" 视为完成
  repeatedTasks: { pattern: string; count: number; examples: string[] }[];      // firstUserMsg 相似度聚类，count>=3 提示
  userInterventions: number;                        // ask_user / confirm 次数
  generated: { apps: number; docs: number; updates: number };                    // audit action 统计
}
```

- 数据源：`sessionStore.listSessions(limit)` + `getEvents()`
  - **窗口过滤**：`listSessions` 默认 `limit=20` 会漏掉窗口内会话 → 传放大 limit（**≥500**），再按 `updatedAt >= windowStart` 过滤（`listSessions` 已返回 updatedAt）
  - 按会话 `getEvents` 全量拉取后过滤 `ev.createdAt >= windowStart`（本地 SQLite，量级可控）
- 工具聚合：复用 `computeSessionStats` 思路，按工具名聚合 tool/call + tool/result（success/durationMs/error）
- 重复任务聚类：首条用户消息归一化（去标点/数字/空白）→ 前缀相似度分组（共享前 N token 同组；**第一期不引入 embedding**，误报仅提示不动作）
- **空数据短路**：窗口内无会话/无事件 → 返回空观察（调用方跳过 LLM，省预算）

### 2. 提议层（src/core/evolution-proposer.ts，新增）

- 触发：仅当观察非空；meta-agent 输入观察 JSON（截断 ~3000 字符）→ 输出**单个** proposal JSON，schema 校验 + 解析失败重试 ≤2 次（失败记审计丢弃，不阻断）
- 提案结构（**action 按类型结构化**，采纳时可直接执行）：

```ts
interface EvolutionProposal {
  id: string;                        // evo-<ts36>-<rand>
  type: "new-skill" | "new-tool" | "new-app" | "config-change" | "tool-fix" | "prompt-fix";
  title: string;                     // ≤40 字符
  reason: string;                    // 观察依据（成功率 43%、同类任务 5 次…）
  action: EvolutionAction;           // 按 type 区分（见下）
  risk: "low" | "medium" | "high";
  status: "pending" | "confirmed" | "applied" | "rejected";   // 两段式确认：pending→confirmed（采纳，不写入）→applied（确认写入）
  createdAt: number;
  meta?: { tokens?: number };        // 进化预算记录（第一期仅记账）
}

type EvolutionAction =
  | { kind: "new-skill"; expert: string; body: string }          // SKILL.md 全文（meta-agent 直接产出，采纳时 validate+register）
  | { kind: "new-tool"; description: string; type: "tool" }
  | { kind: "new-app"; description: string; type: "app" }
  | { kind: "config-change"; field: "model"|"temperature"|"maxTokens"|"thinking"|"skillEvo"; value: unknown }
  | { kind: "tool-fix"; toolName: string; suggestion: string }   // 第一期仅展示建议
  | { kind: "prompt-fix"; agentId: string; suggestion: string }; // 第一期仅展示建议
```

- **new-skill 修正**：不调 `skillEvolution.evolveV2`（其签名需要会话 messages，进化场景无此输入）——由 meta-agent 在提案中直接产出 SKILL.md 正文（frontmatter 含 name/triggers/expert），采纳时复用 `skillEvolution.validate()` + `register()` 落盘 skills/
- 存储：`data/evolution/proposals/<id>.json`（mkdir -p 初始化）+ `data/evolution/ledger.json`（台账时间线，追加）
- **限频护栏**：同日已有 ≥3 条提案 → `POST /evolution/propose` 拒绝（返回 remaining 提示）

### 3. 采纳执行（src/core/evolution-engine.ts，新增，**两段式确认**）

- `observe()` / `propose()` / `list()` / `adopt(id)` / `apply(id)` / `reject(id)`
- **状态机**：`pending →(adopt 确认内容，不写入)→ confirmed →(apply 确认写入，真正执行)→ applied`；reject 可从 pending/confirmed 撤销
- `adopt` 仅做：可行性校验（new-skill 校验 SKILL.md 合法性）+ 置 confirmed + 返回**写入预览**（= action）；**不写入任何内容**
- `apply` 按 type 分发执行（依赖注入，index.ts 组装）：
  - `new-skill` → `skillEvolution.register()` 落盘 `skills/<expert>/`（adopt 阶段已校验）；失败返回 error 不标记 applied
  - `new-tool` / `new-app` → `generatorQueue.submit({ kind:"generate", spec:{ description: action.description, type: action.type, sessionId: "evolution" } })` → 返回 jobId（与对话生成同队列，天然串行互斥）
  - `config-change` → `setConfigField(field, value)`（**白名单 = setConfigField 实际支持的字段**：model/temperature/maxTokens/thinking/skillEvo；提案 schema 已约束，运行时再校验一次）
  - `tool-fix` / `prompt-fix` → 标记 applied + 审计 detail 注明"建议人工执行"，不做自动改写
- 全部动作写 `auditLogger.log(action: "evolution:adopt|apply")` + 广播 `evolution/confirmed|applied`（带 jobId 时一并广播）
- `reject` → 状态置 rejected + 审计 + `evolution/rejected` 事件
- **幂等**：adopt 仅 pending 生效、apply 仅 confirmed 生效、reject 对 pending/confirmed 生效；非法流转返回 `{ ok:false, error:"提案已处理" }`

### 4. API（src/server.ts）

```
GET  /api/v1/evolution/observe                     → EvolutionObservation
POST /api/v1/evolution/propose                     → { ok, proposals: EvolutionProposal[] }（空观察返回 []；限频拒绝带 remaining）
GET  /api/v1/evolution/proposals                   → EvolutionProposal[]（按 createdAt 降序）
POST /api/v1/evolution/proposals/:id/adopt         → { ok, preview? }（确认提案，不写入）
POST /api/v1/evolution/proposals/:id/apply         → { ok, jobId?, detail? }（确认写入，真正执行）
POST /api/v1/evolution/proposals/:id/reject        → { ok }
```

- ServerDeps 注入 `evolutionEngine?`（未注入返回 503，与 appManager 同模式）
- WS 事件：`evolution/confirmed` / `evolution/applied`（含 jobId）/ `evolution/rejected`

### 5. Web「进化」Tab（SystemPanel + EvolutionPanel.svelte，新增）

- SystemTab 增加 `"evolution"`，左侧菜单 + 右侧内容（沿用现布局）
- 上半区**观察指标仪表**：工具成功率 top 失败列表、任务完成率、重复任务 chips、生成统计
- 下半区**提案列表**：类型徽标（new-skill 绿 / new-tool 蓝 / new-app 紫 / config-change 橙 / fix 灰）+ 标题 + 理由 + 风险标 + 采纳/拒绝按钮
- 「运行观察并提议」按钮（observe + propose 串联）
- **采纳反馈路径（明确）**：EvolutionPanel 不在对话流，`spawnGenCard` 不适用 → 采纳后**展开写入预览**（SKILL.md 全文/配置值/生成描述），点「确认写入」才执行；new-tool/new-app 显示**任务已提交 + jobId**，附提示「生成进度见右侧「应用」Tab / 轨迹」，并刷新提案列表；WS 监听 `evolution/*` 自动刷新
- 采纳失败展示后端 error（如技能校验失败、配置字段非法）

### 6. CLI `/evo`（src/commands/evolution.ts，新增）

- `/evo observe` / `/evo propose` / `/evo list` / `/evo adopt <id>`（预览）/ `/evo apply <id>`（写入）/ `/evo reject <id>`
- **CommandContext 新增 `evolutionEngine?: EvolutionEngine` 字段**（未注入提示不可用，同 /app 模式）；注册进 registry.ts（放 appsCommands 后）

### 7. C 项：web tsc 3 错误修复

- `chat.svelte.ts:270`：`pendingTools.indexOf(target)` 传入 `| undefined` → 加空值判断（`if (target)` 内 splice 或非空断言）
- `markdown.ts:8`：`highlight` 选项在 marked v15 已移除 → 改 `marked.use({ renderer })` 扩展 code 渲染调 hljs（零新依赖）
- `markdown.ts:22`：`marked.parse(text)` 返回 `string | Promise<string>` → 同步模式断言（`marked.parse(text, { async: false })` 或类型收窄）
- **取消 GBK 乱码修复**：实测 `data/docs` 文件名为正确 UTF-8（`e4b880...`），之前看到的 `ä¸ä»½` 是 PowerShell GBK 控制台显示假象；全局扫描无任何乱码文件名

## 三、测试

- `evolution-observer`：注入事件 fixture → 断言工具聚合/成功率/失败 top/完成率/重复聚类/**窗口过滤（含超 20 会话场景）**/空数据短路
- `evolution-proposer`：mock modelRouter → JSON 解析、schema 拒绝非法输出（**含 action 按类型结构化校验**）、限频护栏、空观察跳过 LLM
- `evolution-engine`：两段式确认全状态机（adopt 不写入/apply 写入/幂等/reject 可撤销）、各类型分发（mock skillEvolution/generatorQueue/setConfigField）、**new-skill 校验失败不置 confirmed**、审计
- 端点：observe/propose/proposals/adopt/apply/reject 全链路（mock deps + listen(0)）
- CLI：/evo 命令解析与分发（adopt 预览 / apply 写入）
- web tsc 修复后 `npx tsc --noEmit -p web` 0 错误
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build`

## 四、风险

- meta-agent 输出非合法 JSON：schema 校验 + 重试 ≤2 次 + 失败丢弃记审计，不阻断
- 重复任务聚类误报：仅展示提示，不自动动作（护栏兜底）
- 采纳 new-app 与用户对话生成并发：复用 `generatorQueue` 现有 `MAX_CONCURRENT=1` 串行队列，天然互斥
- **new-skill 产物质量**：meta-agent 直接产 SKILL.md 可能不如 evolveV2（无会话上下文）→ 采纳前 validate + 失败可改 pending 或人工编辑（Web 展示 body 可复制）
- 进化预算：第一期仅记账（meta.tokens），强制限额留到第二期「测试 + 推广/回滚」
- 范围控制：**不做** A/B 对比、黄金用例评测、快照回滚（第二期）

## 五、版本

0.10.0：package.json → CHANGELOG.md → README 徽章（提交时同步）
