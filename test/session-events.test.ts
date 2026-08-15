/**
 * 会话事件溯源单测（Sprint 24）
 * 覆盖：事件完整性/seq 连续、回放派生与投影一致、一致性校验、记忆/标题事件
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import type { SessionEvent } from "../src/types.js";

let dir: string;
let store: SessionStore;
let sessionId: string;

beforeEach(() => {
  dir = makeTestDir("session-events");
  setupEnv(dir);
  store = new SessionStore(resolve(dir, "aiworker.db"));
  sessionId = store.createSession("coding").id;
});

afterEach(() => {
  store.close();
  teardownEnv();
});

describe("事件溯源", () => {
  it("完整事件序列（消息 + 轮次 + 工具）且 seq 连续", () => {
    store.appendMessage(sessionId, { role: "user", content: "hello" });
    store.appendEvent(sessionId, "turn/start", { turn: 1 }, "hooks");
    store.appendEvent(sessionId, "step/start", { step: 0 }, "agent-loop");
    store.appendEvent(sessionId, "tool/call", { callId: "t1", name: "fs_read", arguments: "{}" }, "agent-loop");
    store.appendEvent(
      sessionId,
      "tool/result",
      { callId: "t1", success: true, content: "file content", durationMs: 10 },
      "agent-loop",
    );
    store.appendEvent(sessionId, "step/end", { step: 0 }, "agent-loop");
    store.appendMessage(sessionId, { role: "assistant", content: "done" });
    store.appendEvent(sessionId, "turn/end", { turn: 1, reason: "stop" }, "hooks");

    const events = store.getEvents(sessionId);
    expect(events.map((e) => e.type)).toEqual([
      "session/created",
      "user/message",
      "title/set",
      "turn/start",
      "step/start",
      "tool/call",
      "tool/result",
      "step/end",
      "assistant/message",
      "turn/end",
    ]);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));

    // 事件数据无损（JSON 序列化往返）
    const callEv = events.find((e) => e.type === "tool/call") as SessionEvent;
    expect(callEv.data).toEqual({ callId: "t1", name: "fs_read", arguments: "{}" });
    expect(callEv.source).toBe("agent-loop");
  });

  it("回放派生与消息投影一致（含工具调用配对）", () => {
    store.appendMessage(sessionId, { role: "user", content: "read file" });
    store.appendEvent(sessionId, "tool/call", { callId: "t1", name: "fs_read", arguments: "{}" }, "agent-loop");
    store.appendEvent(
      sessionId,
      "tool/result",
      { callId: "t1", success: true, content: "file content", durationMs: 5 },
      "agent-loop",
    );
    store.appendMessage(sessionId, {
      role: "assistant",
      content: "summary",
      tool_calls: [{ id: "t1", type: "function", function: { name: "fs_read", arguments: "{}" } }],
    });

    const replayed = store.replayEvents(sessionId);
    const stored = store.getMessages(sessionId);
    expect(replayed).toHaveLength(3);
    // 助手消息的 tool_calls 后紧跟对应 tool 结果（消息语义顺序）
    expect(replayed[2]).toMatchObject({ role: "tool", tool_call_id: "t1", content: "file content" });
    // 投影表不含 tool 消息（持久化语义），回放含完整序列 → 仅比较 user/assistant 骨架
    expect(replayed.filter((m) => m.role !== "tool")).toEqual(stored);

    const v = store.verifyProjection(sessionId);
    expect(v.ok).toBe(true);
    expect(v.eventCount).toBe(6); // session/created + user/message + title/set + tool/call + tool/result + assistant/message
    expect(v.messageCount).toBe(2);
  });

  it("verifyProjection 检测事件缺失", () => {
    store.appendMessage(sessionId, { role: "user", content: "hi" });
    const raw = store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } };
    raw.db.prepare("DELETE FROM session_events WHERE type = ?").run("user/message");
    const v = store.verifyProjection(sessionId);
    expect(v.ok).toBe(false);
    expect(v.mismatches.length).toBeGreaterThan(0);
  });

  it("记忆更新与标题变更产生事件", () => {
    store.saveEpisodic(sessionId, "内容", "摘要", 1.0);
    store.setSummary(sessionId, "新标题");
    const events = store.getEvents(sessionId);
    expect(events.some((e) => e.type === "memory/update")).toBe(true);
    const titleEv = events.find((e) => e.type === "title/set") as SessionEvent | undefined;
    expect(titleEv).toBeDefined();
    expect(titleEv!.data).toEqual({ title: "新标题" });
  });

  it("renameSession 触发 title/set 事件", () => {
    store.renameSession(sessionId, "重命名");
    const events = store.getEvents(sessionId);
    const titleEv = events.find((e) => e.type === "title/set") as SessionEvent | undefined;
    expect(titleEv).toBeDefined();
    expect(titleEv!.data).toEqual({ title: "重命名" });
  });

  it("getEvents 分页与 fromSeq", () => {
    for (let i = 0; i < 5; i++) {
      store.appendMessage(sessionId, { role: "user", content: `msg-${i}` });
    }
    const all = store.getEvents(sessionId);
    expect(all).toHaveLength(7); // session/created + 5 条 user/message + 1 条自动标题 title/set
    const from3 = store.getEvents(sessionId, 3);
    expect(from3[0]!.seq).toBe(3);
    const limited = store.getEvents(sessionId, 1, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.seq).toBe(1);
  });

  it("assistant/message 事件携带 usage（轨迹/统计 token 数据源）", () => {
    store.appendMessage(
      sessionId,
      { role: "assistant", content: "回答" },
      { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    );
    const events = store.getEvents(sessionId);
    const assistantEv = events.find((e) => e.type === "assistant/message") as SessionEvent | undefined;
    expect(assistantEv).toBeDefined();
    expect(assistantEv!.data).toMatchObject({
      message: { role: "assistant", content: "回答" },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    // 不带 usage 时不写入 usage 字段
    store.appendMessage(sessionId, { role: "assistant", content: "无 usage" });
    const last = store.getEvents(sessionId).at(-1) as SessionEvent;
    expect(last.data).toEqual({ message: { role: "assistant", content: "无 usage" } });
  });

  it("多轮工具型会话：中间 assistant(tool_calls) 事件 + tool 结果可完整回放（Sprint 修复）", () => {
    store.appendMessage(sessionId, { role: "user", content: "任务" });
    // 中间轮：assistant 请求工具（agent-loop 持久化后的形态）
    store.appendMessage(
      sessionId,
      {
        role: "assistant",
        content: "调用",
        tool_calls: [{ id: "t1", type: "function", function: { name: "fs_read", arguments: "{}" } }],
      },
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    );
    store.appendEvent(sessionId, "tool/call", { callId: "t1", name: "fs_read", arguments: "{}" }, "agent-loop");
    store.appendEvent(
      sessionId,
      "tool/result",
      { callId: "t1", success: true, content: "数据", durationMs: 3 },
      "agent-loop",
    );
    // 最终回答
    store.appendMessage(
      sessionId,
      { role: "assistant", content: "完成" },
      { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    );

    const replayed = store.replayEvents(sessionId);
    expect(replayed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(replayed[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "t1", type: "function", function: { name: "fs_read", arguments: "{}" } }],
    });
    expect(replayed[2]).toMatchObject({ role: "tool", tool_call_id: "t1", content: "数据" });
    const v = store.verifyProjection(sessionId);
    expect(v.ok).toBe(true);
  });
});

describe("会话自动标题（Sprint 26）", () => {
  it("首条用户消息自动生成标题并发出 title/set 事件（source=auto）", () => {
    store.appendMessage(sessionId, { role: "user", content: "帮我重构这个项目的路由模块" });
    const sessions = store.listSessions(100);
    const sess = sessions.find((s) => s.id === sessionId)!;
    expect(sess.summary).toBe("帮我重构这个项目的路由模块");
    const events = store.getEvents(sessionId);
    const titleEv = events.find((e) => e.type === "title/set") as SessionEvent | undefined;
    expect(titleEv).toBeDefined();
    expect(titleEv!.data).toEqual({ title: "帮我重构这个项目的路由模块", source: "auto" });
  });

  it("超长首行截断为 ≤24 字符 + 省略号；多行取首条非空行", () => {
    store.appendMessage(sessionId, { role: "user", content: "这是一条非常非常长的用户消息，远远超过二十四个字符的标题长度限制需要被截断" });
    const sessions = store.listSessions(100);
    const sess = sessions.find((s) => s.id === sessionId)!;
    expect(sess.summary!.endsWith("…")).toBe(true);
    expect([...sess.summary!].length).toBeLessThanOrEqual(25);

    store.appendMessage(sessionId, { role: "user", content: "\n\n  第二行才是正文内容  " });
    // 已有标题不覆盖
    const sessions2 = store.listSessions(100);
    expect(sessions2.find((s) => s.id === sessionId)!.summary).toBe(sess.summary);
  });

  it("已有标题（重命名）不被后续用户消息覆盖", () => {
    store.renameSession(sessionId, "自定义标题");
    store.appendMessage(sessionId, { role: "user", content: "新任务" });
    const sessions = store.listSessions(100);
    expect(sessions.find((s) => s.id === sessionId)!.summary).toBe("自定义标题");
  });

  it("generateSessionTitle 直接可用（导出函数）", async () => {
    const { generateSessionTitle } = await import("../src/memory/session-store.js");
    expect(generateSessionTitle("  hello   world  ")).toBe("hello world");
    expect(generateSessionTitle("a".repeat(30))).toBe(`${"a".repeat(24)}…`);
  });
});
