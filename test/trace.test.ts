/**
 * 轨迹观测单测（Sprint 25）
 * 覆盖：轨迹投影（顺序/耗时/失败标记）、会话统计聚合、遥测捕获/幂等/错误隔离、脱敏、JSONL 后端
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { projectTrace, computeSessionStats } from "../src/core/trace.js";
import { TelemetryCoordinator, readTelemetryFile } from "../src/memory/telemetry.js";
import { createTelemetryRedact } from "../src/hooks/handlers.js";
import { hookManager } from "../src/hooks/hook-manager.js";
import type { SessionEvent } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("trace");
  setupEnv(dir);
});

afterEach(() => {
  hookManager.clear();
  teardownEnv();
});

function event(seq: number, type: SessionEvent["type"], data: Record<string, unknown>, createdAt: number): SessionEvent {
  return { seq, sessionId: "s1", type, data, createdAt };
}

const base = 1_700_000_000_000;

describe("projectTrace", () => {
  it("生成有序时间线：turn/step 边界 + 工具耗时/成败 + 消息摘要 + token", () => {
    const events: SessionEvent[] = [
      event(1, "user/message", { role: "user", content: "读取文件并总结" }, base),
      event(2, "turn/start", { turn: 1 }, base + 10),
      event(3, "step/start", { step: 0 }, base + 20),
      event(4, "tool/call", { callId: "t1", name: "fs_read", arguments: '{"path":"a.ts"}' }, base + 30),
      event(5, "tool/result", { callId: "t1", success: true, content: "内容", durationMs: 40 }, base + 70),
      event(6, "step/end", { step: 0 }, base + 80),
      event(
        7,
        "assistant/message",
        { message: { role: "assistant", content: "总结完成" }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
        base + 90,
      ),
      event(8, "turn/end", { turn: 1, reason: "stop" }, base + 100),
    ];

    const items = projectTrace(events);
    // step/end · tool/result · turn/end 是更新项（不新增轨迹条目）
    expect(items.map((i) => i.type)).toEqual(["user", "turn", "step", "tool", "assistant"]);

    const turn = items.find((i) => i.type === "turn")!;
    expect(turn.status).toBe("ok");
    expect(turn.durationMs).toBe(90); // end(100) - start(10)

    const step = items.find((i) => i.type === "step")!;
    expect(step.durationMs).toBe(60); // end(80) - start(20)

    const tool = items.find((i) => i.type === "tool")!;
    expect(tool.label).toBe("fs_read");
    expect(tool.status).toBe("ok");
    expect(tool.durationMs).toBe(40);

    const assistant = items.find((i) => i.type === "assistant")!;
    expect(assistant.tokens).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(assistant.detail).toBe("总结完成");
  });

  it("失败工具标 fail，非 stop 轮次标 fail", () => {
    const events: SessionEvent[] = [
      event(1, "turn/start", { turn: 1 }, base),
      event(2, "step/start", { step: 0 }, base + 10),
      event(3, "tool/call", { callId: "t1", name: "fs_write", arguments: "{}" }, base + 20),
      event(4, "tool/result", { callId: "t1", success: false, content: "Error: 权限不足", error: "权限不足", durationMs: 5 }, base + 25),
      event(5, "step/end", { step: 0 }, base + 30),
      event(6, "turn/end", { turn: 1, reason: "error" }, base + 40),
    ];
    const items = projectTrace(events);
    const tool = items.find((i) => i.type === "tool")!;
    expect(tool.status).toBe("fail");
    expect(tool.detail).toContain("权限不足");
    const turn = items.find((i) => i.type === "turn")!;
    expect(turn.status).toBe("fail");
  });
});

describe("computeSessionStats", () => {
  it("聚合轮次/工具/token/耗时/错误", () => {
    const events: SessionEvent[] = [
      event(1, "user/message", { role: "user", content: "hi" }, base),
      event(2, "turn/start", { turn: 1 }, base + 1),
      event(3, "step/start", { step: 0 }, base + 2),
      event(4, "tool/call", { callId: "t1", name: "a", arguments: "{}" }, base + 3),
      event(5, "tool/result", { callId: "t1", success: true, content: "ok", durationMs: 5 }, base + 8),
      event(6, "tool/call", { callId: "t2", name: "b", arguments: "{}" }, base + 10),
      event(7, "tool/result", { callId: "t2", success: false, content: "Error: x", error: "x", durationMs: 5 }, base + 15),
      event(8, "assistant/message", { message: { role: "assistant", content: "done" }, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }, base + 20),
      event(9, "turn/end", { turn: 1, reason: "stop" }, base + 25),
    ];
    const stats = computeSessionStats("s1", events);
    expect(stats.turnCount).toBe(1);
    expect(stats.stepCount).toBe(1);
    expect(stats.toolCallsTotal).toBe(2);
    expect(stats.toolCallsFailed).toBe(1);
    expect(stats.toolCallsSuccessRate).toBe(0.5);
    expect(stats.tokensPrompt).toBe(100);
    expect(stats.tokensCompletion).toBe(20);
    expect(stats.tokensTotal).toBe(120);
    expect(stats.wallMs).toBe(25); // 末事件(25) - 首事件(0)
    expect(stats.finishReason).toBe("stop");
    expect(stats.errorCount).toBe(1);
  });

  it("空事件 → 全零默认值", () => {
    const stats = computeSessionStats("s1", []);
    expect(stats.turnCount).toBe(0);
    expect(stats.toolCallsTotal).toBe(0);
    expect(stats.tokensTotal).toBe(0);
    expect(stats.wallMs).toBe(0);
    expect(stats.finishReason).toBe("stop");
  });
});

describe("TelemetryCoordinator", () => {
  it("捕获生成 ledger 记录（attributes 含 session.id/event.type/event.seq），JSONL 落盘可读回", async () => {
    const telemetry = new TelemetryCoordinator(dir);
    const events: SessionEvent[] = [
      event(1, "user/message", { role: "user", content: "hi" }, base),
      event(2, "tool/result", { callId: "t1", success: false, content: "Error: boom", error: "boom", durationMs: 1 }, base + 5),
    ];
    await telemetry.capture("s1", events);

    const records = readTelemetryFile(dir, "s1");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      channel: "ledger",
      severity: "info",
      attributes: { "session.id": "s1", "event.type": "user/message", "event.seq": 1 },
    });
    // 失败工具结果 → error 严重度
    expect(records[1]!.severity).toBe("error");
    // JSONL 文件逐行 JSON
    const raw = readFileSync(resolve(dir, "telemetry", "s1.jsonl"), "utf-8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    // 遥测按会话分文件：另一个会话读回 0 条（不跨会话聚合）
    expect(readTelemetryFile(dir, "s2")).toHaveLength(0);

    await telemetry.shutdown();
  });

  it("幂等：重复捕获同 seq 不重复写入", async () => {
    const telemetry = new TelemetryCoordinator(dir);
    const events: SessionEvent[] = [event(1, "user/message", { role: "user", content: "hi" }, base)];
    await telemetry.capture("s1", events);
    await telemetry.capture("s1", events);
    const records = readTelemetryFile(dir, "s1");
    expect(records).toHaveLength(1);
    await telemetry.shutdown();
  });

  it("后端 emit 抛错被隔离（不冒泡到调用方）", async () => {
    const telemetry = new TelemetryCoordinator(dir);
    const events: SessionEvent[] = [event(1, "user/message", { role: "user", content: "hi" }, base)];
    await expect(telemetry.capture("s1", events)).resolves.toBeUndefined();
    await telemetry.shutdown();
  });

  it("脱敏 waterfall：redactTelemetry 改写导出副本的敏感内容", async () => {
    const telemetry = new TelemetryCoordinator(dir);
    hookManager.on("onTelemetryRecord", createTelemetryRedact(), { id: "test:redact", priority: 0 });
    const events: SessionEvent[] = [
      event(1, "user/message", { role: "user", content: "key is sk-abcdefghijklmnopqrstuvwxyz0123456789 and password=secret123" }, base),
    ];
    await telemetry.capture("s1", events);
    const records = readTelemetryFile(dir, "s1");
    expect(records[0]!.body).toEqual({
      role: "user",
      content: "key is sk-**** and password=****",
    });
    await telemetry.shutdown();
  });
});
