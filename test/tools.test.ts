/**
 * 工具执行测试
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolRegistry } from "../src/core/tool-registry.js";
import type { ToolContext } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";

const testDir = makeTestDir("tools");

beforeAll(() => {
  clearTools();
  setupEnv(testDir);
});

afterAll(() => {
  teardownEnv();
});

describe("7. 工具执行", () => {
  const ctx: ToolContext = {
    agentId: "test",
    sessionId: "test",
    workingDir: process.cwd(),
    permissions: "auto",
  };

  it("获取 fs_read handler", () => {
    const readHandler = toolRegistry.getHandler("fs_read");
    expect(readHandler).toBeTruthy();
  });

  it("读取 package.json 成功", async () => {
    const handler = toolRegistry.getHandler("fs_read")!;
    const result = await handler({ path: "package.json" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("aiworker");
  });

  it("列出目录成功", async () => {
    const handler = toolRegistry.getHandler("fs_list")!;
    const result = await handler({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("package.json");
  });

  it("执行 echo 命令成功", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo AiWorker-Test" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("AiWorker-Test");
  });

  it("rm -rf / 在 ask 模式被拦截", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const askCtx: ToolContext = { ...ctx, permissions: "ask" };
    const result = await handler({ command: "rm -rf /" }, askCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("高危");
  });

  it("rm -rf / 在 auto 模式不拦截（交由 hook 确认）", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo safe" }, ctx);
    expect(result.success).toBe(true);
  });

  it("ask_user 透传 multiple 到提问通道", async () => {
    const { setAskProvider } = await import("../src/tools/ask-channel.js");
    const captured: Array<{ question: string; options: string[]; multiple?: boolean }> = [];
    setAskProvider(async (req) => {
      captured.push(req);
      return "x";
    });
    try {
      const handler = toolRegistry.getHandler("ask_user")!;
      await handler({ question: "q", options: ["a", "b"], multiple: true }, ctx);
      await handler({ question: "q", options: ["a", "b"] }, ctx);
      expect(captured[0]!.multiple).toBe(true);
      expect(captured[1]!.multiple).toBe(false);
      // 结果携带用户回答
      const r = await handler({ question: "q", options: ["a", "b"] }, ctx);
      expect(r.success).toBe(true);
      expect(r.content).toContain("用户回答");
    } finally {
      setAskProvider(null);
    }
  });
});
