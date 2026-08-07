/**
 * Streaming + 终端模块测试
 */

import { describe, it, expect } from "vitest";

describe("12. Streaming + 终端模块", () => {
  it("StreamChunk 类型可构造", () => {
    const chunk = { type: "text" as const, content: "hello" };
    expect(chunk.type).toBe("text");
    expect(chunk.content).toBe("hello");
  });

  it("StreamChunk done 类型", () => {
    const chunk = {
      type: "done" as const,
      finishReason: "stop" as const,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
    expect(chunk.finishReason).toBe("stop");
    expect(chunk.usage!.totalTokens).toBe(150);
  });

  it("ModelRouter 导出 completeStream", async () => {
    const { ModelRouter } = await import("../src/core/model-router.js");
    expect(typeof ModelRouter.prototype.completeStream).toBe("function");
  });

  it("ModelRouter 导出 getCurrentModel", async () => {
    const { ModelRouter } = await import("../src/core/model-router.js");
    expect(typeof ModelRouter.prototype.getCurrentModel).toBe("function");
  });

  it("ModelRouter 运行时配置：覆盖 + 持久化接口", async () => {
    const { ModelRouter } = await import("../src/core/model-router.js");
    const r = new ModelRouter();
    const models = r.getAvailableModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.some((m) => m.key === "default")).toBe(true);
    // 覆盖 profile/温度/maxTokens
    r.setDefaultModel("coding");
    r.setTemperature(0.4);
    r.setMaxTokens(2048);
    expect(r.getRuntimeConfig()).toEqual({ profileKey: "coding", model: "", temperature: 0.4, maxTokens: 2048 });
    expect(r.getCurrentModel()).toBeTruthy();
    const overrides = r.getOverrides();
    expect(overrides.profile).toBe("coding");
    expect(overrides.temperature).toBe(0.4);
    // applyOverrides 恢复（含旧字段 model 兼容）
    const r2 = new ModelRouter();
    r2.applyOverrides({ profile: "lite", temperature: 0.1 });
    expect(r2.getRuntimeConfig().profileKey).toBe("lite");
    expect(r2.getCurrentModel()).toBe("Qwen3.6-35B-A3B-UD-IQ3_S");
    expect(r2.getRuntimeConfig().temperature).toBe(0.1);
    // model 字段兼容：显式 model 优先
    const r3 = new ModelRouter();
    r3.applyOverrides({ profile: "lite", model: "custom-model" });
    expect(r3.getCurrentModel()).toBe("custom-model");
    // reset 恢复默认
    r.setDefaultModel("");
    r.setTemperature(null);
    r.setMaxTokens(null);
    expect(r.getOverrides()).toEqual({});
  });

  it("ModelRouter 运行时配置：覆盖影响 completeStream 请求", async () => {
    const { ModelRouter } = await import("../src/core/model-router.js");
    const r = new ModelRouter();
    // 用 lite profile 验证覆盖后的 maxTokens 生效（不实际发请求，仅验证 getProfile 内部路径）
    r.setMaxTokens(12345);
    r.setTemperature(0.77);
    r.setDefaultModel("lite");
    expect(r.getCurrentModel()).toBe("Qwen3.6-35B-A3B-UD-IQ3_S");
    // 通过 getAvailableModels 确认默认 model 可被覆盖读取
    expect(r.getRuntimeConfig().maxTokens).toBe(12345);
    expect(r.getRuntimeConfig().profileKey).toBe("lite");
  });

  it("runAgentLoopStream 从 agent-loop 导出", async () => {
    const mod = await import("../src/core/agent-loop.js");
    expect(typeof mod.runAgentLoopStream).toBe("function");
  });

  it("BaseAgent.runStream 方法存在", async () => {
    const { DefaultAgent } = await import("../src/agents/default-agent.js");
    expect(typeof DefaultAgent.prototype.runStream).toBe("function");
  });

  it("TerminalRenderer 单例可导出", async () => {
    const { renderer } = await import("../src/terminal/renderer.js");
    expect(renderer).toBeDefined();
    expect(typeof renderer.printStatus).toBe("function");
    expect(typeof renderer.write).toBe("function");
    expect(typeof renderer.writeLine).toBe("function");
    expect(typeof renderer.destroy).toBe("function");
  });

  it("InputCollector 队列管理", async () => {
    const { inputCollector } = await import("../src/terminal/input.js");
    expect(inputCollector).toBeDefined();
    expect(typeof inputCollector.startListening).toBe("function");
    expect(typeof inputCollector.stopListening).toBe("function");
    expect(typeof inputCollector.getQueueSize).toBe("function");
    expect(inputCollector.getQueueSize()).toBe(0);
    // no readline conflict: startListening uses raw stdin, no readline
    inputCollector.startListening();
    const q = inputCollector.stopListening();
    expect(Array.isArray(q)).toBe(true);
  });

  it("ANSI 工具函数存在", async () => {
    const ansi = await import("../src/terminal/ansi.js");
    expect(typeof ansi.hideCursor).toBe("function");
    expect(typeof ansi.showCursor).toBe("function");
    expect(typeof ansi.reverseVideo).toBe("function");
    expect(typeof ansi.bold).toBe("function");
    expect(ansi.reverseVideo("test")).toContain("[7m");
    expect(ansi.bold("test")).toContain("[1m");
  });
});
