/**
 * Token 统计与上下文（Sprint 44）测试：
 * estimateText 共享估算 / ContextBreakdown（replayEvents 含 tool、windowSize 参数化、remaining、缓存失效）
 * ContextCompressor 预算窗口独立 + scope 贯通
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextCompressor } from "../src/memory/compressor.js";
import { ContextManager } from "../src/core/context-manager.js";
import { ModelRouter } from "../src/core/model-router.js";
import { estimateText, estimateMessageTokens } from "../src/core/token-estimate.js";
import { makeTestDir, setupEnv } from "./helpers.js";

const testDir = makeTestDir("token-usage");

beforeAll(() => {
  setupEnv(testDir);
});

describe("token-estimate 共享估算（Sprint 44）", () => {
  it("CJK ≈1 token/字、ASCII ≈1 token/4 字符", () => {
    expect(estimateText("")).toBe(0);
    // 8 个 CJK 字 → 8
    expect(estimateText("今天天气真不错啊")).toBe(8);
    // 20 个 ASCII → ceil(20/4) = 5
    expect(estimateText("abcdefghijklmnopqrst")).toBe(5);
    // 混合：4 CJK + 5 ASCII → 4 + ceil(5/4)=2 → 6
    expect(estimateText("你好世界hello")).toBe(6);
  });

  it("estimateMessageTokens 含 tool_calls 参数字符", () => {
    const content = "abcdefgh"; // 8 ASCII → 2
    const toolCalls = { id: "t1", function: { arguments: "abcdefghijklmnopqrstuvwxyz" } }; // 26 ASCII 参数
    const withCalls = estimateMessageTokens(content, toolCalls);
    const withoutCalls = estimateMessageTokens(content);
    expect(withoutCalls).toBe(2);
    // tool_calls JSON 序列化（含键名）计入 → 大于纯 content
    expect(withCalls).toBeGreaterThan(withoutCalls);
  });
});

describe("ContextCompressor 预算窗口（Sprint 44）", () => {
  function longConversation(): { role: "user" | "assistant"; content: string }[] {
    // 每轮约 1000 ASCII 字符 ≈ 250 token
    const msgs: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: "u".repeat(1000) });
      msgs.push({ role: "assistant", content: "a".repeat(1000) });
    }
    return msgs;
  }

  it("默认预算窗口 32768：阈值/目标沿用（回归）", () => {
    const c = new ContextCompressor();
    // 40 条 × ~250 = ~10000 token → 低于 75%×32768
    expect(c.needsCompression(longConversation().slice(0, 40))).toBe(false);
    // 注入极小预算窗口时立即触发（预算窗口独立可注入）
    const small = new ContextCompressor(undefined, 0.75, 1);
    expect(small.needsCompression([{ role: "user", content: "hi" }])).toBe(true);
  });

  it("压缩目标按预算窗口比例（非物理窗口）", async () => {
    const c = new ContextCompressor(undefined, 0.1, 4000); // 预算 4k：40 条×250 超阈值触发
    const msgs = longConversation();
    const { result } = await c.compress(msgs);
    expect(result.compressed).toBe(true);
    expect(result.originalTokens).toBeGreaterThan(result.compressedTokens ?? 0);
  });

  it("scope 透传：压缩摘要请求带 scope 进 modelProvider（Sprint 44）", async () => {
    const scopes: (string | undefined)[] = [];
    const provider = vi.fn(async (opts: { scope?: string }) => {
      scopes.push(opts.scope);
      return { text: "摘要", toolCalls: [], hasToolCalls: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" as const };
    });
    const c = new ContextCompressor(provider as never, 0.1, 4000);
    const msgs = longConversation();
    await c.compress(msgs, "sess-abc");
    expect(scopes).toContain("sess-abc");
    // 不带 scope 的调用（摘要 fire-and-forget）不传 scope
    const c2 = new ContextCompressor(provider as never, 0.1, 4000);
    await c2.compress(longConversation());
    expect(scopes[scopes.length - 1]).toBeUndefined();
  });

  it("物理窗口 < 成本预算时收紧压缩触发（review F1：本地 16384 模型防输入溢出）", async () => {
    const c = new ContextCompressor(undefined, 0.75, 32768);
    // 40 user + 40 assistant，各 800 ASCII 字符 ≈ 200 tok/条 → ~16000 tok
    const msgs: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: "u".repeat(800) });
      msgs.push({ role: "assistant", content: "a".repeat(800) });
    }
    // 默认成本预算下 ~49%（<75%）不触发；16384 物理窗口下 ~98% 触发
    expect(c.needsCompression(msgs)).toBe(false);
    expect(c.needsCompression(msgs, 16384)).toBe(true);
    const { result } = await c.compress(msgs, undefined, 16384);
    expect(result.compressed).toBe(true);
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
  });
});

describe("ContextManager breakdown（Sprint 44）", () => {
  it("windowSize 参数化 + remaining；历史含 replayEvents 的 tool 消息与 tool_calls", () => {
    const dir = resolve(testDir, "bd");
    mkdirSync(dir, { recursive: true });
    const store = new SessionStore(resolve(dir, "bd.db"));
    const mgr = new ContextManager(store, dir);
    const sess = store.createSession("test-agent");

    // 用户 + 带 tool_calls 的 assistant + tool 结果（事件回放可见，投影不可见）
    store.appendMessage(sess.id, { role: "user", content: "查文件" });
    store.appendMessage(
      sess.id,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "fs_list", arguments: JSON.stringify({ path: "/x" }) } }],
      },
      { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    );
    store.appendEvent(sess.id, "tool/call", { callId: "t1", name: "fs_list", arguments: "{}" }, "agent-loop");
    store.appendEvent(sess.id, "tool/result", { callId: "t1", success: true, content: "x".repeat(4000), durationMs: 2 }, "agent-loop"); // 4k ASCII ≈ 1000 tok
    store.appendMessage(sess.id, { role: "assistant", content: "abc" });

    const bd = mgr.getContextBreakdown("系统提示", sess.id, "", "test-agent", 1048576);
    expect(bd.windowSize).toBe(1048576);
    expect(bd.remaining).toBe(1048576 - bd.total);
    // tool 结果 4000 ASCII 字符进历史估算 → 历史显著 > 0（≥1000）
    expect(bd.conversationHistory).toBeGreaterThan(1000);

    store.close();
  });

  it("breakdown 缓存按事件数失效（新事件后重算）", () => {
    const dir = resolve(testDir, "bd-cache");
    mkdirSync(dir, { recursive: true });
    const store = new SessionStore(resolve(dir, "bd-cache.db"));
    const mgr = new ContextManager(store, dir);
    const sess = store.createSession("test-agent");
    store.appendMessage(sess.id, { role: "user", content: "a" });
    const b1 = mgr.getContextBreakdown("sys", sess.id, "", undefined, 32768);
    const b2 = mgr.getContextBreakdown("sys", sess.id, "", undefined, 32768);
    // 无新事件 → 缓存命中，历史一致
    expect(b2.conversationHistory).toBe(b1.conversationHistory);
    store.appendMessage(sess.id, { role: "assistant", content: "新增一段回复内容" });
    const b3 = mgr.getContextBreakdown("sys", sess.id, "", undefined, 32768);
    // 新事件 → 缓存失效，历史增加
    expect(b3.conversationHistory).toBeGreaterThan(b1.conversationHistory);
    store.close();
  });
});

describe("ModelRouter contextWindow 解析（Sprint 44 review）", () => {
  it("provider.model 键大小写漂移时大小写不敏感兜底命中（防窗口静默虚高）", () => {
    const dir = resolve(testDir, "window-case");
    mkdirSync(dir, { recursive: true });
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: { provider: "deepseek", model: "deepseek-v4-flash", baseURL: "http://d", apiKey: "k", temperature: 0.3, maxTokens: 4096 },
        profiles: {
          lite: { provider: "openai", model: "Qwen3.8-27B", baseURL: "http://l", apiKey: "k", temperature: 0.7, maxTokens: 2048 },
        },
        contextWindow: { "openai.qwen3.8-27b": 16384 }, // 与 profile.model 大小写不一致
        routing: { strategy: "profile-based", fallback: "default" },
      }),
      "utf-8",
    );
    const router = new ModelRouter(cfgPath);
    expect(router.getContextWindow("lite")).toBe(16384);
    // provider 大小写也不敏感
    expect(router.getContextWindow("default")).toBe(1048576); // deepseek 内置表
  });
});
