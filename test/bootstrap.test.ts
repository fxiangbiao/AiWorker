/**
 * Sprint 48.0：运行时装配层（createRuntime）与 Server 依赖映射（buildServerDeps）冒烟
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { createRuntime, BUILTIN_AGENT_IDS } from "../src/core/bootstrap.js";
import type { Runtime } from "../src/core/bootstrap.js";
import { buildServerDeps } from "../src/server-deps.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { hookManager } from "../src/hooks/hook-manager.js";
import { makeTestDir, teardownEnv } from "./helpers.js";

const testDir = makeTestDir("bootstrap");
let runtime: Runtime;

beforeAll(async () => {
  runtime = await createRuntime({
    workingDir: resolve(testDir, "work"),
    dataDir: testDir,
    mode: "plan",
    startScheduler: false,
  });
}, 30000);

afterAll(async () => {
  await runtime.shutdown();
  teardownEnv();
});

describe("运行时装配层（Sprint 48.0）", () => {
  it("装配出 7 个内置专家与显式权限模式", () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(runtime.agents[id], `缺少内置专家 ${id}`).toBeDefined();
    }
    expect(BUILTIN_AGENT_IDS.size).toBe(7);
    expect(runtime.defaultMode).toBe("plan");
  });

  it("注册工具与数据目录就绪", () => {
    expect(toolRegistry.getAll().length).toBeGreaterThan(0);
    expect(runtime.sessionStore).toBeDefined();
    expect(runtime.workingDir).toBe(resolve(testDir, "work"));
    expect(runtime.dataDir).toBe(resolve(testDir));
  });

  it("thinking 开关可读写，并可经 applyConfigField 变更", () => {
    expect(runtime.getShowThinking()).toBe(false);
    runtime.setShowThinking(true);
    expect(runtime.getShowThinking()).toBe(true);
    expect(runtime.applyConfigField("thinking", false).ok).toBe(true);
    expect(runtime.getShowThinking()).toBe(false);
    expect(runtime.applyConfigField("不存在的字段", 1).ok).toBe(false);
  });

  it("buildServerDeps 映射字段完整", () => {
    const deps = buildServerDeps(runtime);
    const list = deps.getAgentList();
    expect(list.length).toBe(Object.keys(runtime.agents).length);
    expect(list.every((a) => typeof a.id === "string" && typeof a.systemPrompt === "string")).toBe(true);
    expect(list.some((a) => a.id === "coding" && typeof a.hasConfig === "boolean")).toBe(true);
    expect(deps.getAgentMeta?.().tools.length).toBeGreaterThan(0);
    expect(Array.isArray(deps.getSkills?.())).toBe(true);
    expect(deps.sessionStore).toBe(runtime.sessionStore);
    expect(deps.getConfigState?.().appVersion).toBeTruthy();
    expect(typeof deps.getSystemPrompt?.()).toBe("string");
  });

  it("hooks 与检查点已接线：onMessage 即创建回合检查点", async () => {
    const sessionId = "s-boot-checkpoint";
    runtime.sessionStore.ensureSession(sessionId, "default");
    await hookManager.trigger("onMessage", {
      agentId: "default",
      sessionId,
      data: { instruction: "接线测试" },
    });
    const turns = runtime.rewindService.list(sessionId);
    expect(turns.map((t) => t.turn)).toEqual([1]);
    expect(turns[0]!.userInput).toBe("接线测试");
    expect(turns[0]!.messageSeqBefore).toBe(1);
  });

  it("shutdown 幂等（重复调用不抛错）", async () => {
    await runtime.shutdown();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
