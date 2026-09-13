/**
 * 轨迹投影 — 从会话事件日志（session_events）派生时间线与统计
 * 设计依据：对比报告借鉴点 #7（对齐 DSH dsh-session-stats：观测数据从事件派生，不重复存储）
 */

import type { SessionEvent, TraceItem, SessionStats } from "../types.js";

function summarize(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function findLastItem(items: TraceItem[], predicate: (i: TraceItem) => boolean): TraceItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return items[i];
  }
  return undefined;
}

/** 事件流 → 轨迹时间线（turn/step 边界、工具调用耗时/成败、消息摘要、token） */
export function projectTrace(events: SessionEvent[]): TraceItem[] {
  const items: TraceItem[] = [];
  const toolItems = new Map<string, TraceItem>(); // callId → tool item
  const turnStartAt = new Map<number, number>();
  const stepStartAt = new Map<number, number>();

  for (const ev of events) {
    switch (ev.type) {
      case "turn/start": {
        const { turn } = ev.data as { turn: number };
        turnStartAt.set(turn, ev.createdAt);
        items.push({ seq: ev.seq, type: "turn", label: `turn #${turn}`, at: ev.createdAt, status: "running" });
        break;
      }
      case "turn/end": {
        const { turn, reason } = ev.data as { turn: number; reason: string };
        const item = findLastItem(items, (i) => i.type === "turn" && i.label === `turn #${turn}`);
        if (item) {
          item.status = reason === "stop" ? "ok" : "fail";
          const start = turnStartAt.get(turn);
          if (start !== undefined) item.durationMs = ev.createdAt - start;
          item.detail = `reason=${reason}`;
        }
        break;
      }
      case "step/start": {
        const { step } = ev.data as { step: number };
        stepStartAt.set(step, ev.createdAt);
        items.push({ seq: ev.seq, type: "step", label: `step #${step}`, at: ev.createdAt, status: "running" });
        break;
      }
      case "step/end": {
        const { step } = ev.data as { step: number };
        const item = findLastItem(items, (i) => i.type === "step" && i.label === `step #${step}`);
        if (item) {
          item.status = "ok";
          const start = stepStartAt.get(step);
          if (start !== undefined) item.durationMs = ev.createdAt - start;
        }
        break;
      }
      case "user/message": {
        const content = (ev.data as { content: string }).content ?? "";
        items.push({ seq: ev.seq, type: "user", label: "用户", detail: summarize(content), full: content, at: ev.createdAt });
        break;
      }
      case "assistant/message": {
        const d = ev.data as { message: { content: string }; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
        const content = d.message?.content ?? "";
        items.push({
          seq: ev.seq,
          type: "assistant",
          label: "助手",
          detail: summarize(content),
          full: content,
          at: ev.createdAt,
          tokens: d.usage,
        });
        break;
      }
      case "tool/call": {
        const d = ev.data as { callId: string; name: string; arguments: string };
        const item: TraceItem = {
          seq: ev.seq,
          type: "tool",
          label: d.name,
          detail: summarize(d.arguments, 80),
          full: `参数: ${d.arguments}`,
          at: ev.createdAt,
          status: "running",
        };
        toolItems.set(d.callId, item);
        items.push(item);
        break;
      }
      case "tool/result": {
        const d = ev.data as { callId: string; success: boolean; content: string; error?: string; durationMs?: number; artifacts?: TraceItem["artifacts"] };
        const item = toolItems.get(d.callId);
        if (item) {
          item.status = d.success ? "ok" : "fail";
          if (d.durationMs !== undefined) item.durationMs = d.durationMs;
          if (!d.success && d.error) item.detail = summarize(d.error, 80);
          if (Array.isArray(d.artifacts) && d.artifacts.length > 0) item.artifacts = d.artifacts;
          item.full = `${item.full ?? "参数: -"}\n结果: ${d.success ? d.content : `错误: ${d.error ?? d.content}`}`;
        }
        break;
      }
      case "memory/update": {
        const d = ev.data as { kind: string; summary?: string };
        items.push({ seq: ev.seq, type: "memory", label: `记忆·${d.kind}`, detail: d.summary, at: ev.createdAt });
        break;
      }
      case "title/set": {
        const d = ev.data as { title: string };
        items.push({ seq: ev.seq, type: "title", label: "标题", detail: d.title, at: ev.createdAt });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** 事件流 → 会话级统计（轮次/工具成功率/token/耗时/错误） */
export function computeSessionStats(sessionId: string, events: SessionEvent[]): SessionStats {
  let turnCount = 0;
  let stepCount = 0;
  let toolCallsTotal = 0;
  let toolCallsFailed = 0;
  let tokensPrompt = 0;
  let tokensCompletion = 0;
  let errorCount = 0;
  let finishReason = "stop";
  let firstAt = Number.POSITIVE_INFINITY;
  let lastAt = 0;

  for (const ev of events) {
    firstAt = Math.min(firstAt, ev.createdAt);
    lastAt = Math.max(lastAt, ev.createdAt);
    switch (ev.type) {
      case "turn/start":
        turnCount++;
        break;
      case "turn/end": {
        const reason = (ev.data as { reason: string }).reason;
        finishReason = reason;
        if (reason !== "stop") errorCount++;
        break;
      }
      case "step/start":
        stepCount++;
        break;
      case "tool/call":
        toolCallsTotal++;
        break;
      case "tool/result": {
        const success = (ev.data as { success: boolean }).success;
        if (!success) {
          toolCallsFailed++;
          errorCount++;
        }
        break;
      }
      case "assistant/message": {
        const usage = (ev.data as { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }).usage;
        if (usage) {
          tokensPrompt += usage.promptTokens;
          tokensCompletion += usage.completionTokens;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    sessionId,
    turnCount,
    stepCount,
    toolCallsTotal,
    toolCallsFailed,
    toolCallsSuccessRate: toolCallsTotal > 0 ? (toolCallsTotal - toolCallsFailed) / toolCallsTotal : 0,
    tokensPrompt,
    tokensCompletion,
    tokensTotal: tokensPrompt + tokensCompletion,
    wallMs: Number.isFinite(firstAt) ? Math.max(0, lastAt - firstAt) : 0,
    finishReason,
    errorCount,
  };
}
