# Sprint 40 — 进化引擎第二期：补丁生效 + 快照回滚（0.11.0）

> 状态：**✅ 开发完成（647 测试全绿，含变更对比补丁，待用户验收，未提交）**
> 需求：设计文档 4.6「Promote/Rollback」——推广后验证 + **回滚硬能力**；并把第一期的"建议类"提案升级为真正生效
> 现状：第一期（0.10.0）tool-fix/prompt-fix 仅记录建议文本，不生效；new-skill/config-change/new-tool/new-app 已可写入但**不可回滚**
> 前置：0.10.0（9cb5299 + 7baa848）

## 一、目标

1. **快照回滚（硬能力）**：apply 写入前自动快照受影响文件 → `/evo rollback <id>` + Web 回滚按钮一键还原（设计文档明确"回滚是硬能力"）
2. **tool-fix 真正生效**：meta-agent 产出**工具描述改进**（`newDescription`）→ apply 时热覆盖注册（工具描述可运行时更新，引导 LLM 更正确调用）；handler 为编译期代码不改（安全边界）
3. **prompt-fix 真正生效**：meta-agent 产出**改进后的 systemPrompt** → apply 时写 `config/agents/<id>.yaml` + `reloadAgent` 热重载（复用现有管线）
4. **生成后验证（轻量）**：new-tool/new-app 采纳后，生成任务 done/failed 结果回写 ledger（不自动评分，不做黄金用例/A/B——成本高且依赖真实运行积累）
5. 状态机扩展：`applied → rolled_back`（回滚终态）；全审计 + 事件

## 二、设计

### 1. 提案 action 扩展（src/types.ts）

```ts
type EvolutionAction =
  | { kind: "new-skill"; expert: string; body: string }
  | { kind: "new-tool"; description: string; type: "tool" }
  | { kind: "new-app"; description: string; type: "app" }
  | { kind: "config-change"; field: ...; value: unknown }
  | { kind: "tool-fix"; toolName: string; suggestion: string; newDescription: string }   // 新增：改进后的工具描述
  | { kind: "prompt-fix"; agentId: string; suggestion: string; newPrompt: string };      // 新增：改进后的 systemPrompt
```

- 状态：`"pending" | "confirmed" | "applied" | "rejected" | "rolled_back"`（**rolled_back 为终态**，回滚后再改需重新 propose）

### 2. 快照 + 回滚（src/core/evolution-snapshot.ts，新增）

```
data/evolution/snapshots/<proposalId>.json   （单文件；提案 applied 即终态，一次 apply 仅一次快照）
{ files: { file: string; content: string | null; at: number; kind: "file" }[];   // content=null 表示原不存在
  tools: { toolName: string; definition: ToolDefinition; at: number }[] }         // tool-fix：完整原定义
```

- `capture(deps)`：apply 前按 action 类型快照受影响目标
  - new-skill → `skills/<expert>/<name>.md`（已存在则存原内容，不存在则 content=null）
  - config-change → `data/runtime-config.json`
  - prompt-fix → `config/agents/<agentId>.yaml`（content=null 表示内置无 YAML 覆盖，回滚应删除）
  - tool-fix → **完整原 ToolDefinition**（`toolRegistry.getAll()` 取当前定义，恢复时整体重注册）
  - new-tool/new-app → 无快照（生成物在沙箱，destroy 即清理；ledger 记 jobId）
- `restore(snapshot)`：按 kind 恢复（文件写回/删除 + `reloadSkill`/`unloadSkill`/`reloadAgent`/重新注册工具定义）

### 2.5 技能注册表卸载能力（src/core/skill-registry.ts，新增）

- `unloadSkill(name: string): boolean`：按名移除内存条目（回滚删除技能文件后必须同步，否则注册表残留、技能仍可被激活）

### 3. apply 扩展（src/core/evolution-engine.ts）

- apply 前先 `capture` 快照（失败不阻断写入，但记审计 warning）
- 新增分支（**依赖注入回调**，index.ts 闭包内实现，engine 不碰 AgentConfig/ToolDefinition 细节）：
  - `tool-fix` → `patchToolDescription(toolName, newDescription)` 回调：`toolRegistry.register(name, 新定义(仅换 description), 原 handler)` → detail "工具描述已更新（本次运行生效，重启回内置默认）"
  - `prompt-fix` → `applyPromptFix(agentId, newPrompt)` 回调：index.ts 内读 `agents[id].getConfig()` → 替换 systemPrompt → `saveAgentConfig(id, cfg)`（含 stripSkillSection + reloadAgent）→ detail "提示词已更新并热重载"
- apply 返回 `{ ok, jobId?, detail?, snapshotSeq? }`

### 4. rollback（src/core/evolution-engine.ts）

```
POST /evolution/proposals/:id/rollback   → { ok, detail? }
/evo rollback <id>
Web 已 applied 提案显示「回滚」按钮
```

- 仅 `applied` 可回滚（`rolled_back` 终态不可再滚）；恢复快照（`restore`）→ 状态置 `rolled_back` → 审计 `evolution:rollback` + 广播 `evolution/rolled_back`
- 恢复后联动：
  - prompt-fix 回滚 → 恢复/删除 YAML + `reloadAgent(id)`
  - tool-fix 回滚 → 用快照完整 definition 重注册
  - config-change 回滚 → 重写 runtime-config.json（内存覆盖值重启后生效，detail 注明）
  - new-skill 回滚 → 原存在恢复文件 + reloadSkill；原不存在删文件 + **unloadSkill**
- **无快照**（new-tool/new-app）→ `{ ok:false, error:"该类型无可回滚快照（生成物可在应用 Tab 销毁）", jobId? }`（detail 附 ledger 中的 jobId 辅助定位）

### 5. 生成结果回写（ledger）

- apply new-tool/new-app 时 ledger 记 `{ event: "generated-submitted", jobId }`
- `ProposalStore` 增 `readLedger(limit): Record<string, unknown>[]`（JSONL 尾部 N 条）
- index.ts 桥接：`eventBus.subscribe` 监听 `gen/done`/`gen/failed` → 按 jobId 反查 ledger 中 `generated-submitted` 的提案 → engine 追加 `{ event: "generated", ok, appId }`

### 6. API（src/server.ts）

```
POST /api/v1/evolution/proposals/:id/rollback   → { ok, detail?, error? }
GET  /api/v1/evolution/ledger?limit=20          → { entries: [...] }   （Web 台账视图数据源）
```

- ServerDeps 注入扩展：`patchToolDescription(toolName, newDescription)`、`applyPromptFix(agentId, newPrompt)`（index.ts 闭包）、`onGenResult` 桥接

### 7. Web「进化」Tab（EvolutionPanel.svelte）

- 提案卡片：applied 状态显示**「回滚」按钮**（调用 rollback 端点）
- tool-fix/prompt-fix 确认预览展示 newDescription/newPrompt 全文（可审查）
- 台账视图（轻量）：`GET /evolution/ledger?limit=20` 拉取，展示事件/提案标题/时间线，放观察区下方
- WS 监听 `evolution/rolled_back` 刷新

### 8. CLI `/evo`

- 新增 `rollback <id>`；list 状态文案补 `rolled_back`（已回滚）

### 9. 变更对比展示（评审补：进化前后对比）

- **数据零新增**：before 从快照提取（tool-fix 描述 / config-change 字段值 / prompt-fix YAML systemPrompt / new-skill 原文件），after 从提案 action 派生
- `src/core/evolution-diff.ts`：`buildChangeView(proposal, snapshot)` 纯函数 + 行级 LCS diff（零依赖）
- API `GET /evolution/proposals/:id/change`（GET；其他 method 405）
- Web：applied/rolled_back 卡片「查看变更」按钮 → 展开修改前/后对照 + 红删绿增行；纯新增（new-tool/new-app）全绿
- CLI `/evo diff <id>`：修改前/后 + 行级差异
- 测试：diffLines/提取/engine.change/端点/CLI（+17）

### 10. 排除（范围控制，沿用第一期结论）

- **不做**：黄金用例评测、A/B 对比、自动回滚触发（成功率/耗时阈值）——依赖真实运行数据积累，留第三期
- **不做**：修改内置工具 handler（编译期代码）、MCP/插件自动改写

## 三、测试

- `evolution-snapshot`：capture/restore 各类型（文件存在/不存在 content=null、tool-fix 完整 definition、config YAML 原无覆盖删除）
- `skill-registry`：`unloadSkill` 移除内存条目（回滚联动）
- `evolution-engine`：tool-fix apply 热覆盖描述（mock patchToolDescription 回调）、prompt-fix apply 写 YAML + reloadAgent（mock applyPromptFix 回调）、rollback 各类型恢复 + 状态 rolled_back + 幂等（非 applied 拒绝、rolled_back 终态）、new-tool/new-app 无快照回滚报错（含 jobId）、readLedger 尾部截取
- 端点：rollback / ledger 全链路（mock deps + listen(0)）
- CLI：/evo rollback 解析与分发
- proposer：schema 校验 tool-fix/prompt-fix 新字段（newDescription/newPrompt 必填）
- 全量验证链：`npm run build && npm run lint && npm test && npm run web:build` + web tsc 0 错误

## 四、风险

- prompt-fix 覆盖原提示词可能退化 → 快照 + 可回滚兜底；两段式确认时预览全文；建议保留原 prompt 在快照
- tool-fix 只改描述不改 handler，价值有限但安全 → 接受（handler 编译期不可改是硬约束）；**覆盖仅本次运行生效，重启回内置默认**（天然回退，需在 UI/CLI detail 说明）
- 快照写盘失败 → apply 不阻断，记审计 warning（回滚能力降级但不影响写入）
- config-change 回滚后 runtime-config.json 恢复，但已加载的 modelRouter 覆盖值需重启生效 → detail 注明"重启后生效"
- **技能回滚注册表残留**（审核发现）：删除技能文件后必须 `unloadSkill` 同步内存，否则技能仍可被触发词激活（已列入 2.5）
- 生成结果回写依赖 gen/* 事件桥接 → index.ts 注入 onGenResult，测试 mock

## 五、版本

0.11.0：package.json → CHANGELOG.md → README 徽章（提交时同步）
