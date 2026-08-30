/**
 * 进化引擎（Sprint 39 第一期：观察 + 提议 + 两段式确认）
 * 闭环: observe（派生指标）→ propose（meta-agent 提案）→ adopt（确认提案内容，不写入）
 *       → apply（确认写入，真正执行）→ applied；reject 可随时撤销
 * 护栏: 提案仅建议、用户确认；写入前二次确认（adopt ≠ 写入）；每日限频（proposer 内）；
 *       全部动作审计 + evolution/* 事件
 */

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { EvolutionObservation, EvolutionPreview, EvolutionProposal } from "../types.js";
import type { ModelRouter } from "./model-router.js";
import { observeEvolution, type ObservationDeps } from "./evolution-observer.js";
import { EvolutionProposer, countTodayProposals } from "./evolution-proposer.js";
import { skillEvolution } from "./skill-evolution.js";
import { auditLogger } from "./audit-logger.js";
import { eventBus } from "../server/event-bus.js";

/** 每日提案上限（与 proposer 常量一致，engine 侧限频判断） */
const DAILY_PROPOSAL_LIMIT = 3;

/** engine 使用的最小提案存储接口（真实 EvolutionProposer 与测试 mock 均满足） */
export interface ProposalStore {
  propose(observation: EvolutionObservation): Promise<EvolutionProposal[]>;
  list(): EvolutionProposal[];
  get(id: string): EvolutionProposal | undefined;
  save(p: EvolutionProposal): void;
  appendLedger(entry: Record<string, unknown>): void;
}

export interface EvolutionEngineDeps {
  dataDir: string;
  /** 观察数据源（index.ts 注入 sessionStore 适配） */
  observation: ObservationDeps;
  /** meta-agent 模型路由（无则 propose 返回不可用；测试可注入 mock proposer 替代） */
  modelRouter?: ModelRouter;
  /** 提案生成器（测试注入 mock；缺省内部创建） */
  proposer?: ProposalStore;
  /** 生成队列（new-tool/new-app 写入；未注入则此类提案写入失败） */
  submitGenerate?: (spec: { description: string; type: string; sessionId?: string }) => string;
  /** 配置应用（config-change 写入；未注入则返回不可用） */
  setConfigField?: (field: string, value: unknown) => { ok: boolean; error?: string };
}

export class EvolutionEngine {
  private proposer: ProposalStore;

  constructor(private deps: EvolutionEngineDeps) {
    const dir = resolve(deps.dataDir, "evolution");
    mkdirSync(resolve(dir, "proposals"), { recursive: true });
    this.proposer =
      deps.proposer ??
      new EvolutionProposer({
        modelRouter: deps.modelRouter as never,
        dataDir: deps.dataDir,
        todayCount: () => countTodayProposals(this.list()),
      });
  }

  /** 观察（派生指标，不落库） */
  observe(now = Date.now()): EvolutionObservation {
    return observeEvolution(this.deps.observation, now);
  }

  /** 提议（观察 → meta-agent → 落盘；空观察/限频返回 []） */
  async propose(): Promise<{ ok: boolean; proposals: EvolutionProposal[]; limited?: boolean; error?: string }> {
    if (!this.deps.modelRouter && !this.deps.proposer) {
      return { ok: false, proposals: [], error: "模型路由未初始化，无法提议" };
    }
    const observation = this.observe();
    const hasData =
      observation.toolStats.length > 0 ||
      observation.repeatedTasks.length > 0 ||
      observation.userInterventions > 0 ||
      observation.completion.sessions > 0;
    if (!hasData) return { ok: true, proposals: [] };
    if (countTodayProposals(this.list()) >= DAILY_PROPOSAL_LIMIT) {
      return { ok: false, proposals: [], limited: true };
    }
    const proposals = await this.proposer.propose(observation);
    return { ok: true, proposals };
  }

  list(): EvolutionProposal[] {
    return this.proposer.list();
  }

  /** 采纳（第一步确认）：pending → confirmed，仅校验可行性并返回写入预览，不写入任何内容 */
  adopt(id: string): { ok: boolean; error?: string; preview?: EvolutionPreview } {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status !== "pending") return { ok: false, error: `提案已处理（${p.status}）` };

    const action = p.action;
    // 确认期可行性校验（不写入）：new-skill 校验 SKILL.md 合法性；其余仅结构校验
    if (action.kind === "new-skill") {
      const pendingDir = resolve(this.deps.dataDir, "evolution", "pending-skills");
      mkdirSync(pendingDir, { recursive: true });
      const filePath = resolve(pendingDir, `${p.id}.md`);
      writeFileSync(filePath, action.body, "utf-8");
      const validation = skillEvolution.validate(filePath);
      unlinkSync(filePath);
      if (!validation.valid) {
        return { ok: false, error: `技能校验失败: ${validation.errors.join("; ")}` };
      }
    }

    this.proposer.save({ ...p, status: "confirmed" });
    this.proposer.appendLedger({
      at: Date.now(),
      event: "confirmed",
      id,
      type: p.type,
      title: p.title,
    });
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "evolution",
      sessionId: "",
      action: "evolution:adopt",
      target: id,
      result: "success",
      detail: `${p.type}: ${p.title}（已确认，待写入）`,
    });
    eventBus.broadcast({ type: "evolution/confirmed", proposalId: id });
    return { ok: true, preview: action };
  }

  /** 确认写入（第二步执行）：confirmed → applied，真正写入/生效 */
  async apply(id: string): Promise<{ ok: boolean; error?: string; jobId?: string; detail?: string }> {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status !== "confirmed") return { ok: false, error: `提案未确认或已处理（${p.status}）` };

    const action = p.action;
    let detail: string | undefined;
    let jobId: string | undefined;
    switch (action.kind) {
      case "new-skill": {
        const pendingDir = resolve(this.deps.dataDir, "evolution", "pending-skills");
        mkdirSync(pendingDir, { recursive: true });
        const filePath = resolve(pendingDir, `${p.id}.md`);
        writeFileSync(filePath, action.body, "utf-8");
        const registered = skillEvolution.register(filePath, action.expert);
        if (!registered) {
          unlinkSync(filePath);
          return { ok: false, error: "技能注册失败（可能重复或落盘失败）" };
        }
        detail = `技能已沉淀至 skills/${action.expert}/`;
        break;
      }
      case "new-tool":
      case "new-app": {
        if (!this.deps.submitGenerate) {
          return { ok: false, error: "生成队列未初始化" };
        }
        jobId = this.deps.submitGenerate({
          description: action.description,
          type: action.type,
          sessionId: "evolution",
        });
        detail = `生成任务已提交（jobId: ${jobId}）`;
        break;
      }
      case "config-change": {
        if (!this.deps.setConfigField) {
          return { ok: false, error: "配置通道未初始化" };
        }
        const result = this.deps.setConfigField(action.field, action.value);
        if (!result.ok) return { ok: false, error: result.error ?? "配置应用失败" };
        detail = `配置已更新: ${action.field}=${JSON.stringify(action.value)}`;
        break;
      }
      case "tool-fix":
        detail = `已记录建议（人工执行）: ${action.suggestion.slice(0, 100)}`;
        break;
      case "prompt-fix":
        detail = `已记录建议（人工执行）: ${action.suggestion.slice(0, 100)}`;
        break;
    }

    this.proposer.save({ ...p, status: "applied" });
    this.proposer.appendLedger({
      at: Date.now(),
      event: "applied",
      id,
      type: p.type,
      title: p.title,
      detail,
      jobId,
    });
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "evolution",
      sessionId: "",
      action: "evolution:apply",
      target: id,
      result: "success",
      detail: `${p.type}: ${p.title}${detail ? ` | ${detail}` : ""}`,
    });
    eventBus.broadcast({ type: "evolution/applied", proposalId: id, jobId, detail });
    return { ok: true, jobId, detail };
  }

  /** 拒绝（pending 或 confirmed 均可撤销） */
  reject(id: string): { ok: boolean; error?: string } {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status === "applied" || p.status === "rejected") {
      return { ok: false, error: `提案已处理（${p.status}）` };
    }
    this.proposer.save({ ...p, status: "rejected" });
    this.proposer.appendLedger({
      at: Date.now(),
      event: "rejected",
      id,
      type: p.type,
      title: p.title,
    });
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "evolution",
      sessionId: "",
      action: "evolution:reject",
      target: id,
      result: "success",
      detail: `${p.type}: ${p.title}`,
    });
    eventBus.broadcast({ type: "evolution/rejected", proposalId: id });
    return { ok: true };
  }
}

export function createEvolutionEngine(deps: EvolutionEngineDeps): EvolutionEngine {
  return new EvolutionEngine(deps);
}
