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

  it("模型切换：写侧字段名 model 与读侧别名 profileKey 都能生效（回归：未知配置项 profileKey）", () => {
    // 走 Web 实际命中的注入路径（POST /config → deps.setConfigField），而非直接调 applyConfigField
    const setField = buildServerDeps(runtime).setConfigField!;
    const keys = runtime.modelRouter.getAvailableModels().map((m) => m.key);
    expect(keys.length).toBeGreaterThan(1);
    const target = keys.find((k) => k !== "default") ?? keys[0]!;

    // 规范名（文档化字段，CLI /config model 与进化提案都用它）
    const r1 = setField("model", target);
    expect(r1.ok, r1.error).toBe(true);
    expect(runtime.modelRouter.getRuntimeConfig().profileKey).toBe(target);

    // 读侧同义名（GET /config 暴露为 runtimeConfig.profileKey，前端曾按此名写回）
    const other = keys.find((k) => k !== target) ?? "default";
    const r2 = setField("profileKey", other);
    expect(r2.ok, r2.error).toBe(true);
    expect(runtime.modelRouter.getRuntimeConfig().profileKey).toBe(other);

    // 未知 key 仍要拒绝（别名兼容不能放宽校验）
    const bad = setField("profileKey", "no-such-model");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("未知模型");

    // 未知字段报错要给出可用字段（本次问题的可诊断性改进）
    const unknown = setField("no-such-field", 1);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("可用：");

    // 大小写归一与 CLI /config model 一致（能存进去就必须能选回来）
    const upper = setField("model", target.toUpperCase());
    expect(upper.ok, upper.error).toBe(true);
    expect(runtime.modelRouter.getRuntimeConfig().profileKey).toBe(target);

    // 「能选」必须等于「真的用上」：当前模型与展示上下文都要跟着 profile 走
    const expectedModel = runtime.modelRouter.getAvailableModels().find((m) => m.key === target)!.model;
    expect(runtime.modelRouter.getCurrentModel()).toBe(expectedModel);
    expect(runtime.modelRouter.getDisplayModel()).toContain(`(${target})`);

    runtime.applyConfigField("reset", undefined);
    expect(runtime.modelRouter.getRuntimeConfig().profileKey).toBe("");
    expect(runtime.modelRouter.getDisplayModel()).not.toContain(`(${target})`);
  });

  it("新增 profile 后可立即被选中（添加 → 下拉 → 切换 的完整链路）", () => {
    // addModel 会把 profile 写回真实的 config/models.json（进程 cwd 下的仓库文件），
    // 因此这里用 addProfile 直接验证"运行时立即可见 + 可被切换"，避免测试污染仓库配置
    const setField = buildServerDeps(runtime).setConfigField!;
    expect(runtime.modelRouter.addProfile("regression-probe", { model: "probe-model", baseURL: "https://example.invalid/v1" })).toBe(true);
    try {
      expect(runtime.modelRouter.getAvailableModels().map((m) => m.key)).toContain("regression-probe");
      const r = setField("profileKey", "regression-probe");
      expect(r.ok, r.error).toBe(true);
      expect(runtime.modelRouter.getRuntimeConfig().profileKey).toBe("regression-probe");
    } finally {
      delete (runtime.modelRouter as unknown as { config: { profiles: Record<string, unknown> } }).config.profiles["regression-probe"];
      runtime.applyConfigField("reset", undefined);
    }
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
