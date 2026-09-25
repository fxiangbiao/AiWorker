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

  it("协作工作会话（wk- 前缀）不出现在 listSessions", async () => {
    const { sessionStore } = await makeCoordinator(true);
    const sid = sessionStore.createSession("default").id; // 用户会话
    sessionStore.ensureSession("wk-abc-1", "research"); // 协作步骤工作会话
    const list = sessionStore.listSessions(50);
    expect(list.some((s) => s.id === sid)).toBe(true);
    expect(list.some((s) => s.id === "wk-abc-1")).toBe(false);
    sessionStore.close();
  });

  it("execute 的步骤会话带 wk- 前缀（隔离保留但不进用户列表）", async () => {
    const { coordinator, sessionStore } = await makeCoordinator();
    const plan = {
      steps: [{ id: "s1", description: "协作步骤", expertId: "default", dependsOn: [] as string[], critical: true }],
      goal: "worker 会话测试",
      estimatedSteps: 1,
    };
    const result = await coordinator.execute(plan, testDir, testDir);
    expect(result.plan.steps.length).toBe(1);
    // 步骤确实运行了（会话被创建），但全部带 wk- 前缀 → 用户列表为空
    expect(sessionStore.listSessions(50).length).toBe(0);
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

  it("DAG worker 与子智能体同权：无确认通道、不看控制面工具、父会话通道不受影响", async () => {
    const { TeamCoordinator } = await import("../src/core/team-coordinator.js");
    const { requestConfirm, setConfirmProvider } = await import("../src/hooks/confirm-channel.js");
    const restore = setConfirmProvider(async () => "allow");
    const patches: Array<Record<string, unknown>> = [];
    let workerAnswer: string | null | undefined;
    const worker = {
      run: async () => {
        workerAnswer = await requestConfirm("worker 危险操作？", [{ value: "allow", label: "允许" }]);
        return { text: "worker 结果" };
      },
      getConfig: () => ({
        tools: ["fs_read", "spawn_agent", "send_message"],
        mcpServers: [],
        skills: [],
        plugins: [],
        subagents: true,
        permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
      }),
      fork: (p: Record<string, unknown>) => {
        patches.push(p);
        return worker;
      },
    };
    const coordinator = new TeamCoordinator({ default: worker as never }, {} as never);
    const plan = {
      steps: [{ id: "s1", description: "调研", expertId: "default", dependsOn: [] as string[], critical: true }],
      goal: "worker 权限",
      estimatedSteps: 1,
    };

    await coordinator.execute(plan as never, testDir, testDir as never);
    expect(workerAnswer).toBeNull();
    expect(patches[0]!.subagents).toBe(false);
    // 控制面工具即使被显式写进 YAML tools，也要从 worker 工具面剔除（不能只靠 subagents:false）
    expect(patches[0]!.tools).toEqual(["fs_read"]);
    expect(await requestConfirm("父会话危险操作？", [{ value: "allow", label: "允许" }])).toBe("allow");
    setConfirmProvider(restore);
  });
});
