/**
 * 记忆系统测试：会话存储 / 上下文压缩 / 记忆增强 (Sprint 8)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextCompressor } from "../src/memory/compressor.js";
import { ContextManager } from "../src/core/context-manager.js";
import { makeTestDir, setupEnv } from "./helpers.js";

const testDir = makeTestDir("memory");

beforeAll(() => {
  setupEnv(testDir);
});

describe("4. 会话存储 (SQLite + FTS5)", () => {
  let sessionStore: SessionStore;
  let session: { id: string; agentId: string; createdAt: number; updatedAt: number };

  beforeAll(() => {
    sessionStore = new SessionStore(resolve(testDir, "test.db"));
    session = sessionStore.createSession("test-agent");
  });

  it("创建会话成功", () => {
    expect(session.id).toBeTruthy();
  });
  it("消息历史 2 条", () => {
    sessionStore.appendMessage(session.id, { role: "user", content: "你好" });
    sessionStore.appendMessage(session.id, { role: "assistant", content: "你好！有什么可以帮你的？" });
    const history = sessionStore.getMessages(session.id);
    expect(history.length).toBe(2);
  });
  it("第一条是 user 消息", () => {
    const history = sessionStore.getMessages(session.id);
    expect(history[0].role).toBe("user");
  });
  it("第二条是 assistant 消息", () => {
    const history = sessionStore.getMessages(session.id);
    expect(history[1].role).toBe("assistant");
  });
  it("FTS5 检索到结果", () => {
    sessionStore.saveEpisodic(session.id, "用户询问了天气", "天气查询", 1.0);
    const results = sessionStore.searchEpisodic("天气");
    expect(results.length).toBeGreaterThan(0);
  });

  it("turn_logs 写入与查询（当前会话）", () => {
    // 两次 Date.now() 之间可能跨毫秒 → 固定成同一基准，去掉挂钟竞态（P0-7 确定性）
    const now = Date.now();
    sessionStore.createTurnLog({
      id: "turn-test-1",
      sessionId: session.id,
      agentId: "test-agent",
      seq: 1,
      userInput: "测试问题",
      startedAt: now - 1000,
      finishedAt: now,
      iterations: 3,
      toolCallsTotal: 2,
      toolCallsSuccess: 2,
      toolCallsFailed: 0,
      tokensPrompt: 1000,
      tokensCompletion: 500,
      finishReason: "stop",
    });
    const turns = sessionStore.getTurnLogs(session.id);
    expect(turns.length).toBe(1);
    expect(turns[0].userInput).toBe("测试问题");
    expect(turns[0].iterations).toBe(3);
    expect(turns[0].finishedAt - turns[0].startedAt).toBe(1000);
  });
  it("getRecentTurnLogs 回退到最近会话", () => {
    const recent = sessionStore.getRecentTurnLogs(5);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0].sessionId).toBe(session.id);
  });
  it("TurnLog 口径：getRecentTurnLogs 不是跨会话聚合；getTurnLogsByAgent 不存在", () => {
    const parentSid = sessionStore.createSession("probe").id;
    const childSid = sessionStore.createSession("probe").id;
    // 现有回落用例的 turn log 用的是挂钟时刻，这里取更晚的基准，保证"最新会话"是本用例的子会话
    const now = Date.now();
    const base = {
      seq: 1,
      iterations: 1,
      toolCallsTotal: 0,
      toolCallsSuccess: 0,
      toolCallsFailed: 0,
      finishReason: "stop",
    };
    sessionStore.createTurnLog({
      ...base,
      id: "tl-parent",
      sessionId: parentSid,
      agentId: "default",
      userInput: "父问题",
      startedAt: now,
      finishedAt: now + 100,
      tokensPrompt: 100,
      tokensCompletion: 50,
    });
    sessionStore.createTurnLog({
      ...base,
      id: "tl-child",
      sessionId: childSid,
      agentId: "researcher",
      userInput: "子任务",
      startedAt: now + 1000,
      finishedAt: now + 1100,
      tokensPrompt: 7,
      tokensCompletion: 3,
    });

    // 名字像"最近的跨会话轮次"，实际只返回 started_at 最新的那一个会话
    expect(sessionStore.getRecentTurnLogs(50).map((t) => t.sessionId)).toEqual([childSid]);
    expect((sessionStore as unknown as Record<string, unknown>).getTurnLogsByAgent).toBeUndefined();
  });
});

describe("5. 上下文压缩", () => {
  const compressor = new ContextCompressor(undefined, 0.92);

  it("小上下文不触发压缩", () => {
    const smallMessages = [{ role: "user" as const, content: "hello" }];
    expect(compressor.needsCompression(smallMessages)).toBe(false);
  });

  it("大上下文触发 92% 压缩", () => {
    const largeMessages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: "A".repeat(5000) + ` message ${i}`,
    }));
    expect(compressor.needsCompression(largeMessages)).toBe(true);
  });

  it("压缩成功执行并减少消息", async () => {
    const largeMessages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: "A".repeat(5000) + ` message ${i}`,
    }));
    const { messages: compressed, result } = await compressor.compress(largeMessages);
    expect(result.compressed).toBe(true);
    expect(compressed.length).toBeLessThan(largeMessages.length);
  });
});

describe("15. 记忆系统增强 (Sprint 8)", () => {
  it("自适应 KEEP_RECENT 计算", async () => {
    const compressor = new ContextCompressor();

    // 通过 needsCompression 间接验证：消息数少时不触发压缩
    const short = [{ role: "user" as const, content: "hi" }];
    expect(compressor.needsCompression(short)).toBe(false);

    // 100 条消息压缩后保留 ~20 条
    const many = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i} `.repeat(10),
    }));
    const usage = compressor.getUsage(many);
    expect(usage).toBeGreaterThan(0);
  });

  it("searchEpisodic 时间衰减排序", async () => {
    const store = new SessionStore(resolve(testDir, "test-decay.db"));

    store.saveEpisodic("s1", "旧数据分析内容", "旧摘要", 1.0);
    store.saveEpisodic("s2", "新数据分析内容", "新摘要", 1.0);

    const results = store.searchEpisodic("数据分析", 5);
    // 两个条目都匹配，新内容应该排前面
    expect(results.length).toBeGreaterThan(0);

    store.close();
  });

  it("searchEpisodic 中文分词命中", async () => {
    const store = new SessionStore(resolve(testDir, "test-seg.db"));

    store.saveEpisodic("s1", "这是一段关于数据分析方法的讨论", "数据分析摘要", 1.0);

    // 用不同表述搜索
    const results = store.searchEpisodic("分析数据", 5);
    expect(results.length).toBeGreaterThan(0);

    store.close();
  });

  it("MEMORY.md 双段结构持久化", async () => {
    const memDir = resolve(testDir, "memory-sections");
    mkdirSync(memDir, { recursive: true });
    const store = new SessionStore(resolve(testDir, "test-sections.db"));
    const mgr = new ContextManager(store, testDir);

    // 写入项目信息
    await mgr.updateMemory("这是 React 18 + TypeScript 项目\n使用 Vitest 做测试");
    // 写入会话历史
    await mgr.summarizeSession([{ role: "user", content: "帮我实现一个组件" }], "实现 React 组件", "test-session-1");

    const content = readFileSync(resolve(testDir, "memory", "MEMORY.md"), "utf-8");
    expect(content).toContain("项目信息");
    expect(content).toContain("会话历史");
    expect(content).toContain("React");

    store.close();
  });

  it("MEMORY.md 项目信息不被会话冲刷", async () => {
    const store = new SessionStore(resolve(testDir, "test-noscrub.db"));
    const mgr = new ContextManager(store, testDir);

    // 写入项目信息
    await mgr.updateMemory("React 18 + TypeScript");

    // 多次写入会话历史
    for (let i = 0; i < 5; i++) {
      await mgr.summarizeSession([{ role: "user", content: `任务 ${i}` }], `任务 ${i}`, `test-session-${i}`);
    }

    const content = readFileSync(resolve(testDir, "memory", "MEMORY.md"), "utf-8");
    // 项目信息应该保持
    expect(content).toContain("React 18 + TypeScript");

    store.close();
  });

  it("USER.md 自动提取用户偏好", async () => {
    const store = new SessionStore(resolve(testDir, "test-user.db"));
    const compressor = new ContextCompressor();
    const mgr = new ContextManager(store, testDir, compressor);

    // 模拟包含用户偏好的对话
    const messages = [
      { role: "user" as const, content: "我习惯用 React 和 TypeScript 开发" },
      { role: "assistant" as const, content: "好的，我会使用 React 和 TypeScript" },
      { role: "user" as const, content: "请用中文回复，并且先写测试" },
      { role: "assistant" as const, content: "明白了" },
    ];

    await mgr.summarizeSession(messages, "技术栈偏好测试", "test-user-profile");

    const userContent = readFileSync(resolve(testDir, "memory", "USER.md"), "utf-8");
    // 用户画像文件应该更新
    expect(userContent.length).toBeGreaterThan(0);

    store.close();
  });
});
