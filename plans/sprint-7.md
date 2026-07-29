# Sprint 7: Team Coordinator — 多智能体动态编排

> 目标：实现灵活的多专家协作系统，让 Agent 根据任务动态编排执行计划

---

## 动机

当前每个任务只分配给一个专家智能体。对于跨领域复杂任务（如"从设计到原型开发一款游戏"），需要多个专家配合。固定的 Pipeline/Parallel/Debate 三种模式过于僵化，因此设计为 **LLM 动态 DAG 编排**：由协调器分析任务、生成执行计划、按拓扑序调度专家。

---

## 架构

```
用户输入
  │
  ▼
协调器.plan()
  ├─① 模板匹配 → 预设 DAG (零 LLM 成本)
  │
  └─② LLM 生成 → 结构化 JSON 执行计划
                  ├─ schema 校验
                  └─ 展示给用户确认
  │
  ▼
协调器.execute()
  ├─ 拓扑排序 (校验无环)
  ├─ 按序执行每步
  │   ├─ [单专家] 直接调用 BaseAgent.run()
  │   └─ [多专家] Promise.all 并行 (上限 3)
  ├─ 每步完成 → 摘要传递至下游
  ├─ 失败容忍 → 非关键步骤标记跳过
  └─ 全完成 → LLM 合成汇总报告
  │
  ▼
输出给用户
```

### 执行计划结构

```typescript
interface ExecutionStep {
  id: string;           // 唯一标识，如 "step-1"
  description: string;  // 此步骤做什么（作为子任务指令传给专家）
  expertId: string;     // 专家 ID: coding / research / data-analysis / financial / game-dev / product-ops
  dependsOn: string[];  // 依赖的上一步 ID 列表，[] 表示无依赖
  critical: boolean;    // true=失败则中止，false=可跳过
}
```

示例计划（游戏开发）：
```json
[
  { "id": "s1", "description": "调研当前放置类手游市场趋势和竞品", "expertId": "research", "dependsOn": [], "critical": false },
  { "id": "s2", "description": "设计核心玩法循环和游戏机制", "expertId": "game-dev", "dependsOn": ["s1"], "critical": true },
  { "id": "s3", "description": "实现 Godot 可运行原型", "expertId": "coding", "dependsOn": ["s2"], "critical": true },
  { "id": "s4", "description": "设计数值平衡和经济系统", "expertId": "data-analysis", "dependsOn": ["s3"], "critical": false },
  { "id": "s5", "description": "撰写商业化方案和运营计划", "expertId": "product-ops", "dependsOn": ["s3"], "critical": false },
]
```

---

## 新增文件

| 文件 | 说明 |
|------|------|
| `src/core/team-coordinator.ts` | TeamCoordinator 主类 (plan + execute + synthesize) |

## 修改文件

| 文件 | 修改 |
|------|------|
| `src/types.ts` | 新增 `ExecutionStep`、`ExecutionPlan`、`PlanTemplate` 类型 |
| `src/index.ts` | CLI 集成：自动检测 + `/plan` 命令 |
| `config/models.json` | (可选) 确认 reasoning profile 可调用 |

## 不变文件

- `src/core/agent-loop.ts` — 无需修改，复用现有 loop
- `src/agents/base-agent.ts` — 无需修改，复用 `run()` 方法
- `src/agents/router.ts` — 无需修改，协调器内部调用 `routeToExpert`

---

## 实现步骤

### Step 1: 类型定义 (`src/types.ts`)

```typescript
export interface ExecutionStep {
  id: string;
  description: string;
  expertId: string;
  dependsOn: string[];
  critical: boolean;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  goal: string;
  estimatedSteps: number;
}

export interface TemplatePlan {
  id: string;
  name: string;
  matchPattern: RegExp[];
  steps: ExecutionStep[];
}
```

### Step 2: TeamCoordinator 类 (`src/core/team-coordinator.ts`)

关键方法：
- `plan(instruction, modelRouter?)` → 先匹配模板，无模板则 LLM 生成
- `validatePlan(plan)` → topology sort 检测环，校验 expertId
- `execute(plan, agents, deps)` → 按拓扑序执行，失败容忍
- `synthesize(results, goal)` → LLM 合并所有步骤输出为最终报告

#### `plan()` 实现

```typescript
async plan(instruction: string): Promise<{ plan: ExecutionPlan; source: "template" | "llm" }> {
  // 1. 模板匹配
  for (const template of templates) {
    if (template.matchPattern.some(p => p.test(instruction))) {
      return { plan: { steps: template.steps, goal: instruction, estimatedSteps: template.steps.length }, source: "template" };
    }
  }
  
  // 2. LLM 生成
  const planJson = await this.modelRouter.completeWithProfile("reasoning", [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: instruction },
  ]);
  
  const plan = JSON.parse(planJson.text);
  this.validatePlan(plan);
  return { plan, source: "llm" };
}
```

#### `execute()` 实现

```typescript
async execute(plan: ExecutionPlan, agents: Record<string, BaseAgent>, deps: AgentLoopDeps): Promise<string> {
  const results = new Map<string, string>();
  const remaining = [...plan.steps];
  
  while (remaining.length > 0) {
    const ready = remaining.filter(s => s.dependsOn.every(d => results.has(d)));
    if (ready.length === 0) break; // 死锁保护
    
    for (const step of ready) {
      // 构建上下文：依赖步骤的摘要
      const context = step.dependsOn.map(d => {
        const r = results.get(d)!;
        return `[${d} 结果]\n${r.slice(0, 2000)}`;
      }).join("\n\n");
      
      const instruction = context ? `${step.description}\n\n上一步结果:\n${context}` : step.description;
      
      try {
        const agent = agents[step.expertId] ?? agents["default"];
        const result = await agent.run({ instruction, mode: "craft" }, deps.workingDir);
        
        // 存储摘要而非全文（控制上下文膨胀）
        const summary = result.text.length > 3000 ? result.text.slice(0, 3000) + "..." : result.text;
        results.set(step.id, `[${step.expertId}] ${summary}`);
        
        // 输出进度
        console.log(`✓ Step ${step.id}: ${step.expertId} 完成 (${result.iterations} 次迭代)`);
      } catch (err) {
        if (step.critical) throw err;
        results.set(step.id, `[${step.expertId}] 步骤失败，已跳过`);
        console.log(`⚠ Step ${step.id}: ${step.expertId} 失败，已跳过`);
      }
      
      remaining.splice(remaining.indexOf(step), 1);
    }
  }
  
  return this.synthesize(plan, results);
}
```

### Step 3: 预设模板

初始模板（后续可扩展）：

| 模板 | 匹配关键词 | 步骤 |
|------|-----------|------|
| `game-dev-pipeline` | 游戏开发、游戏制作、Godot | 调研 → 设计 → 编码 → 数值 → 运营 |
| `product-analysis` | 产品分析、竞品分析、市场调研 | 调研(并行) → 数据分析(并行) → 运营方案(并行) → 汇总 |
| `full-stack-feature` | 开发功能、全栈、实现新功能 | 设计 → 编码 → 测试 |

### Step 4: CLI 集成 (`src/index.ts`)

- 自动检测：`routeToExpert()` 返回 `"default"` 且任务复杂时 → 触发协调器
- 显式命令：`/plan <描述>` → 直接调用协调器

---

## 测试计划

| 测试 | 说明 |
|------|------|
| plan() 模板匹配 | 匹配关键词返回预设模板 |
| plan() LLM 生成 | 无匹配时调用 LLM |
| validatePlan() 环检测 | 循环依赖时报错 |
| execute() 串行步骤 | 按依赖序依次执行 |
| execute() 并行步骤 | 无依赖步骤并发执行 |
| execute() 失败容忍 | 非关键步骤失败后继续 |
| synthesize() 汇总 | 合并多步骤输出 |
| CLI /plan 命令 | 交互触发协调器 |
| CLI 自动检测 | 复杂任务自动进入协调器 |

---

## 开放问题（第二期）

1. **辩论模式**：同一任务分配给两个专家互评 → DAG 内单个 step 的子流程
2. **用户修改计划**：展示计划后允许增删改步骤
3. **技能感知规划**：plan() 时考虑每个专家可用的 SKILL.md
4. **流式步骤输出**：每步 streaming 输出，减少等待感
5. **模型按步骤配置**：不同步骤用不同模型 profile
