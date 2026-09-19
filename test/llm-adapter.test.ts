/**
 * LLM 适配器 seam 单元测试 — mock OpenAI SDK（不触真实 LLM）
 * 覆盖：complete / 流式组装 / thinking 透传 / 错误分类 / retryable 重试 / 注册表降级 / ModelRouter 门面
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir } from "./helpers.js";

const h = vi.hoisted(() => ({
  mockCreate: undefined as
    | undefined
    | ((params: unknown, options?: unknown) => unknown),
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    constructor(public config: { apiKey: string; baseURL: string }) {}
    chat = {
      completions: {
        create: (params: unknown, options?: unknown) => {
          if (!h.mockCreate) throw new Error("mockCreate not configured");
          return h.mockCreate(params, options);
        },
      },
    };
  },
}));

import { openaiCompatibleAdapter } from "../src/core/llm/openai-compatible.js";
import { adapterRegistry } from "../src/core/llm/adapter-registry.js";
import { classifyError, classifyHttpError, isRetryable, LlmError } from "../src/core/llm/llm-error.js";
import type { LlmConnection } from "../src/core/llm/llm-adapter.js";
import { ModelRouter } from "../src/core/model-router.js";
import type { StreamChunk } from "../src/types.js";

const conn: LlmConnection = {
  provider: "test",
  model: "test-model",
  baseURL: "https://test.local/v1",
  apiKey: "sk-test",
  temperature: 0.5,
  maxTokens: 4096,
};

const okResponse = {
  choices: [{ message: { content: "hello", tool_calls: undefined }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

beforeEach(() => {
  h.mockCreate = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleAdapter.complete", () => {
  it("规范化响应（text / usage / finishReason）", async () => {
    h.mockCreate = vi.fn().mockResolvedValue(okResponse);
    const res = await openaiCompatibleAdapter.complete(conn, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("hello");
    expect(res.hasToolCalls).toBe(false);
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(res.finishReason).toBe("stop");
    expect(h.mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m", temperature: 0.5, max_tokens: 4096 }),
      expect.anything(),
    );
  });

  it("thinking 经 extra_body 透传（供应商专属参数由 adapter 消费）", async () => {
    h.mockCreate = vi.fn().mockResolvedValue(okResponse);
    await openaiCompatibleAdapter.complete(
      { ...conn, thinking: true },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
    );
    expect(h.mockCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extra_body: { thinking: { type: "enabled" } } }),
    );
  });

  it("retryable 错误（429）指数退避重试后成功", async () => {
    vi.useFakeTimers();
    try {
      h.mockCreate = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: "rate limit exceeded" })
        .mockResolvedValueOnce(okResponse);
      const promise = openaiCompatibleAdapter.complete(conn, { model: "m", messages: [] });
      await vi.advanceTimersByTimeAsync(2000);
      const res = await promise;
      expect(h.mockCreate).toHaveBeenCalledTimes(2);
      expect(res.text).toBe("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("quota 错误不重试，抛出 LlmError(quota)", async () => {
    h.mockCreate = vi.fn().mockRejectedValue({ status: 402, message: "Insufficient Quota" });
    await expect(openaiCompatibleAdapter.complete(conn, { model: "m", messages: [] })).rejects.toMatchObject({
      name: "LlmError",
      code: "quota",
    });
    expect(h.mockCreate).toHaveBeenCalledTimes(1);
  });

  it("重试耗尽后抛出分类 LlmError", async () => {
    vi.useFakeTimers();
    try {
      h.mockCreate = vi.fn().mockRejectedValue({ status: 429, message: "rate limit" });
      const promise = openaiCompatibleAdapter.complete(conn, { model: "m", messages: [] });
      const assertion = expect(promise).rejects.toMatchObject({ code: "rate_limit" });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(h.mockCreate).toHaveBeenCalledTimes(4); // 1 + 3 次重试
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAICompatibleAdapter.completeStream", () => {
  it("流式组装：thinking → text → tool_call → done，usage 只回调一次", async () => {
    h.mockCreate = vi.fn().mockImplementation(
      async function* () {
        yield { choices: [{ delta: { reasoning_content: "思考中" }, finish_reason: null }] };
        yield { choices: [{ delta: { content: "结果" }, finish_reason: null }] };
        yield {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fs_read", arguments: "{}" } }] },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    );

    const types: string[] = [];
    let usageCalls = 0;
    const stream = openaiCompatibleAdapter.completeStream(conn, {
      model: "m",
      messages: [],
      onUsage: () => {
        usageCalls += 1;
      },
    });
    let doneContent: string | undefined;
    for await (const c of stream) {
      types.push(c.type);
      if (c.type === "thinking") expect(c.content).toBe("思考中");
      if (c.type === "tool_call_delta") expect(c.content).toBe("{}");
      if (c.type === "done") doneContent = c.content;
    }
    expect(types).toEqual(["thinking", "text", "tool_call_start", "tool_call_delta", "done"]);
    expect(usageCalls).toBe(1);
    const parsed = JSON.parse(doneContent ?? "[]") as Array<{ id: string; function: { name: string } }>;
    expect(parsed).toEqual([{ id: "t1", type: "function", function: { name: "fs_read", arguments: "{}" } }]);
  });

  it("创建阶段失败（quota）→ error chunk 带稳定 errorCode，不重试", async () => {
    h.mockCreate = vi.fn().mockRejectedValue({ status: 402, message: "Insufficient Quota" });
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatibleAdapter.completeStream(conn, { model: "m", messages: [] })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "error", error: "Insufficient Quota", errorCode: "quota" }]);
    expect(h.mockCreate).toHaveBeenCalledTimes(1);
  });

  it("abort 中断 → error chunk 保持原语义（error: aborted）", async () => {
    h.mockCreate = vi.fn().mockRejectedValue({ name: "AbortError", message: "The operation was aborted" });
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatibleAdapter.completeStream(conn, { model: "m", messages: [] })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ type: "error", error: "aborted" }]);
  });

  it("迭代中途 retryable 失败不重试（已产出 chunk → 直接 error，防内容/工具调用重复）", async () => {
    // 第一个 chunk 正常产出，随后抛 429：消费者已收到部分输出，绝不再重试
    h.mockCreate = vi.fn().mockImplementation(
      async function* () {
        yield { choices: [{ delta: { content: "部分输出" }, finish_reason: null }] };
        throw { status: 429, message: "rate limit exceeded" };
      },
    );
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatibleAdapter.completeStream(conn, { model: "m", messages: [] })) {
      chunks.push(c);
    }
    expect(chunks.map((c) => c.type)).toEqual(["text", "error"]);
    expect((chunks[1] as { errorCode?: string }).errorCode).toBe("rate_limit");
    expect(h.mockCreate).toHaveBeenCalledTimes(1); // 未重试
  });
});

describe("错误分类与重试判定", () => {
  it("classifyHttpError 映射", () => {
    expect(classifyHttpError(401, "unauthorized")).toBe("invalid_credential");
    expect(classifyHttpError(403, "forbidden")).toBe("invalid_credential");
    expect(classifyHttpError(429, "rate limit")).toBe("rate_limit");
    expect(classifyHttpError(400, "This model's maximum context length is 4096 tokens")).toBe("context_window");
    expect(classifyHttpError(503, "server error")).toBe("network");
    expect(classifyHttpError(422, "bad")).toBe("unknown");
  });

  it("文案启发式识别 quota / context_window", () => {
    expect(classifyError({ message: "Insufficient Quota", status: 400 })).toBe("quota");
    expect(classifyError({ message: "maximum context length exceeded", status: 400 })).toBe("context_window");
    expect(classifyError(new TypeError("fetch failed"))).toBe("network");
  });

  it("isRetryable 只对瞬时失败为 true", () => {
    expect(isRetryable("rate_limit")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
    expect(isRetryable("network")).toBe(true);
    expect(isRetryable("quota")).toBe(false);
    expect(isRetryable("invalid_credential")).toBe(false);
    expect(isRetryable("context_window")).toBe(false);
  });

  it("LlmError instanceof 判定", () => {
    const err = new LlmError("quota", "out of quota");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("quota");
    expect(err.name).toBe("LlmError");
  });
});

describe("AdapterRegistry", () => {
  it("按 id 解析，未知 id 降级 openai-compatible", () => {
    expect(adapterRegistry.resolve("openai-compatible").id).toBe("openai-compatible");
    expect(adapterRegistry.resolve("nonexistent").id).toBe("openai-compatible");
    expect(adapterRegistry.resolve(undefined).id).toBe("openai-compatible");
  });
});

describe("ModelRouter 门面", () => {
  it("complete 走适配器并统一计量；completeStream 流末单次累计", async () => {
    const dir = makeTestDir("llm-router");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: {
          provider: "deepseek",
          model: "m1",
          baseURL: "https://t.local/v1",
          apiKey: "sk-1",
          temperature: 0.5,
          maxTokens: 4096,
          adapter: "openai-compatible",
        },
        profiles: { coding: { temperature: 0.2 } },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);

    h.mockCreate = vi.fn().mockResolvedValue(okResponse);
    const res = await router.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("hello");
    expect(router.getTokenUsage()).toBe(15);
    expect(router.getPromptTokens()).toBe(10);
    expect(router.getCompletionTokens()).toBe(5);

    h.mockCreate = vi.fn().mockImplementation(
      async function* () {
        yield { choices: [{ delta: { content: "a" }, finish_reason: null }] };
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    );
    const textChunks: string[] = [];
    for await (const c of router.completeStream("default", [{ role: "user", content: "hi" }])) {
      if (c.type === "text") textChunks.push(c.content!);
    }
    expect(textChunks).toEqual(["a"]);
    // 15 + (7 + 3)
    expect(router.getTokenUsage()).toBe(25);
    expect(router.getPromptTokens()).toBe(17);
    expect(router.getCompletionTokens()).toBe(8);
  });

  it("completeWithProfile 使用 preference profile 的完整连接与温度（lite 类异源 profile 不再错配 default 连接）", async () => {
    const dir = makeTestDir("llm-router-profile");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: {
          provider: "deepseek",
          model: "m1",
          baseURL: "https://t.local/v1",
          apiKey: "sk-1",
          temperature: 0.5,
          maxTokens: 4096,
          adapter: "openai-compatible",
        },
        profiles: {
          coding: { temperature: 0.2 },
          lite: { provider: "openai", model: "qwen-x", baseURL: "http://localhost:8000/v1", apiKey: "sk-lite", temperature: 0.7 },
        },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);

    // coding：temperature 0.2 生效（preference profile 覆盖）
    h.mockCreate = vi.fn().mockResolvedValue(okResponse);
    await router.completeWithProfile("coding", [{ role: "user", content: "hi" }]);
    expect(h.mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m1", temperature: 0.2 }),
      expect.anything(),
    );

    // lite：模型名 + 连接参数均来自 lite profile（不再用 default 的连接发 lite 模型）
    h.mockCreate = vi.fn().mockResolvedValue(okResponse);
    await router.completeWithProfile("lite", [{ role: "user", content: "hi" }]);
    expect(h.mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "qwen-x", temperature: 0.7 }),
      expect.anything(),
    );
  });

  it("getDisplayModel 展示 profile 上下文（/config model 后状态栏可感知）", async () => {
    const dir = makeTestDir("llm-router-display");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: { provider: "deepseek", model: "m1", baseURL: "https://t.local/v1", apiKey: "sk-1", temperature: 0.5, maxTokens: 4096 },
        profiles: { coding: { temperature: 0.2 } },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);
    expect(router.getDisplayModel()).toBe("m1");
    router.setDefaultModel("coding");
    // coding 未覆盖 model → 模型名不变，但展示 profile 上下文
    expect(router.getDisplayModel()).toBe("m1 (coding)");
    router.setDefaultModel("");
    expect(router.getDisplayModel()).toBe("m1");
  });

  it("getContextWindow 解析链：profile 字段 > provider.model 键 > provider 键 > 内置表 > 兜底（Sprint 44）", async () => {
    const dir = makeTestDir("llm-router-window");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        contextWindow: {
          deepseek: 1048576,
          openai: 131072,
          google: 262144,
          "openai.custom-model": 65536,
        },
        default: { provider: "deepseek", model: "deepseek-v4-flash", baseURL: "https://t.local/v1", apiKey: "sk-1", temperature: 0.5, maxTokens: 4096 },
        profiles: {
          // 显式声明 → 最高优先级
          coding: { provider: "openai", model: "custom-model", contextWindow: 8192 },
          // 未显式声明 → 查 provider.model 键
          lite: { provider: "openai", model: "custom-model", baseURL: "http://localhost:8000/v1", apiKey: "sk" },
          // provider 默认键
          gemma: { provider: "google", model: "gemma-4-26b-a4b", baseURL: "https://g.local/v1", apiKey: "sk" },
          // 内置表（deepseek 内置 1048576）
          reason: { provider: "deepseek", model: "deepseek-v4-pro", baseURL: "https://t.local/v1", apiKey: "sk" },
          // 未知 provider/model → 兜底 32768
          mystery: { provider: "unknown", model: "x", baseURL: "https://x.local/v1", apiKey: "sk" },
        },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);
    // default（deepseek 内置 1M，profile 未声明）
    expect(router.getContextWindow()).toBe(1048576);
    // profile 显式字段最优先
    expect(router.getContextWindow("coding")).toBe(8192);
    // 无 profile 字段 → provider.model 精确键
    expect(router.getContextWindow("lite")).toBe(65536);
    // provider 默认键
    expect(router.getContextWindow("gemma")).toBe(262144);
    // 内置表
    expect(router.getContextWindow("reason")).toBe(1048576);
    // 兜底
    expect(router.getContextWindow("mystery")).toBe(32768);
    // getAvailableModels 输出含解析后窗口
    const models = router.getAvailableModels();
    const coding = models.find((m) => m.key === "coding");
    expect(coding?.contextWindow).toBe(8192);
  });

  it("会话账本 scope：按 sessionId 累计、差分、deleteScope/reset，父会话/按 agent 的聚合入口不存在（Sprint 44）", async () => {
    const dir = makeTestDir("llm-router-scope");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: { provider: "deepseek", model: "m1", baseURL: "https://t.local/v1", apiKey: "sk-1", temperature: 0.5, maxTokens: 4096 },
        profiles: { coding: { temperature: 0.2 } },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);
    // usage: {prompt_tokens:10, completion_tokens:5, total_tokens:15}
    h.mockCreate = vi.fn().mockResolvedValue(okResponse);

    // 带 scope 的 complete 计入会话账本
    await router.complete({ messages: [{ role: "user", content: "hi" }], scope: "sess-a" });
    await router.complete({ messages: [{ role: "user", content: "hi" }], scope: "sess-b" });
    await router.complete({ messages: [{ role: "user", content: "hi" }], scope: "sess-a" });
    // 不带 scope 只进全局
    await router.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(router.getSessionTokens("sess-a")).toEqual({ prompt: 20, completion: 10 });
    expect(router.getSessionTokens("sess-b")).toEqual({ prompt: 10, completion: 5 });
    expect(router.getSessionTokens("nonexistent")).toEqual({ prompt: 0, completion: 0 });
    // 全局含全部 4 次请求（15 × 4 = 60）
    expect(router.getTokenUsage()).toBe(60);

    // 父会话/按 agent 的聚合入口不存在
    expect(
      (router as unknown as Record<string, unknown>).getParentTokens,
    ).toBeUndefined();

    // deleteScope 清理单会话
    router.deleteScope("sess-b");
    expect(router.getSessionTokens("sess-b")).toEqual({ prompt: 0, completion: 0 });

    // resetTokenUsage 清全局 + 全部账本
    router.resetTokenUsage();
    expect(router.getTokenUsage()).toBe(0);
    expect(router.getSessionTokens("sess-a")).toEqual({ prompt: 0, completion: 0 });
  });

  it("流式 completeStream scope 计入会话账本（Sprint 44）", async () => {
    const dir = makeTestDir("llm-router-scope-stream");
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: { provider: "deepseek", model: "m1", baseURL: "https://t.local/v1", apiKey: "sk-1", temperature: 0.5, maxTokens: 4096 },
        profiles: {},
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);
    h.mockCreate = vi.fn().mockImplementation(
      async function* () {
        yield { choices: [{ delta: { content: "a" }, finish_reason: null }] };
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    );
    for await (const c of router.completeStream("default", [{ role: "user", content: "hi" }], undefined, { scope: "sess-x" })) {
      void c;
    }
    expect(router.getSessionTokens("sess-x")).toEqual({ prompt: 7, completion: 3 });
    // 流式 usage 单次回调，不膨胀
    expect(router.getTokenUsage()).toBe(10);
  });
});
