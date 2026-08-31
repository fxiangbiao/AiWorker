/**
 * 进化提议（Sprint 39）— meta-agent 分析观察数据 → 结构化提案
 * 管线: 观察非空 → LLM 输出单条 proposal JSON → schema 校验 → 解析失败重试 ≤2 → 落盘 proposals/ + ledger
 * 护栏: 每天 ≤3 条提案（限频）；仅建议不自动执行（用户确认制）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvolutionAction, EvolutionObservation, EvolutionProposal, EvolutionProposalType } from "../types.js";
import type { ModelRouter } from "./model-router.js";
import { auditLogger } from "./audit-logger.js";

/** 每日提案上限（v0.5 护栏：每类变更限频） */
export const DAILY_PROPOSAL_LIMIT = 3;
const MAX_PARSE_RETRIES = 2;
const OBSERVATION_MAX_CHARS = 3000;

const PROPOSER_PROMPT = `你是 AiWorker 的进化分析师。基于以下「观察数据」（最近 7 天系统运行统计），提出 **1 条** 最有价值的进化建议。

# 观察数据（JSON）
{OBSERVATION}

# 输出要求
- 严格输出单个 JSON 对象，不要输出任何其他文字/代码块标记
- 只提有明确依据的建议（成功率低、重复任务多、频繁错误等），否则输出 {"empty": true}
- 提案类型与动作结构必须严格遵循下面的 schema

# 可选类型与 action 结构
- new-skill: 发现重复任务模式 → 沉淀技能。action = {"kind":"new-skill","expert":"<agentId>","body":"<SKILL.md 全文：frontmatter 含 name/version/triggers/expert/tools_required + 正文>"}
- new-tool: 重复任务可工具化。action = {"kind":"new-tool","description":"<一句话描述>","type":"tool"}
- new-app: 重复任务可应用化。action = {"kind":"new-app","description":"<一句话描述>","type":"app"}
- config-change: 配置可调优（仅 temperature/maxTokens，可持久化可回滚）。action = {"kind":"config-change","field":"temperature|maxTokens","value":<number>}
- tool-fix: 某工具失败率高。action = {"kind":"tool-fix","toolName":"<工具名>","suggestion":"<改进建议>","newDescription":"<改进后的工具 description（一句话，说明更准确的能力/用法，让 LLM 调用更正确）>"}
- prompt-fix: 某智能体完成率低。action = {"kind":"prompt-fix","agentId":"<agentId>","suggestion":"<提示词改进建议>","newPrompt":"<改进后的完整 systemPrompt（基于原提示词修改，保持角色与风格）>"}

# 输出 JSON schema
{
  "type": "new-skill|new-tool|new-app|config-change|tool-fix|prompt-fix",
  "title": "≤40 字符中文标题",
  "reason": "观察依据，1-2 句（引用具体数字）",
  "action": { ...上面按 type 选择的结构 },
  "risk": "low|medium|high"
}`;

/** schema 校验：action 结构与 type 匹配 + 必填字段 */
export function validateProposal(raw: unknown): EvolutionProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.empty === true) return null;
  const type = o.type as EvolutionProposalType;
  const validTypes: EvolutionProposalType[] = ["new-skill", "new-tool", "new-app", "config-change", "tool-fix", "prompt-fix"];
  if (!validTypes.includes(type)) return null;
  if (typeof o.title !== "string" || o.title.length === 0 || o.title.length > 40) return null;
  if (typeof o.reason !== "string" || o.reason.length === 0) return null;
  if (o.risk !== "low" && o.risk !== "medium" && o.risk !== "high") return null;
  const action = o.action as Record<string, unknown> | undefined;
  if (!action || typeof action !== "object") return null;
  if (action.kind !== type) return null;

  switch (type) {
    case "new-skill":
      if (typeof action.expert !== "string" || action.expert.includes("..") || action.expert.includes("/") || action.expert.includes("\\")) return null;
      if (typeof action.body !== "string" || action.body.length < 100) return null;
      break;
    case "new-tool":
      if (typeof action.description !== "string" || action.description.length === 0) return null;
      break;
    case "new-app":
      if (typeof action.description !== "string" || action.description.length === 0) return null;
      break;
    case "config-change": {
      const field = action.field as string;
      // 仅允许可持久化+可回滚的字段（thinking 是内存开关，不落盘、回滚无效，交配置 Tab 管理）
      if (!["temperature", "maxTokens"].includes(field)) return null;
      const v = action.value;
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      break;
    }
    case "tool-fix":
      if (typeof action.toolName !== "string" || action.toolName.includes("..") || action.toolName.includes("/") || action.toolName.includes("\\")) return null;
      if (typeof action.suggestion !== "string" || action.suggestion.length === 0) return null;
      if (typeof action.newDescription !== "string" || action.newDescription.length === 0) return null;
      break;
    case "prompt-fix":
      if (typeof action.agentId !== "string" || action.agentId.includes("..") || action.agentId.includes("/") || action.agentId.includes("\\")) return null;
      if (typeof action.suggestion !== "string" || action.suggestion.length === 0) return null;
      if (typeof action.newPrompt !== "string" || action.newPrompt.length === 0) return null;
      break;
  }
  return {
    id: "",
    type,
    title: o.title,
    reason: o.reason,
    action: action as EvolutionAction,
    risk: o.risk as EvolutionProposal["risk"],
    status: "pending",
    createdAt: 0,
  };
}

export interface ProposerDeps {
  modelRouter: ModelRouter;
  dataDir: string;
  /** 今日已生成提案数（限频判断）；由 engine 传入 */
  todayCount: () => number;
}

export class EvolutionProposer {
  constructor(private deps: ProposerDeps) {}

  private proposalsDir(): string {
    const dir = resolve(this.deps.dataDir, "evolution", "proposals");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private ledgerPath(): string {
    return resolve(this.deps.dataDir, "evolution", "ledger.json");
  }

  list(): EvolutionProposal[] {
    const dir = this.proposalsDir();
    if (!existsSync(dir)) return [];
    const out: EvolutionProposal[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as EvolutionProposal;
        out.push(p);
      } catch {
        /* 损坏文件跳过 */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): EvolutionProposal | undefined {
    return this.list().find((p) => p.id === id);
  }

  save(p: EvolutionProposal): void {
    writeFileSync(resolve(this.proposalsDir(), `${p.id}.json`), JSON.stringify(p, null, 2), "utf-8");
  }

  appendLedger(entry: Record<string, unknown>): void {
    appendFileSync(this.ledgerPath(), `${JSON.stringify(entry)}\n`, "utf-8");
  }

  /** 台账尾部 N 条（Web 台账视图；文件缺失返回 []） */
  readLedger(limit = 20): Record<string, unknown>[] {
    const path = this.ledgerPath();
    if (!existsSync(path)) return [];
    try {
      const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0);
      return lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { event: "corrupt", raw: l.slice(0, 100) };
        }
      });
    } catch {
      return [];
    }
  }

  /** meta-agent 提议（观察为空/限频直接短路；解析失败重试 ≤2 次） */
  async propose(observation: EvolutionObservation): Promise<EvolutionProposal[]> {
    const hasData =
      observation.toolStats.length > 0 ||
      observation.repeatedTasks.length > 0 ||
      observation.userInterventions > 0 ||
      observation.completion.sessions > 0;
    if (!hasData) return [];
    if (this.deps.todayCount() >= DAILY_PROPOSAL_LIMIT) return [];

    const prompt = PROPOSER_PROMPT.replace(
      "{OBSERVATION}",
      JSON.stringify(observation).slice(0, OBSERVATION_MAX_CHARS),
    );

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      let raw: string;
      let usage: { totalTokens?: number } | undefined;
      try {
        const resp = await this.deps.modelRouter.completeWithProfile("default", [
          { role: "user", content: prompt },
        ]);
        raw = resp.text?.trim() ?? "";
        usage = resp.usage;
      } catch (err) {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: "evolution",
          sessionId: "",
          action: "evolution:propose-failed",
          target: "llm",
          result: "error",
          detail: (err as Error).message.slice(0, 200),
        });
        return [];
      }
      if (!raw) return [];
      const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        continue;
      }
      const proposal = validateProposal(parsed);
      if (!proposal) continue;

      const now = Date.now();
      const id = `evo-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const full: EvolutionProposal = { ...proposal, id, createdAt: now };
      this.save(full);
      this.appendLedger({
        at: now,
        event: "proposed",
        id,
        type: full.type,
        title: full.title,
        risk: full.risk,
        tokens: usage?.totalTokens ?? 0,
      });
      auditLogger.log({
        timestamp: now,
        agentId: "evolution",
        sessionId: "",
        action: "evolution:propose",
        target: id,
        result: "success",
        detail: `${full.type}: ${full.title}`,
      });
      return [full];
    }
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "evolution",
      sessionId: "",
      action: "evolution:propose-failed",
      target: "parse",
      result: "error",
      detail: "meta-agent 输出未通过 schema 校验（重试耗尽）",
    });
    return [];
  }
}

/** 今日已生成提案数（文件 createdAt 判断，供限频） */
export function countTodayProposals(list: EvolutionProposal[], now = Date.now()): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return list.filter((p) => p.createdAt >= dayStart.getTime()).length;
}
