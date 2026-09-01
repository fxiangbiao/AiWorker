/**
 * 进化黄金用例单测（Sprint 41 第三期）
 * 覆盖：EvolutionCases 文件存储、splitTurns 按 turn 切分、extractCasesFromSessions 提取/去重/截断
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import {
  EvolutionCases,
  splitTurns,
  extractCasesFromSessions,
  type CasesSessionDeps,
} from "../src/core/evolution-cases.js";
import type { SessionEvent, SessionEventType } from "../src/types.js";

let dir: string;
let now: number;

beforeEach(() => {
  dir = makeTestDir("evolution-cases");
  setupEnv(dir);
  now = Date.now();
});

afterEach(() => {
  teardownEnv();
});

function ev(seq: number, type: SessionEventType, data: Record<string, unknown>, createdAt = now): SessionEvent {
  return { seq, sessionId: "s1", type, data, createdAt };
}

function turnEvents(turn: number, reason: string, userText: string, assistantText: string, base: number): SessionEvent[] {
  return [
    ev(base + 0, "turn/start", { turn }),
    ev(base + 1, "user/message", { role: "user", content: userText } as unknown as Record<string, unknown>),
    ev(base + 2, "turn/end", { turn, reason }),
    ev(base + 3, "assistant/message", { message: { role: "assistant", content: assistantText } }),
  ];
}

describe("EvolutionCases 存储", () => {
  it("add/list/get/delete 落盘与读取", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const c = store.add({ input: "整理周报", expected: "输出 markdown 周报", source: "manual" });
    expect(c.id).toMatch(/^case-/);
    expect(store.get(c.id)?.input).toBe("整理周报");
    expect(store.list()[0]!.source).toBe("manual");
    expect(existsSync(resolve(dir, "evolution", "cases", `${c.id}.json`))).toBe(true);
    expect(store.delete(c.id)).toBe(true);
    expect(store.delete(c.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("list 按 createdAt 降序 + limit 截断", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    store.add({ input: "新任务", source: "manual" });
    // 直接落盘一条更早的用例（createdAt 明确更旧，避免同毫秒排序不稳定）
    const casesDir = resolve(dir, "evolution", "cases");
    writeFileSync(
      resolve(casesDir, "case-old.json"),
      JSON.stringify({ id: "case-old", input: "最早任务", source: "session", createdAt: now - 100000 }),
      "utf-8",
    );
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(1)[0]!.input).toBe("新任务");
    expect(store.list(10).map((c) => c.id)).toEqual([expect.stringMatching(/^case-/), "case-old"]);
  });

  it("损坏文件跳过", () => {
    const casesDir = resolve(dir, "evolution", "cases");
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(resolve(casesDir, "bad.json"), "{invalid", "utf-8");
    const store = new EvolutionCases(casesDir);
    store.add({ input: "任务", source: "manual" });
    expect(store.list()).toHaveLength(1);
  });
});

describe("splitTurns", () => {
  it("多轮会话切出多个 turn，事件归属正确", () => {
    const events = [
      ...turnEvents(1, "stop", "任务一", "答复一", 100),
      ...turnEvents(2, "stop", "任务二", "答复二", 200),
    ];
    const turns = splitTurns(events);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turn).toBe(1);
    expect(turns[0]!.reason).toBe("stop");
    expect(turns[0]!.events.filter((e) => e.type === "user/message")).toHaveLength(1);
    expect(turns[1]!.events.filter((e) => e.type === "user/message")[0]!.data).toEqual({
      role: "user",
      content: "任务二",
    });
  });

  it("未闭环的末 turn 丢弃（会话进行中）", () => {
    const events = [
      ...turnEvents(1, "stop", "任务一", "答复一", 100),
      ev(200, "turn/start", { turn: 2 }),
      ev(201, "user/message", { message: { role: "user", content: "进行中" } }),
    ];
    const turns = splitTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turn).toBe(1);
  });

  it("error/aborted 的 turn 保留 reason 供上层过滤", () => {
    const events = turnEvents(1, "error", "任务", "答复", 100);
    const turns = splitTurns(events);
    expect(turns[0]!.reason).toBe("error");
  });
});

describe("extractCasesFromSessions", () => {
  const deps = (sessions: { id: string; events: SessionEvent[] }[]): CasesSessionDeps => ({
    listSessions: (limit = 20) =>
      sessions.map((s) => ({ id: s.id, updatedAt: now, turnCount: 1, firstUserMsg: null })).slice(0, limit),
    getEvents: (id) => sessions.find((s) => s.id === id)?.events ?? [],
  });

  it("按 turn 提取：stop turn 的末条用户消息为 input、末条助手消息为 expected", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const d = deps([
      {
        id: "s1",
        events: [
          ...turnEvents(1, "stop", "帮我写周报", "好的，这是周报：\n- 完成 A\n- 完成 B", 100),
          ...turnEvents(2, "stop", "再优化一下格式", "已调整格式。", 200),
        ],
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(2);
    const list = store.list();
    // 两条 createdAt 同毫秒，顺序不稳定 → 按 input 定位断言
    const byInput = (input: string) => list.find((c) => c.input === input)!;
    expect(byInput("再优化一下格式").expected).toBe("已调整格式。");
    expect(byInput("再优化一下格式").source).toBe("session");
    expect(byInput("再优化一下格式").sessionId).toBe("s1");
    expect(byInput("帮我写周报").expected).toContain("完成 A");
  });

  it("error/aborted turn 不提取；无助手回复的 turn 不提取", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const d = deps([
      {
        id: "s1",
        events: [
          ...turnEvents(1, "error", "失败任务", "答复", 100),
          ev(200, "turn/start", { turn: 2 }),
          ev(201, "user/message", { role: "user", content: "无回复" } as unknown as Record<string, unknown>),
          ev(202, "turn/end", { turn: 2, reason: "stop" }),
        ],
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("去重：normalizeTaskText 完全一致跳过（记 skipped）", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    store.add({ input: "帮我写周报", source: "manual" });
    const d = deps([
      {
        id: "s1",
        events: turnEvents(1, "stop", "帮我写周报！！", "答复", 100),
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("expected 截断 ≤200 字符；content 为 parts 数组兼容 messageText", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const long = "长".repeat(300);
    const d = deps([
      {
        id: "s1",
        events: [
          ev(100, "turn/start", { turn: 1 }),
          ev(101, "user/message", { role: "user", content: [{ type: "text", text: "整理本周会议纪要" }] } as unknown as Record<string, unknown>),
          ev(102, "turn/end", { turn: 1, reason: "stop" }),
          ev(103, "assistant/message", { message: { role: "assistant", content: long } }),
        ],
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(1);
    expect(store.list()[0]!.input).toBe("整理本周会议纪要");
    expect(store.list()[0]!.expected!.length).toBe(200);
  });

  it("窗口过滤：窗口外事件不提取", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const d = deps([
      {
        id: "s1",
        events: turnEvents(1, "stop", "旧任务", "答复", now - 8 * 24 * 60 * 60 * 1000),
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(0);
  });

  it("畸形 data 防御：user/message 非 Message 形状按跳过处理，不抛错（回归：真实数据崩溃修复）", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const d = deps([
      {
        id: "s1",
        events: [
          ev(100, "turn/start", { turn: 1 }),
          ev(101, "user/message", { weird: true } as unknown as Record<string, unknown>),
          ev(102, "turn/end", { turn: 1, reason: "stop" }),
          ev(103, "assistant/message", { message: { role: "assistant", content: "答复" } }),
        ],
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("user/message data 为 Message 本体（对齐 session-store 真实形状）", () => {
    const store = new EvolutionCases(resolve(dir, "evolution", "cases"));
    const d = deps([
      {
        id: "s1",
        events: [
          ev(100, "turn/start", { turn: 1 }),
          ev(101, "user/message", { role: "user", content: "请生成一份项目周报" } as unknown as Record<string, unknown>),
          ev(102, "turn/end", { turn: 1, reason: "stop" }),
          ev(103, "assistant/message", { message: { role: "assistant", content: "已生成" } }),
        ],
      },
    ]);
    const result = extractCasesFromSessions(d, store, now);
    expect(result.added).toBe(1);
    expect(store.list()[0]!.input).toBe("请生成一份项目周报");
  });
});
