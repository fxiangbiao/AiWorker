/**
 * 进化评测（Sprint 41 第三期）— A/B 量化对比 + 阈值裁决
 * runEval: 每用例对 before/after 各调裁判 scoreCase(task, text, expected?) → ok
 * 护栏: MAX_EVAL_CASES=5（取最近）；裁判失败按用例跳过不计分母；耗时仅报告不裁决（裁判调用耗时≠工具执行耗时）
 */

import type { EvolutionCase } from "./evolution-cases.js";

/** 每次评测用例数上限（预算内试运行：≤2×5 次裁判调用） */
export const MAX_EVAL_CASES = 5;
/** 相对回归阈值：新成功率低于旧 -0.2 判回归（严格小于，恰等于不算） */
export const REGRESS_DELTA = 0.2;
/** 绝对回归阈值：候选成功率 < 0.5 且计分用例 ≥2 判回归 */
export const REGRESS_ABSOLUTE = 0.5;
export const REGRESS_MIN_TOTAL = 2;

export type EvalVerdict = "pass" | "regress" | "unknown" | "not-evaluable";

export interface EvalCaseResult {
  caseId: string;
  beforeOk: boolean;
  afterOk: boolean;
  reason?: string;
  beforeLatencyMs?: number;
  afterLatencyMs?: number;
}

export interface ScoreOutcome {
  ok: boolean;
  reason?: string;
  latencyMs?: number;
}

/** 评测裁判（index.ts 闭包：modelRouter 判断文本是否足以引导正确完成；测试注入 mock） */
export type ScoreCase = (task: string, text: string, expected?: string) => Promise<ScoreOutcome> | ScoreOutcome;

export interface EvalReport {
  total: number;
  skipped: number;
  hasBaseline: boolean;
  baselinePassRate: number;
  candidatePassRate: number;
  deltaRate: number;
  beforeLatencyMs?: number;
  afterLatencyMs?: number;
  verdict: EvalVerdict;
  reason?: string;
  results: EvalCaseResult[];
}

export interface RunEvalInput {
  before?: string;
  after: string;
  cases: EvolutionCase[];
  scoreCase: ScoreCase;
  maxCases?: number;
}

/** 阈值裁决（纯函数，单测直接覆盖）：A 相对线 + C 绝对线；0 用例 unknown */
export function decideVerdict(p: {
  hasBaseline: boolean;
  baselinePassRate: number;
  candidatePassRate: number;
  total: number;
}): EvalVerdict {
  const { hasBaseline, baselinePassRate, candidatePassRate, total } = p;
  if (total === 0) return "unknown";
  // 浮点 epsilon：0.8 - 0.2 = 0.6000000000000001，恰等于阈值不算回归（超阈值语义）
  if (hasBaseline && baselinePassRate > 0 && candidatePassRate < baselinePassRate - REGRESS_DELTA - 1e-9) {
    return "regress";
  }
  if (total >= REGRESS_MIN_TOTAL && candidatePassRate < REGRESS_ABSOLUTE) return "regress";
  return "pass";
}

/** A/B 评测编排：用例取最近 maxCases 条；单用例裁判失败按 skipped 跳过（不计分母） */
export async function runEval(input: RunEvalInput): Promise<EvalReport> {
  const max = input.maxCases ?? MAX_EVAL_CASES;
  const cases = [...input.cases].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
  const hasBaseline = input.before !== undefined;
  const results: EvalCaseResult[] = [];
  let beforePass = 0;
  let afterPass = 0;
  let beforeLat = 0;
  let afterLat = 0;
  let beforeN = 0;
  let afterN = 0;
  let skipped = 0;

  for (const c of cases) {
    const r: EvalCaseResult = { caseId: c.id, beforeOk: false, afterOk: false };
    if (hasBaseline) {
      try {
        const out = await input.scoreCase(c.input, input.before!, c.expected);
        r.beforeOk = out.ok;
        r.beforeLatencyMs = out.latencyMs;
        r.reason = out.reason;
        beforePass += out.ok ? 1 : 0;
        beforeLat += out.latencyMs ?? 0;
        beforeN++;
      } catch {
        skipped++;
        continue;
      }
    }
    try {
      const out = await input.scoreCase(c.input, input.after, c.expected);
      r.afterOk = out.ok;
      r.afterLatencyMs = out.latencyMs;
      r.reason = r.reason ?? out.reason;
      afterPass += out.ok ? 1 : 0;
      afterLat += out.latencyMs ?? 0;
      afterN++;
    } catch {
      skipped++;
      continue;
    }
    results.push(r);
  }

  const baselinePassRate = beforeN > 0 ? beforePass / beforeN : 0;
  const candidatePassRate = afterN > 0 ? afterPass / afterN : 0;
  return {
    total: results.length,
    skipped,
    hasBaseline,
    baselinePassRate,
    candidatePassRate,
    deltaRate: candidatePassRate - baselinePassRate,
    beforeLatencyMs: beforeN > 0 ? beforeLat / beforeN : undefined,
    afterLatencyMs: afterN > 0 ? afterLat / afterN : undefined,
    verdict: decideVerdict({ hasBaseline, baselinePassRate, candidatePassRate, total: results.length }),
    results,
  };
}

/** 不可评测报告（new-skill/config-change/new-tool/new-app） */
export function notEvaluableReport(kind: string): EvalReport {
  return {
    total: 0,
    skipped: 0,
    hasBaseline: false,
    baselinePassRate: 0,
    candidatePassRate: 0,
    deltaRate: 0,
    verdict: "not-evaluable",
    reason: `${kind} 无文本可比对（config 无文本、技能/生成物已在写入期静态校验），评测不适用`,
    results: [],
  };
}
