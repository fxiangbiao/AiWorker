/**
 * 进化引擎第三期单测（Sprint 41：A/B 评测 + 推广后验证 + 自动回滚）
 * 覆盖：before 双轨（快照/实时/无基线）、eval 不动作与状态门、verify 三态（regress 自动回滚/pass/unknown）、not-evaluable、端点
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { EvolutionEngine } from "../src/core/evolution-engine.js";
import { EvolutionCases } from "../src/core/evolution-cases.js";
import { captureSnapshot, type SnapshotDeps } from "../src/core/evolution-snapshot.js";
import { auditLogger } from "../src/core/audit-logger.js";
import { buildCliCommands } from "../src/commands/registry.js";
import type { CliCommand, CommandContext } from "../src/commands/types.js";
import type { EvolutionProposal, ToolDefinition } from "../src/types.js";
import type { ScoreCase } from "../src/core/evolution-eval.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("evolution-verify");
  setupEnv(dir);
});

afterEach(() => {
  teardownEnv();
});

function snapshotDeps(): SnapshotDeps {
  return {
    dataDir: dir,
    skillsDir: resolve(dir, "skills"),
    agentsDir: resolve(dir, "agents"),
    runtimeConfigPath: resolve(dir, "runtime-config.json"),
    getToolDefinition: () => def("原描述"),
  };
}

function def(description: string): ToolDefinition {
  return {
    type: "function",
    function: { name: "fs_read", description, parameters: { type: "object", properties: {} } },
  };
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof EvolutionEngine>[0]> = {}) {
  const base: ConstructorParameters<typeof EvolutionEngine>[0] = {
    dataDir: dir,
    observation: { listSessions: () => [], getEvents: () => [] },
    modelRouter: undefined as never,
    submitGenerate: (spec) => `job-${spec.type}`,
    setConfigField: (field, value) => ({ ok: true }),
    patchToolDescription: () => ({ ok: true }),
    scoreCase: async () => ({ ok: true }),
    snapshot: snapshotDeps(),
    restoreHooks: { registerTool: vi.fn(), reloadSkill: vi.fn(), unloadSkill: vi.fn(), reloadAgent: vi.fn() },
    ...overrides,
  };
  return new EvolutionEngine(base);
}

function seed(engine: EvolutionEngine, p: EvolutionProposal): void {
  (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
}

function proposal(partial: Partial<EvolutionProposal>): EvolutionProposal {
  return {
    id: "evo-p",
    type: "tool-fix",
    title: "测试",
    reason: "依据",
    action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
    risk: "low",
    status: "pending",
    createdAt: Date.now(),
    ...partial,
  };
}

/** 造 3 条黄金用例（engine.addCase 公开 API） */
function seedCases(engine: EvolutionEngine, n = 3): void {
  for (let i = 0; i < n; i++) engine.addCase(`任务 ${i}`);
}

/** 裁判：旧文本通过、新文本失败（用于回归场景） */
function regressJudge(): ScoreCase {
  return async (task, text) => ({ ok: text === "原描述" || text === "旧提示词", latencyMs: 5 });
}

// ===== before 双轨 =====

describe("eval before 双轨", () => {
  it("applied 走快照（extractBefore 现成逻辑）", async () => {
    const engine = makeEngine({ scoreCase: regressJudge() });
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-a1", status: "confirmed" }));
    await engine.apply("evo-a1"); // 快照落盘（tools 含原描述）

    const result = await engine.eval("evo-a1");
    expect(result.ok).toBe(true);
    expect(result.report!.hasBaseline).toBe(true);
    expect(result.report!.baselinePassRate).toBe(1);
    expect(result.report!.candidatePassRate).toBe(0);
    expect(result.report!.verdict).toBe("regress");
  });

  it("pending 走实时定义（getToolDescription）", async () => {
    const getToolDescription = vi.fn(() => "实时描述");
    const calls: string[] = [];
    const scoreCase: ScoreCase = async (task, text) => { calls.push(text); return { ok: true }; };
    const engine = makeEngine({ getToolDescription, scoreCase });
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-a2" }));

    const result = await engine.eval("evo-a2");
    expect(result.report!.hasBaseline).toBe(true);
    expect(getToolDescription).toHaveBeenCalledWith("fs_read");
    expect(calls).toContain("实时描述");
    expect(calls).toContain("新描述");
  });

  it("apply 失败残留快照但 confirmed 仍取实时（按 status 选源）", async () => {
    const getToolDescription = vi.fn(() => "实时描述");
    const calls: string[] = [];
    const scoreCase: ScoreCase = async (task, text) => { calls.push(text); return { ok: true }; };
    const engine = makeEngine({ getToolDescription, scoreCase });
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-a3", status: "confirmed" }));
    // 手工落一份残留快照（模拟 apply 中途失败）
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    const snap = captureSnapshot(snapshotDeps(), "evo-a3", {
      kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述",
    });
    writeFileSync(resolve(dir, "evolution", "snapshots", "evo-a3.json"), JSON.stringify(snap), "utf-8");

    await engine.eval("evo-a3");
    expect(calls).toContain("实时描述");
    expect(calls).not.toContain("原描述");
  });

  it("旧数据无基线：仅跑候选，hasBaseline=false", async () => {
    const engine = makeEngine(); // 无 getToolDescription
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-a4" }));
    const result = await engine.eval("evo-a4");
    expect(result.report!.hasBaseline).toBe(false);
    expect(result.report!.results[0]!.beforeOk).toBe(false);
  });
});

// ===== eval =====

describe("eval（仅评测不动作）", () => {
  it("状态不变 + ledger 追加 eval 摘要", async () => {
    const engine = makeEngine();
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-e1" }));
    const result = await engine.eval("evo-e1");
    expect(result.ok).toBe(true);
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-e1.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("pending"); // 不动作
    const entries = engine.ledger(20);
    const evalEntry = entries.find((e) => e.event === "eval" && e.id === "evo-e1");
    expect(evalEntry).toBeTruthy();
    expect(evalEntry!.verdict).toBe(result.report!.verdict);
  });

  it("rolled_back/rejected 拒绝评测", async () => {
    const engine = makeEngine();
    seedCases(engine, 1);
    seed(engine, proposal({ id: "evo-e2", status: "rolled_back" }));
    const result = await engine.eval("evo-e2");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("终态");
  });

  it("new-app 不可评测（not-evaluable，无 ledger eval 条目）", async () => {
    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-e3", type: "new-app",
      action: { kind: "new-app", description: "番茄钟", type: "app" },
    }));
    const result = await engine.eval("evo-e3");
    expect(result.ok).toBe(true);
    expect(result.report!.verdict).toBe("not-evaluable");
    expect(engine.ledger(20).filter((e) => e.event === "eval")).toHaveLength(0);
  });

  it("用例库为空 → 明确错误", async () => {
    const engine = makeEngine();
    seed(engine, proposal({ id: "evo-e4" }));
    const result = await engine.eval("evo-e4");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("黄金用例库为空");
  });

  it("scoreCase 未注入 → 明确错误", async () => {
    const engine = makeEngine({ scoreCase: undefined });
    seedCases(engine, 1);
    seed(engine, proposal({ id: "evo-e5" }));
    const result = await engine.eval("evo-e5");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scoreCase");
  });
});

// ===== verify =====

describe("verify（推广后验证 + 自动回滚）", () => {
  it("仅 applied 可验证", async () => {
    const engine = makeEngine();
    seedCases(engine, 1);
    seed(engine, proposal({ id: "evo-v1", status: "confirmed" }));
    const result = await engine.verify("evo-v1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("仅已写入");
  });

  it("regress → 自动回滚（doRollback auto 单路径：rolled_back + 审计 + 广播）", async () => {
    const engine = makeEngine({ scoreCase: regressJudge() });
    seedCases(engine, 5);
    seed(engine, proposal({ id: "evo-v2", status: "confirmed" }));
    await engine.apply("evo-v2"); // applied + 快照
    expect(existsSync(resolve(dir, "evolution", "snapshots", "evo-v2.json"))).toBe(true);

    const auditSpy = vi.spyOn(auditLogger, "log");
    let broadcasted: unknown = null;
    const { eventBus } = await import("../src/server/event-bus.js");
    const unsub = eventBus.subscribe((d) => { broadcasted = d; });

    const result = await engine.verify("evo-v2");
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(true);
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-v2.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("rolled_back");
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "evolution:auto_rolled_back", target: "evo-v2" }));
    expect(broadcasted).toMatchObject({ type: "evolution/auto_rolled_back", proposalId: "evo-v2", evalNote: expect.stringContaining("评测回归") });
    const entries = engine.ledger(20);
    const rb = entries.find((e) => e.event === "rolled_back" && e.id === "evo-v2");
    expect(rb).toMatchObject({ source: "auto" });
    unsub();
    auditSpy.mockRestore();
  });

  it("pass → 记 verified，状态保持 applied，不回滚", async () => {
    const scoreCase: ScoreCase = async () => ({ ok: true });
    const engine = makeEngine({ scoreCase });
    seedCases(engine, 3);
    seed(engine, proposal({ id: "evo-v3", status: "confirmed" }));
    await engine.apply("evo-v3");
    const result = await engine.verify("evo-v3");
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBeUndefined();
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-v3.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied");
    const entries = engine.ledger(20);
    expect(entries.find((e) => e.event === "verified" && e.id === "evo-v3")?.verdict).toBe("pass");
  });

  it("unknown（全部 skipped）→ 记 verified 不动作", async () => {
    const scoreCase: ScoreCase = async () => { throw new Error("down"); };
    const engine = makeEngine({ scoreCase });
    seedCases(engine, 3);
    seed(engine, proposal({ id: "evo-v4", status: "confirmed" }));
    await engine.apply("evo-v4");
    const result = await engine.verify("evo-v4");
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBeUndefined();
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-v4.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied");
    expect(engine.ledger(20).find((e) => e.event === "verified" && e.id === "evo-v4")?.verdict).toBe("unknown");
  });

  it("not-evaluable（new-app applied）→ 报告不动作", async () => {
    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-v5", type: "new-app", status: "applied",
      action: { kind: "new-app", description: "番茄钟", type: "app" },
    }));
    const result = await engine.verify("evo-v5");
    expect(result.ok).toBe(true);
    expect(result.report!.verdict).toBe("not-evaluable");
    expect(result.rolledBack).toBeUndefined();
  });

  it("regress 但无快照 → 明确报错，不自动回滚", async () => {
    const engine = makeEngine({ scoreCase: regressJudge() });
    seedCases(engine, 3);
    seed(engine, proposal({ id: "evo-v6", status: "applied" })); // 直接置 applied，无快照
    const result = await engine.verify("evo-v6");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("快照不存在");
  });

  it("manual rollback 不受影响（回归：状态机仍 manual 审计）", async () => {
    const engine = makeEngine();
    seed(engine, proposal({ id: "evo-v7", status: "confirmed" }));
    await engine.apply("evo-v7");
    const auditSpy = vi.spyOn(auditLogger, "log");
    const result = engine.rollback("evo-v7");
    expect(result.ok).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "evolution:rollback" }));
    auditSpy.mockRestore();
  });
});

// ===== cases 透传 =====

describe("engine 用例库透传", () => {
  it("addCase/listCases/deleteCase/extractCases", () => {
    const engine = makeEngine();
    const c = engine.addCase("整理周报", "输出周报");
    expect(c.ok).toBe(true);
    expect(engine.listCases(10)).toHaveLength(1);
    expect(engine.listCases(10)[0]!.expected).toBe("输出周报");
    expect(engine.deleteCase(c.case!.id).ok).toBe(true);
    expect(engine.listCases(10)).toHaveLength(0);
  });

  it("addCase 空任务拒绝；extractCases 空会话返回 0", () => {
    const engine = makeEngine();
    expect(engine.addCase("  ").ok).toBe(false);
    expect(engine.extractCases()).toEqual({ added: 0, skipped: 0 });
  });

  it("extractCases 从会话事件提取（注入 store + 事件源）", () => {
    const now = Date.now();
    const casesStore = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const engine = makeEngine({
      cases: casesStore,
      observation: {
        listSessions: () => [{ id: "s1", updatedAt: now, turnCount: 1, firstUserMsg: null }],
        getEvents: () => [
          { seq: 0, sessionId: "s1", type: "turn/start", data: { turn: 1 }, createdAt: now },
          { seq: 1, sessionId: "s1", type: "user/message", data: { role: "user", content: "帮我写周报" } as unknown as Record<string, unknown>, createdAt: now },
          { seq: 2, sessionId: "s1", type: "turn/end", data: { turn: 1, reason: "stop" }, createdAt: now },
          { seq: 3, sessionId: "s1", type: "assistant/message", data: { message: { role: "assistant", content: "好的" } }, createdAt: now },
        ],
      },
    });
    expect(engine.extractCases()).toEqual({ added: 1, skipped: 0 });
    expect(engine.listCases(10)[0]!.source).toBe("session");
  });
});

// ===== CLI /evo case / eval / verify =====

describe("CLI /evo 第三期命令", () => {
  const commands: CliCommand[] = buildCliCommands();

  function find(name: string): CliCommand {
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) throw new Error(`command not found: ${name}`);
    return cmd;
  }

  function makeCtx(engine: EvolutionEngine): { ctx: CommandContext; writes: string[] } {
    const writes: string[] = [];
    const ctx = {
      mode: () => "auto" as const,
      setMode: () => {},
      showThinking: () => false,
      toggleThinking: () => {},
      currentSessionId: () => undefined,
      setCurrentSessionId: () => {},
      prefillQueue: [],
      lastAnswer: { value: "" },
      agents: {},
      currentAgent: () => ({}) as never,
      coordinator: {} as never,
      modelRouter: {} as never,
      sessionStore: {} as never,
      skillCount: 0,
      workingDir: dir,
      runtimeConfigPath: resolve(dir, "runtime-config.json"),
      persistRuntimeConfig: () => {},
      getContextBreakdown: () => ({}),
      listCommands: () => commands,
      evolutionEngine: engine,
      write: (t: string) => writes.push(t),
      writeLine: (l: string) => writes.push(l),
      printStatus: () => {},
      ask: () => Promise.resolve(null),
    } as unknown as CommandContext;
    return { ctx, writes };
  }

  it("/evo case add <任务> [期望] 手工补录（期望为剩余参数 join）", async () => {
    const engine = makeEngine();
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "case add 整理周报 输出 markdown", "/evo case add 整理周报 输出 markdown");
    const joined = writes.join("\n");
    expect(joined).toContain("已补录");
    expect(engine.listCases(10)).toHaveLength(1);
    expect(engine.listCases(10)[0]!.expected).toBe("输出 markdown");
  });

  it("/evo case list 展示用例", async () => {
    const engine = makeEngine();
    engine.addCase("整理周报");
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "case list", "/evo case list");
    expect(writes.join("\n")).toContain("整理周报");
  });

  it("/evo case delete <id> 删除用例", async () => {
    const engine = makeEngine();
    const c = engine.addCase("整理周报").case!;
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, `case delete ${c.id}`, `/evo case delete ${c.id}`);
    expect(writes.join("\n")).toContain("已删除");
    expect(engine.listCases(10)).toHaveLength(0);
  });

  it("/evo case extract 提取用例并报告新增/跳过", async () => {
    const engine = makeEngine();
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "case extract", "/evo case extract");
    expect(writes.join("\n")).toContain("新增 0 条");
  });

  it("/evo eval <id> 输出评测报告（通过徽标）", async () => {
    const engine = makeEngine({ scoreCase: async () => ({ ok: true }) });
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-cli-eval" }));
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "eval evo-cli-eval", "/evo eval evo-cli-eval");
    const joined = writes.join("\n");
    expect(joined).toContain("✅ 通过");
    expect(joined).toContain("计分用例 2");
  });

  it("/evo eval 无 id 提示用法", async () => {
    const engine = makeEngine();
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "eval", "/evo eval");
    expect(writes.join("\n")).toContain("用法");
  });

  it("/evo verify <id> 回归自动回滚提示", async () => {
    const engine = makeEngine({ scoreCase: regressJudge() });
    seedCases(engine, 2);
    seed(engine, proposal({ id: "evo-cli-v", status: "confirmed" }));
    await engine.apply("evo-cli-v");
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "verify evo-cli-v", "/evo verify evo-cli-v");
    const joined = writes.join("\n");
    expect(joined).toContain("🔻 回归");
    expect(joined).toContain("已自动回滚");
  });
});
