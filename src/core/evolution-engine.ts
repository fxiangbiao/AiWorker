/**
 * 进化引擎（Sprint 39 第一期 + Sprint 40 第二期：补丁生效 + 快照回滚）
 * 闭环: observe（派生指标）→ propose（meta-agent 提案）→ adopt（确认提案内容，不写入）
 *       → apply（确认写入，真正执行）→ applied；reject 可随时撤销；rollback 快照还原（→ rolled_back）
 * 护栏: 提案仅建议、用户确认；写入前二次确认（adopt ≠ 写入）；每日限频（proposer 内）；
 *       写入前快照、回滚硬能力；全部动作审计 + evolution/* 事件
 */

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { EvolutionObservation, EvolutionPreview, EvolutionProposal } from "../types.js";
import type { ModelRouter } from "./model-router.js";
import { observeEvolution, type ObservationDeps } from "./evolution-observer.js";
import { EvolutionProposer, countTodayProposals } from "./evolution-proposer.js";
import {
  captureSnapshot,
  readSnapshot,
  restoreSnapshot,
  snapshotDir,
  type RestoreHooks,
  type SnapshotDeps,
} from "./evolution-snapshot.js";
import { skillEvolution } from "./skill-evolution.js";
import { buildChangeView, type ChangeView } from "./evolution-diff.js";
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
  readLedger?(limit?: number): Record<string, unknown>[];
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
  /** tool-fix 写入：热覆盖工具描述（index.ts 闭包；未注入则 tool-fix 写入失败） */
  patchToolDescription?: (toolName: string, newDescription: string) => { ok: boolean; error?: string };
  /** prompt-fix 写入：替换智能体提示词 + 热重载（index.ts 闭包；未注入则 prompt-fix 写入失败） */
  applyPromptFix?: (agentId: string, newPrompt: string) => { ok: boolean; error?: string };
  /** 快照路径与工具定义（rollback 用；缺省从默认路径构造） */
  snapshot?: SnapshotDeps;
  /** 回滚联动钩子（skill/agent 热重载；缺省 no-op） */
  restoreHooks?: RestoreHooks;
}

export class EvolutionEngine {
  private proposer: ProposalStore;

  constructor(private deps: EvolutionEngineDeps) {
    const dir = resolve(deps.dataDir, "evolution");
    mkdirSync(resolve(dir, "proposals"), { recursive: true });
    mkdirSync(snapshotDir(deps.dataDir), { recursive: true });
    this.proposer =
      deps.proposer ??
      new EvolutionProposer({
        modelRouter: deps.modelRouter as never,
        dataDir: deps.dataDir,
        todayCount: () => countTodayProposals(this.list()),
      });
  }

  /** 默认快照 deps（生产路径；测试注入覆盖） */
  private snapshotDeps(): SnapshotDeps {
    return (
      this.deps.snapshot ?? {
        dataDir: this.deps.dataDir,
        skillsDir: resolve(process.cwd(), "skills"),
        agentsDir: resolve(process.cwd(), "config", "agents"),
        runtimeConfigPath: resolve(this.deps.dataDir, "runtime-config.json"),
        getToolDefinition: () => undefined,
      }
    );
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
      let validation;
      try {
        validation = skillEvolution.validate(filePath);
      } finally {
        try { unlinkSync(filePath); } catch { /* 临时文件清理失败不影响 */ }
      }
      if (!validation!.valid) {
        return { ok: false, error: `技能校验失败: ${validation!.errors.join("; ")}` };
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

  /** 确认写入（第二步执行）：confirmed → applied，真正写入/生效（写入前先快照） */
  async apply(id: string): Promise<{ ok: boolean; error?: string; jobId?: string; detail?: string }> {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status !== "confirmed") return { ok: false, error: `提案未确认或已处理（${p.status}）` };

    // 写入前快照（失败不阻断写入，记审计 warning；回滚能力降级）
    try {
      const snap = captureSnapshot(this.snapshotDeps(), id, p.action);
      const snapPath = resolve(snapshotDir(this.deps.dataDir), `${id}.json`);
      writeFileSync(snapPath, JSON.stringify(snap, null, 2), "utf-8");
    } catch (err) {
      auditLogger.log({
        timestamp: Date.now(),
        agentId: "evolution",
        sessionId: "",
        action: "evolution:snapshot-failed",
        target: id,
        result: "error",
        detail: (err as Error).message.slice(0, 200),
      });
    }

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
          try { unlinkSync(filePath); } catch { /* 清理失败不影响 */ }
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
      case "tool-fix": {
        if (!this.deps.patchToolDescription) {
          return { ok: false, error: "工具描述更新通道未初始化" };
        }
        if (!action.newDescription) {
          return { ok: false, error: "提案缺少工具描述改进（newDescription），无法应用（旧格式提案请重新提议）" };
        }
        const result = this.deps.patchToolDescription(action.toolName, action.newDescription);
        if (!result.ok) return { ok: false, error: result.error ?? "工具描述更新失败" };
        detail = `工具描述已更新: ${action.toolName}（本次运行生效，重启回内置默认）`;
        break;
      }
      case "prompt-fix": {
        if (!this.deps.applyPromptFix) {
          return { ok: false, error: "提示词更新通道未初始化" };
        }
        if (!action.newPrompt) {
          return { ok: false, error: "提案缺少提示词改进（newPrompt），无法应用（旧格式提案请重新提议）" };
        }
        const result = this.deps.applyPromptFix(action.agentId, action.newPrompt);
        if (!result.ok) return { ok: false, error: result.error ?? "提示词更新失败" };
        detail = `提示词已更新并热重载: ${action.agentId}`;
        break;
      }
    }

    this.proposer.save({ ...p, status: "applied" });
    const now = Date.now();
    this.proposer.appendLedger({
      at: now,
      event: "applied",
      id,
      type: p.type,
      title: p.title,
      detail,
      jobId,
    });
    // new-tool/new-app：记录生成任务待回写（供 onGenResult 匹配）
    if (jobId) {
      this.proposer.appendLedger({
        at: now,
        event: "generated-submitted",
        id,
        jobId,
        type: p.type,
        title: p.title,
      });
    }
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

  /** 回滚（快照还原）：applied → rolled_back（终态）；仅 applied 可回滚 */
  rollback(id: string): { ok: boolean; error?: string; detail?: string; jobId?: string } {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status !== "applied") {
      return { ok: false, error: p.status === "rolled_back" ? "提案已回滚（终态）" : `仅已写入（applied）提案可回滚（当前 ${p.status}）` };
    }
    if (p.type === "new-tool" || p.type === "new-app") {
      const jobId = this.findJobId(id);
      return {
        ok: false,
        error: "该类型无可回滚快照（生成物可在「应用」Tab 销毁）",
        jobId,
      };
    }
    const snap = readSnapshot(this.deps.dataDir, id);
    if (!snap) {
      return { ok: false, error: "快照不存在，无法回滚（写入时快照失败）" };
    }
    // tool-fix 回滚依赖 restoreHooks.registerTool（index.ts 注入）；缺省 no-op 会导致虚假成功
    if (snap.tools.length > 0 && !this.deps.restoreHooks?.registerTool) {
      return { ok: false, error: "回滚联动未初始化（registerTool 缺失），无法恢复工具描述" };
    }
    const restored = restoreSnapshot(this.snapshotDeps(), snap, this.deps.restoreHooks ?? { registerTool: () => {} });
    if (!restored.ok) return { ok: false, error: restored.detail };
    // config-change：内存覆盖值需重启后回退（detail 注明）
    const finalDetail =
      p.type === "config-change"
        ? `${restored.detail}（内存配置重启后生效）`
        : restored.detail;

    this.proposer.save({ ...p, status: "rolled_back" });
    this.proposer.appendLedger({
      at: Date.now(),
      event: "rolled_back",
      id,
      type: p.type,
      title: p.title,
      detail: finalDetail,
    });
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "evolution",
      sessionId: "",
      action: "evolution:rollback",
      target: id,
      result: "success",
      detail: `${p.type}: ${p.title} | ${finalDetail}`,
    });
    eventBus.broadcast({ type: "evolution/rolled_back", proposalId: id, detail: finalDetail });
    return { ok: true, detail: finalDetail };
  }

  /** 台账尾部 N 条 */
  ledger(limit = 20): Record<string, unknown>[] {
    return this.proposer.readLedger?.(limit) ?? [];
  }

  /** 生成任务结果回写（index.ts 桥接 gen/done|failed|canceled）：按 jobId 匹配提案，ledger 记 generated */
  onGenResult(jobId: string, ok: boolean, appId?: string, canceled?: boolean): void {
    const entries = this.proposer.readLedger?.(500) ?? [];
    const submitted = [...entries].reverse().find((e) => e.event === "generated-submitted" && e.jobId === jobId);
    if (!submitted) return;
    this.proposer.appendLedger({
      at: Date.now(),
      event: "generated",
      id: submitted.id,
      jobId,
      ok,
      appId,
      canceled: canceled === true,
      type: submitted.type,
      title: submitted.title,
    });
    eventBus.broadcast({ type: "evolution/generated", proposalId: submitted.id, jobId, ok, appId, canceled: canceled === true });
  }

  /** 变更对比视图（before=快照，after=提案 action；供 Web/CLI 展示进化前后差异） */
  change(id: string): { ok: boolean; error?: string; view?: ChangeView } {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    const snap = readSnapshot(this.deps.dataDir, id);
    return { ok: true, view: buildChangeView(p, snap) };
  }

  /** 从 ledger 反查提案关联的 jobId（new-tool/new-app 回滚提示用） */
  private findJobId(id: string): string | undefined {
    const entries = this.proposer.readLedger?.(500) ?? [];
    const applied = entries.find((e) => e.event === "applied" && e.id === id);
    return applied?.jobId as string | undefined;
  }

  /** 拒绝（pending 或 confirmed 均可撤销；applied/rolled_back 终态不可） */
  reject(id: string): { ok: boolean; error?: string } {
    const p = this.proposer.get(id);
    if (!p) return { ok: false, error: `提案不存在: ${id}` };
    if (p.status === "applied" || p.status === "rejected" || p.status === "rolled_back") {
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
