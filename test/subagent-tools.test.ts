/**
 * 子智能体工具测试（Sprint 52 T2）
 * 覆盖：受限工具空白名单不可见、执行层硬校验、深度1拒绝、readOnly闭集
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { SessionStore, WORKER_SESSION_PREFIX } from "../src/memory/session-store.js";
import { SubagentRunner } from "../src/core/subagent-runner.js";
import { registerSubagentTools, isRestrictedTool } from "../src/core/subagent-tools.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import type { BaseAgent } from "../src/agents/base-agent.js";
import type { Task, StreamCallbacks, ToolContext } from "../src/types.js";

const dir = makeTestDir("subagent-tools");

describe("Sprint 52 Subagent Tools", () => {
  let store: SessionStore;

  beforeEach(() => {
    setupEnv(dir);
    store = new SessionStore(resolve(dir, "tools.db"));
    registerSubagentTools();
  });

  afterEach(() => {
    store.close();
    teardownEnv();
  });

  it("isRestrictedTool 正确标记四个工具", () => {
    expect(isRestrictedTool("spawn_agent")).toBe(true);
    expect(isRestrictedTool("send_message")).toBe(true);
    expect(isRestrictedTool("list_agents")).toBe(true);
    expect(isRestrictedTool("interrupt_agent")).toBe(true);
    expect(isRestrictedTool("fs_read")).toBe(false);
    expect(isRestrictedTool("terminal_exec")).toBe(false);
  });

  it("受限工具已注册到全局注册表", () => {
    expect(toolRegistry.getHandler("spawn_agent")).toBeTruthy();
    expect(toolRegistry.getHandler("send_message")).toBeTruthy();
    expect(toolRegistry.getHandler("list_agents")).toBeTruthy();
    expect(toolRegistry.getHandler("interrupt_agent")).toBeTruthy();
  });

  it("spawn_agent handler 拒绝子智能体递归生成（深度1）", async () => {
    const handler = toolRegistry.getHandler("spawn_agent")!;
    const ctx: ToolContext = {
      agentId: "default",
      sessionId: `${WORKER_SESSION_PREFIX}test-child`,
      workingDir: dir,
      permissions: "auto",
    };
    const result = await handler({ agentId: "default", task: "递归" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("深度");
  });

  it("spawn_agent handler 正常生成主智能体", async () => {
    const { subagentRunner } = await import("../src/core/subagent-runner.js");
    const agentMock = {
      runStream: async () => ({ text: "ok", truncated: false, iterations: 1, toolCallsExecuted: 0, messages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      getConfig: () => ({ tools: [], mcpServers: [], skills: [], plugins: [], permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] } }),
      fork: () => agentMock,
    };
    subagentRunner.init({
      createAgent: () => agentMock as unknown as BaseAgent,
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });

    const handler = toolRegistry.getHandler("spawn_agent")!;
    const ctx: ToolContext = {
      agentId: "default",
      sessionId: "main-session-1",
      workingDir: dir,
      permissions: "auto",
    };
    const result = await handler({ agentId: "default", task: "调研任务" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("sub-");
    subagentRunner.clear();
  });

  it("send_message handler 拒绝操作非本会话子智能体", async () => {
    const handler = toolRegistry.getHandler("send_message")!;
    const ctx: ToolContext = {
      agentId: "default",
      sessionId: "session-a",
      workingDir: dir,
      permissions: "auto",
    };
    const result = await handler({ id: "nonexistent", message: "hi" }, ctx);
    expect(result.success).toBe(false);
  });

  it("list_agents handler 返回空列表", async () => {
    const handler = toolRegistry.getHandler("list_agents")!;
    const ctx: ToolContext = {
      agentId: "default",
      sessionId: "main-session",
      workingDir: dir,
      permissions: "auto",
    };
    const result = await handler({}, ctx);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("interrupt_agent handler 不存在返回失败", async () => {
    const handler = toolRegistry.getHandler("interrupt_agent")!;
    const ctx: ToolContext = {
      agentId: "default",
      sessionId: "main-session",
      workingDir: dir,
      permissions: "auto",
    };
    const result = await handler({ id: "no-such" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("不存在");
  });
});
