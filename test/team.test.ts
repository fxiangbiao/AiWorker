/**
 * Team 协调器测试：模板匹配 / 计划降级 / 执行 / 环检测 / 汇总
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { makeTestDir, setupEnv } from "./helpers.js";

const testDir = makeTestDir("team");
const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "./fixtures/models.json");

describe("14. Team Coordinator", () => {
  let counter = 0;

  async function makeCoordinator(failLLM = false) {
    const { TeamCoordinator } = await import("../src/core/team-coordinator.js");
    const { DefaultAgent } = await import("../src/agents/default-agent.js");
    const { ModelRouter } = await import("../src/core/model-router.js");

    const modelRouter = new ModelRouter(FIXTURE_PATH);
    if (failLLM) {
      modelRouter.completeWithProfile = async () => {
        throw new Error("模拟");
      };
    }
    counter++;
    const sessionStore = new SessionStore(resolve(testDir, `test-coord-${counter}.db`));
    const contextManager = new ContextManager(sessionStore, testDir);
    const deps = { modelRouter, contextManager, sessionStore };
    const agents = { default: new DefaultAgent(deps) };
    const coordinator = new TeamCoordinator(agents, modelRouter);
    return { coordinator, sessionStore };
  }

  it("模板匹配 — 游戏开发关键词触发模板", async () => {
    setupEnv(testDir);
    const { coordinator, sessionStore } = await makeCoordinator();

    const { plan, source } = await coordinator.plan("帮我开发一款放置类手游");
    expect(source).toBe("template");
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.steps[0].expertId).toBe("research"); // game-dev 模板第一步是 research

    sessionStore.close();
  });

  it("模板匹配 — 产品分析关键词触发模板", async () => {
    const { coordinator, sessionStore } = await makeCoordinator();

    const { plan, source } = await coordinator.plan("帮我做一份竞品分析报告");
    expect(source).toBe("template");
    expect(plan.steps.length).toBeGreaterThan(1);

    sessionStore.close();
  });

  it("无模板匹配时降级为单步计划（无 API key 时 LLM 失败走 fallback）", async () => {
    const { coordinator, sessionStore } = await makeCoordinator(true);

    // plan() 现在有 fallback：LLM 失败 → 降级为单步默认计划
    const { plan, source } = await coordinator.plan("一个非常独特的任务");
    expect(source).toBe("template"); // fallback 标记为 template
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].expertId).toBe("default");

    sessionStore.close();
  });

  it("execute 处理单步执行（允许失败）", async () => {
    const { coordinator, sessionStore } = await makeCoordinator(true);

    const plan = {
      steps: [{ id: "s1", description: "测试任务", expertId: "default", dependsOn: [] as string[], critical: true }],
      goal: "测试",
      estimatedSteps: 1,
    };

    const result = await coordinator.execute(plan, testDir, testDir);
    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");

    sessionStore.close();
  }, 10000);

  it("execute 处理多步流水线", async () => {
    const { coordinator, sessionStore } = await makeCoordinator(true);

    const plan = {
      steps: [
        { id: "s1", description: "第一步", expertId: "default", dependsOn: [] as string[], critical: true },
        {
          id: "s2",
          description: "第二步（依赖 s1）",
          expertId: "default",
          dependsOn: ["s1"] as string[],
          critical: false,
        },
      ],
      goal: "流水线测试",
      estimatedSteps: 2,
    };

    const result = await coordinator.execute(plan, testDir, testDir);
    expect(result.plan.steps.length).toBe(2);
    expect(typeof result.text).toBe("string");

    sessionStore.close();
  }, 10000);

  it("validateSteps 自动去除环依赖", async () => {
    const { coordinator, sessionStore } = await makeCoordinator(true);

    const plan = {
      steps: [
        { id: "s1", description: "step1", expertId: "default", dependsOn: ["s3"] as string[], critical: true },
        { id: "s2", description: "step2", expertId: "default", dependsOn: ["s1"] as string[], critical: true },
        { id: "s3", description: "step3", expertId: "default", dependsOn: ["s2"] as string[], critical: true },
      ],
      goal: "环测试",
      estimatedSteps: 3,
    };

    const result = await coordinator.execute(plan, testDir, testDir);
    expect(typeof result.text).toBe("string");

    sessionStore.close();
  }, 10000);

  it("synthesize 生成含全部步骤的报告", async () => {
    const { coordinator, sessionStore } = await makeCoordinator(true);

    const plan = {
      steps: [{ id: "s1", description: "调研", expertId: "research", dependsOn: [] as string[], critical: false }],
      goal: "测试汇总",
      estimatedSteps: 1,
    };

    const result = await coordinator.execute(plan, testDir, testDir);
    expect(result.text).toContain("测试汇总");
    expect(result.text).toContain("s1");

    sessionStore.close();
  }, 10000);
});
