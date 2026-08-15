/**
 * Team 协调器 — 多智能体动态编排
 * 设计依据：Section 5.3 — 子 Agent 隔离原则 + DAG 编排
 *
 * 核心流程：
 *   plan() → 模板优先 / LLM 生成 → validate → 拓扑排序
 *   execute() → 按序执行 DAG → 失败容忍 → 汇总
 */

import type {
  ExecutionStep,
  ExecutionPlan,
  PlanTemplate,
  CoordinatorResult,
  StreamCallbacks,
} from "../types.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { ModelRouter } from "./model-router.js";

const MAX_STEPS = 8;
const MAX_PARALLEL = 3;

const PLAN_SYSTEM_PROMPT = `你是一个任务编排专家。将用户的任务拆解为多个步骤，分配给不同的专家智能体协作完成。

可用专家:
- coding: 编码工程师 — 写代码、调试、重构、测试、Git
- research: 研究分析师 — 市场调研、竞品分析、趋势预测、报告
- data-analysis: 数据分析师 — 数据分析、统计、可视化、SQL
- financial: 理财投资顾问 — 股票、基金、投资分析
- game-dev: 游戏设计师 — Godot、GDScript、关卡设计、数值平衡
- product-ops: 产品运营 — PRD、用户调研、内容创作、运营方案

规则:
1. 只输出 JSON，不要其他内容
2. steps 数组，每步包含: id, description, expertId, dependsOn[], critical
3. id 格式 "s1","s2"...
4. dependsOn 引用上一步 id，无依赖填 []
5. critical=true 表示此步骤失败则中止，false 可跳过
6. 步骤不超过 ${MAX_STEPS} 个
7. 不要循环依赖
8. description 要具体，作为子任务指令直接传给专家

示例输出:
{
  "steps": [
    {"id":"s1","description":"调研当前市场趋势和竞品","expertId":"research","dependsOn":[],"critical":false},
    {"id":"s2","description":"设计核心玩法和技术方案","expertId":"game-dev","dependsOn":["s1"],"critical":true}
  ],
  "estimatedSteps": 2
}`;

export class TeamCoordinator {
  private agents: Record<string, BaseAgent>;
  private modelRouter: ModelRouter;

  constructor(agents: Record<string, BaseAgent>, modelRouter: ModelRouter) {
    this.agents = agents;
    this.modelRouter = modelRouter;
  }

  /**
   * plan — 生成执行计划
   * 优先匹配模板（零 LLM 成本），无匹配时用 reasoning 模型生成
   */
  async plan(instruction: string): Promise<{ plan: ExecutionPlan; source: "template" | "llm" }> {
    for (const template of TEMPLATES) {
      if (template.matchPattern.some((p) => p.test(instruction))) {
        const steps = template.steps.map((s) => ({ ...s }));
        return {
          plan: { steps, goal: instruction, estimatedSteps: steps.length },
          source: "template",
        };
      }
    }

    try {
      const response = await this.modelRouter.completeWithProfile("reasoning", [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ]);
      const plan = this.parsePlan(response.text, instruction);
      return { plan, source: "llm" };
    } catch {
      // reasoning 模型不可用，降级到默认模型
      try {
        const response = await this.modelRouter.completeWithProfile("default", [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          { role: "user", content: instruction },
        ]);
        const plan = this.parsePlan(response.text, instruction);
        return { plan, source: "llm" };
      } catch {
        return { plan: this.fallbackPlan(instruction), source: "template" };
      }
    }
  }

  /**
   * execute — 按拓扑序执行 DAG
   */
  async execute(
    plan: ExecutionPlan,
    workingDir: string,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<CoordinatorResult> {
    const stepResults = new Map<string, string>();
    const failedSteps: string[] = [];
    const remaining = [...plan.steps];

    while (remaining.length > 0) {
      if (signal?.aborted) break;

      const ready = remaining.filter((s) => s.dependsOn.every((d) => stepResults.has(d)));
      if (ready.length === 0) {
        const blocked = remaining.map(
          (s) => `${s.id}(缺: ${s.dependsOn.filter((d) => !stepResults.has(d)).join(",")})`,
        );
        const text = `执行计划失败: 步骤间存在循环依赖或死锁 — ${blocked.join(", ")}`;
        return { text, plan, stepResults, failedSteps: remaining.map((s) => s.id), source: "llm" as const };
      }

      const batch = ready.slice(0, MAX_PARALLEL);

      const batchResults = await Promise.all(
        batch.map(async (step) => {
          if (signal?.aborted) return null;

          const context = step.dependsOn
            .map((d) => {
              const r = stepResults.get(d);
              return r ? `[${d} 结果]\n${r.slice(0, 2000)}` : "";
            })
            .filter(Boolean)
            .join("\n\n");

          const instruction = context ? `${step.description}\n\n上一步结果:\n${context}` : step.description;

          callbacks?.onToolCall?.(step.expertId, step.description, step.id);
          callbacks?.onStepStart?.(step.id, step.expertId, step.description);

          try {
            const agent = this.agents[step.expertId];
            if (!agent) throw new Error(`未知专家: ${step.expertId}`);

            const result = await agent.run({ instruction, mode: "auto" }, workingDir);

            const summary = result.text.length > 3000 ? result.text.slice(0, 3000) + "..." : result.text;
            stepResults.set(step.id, summary);
            callbacks?.onToolResult?.(step.expertId, true, summary.slice(0, 100));
            callbacks?.onStepEnd?.(step.id, true);
            return { id: step.id, status: "ok" as const };
          } catch (err) {
            if (step.critical) {
              callbacks?.onStepEnd?.(step.id, false);
              throw err;
            }
            failedSteps.push(step.id);
            stepResults.set(step.id, `[${step.expertId}] 步骤失败，已跳过`);
            callbacks?.onToolResult?.(step.expertId, false, (err as Error).message);
            callbacks?.onStepEnd?.(step.id, false);
            return { id: step.id, status: "skipped" as const };
          }
        }),
      );

      for (const r of batchResults) {
        if (r) {
          const idx = remaining.findIndex((s) => s.id === r.id);
          if (idx !== -1) remaining.splice(idx, 1);
        }
      }
    }

    const text = await this.synthesize(plan, stepResults, failedSteps);
    return { text, plan, stepResults, failedSteps, source: "llm" };
  }

  /**
   * 获取可用专家列表（供外部展示用）
   */
  getAvailableAgents(): string[] {
    return Object.keys(this.agents);
  }

  /**
   * debate — 辩论模式
   * 两个专家各自独立分析同一问题，互审结论，最终汇总为多角度报告
   */
  async debate(
    instruction: string,
    agentA: string,
    agentB: string,
    workingDir: string,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<CoordinatorResult> {
    const agent1 = this.agents[agentA];
    const agent2 = this.agents[agentB];
    if (!agent1 || !agent2) {
      return {
        text: `辩论模式需要两个有效专家，当前可用: ${Object.keys(this.agents).join(", ")}`,
        plan: { steps: [], goal: instruction, estimatedSteps: 0 },
        stepResults: new Map(),
        failedSteps: [],
        source: "llm",
      };
    }

    callbacks?.onToolCall?.(agentA, "第一轮分析", "debate-a1");
    const r1 = await agent1.run({ instruction, mode: "auto" }, workingDir);
    if (signal?.aborted) {
      return {
        text: "辩论已中断",
        plan: { steps: [], goal: instruction, estimatedSteps: 0 },
        stepResults: new Map(),
        failedSteps: [],
        source: "llm",
      };
    }

    callbacks?.onToolCall?.(agentB, "第一轮分析", "debate-b1");
    const r2 = await agent2.run({ instruction, mode: "auto" }, workingDir);
    if (signal?.aborted) {
      return {
        text: "辩论已中断",
        plan: { steps: [], goal: instruction, estimatedSteps: 0 },
        stepResults: new Map(),
        failedSteps: [],
        source: "llm",
      };
    }

    // 互审: 每个 agent 审视对方结论
    const critiqueA = `请批判性地审视以下来自 ${agentA} 的分析，指出遗漏、矛盾或可改进之处:\n\n${r1.text.slice(0, 3000)}`;
    callbacks?.onToolCall?.(agentB, "审视对方结论", "debate-b2");
    const cr2 = await agent2.run({ instruction: critiqueA, mode: "auto" }, workingDir);

    const critiqueB = `请批判性地审视以下来自 ${agentB} 的分析，指出遗漏、矛盾或可改进之处:\n\n${r2.text.slice(0, 3000)}`;
    callbacks?.onToolCall?.(agentA, "审视对方结论", "debate-a2");
    const cr1 = await agent1.run({ instruction: critiqueB, mode: "auto" }, workingDir);

    // 综合报告
    const text = this.synthesizeDebate(instruction, agentA, agentB, r1.text, r2.text, cr1.text, cr2.text);

    const stepResults = new Map<string, string>();
    stepResults.set("debate-a1", r1.text);
    stepResults.set("debate-b1", r2.text);
    stepResults.set("debate-a2", cr1.text);
    stepResults.set("debate-b2", cr2.text);

    return {
      text,
      plan: { steps: [], goal: instruction, estimatedSteps: 0 },
      stepResults,
      failedSteps: [],
      source: "llm",
    };
  }

  private synthesizeDebate(
    goal: string,
    agentA: string,
    agentB: string,
    a1: string,
    b1: string,
    a2: string,
    b2: string,
  ): string {
    const parts: string[] = [];
    parts.push(`# 辩论分析: ${goal.slice(0, 100)}`);
    parts.push("");
    parts.push(`## 正方观点 (${agentA})`);
    parts.push(a1.length > 1500 ? a1.slice(0, 1500) + "..." : a1);
    parts.push("");
    parts.push(`## 反方观点 (${agentB})`);
    parts.push(b1.length > 1500 ? b1.slice(0, 1500) + "..." : b1);
    parts.push("");
    parts.push(`## ${agentB} 对 ${agentA} 的质疑`);
    parts.push(a2.length > 1000 ? a2.slice(0, 1000) + "..." : a2);
    parts.push("");
    parts.push(`## ${agentA} 对 ${agentB} 的质疑`);
    parts.push(b2.length > 1000 ? b2.slice(0, 1000) + "..." : b2);
    parts.push("");
    parts.push("---");
    parts.push("辩论完成。请基于双方观点和互审意见做出最终判断。");
    return parts.join("\n");
  }

  /**
   * synthesize — 汇总所有步骤结果为最终报告
   */
  private async synthesize(
    plan: ExecutionPlan,
    stepResults: Map<string, string>,
    failedSteps: string[],
  ): Promise<string> {
    const parts: string[] = [];
    parts.push(`# 执行报告: ${plan.goal.slice(0, 100)}`);
    parts.push("");

    for (const step of plan.steps) {
      const result = stepResults.get(step.id);
      const status = failedSteps.includes(step.id) ? "❌ 跳过" : "✅ 完成";
      parts.push(`## Step ${step.id}: ${step.expertId} ${status}`);
      parts.push(`> ${step.description}`);
      if (result) {
        const body = result.length > 800 ? result.slice(0, 800) + "..." : result;
        parts.push(body);
      }
      parts.push("");
    }

    if (failedSteps.length > 0) {
      parts.push("---");
      parts.push(`⚠ 跳过的步骤: ${failedSteps.join(", ")}`);
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * parsePlan — 解析 LLM 返回的 JSON 并校验
   */
  private parsePlan(raw: string, instruction: string): ExecutionPlan {
    const json = this.extractJson(raw);
    let parsed: { steps?: unknown[]; estimatedSteps?: number };
    try {
      parsed = JSON.parse(json);
    } catch {
      return this.fallbackPlan(instruction);
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return this.fallbackPlan(instruction);
    }

    const steps: ExecutionStep[] = [];
    const ids = new Set<string>();

    for (const item of parsed.steps) {
      const s = item as Record<string, unknown>;
      const id = String(s.id ?? "");
      if (!id || ids.has(id)) continue;
      ids.add(id);

      steps.push({
        id,
        description: String(s.description ?? ""),
        expertId: String(s.expertId ?? "default"),
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
        critical: s.critical === true,
      });
    }

    if (steps.length === 0) return this.fallbackPlan(instruction);
    if (steps.length > MAX_STEPS) steps.length = MAX_STEPS;

    this.validateSteps(steps);

    return {
      steps,
      goal: instruction,
      estimatedSteps: parsed.estimatedSteps ?? steps.length,
    };
  }

  private validateSteps(steps: ExecutionStep[]): void {
    const ids = new Set(steps.map((s) => s.id));

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          step.dependsOn = step.dependsOn.filter((d) => d !== dep);
        }
      }
    }

    // 拓扑排序检测环 (Kahn)
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const s of steps) {
      inDegree.set(s.id, 0);
      adj.set(s.id, []);
    }
    for (const s of steps) {
      for (const dep of s.dependsOn) {
        adj.get(dep)?.push(s.id);
        inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let count = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      count++;
      for (const next of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    if (count !== steps.length) {
      const cycleNodes = steps.filter((s) => (inDegree.get(s.id) ?? 0) > 0).map((s) => s.id);
      throw new Error(
        `检测到循环依赖: ${cycleNodes.join(" → ")}。` +
          `请手动指定步骤顺序或使用 /plan --linear 选项将步骤展平为线性执行。`,
      );
    }
  }

  private fallbackPlan(instruction: string): ExecutionPlan {
    return {
      steps: [
        {
          id: "s1",
          description: instruction,
          expertId: "default",
          dependsOn: [],
          critical: true,
        },
      ],
      goal: instruction,
      estimatedSteps: 1,
    };
  }

  private extractJson(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    const braceStart = text.indexOf("{");
    const braceEnd = text.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      return text.slice(braceStart, braceEnd + 1);
    }
    return text;
  }
}

// ── 预设模板 ──

const TEMPLATES: PlanTemplate[] = [
  {
    id: "game-dev-pipeline",
    name: "游戏开发流水线",
    matchPattern: [/游戏.*开发|开发.*游戏|制作.*游戏|游戏.*制作/i, /Godot|游戏.*原型|放置.*手游/i],
    steps: [
      {
        id: "s1",
        description: "调研当前同类游戏市场趋势和竞品分析，给出差异化建议",
        expertId: "research",
        dependsOn: [],
        critical: false,
      },
      {
        id: "s2",
        description: "设计核心玩法循环、游戏机制和系统架构",
        expertId: "game-dev",
        dependsOn: ["s1"],
        critical: true,
      },
      {
        id: "s3",
        description: "实现 Godot 可运行原型，包含核心玩法",
        expertId: "coding",
        dependsOn: ["s2"],
        critical: true,
      },
      {
        id: "s4",
        description: "设计数值平衡模型和经济系统，提供数据模拟",
        expertId: "data-analysis",
        dependsOn: ["s3"],
        critical: false,
      },
      {
        id: "s5",
        description: "撰写商业化方案和运营计划",
        expertId: "product-ops",
        dependsOn: ["s3"],
        critical: false,
      },
    ],
  },
  {
    id: "product-analysis",
    name: "产品分析报告",
    matchPattern: [/产品.*分析|竞品.*分析|市场.*调研|分析.*报告/i, /多角度.*分析|从.*角度.*分析/i],
    steps: [
      {
        id: "s1",
        description: "从技术角度分析产品架构、技术栈和实现方案",
        expertId: "coding",
        dependsOn: [],
        critical: false,
      },
      {
        id: "s2",
        description: "分析产品数据和关键指标，给出数据洞察",
        expertId: "data-analysis",
        dependsOn: [],
        critical: false,
      },
      {
        id: "s3",
        description: "从运营角度分析用户价值和增长策略",
        expertId: "product-ops",
        dependsOn: [],
        critical: false,
      },
      {
        id: "s4",
        description: "综合技术、数据和运营三个角度，撰写完整分析报告",
        expertId: "research",
        dependsOn: ["s1", "s2", "s3"],
        critical: true,
      },
    ],
  },
  {
    id: "full-stack-feature",
    name: "全栈功能开发",
    matchPattern: [/开发.*功能|实现.*功能|全栈.*开发|前后端.*开发/i, /添加.*(?:页面|接口|API|组件|模块)/i],
    steps: [
      {
        id: "s1",
        description: "设计技术方案和架构，选择技术栈",
        expertId: "coding",
        dependsOn: [],
        critical: true,
      },
      {
        id: "s2",
        description: "编写后端接口和数据库模型",
        expertId: "coding",
        dependsOn: ["s1"],
        critical: true,
      },
      {
        id: "s3",
        description: "编写前端页面和交互逻辑",
        expertId: "coding",
        dependsOn: ["s1"],
        critical: true,
      },
      {
        id: "s4",
        description: "编写集成测试，验证前后端联调",
        expertId: "coding",
        dependsOn: ["s2", "s3"],
        critical: false,
      },
    ],
  },
  {
    id: "investment-analysis",
    name: "投资分析",
    matchPattern: [/投资.*分析|股票.*分析|基金.*推荐|理财.*方案/i, /资产.*配置|组合.*投资|风险评估/i],
    steps: [
      {
        id: "s1",
        description: "分析当前市场和行业趋势",
        expertId: "research",
        dependsOn: [],
        critical: false,
      },
      {
        id: "s2",
        description: "分析标的财务数据和估值指标",
        expertId: "financial",
        dependsOn: ["s1"],
        critical: true,
      },
      {
        id: "s3",
        description: "量化风险收益比，给出配置建议",
        expertId: "data-analysis",
        dependsOn: ["s2"],
        critical: false,
      },
    ],
  },
];

/**
 * 根据话题关键词自动匹配最优辩论专家对（供 CLI 与 HTTP API 共用）
 */
export function pickDebateAgents(topic: string, available: string[]): { agentA: string; agentB: string } {
  const defaultPair = { agentA: "research", agentB: "coding" };

  if (available.length < 2) return defaultPair;

  const has = (id: string) => available.includes(id);

  if (/投资|股票|基金|理财|财务|资产/i.test(topic) && has("financial") && has("data-analysis")) {
    return { agentA: "financial", agentB: "data-analysis" };
  }
  if (/游戏/i.test(topic) && has("game-dev") && has("product-ops")) {
    return { agentA: "game-dev", agentB: "product-ops" };
  }
  if (/(?:技术选型|架构|框架|语言.*选择|React.*Vue|前后端)/i.test(topic) && has("coding") && has("research")) {
    return { agentA: "coding", agentB: "research" };
  }
  if (/(?:产品|运营|用户|市场|PRD)/i.test(topic) && has("product-ops") && has("research")) {
    return { agentA: "product-ops", agentB: "research" };
  }
  if (/数据|分析|统计|报表/i.test(topic) && has("data-analysis") && has("research")) {
    return { agentA: "data-analysis", agentB: "research" };
  }

  return defaultPair;
}
