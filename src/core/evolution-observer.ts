/**
 * 进化观察（Sprint 39）— 从会话事件派生进化指标
 * 数据源：session_events（工具成败/耗时/轮次）+ audit（生成统计）+ 首条用户消息（重复任务聚类）
 * 原则：不新增存储，全部派生；窗口内无数据返回空观察（调用方跳过 LLM 省预算）
 */

import type { EvolutionObservation, EvolutionToolStat, SessionEvent } from "../types.js";

export interface ObservationDeps {
  /** 列出会话（含 updatedAt/turnCount/firstUserMsg）；调用方需传放大 limit 覆盖窗口 */
  listSessions: (limit?: number) => Array<{
    id: string;
    updatedAt: number;
    turnCount: number;
    firstUserMsg: string | null;
  }>;
  /** 拉取会话事件（全量，观察方自行过滤窗口） */
  getEvents: (sessionId: string) => SessionEvent[];
  /** 审计查询：按 action 前缀统计（app:generate / app:generate-doc / app:update）；返回 null 表示不可用则计 0 */
  auditCount?: (actionPrefix: string) => number;
}

export const EVOLUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 列表放大 limit（listSessions 默认 20 会漏窗口内会话） */
export const OBSERVE_LIST_LIMIT = 500;

/** 归一化首条用户消息：去标点/数字/空白，小写，用于前缀聚类 */
export function normalizeTaskText(text: string): string {
  return text
    .replace(/[\p{P}\p{N}\s]/gu, "")
    .toLowerCase()
    .slice(0, 40);
}

/** 前缀相似度聚类：共享前 N 字符（≥8）归为一组 */
function clusterTasks(msgs: { text: string }[]): EvolutionObservation["repeatedTasks"] {
  const groups = new Map<string, { count: number; examples: string[] }>();
  for (const m of msgs) {
    const norm = normalizeTaskText(m.text);
    if (norm.length < 8) continue;
    let matched: string | null = null;
    for (const prefix of groups.keys()) {
      const shared = prefix.length < norm.length ? prefix : norm;
      if (shared.length >= 8 && (norm.startsWith(prefix) || prefix.startsWith(norm))) {
        matched = prefix;
        break;
      }
    }
    if (matched) {
      const g = groups.get(matched)!;
      g.count++;
      if (g.examples.length < 3) g.examples.push(m.text.slice(0, 60));
    } else {
      groups.set(norm, { count: 1, examples: [m.text.slice(0, 60)] });
    }
  }
  return [...groups.entries()]
    .map(([pattern, g]) => ({ pattern, count: g.count, examples: g.examples }))
    .filter((g) => g.count >= 3)
    .sort((a, b) => b.count - a.count);
}

interface ToolAgg {
  calls: number;
  failed: number;
  durationSum: number;
  errors: Map<string, number>;
}

/** 事件流 → 工具聚合（callId 配对）+ 轮次/干预统计 */
function aggregateEvents(
  events: SessionEvent[],
  toolAgg: Map<string, ToolAgg>,
  counters: { turns: number; okTurns: number; interventions: number },
): void {
  const callNames = new Map<string, string>();
  for (const ev of events) {
    switch (ev.type) {
      case "tool/call": {
        const d = ev.data as { callId: string; name: string };
        callNames.set(d.callId, d.name);
        const agg = toolAgg.get(d.name) ?? { calls: 0, failed: 0, durationSum: 0, errors: new Map<string, number>() };
        agg.calls++;
        toolAgg.set(d.name, agg);
        break;
      }
      case "tool/result": {
        const d = ev.data as { callId: string; success: boolean; error?: string; durationMs?: number };
        const name = callNames.get(d.callId);
        if (!name) break;
        const agg = toolAgg.get(name);
        if (!agg) break;
        if (!d.success) {
          agg.failed++;
          if (d.error) {
            const key = d.error.slice(0, 80);
            agg.errors.set(key, (agg.errors.get(key) ?? 0) + 1);
          }
        }
        if (d.durationMs !== undefined) agg.durationSum += d.durationMs;
        break;
      }
      case "turn/end": {
        counters.turns++;
        if ((ev.data as { reason: string }).reason === "stop") counters.okTurns++;
        break;
      }
      default:
        break;
    }
  }
  for (const ev of events) {
    if (ev.type === "tool/call" && (ev.data as { name: string }).name === "ask_user") {
      counters.interventions++;
    }
  }
}

export function observeEvolution(deps: ObservationDeps, now = Date.now()): EvolutionObservation {
  const windowStart = now - EVOLUTION_WINDOW_MS;
  const sessions = deps.listSessions(OBSERVE_LIST_LIMIT);
  const toolAgg = new Map<string, ToolAgg>();
  const counters = { turns: 0, okTurns: 0, interventions: 0 };
  const firstMsgs: { text: string }[] = [];
  let sessionCount = 0;

  for (const s of sessions) {
    if (s.updatedAt < windowStart) continue;
    sessionCount++;
    if (s.firstUserMsg) firstMsgs.push({ text: s.firstUserMsg });
    const events = deps.getEvents(s.id).filter((ev) => ev.createdAt >= windowStart);
    if (events.length > 0) aggregateEvents(events, toolAgg, counters);
  }

  const toolStats: EvolutionToolStat[] = [...toolAgg.entries()]
    .map(([name, agg]) => ({
      name,
      calls: agg.calls,
      failed: agg.failed,
      successRate: agg.calls > 0 ? (agg.calls - agg.failed) / agg.calls : 0,
      avgDurationMs: agg.calls > 0 ? Math.round(agg.durationSum / agg.calls) : 0,
      topErrors: [...agg.errors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([err, count]) => ({ err, count })),
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    windowStart,
    windowEnd: now,
    toolStats,
    completion: {
      sessions: sessionCount,
      ok: counters.okTurns,
      rate: counters.turns > 0 ? counters.okTurns / counters.turns : 0,
      avgTurns: sessionCount > 0 ? Math.round((counters.turns / sessionCount) * 10) / 10 : 0,
    },
    repeatedTasks: clusterTasks(firstMsgs),
    userInterventions: counters.interventions,
    generated: {
      apps: deps.auditCount?.("app:generate") ?? 0,
      docs: deps.auditCount?.("app:generate-doc") ?? 0,
      updates: deps.auditCount?.("app:update") ?? 0,
    },
  };
}
