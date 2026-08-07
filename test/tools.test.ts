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
    projectDir: process.cwd(),
    permissions: "craft",
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

  it("rm -rf / 被拦截", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "rm -rf /" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("高危");
  });
});
