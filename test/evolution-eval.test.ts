/**
 * 进化评测单测（Sprint 41 第三期）
 * 覆盖：decideVerdict 阈值（A 相对线 / C 绝对线 / 边界 / unknown）、runEval 编排（调用次数/skipped/超限/expected 传入/latency 仅报告）
 */

import { describe, it, expect, vi } from "vitest";
import { decideVerdict, runEval, notEvaluableReport, MAX_EVAL_CASES, type ScoreCase } from "../src/core/evolution-eval.js";
import type { EvolutionCase } from "../src/core/evolution-cases.js";

function makeCase(partial: Partial<EvolutionCase> = {}): EvolutionCase {
  return {
    id: `c-${partial.createdAt ?? 0}`,
    input: "任务",
    source: "manual",
    createdAt: 0,
    ...partial,
  };
}

describe("decideVerdict", () => {
  it("A 相对线：基线>0 且新 < 旧-0.2 → regress", () => {
    expect(decideVerdict({ hasBaseline: true, baselinePassRate: 0.8, candidatePassRate: 0.5, total: 5 })).toBe("regress");
  });

  it("边界：恰等于 -0.2 不算回归（超阈值语义）", () => {
    expect(decideVerdict({ hasBaseline: true, baselinePassRate: 0.8, candidatePassRate: 0.6, total: 5 })).toBe("pass");
  });

  it("基线为 0 不走 A 线（无法比较），由绝对线裁决", () => {
    expect(decideVerdict({ hasBaseline: true, baselinePassRate: 0, candidatePassRate: 0.3, total: 5 })).toBe("regress");
  });

  it("C 绝对线：计分 ≥2 且新 <0.5 → regress；无基线同样生效", () => {
    expect(decideVerdict({ hasBaseline: false, baselinePassRate: 0, candidatePassRate: 0.4, total: 3 })).toBe("regress");
    expect(decideVerdict({ hasBaseline: false, baselinePassRate: 0, candidatePassRate: 0.6, total: 3 })).toBe("pass");
  });

  it("单用例（total=1）不触发绝对线（防噪声）", () => {
    expect(decideVerdict({ hasBaseline: false, baselinePassRate: 0, candidatePassRate: 0, total: 1 })).toBe("pass");
  });

  it("0 计分用例 → unknown", () => {
    expect(decideVerdict({ hasBaseline: true, baselinePassRate: 0, candidatePassRate: 0, total: 0 })).toBe("unknown");
  });
});

describe("runEval", () => {
  it("有基线：每用例调裁判 2 次，前后成功率/耗时正确汇总", async () => {
    const scoreCase: ScoreCase = vi.fn(async (task, text) => ({
      ok: text === "新",  // 旧失败 新成功
      latencyMs: 10,
    }));
    const cases = [
      makeCase({ id: "c1", createdAt: 1 }),
      makeCase({ id: "c2", createdAt: 2 }),
    ];
    const report = await runEval({ before: "旧", after: "新", cases, scoreCase });
    expect(scoreCase).toHaveBeenCalledTimes(4);
    expect(report.hasBaseline).toBe(true);
    expect(report.baselinePassRate).toBe(0);
    expect(report.candidatePassRate).toBe(1);
    expect(report.deltaRate).toBe(1);
    expect(report.beforeLatencyMs).toBe(10);
    expect(report.afterLatencyMs).toBe(10);
    expect(report.verdict).toBe("pass");
    expect(report.results).toHaveLength(2);
    expect(report.results[0]!.beforeOk).toBe(false);
    expect(report.results[0]!.afterOk).toBe(true);
  });

  it("无基线：每用例只调 after 1 次", async () => {
    const scoreCase = vi.fn(async () => ({ ok: true }));
    const report = await runEval({ before: undefined, after: "新", cases: [makeCase({ id: "c1" })], scoreCase });
    expect(scoreCase).toHaveBeenCalledTimes(1);
    expect(report.hasBaseline).toBe(false);
  });

  it("expected 传入裁判", async () => {
    const scoreCase = vi.fn(async () => ({ ok: true }));
    await runEval({ before: "旧", after: "新", cases: [makeCase({ id: "c1", expected: "期望" })], scoreCase });
    expect(scoreCase).toHaveBeenCalledWith("任务", "旧", "期望");
    expect(scoreCase).toHaveBeenCalledWith("任务", "新", "期望");
  });

  it("裁判抛错 → 该用例 skipped，不计入分母", async () => {
    const scoreCase: ScoreCase = vi.fn(async () => {
      throw new Error("llm down");
    });
    const report = await runEval({ before: "旧", after: "新", cases: [makeCase({ id: "c1" }), makeCase({ id: "c2" })], scoreCase });
    expect(report.skipped).toBe(2);
    expect(report.total).toBe(0);
    expect(report.verdict).toBe("unknown");
  });

  it("before 抛错 after 成功 → 整用例跳过（保守不计分）", async () => {
    const scoreCase: ScoreCase = vi.fn(async (task, text) => {
      if (text === "旧") throw new Error("down");
      return { ok: true };
    });
    const report = await runEval({ before: "旧", after: "新", cases: [makeCase({ id: "c1" })], scoreCase });
    expect(report.skipped).toBe(1);
    expect(report.total).toBe(0);
  });

  it("超限取最近 maxCases 条（按 createdAt 降序）", async () => {
    const scoreCase = vi.fn(async () => ({ ok: true }));
    const cases = Array.from({ length: MAX_EVAL_CASES + 3 }, (_, i) => makeCase({ id: `c${i}`, createdAt: i }));
    const report = await runEval({ before: "旧", after: "新", cases, scoreCase, maxCases: 3 });
    expect(report.total).toBe(3);
    expect(report.results.map((r) => r.caseId)).toEqual(["c7", "c6", "c5"]);
  });

  it("verdict 汇总：回归场景（新 < 旧-0.2）", async () => {
    const scoreCase: ScoreCase = vi.fn(async (task, text) => ({ ok: text === "旧" }));
    const cases = [makeCase({ id: "c1" }), makeCase({ id: "c2" }), makeCase({ id: "c3" }), makeCase({ id: "c4" }), makeCase({ id: "c5" })];
    const report = await runEval({ before: "旧", after: "新", cases, scoreCase });
    expect(report.baselinePassRate).toBe(1);
    expect(report.candidatePassRate).toBe(0);
    expect(report.verdict).toBe("regress");
  });

  it("latency 仅报告不参与裁决（裁判耗时与执行耗时无关）", async () => {
    const scoreCase: ScoreCase = vi.fn(async () => ({ ok: true, latencyMs: 9999 }));
    const report = await runEval({ before: "旧", after: "新", cases: [makeCase({ id: "c1" })], scoreCase });
    expect(report.beforeLatencyMs).toBe(9999);
    expect(report.verdict).toBe("pass");
  });
});

describe("notEvaluableReport", () => {
  it("new-skill 等返回 not-evaluable + 原因", () => {
    const report = notEvaluableReport("new-skill");
    expect(report.verdict).toBe("not-evaluable");
    expect(report.reason).toContain("无文本可比对");
  });
});
