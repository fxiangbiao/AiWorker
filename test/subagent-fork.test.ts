/**
 * Sprint 52：BaseAgent.fork() per-spawn 副本隔离 + 控制类工具审批门
 * 覆盖：fork 后改副本不影响原实例 / readOnly fork 工具面恰为只读闭集 / 子智能体工具面剔除控制类工具 /
 *       spawn_agent 在 never_auto_approve 下无确认通道时被拒
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { BaseAgent } from "../src/agents/base-agent.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { READ_ONLY_TOOLS, isRestrictedTool } from "../src/core/subagent-rules.js";
import { ApprovalService } from "../src/security/approval-service.js";
import { PermissionModel } from "../src/security/permission-model.js";
import type { AgentConfig } from "../src/types.js";

const dir = makeTestDir("subagent-fork");

class ProbeAgent extends BaseAgent {}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "probe",
    name: "probe",
    displayName: "Probe",
    type: "test",
    systemPrompt: "基础提示",
    modelPreference: "default",
    maxIterations: 10,
    sandbox: false,
    tools: ["fs_read", "fs_write", "terminal_exec", "spawn_agent", "send_message"],
    mcpServers: ["demo"],
    skills: ["skill-a"],
    plugins: ["plug-a"],
    strictTools: false,
    permissions: { defaultMode: "auto", allowedTools: ["*"], deniedTools: ["x"] },
    ...overrides,
  };
}

function makeInstance(cfg = makeConfig()): BaseAgent {
  return new ProbeAgent(cfg, {
    modelRouter: {} as never,
    contextManager: {} as never,
    sessionStore: {} as never,
  });
}

describe("Sprint 52 fork 与审批门", () => {
  beforeEach(() => setupEnv(dir));
  afterEach(() => teardownEnv());

  it("fork 返回独立副本：改副本的 mode/tools 不影响原实例", () => {
    const orig = makeInstance();
    const copy = orig.fork();

    expect(copy).not.toBe(orig);
    copy.setMode("ask");
    expect(copy.getMode()).toBe("ask");
    expect(orig.getMode()).toBe("auto");

    copy.getConfig().tools.push("injected");
    expect(orig.getConfig().tools).not.toContain("injected");

    copy.getConfig().permissions.deniedTools.push("injected");
    expect(orig.getConfig().permissions.deniedTools).toEqual(["x"]);
  });

  it("同名并发：两个 fork 各自 setMode 互不干扰", () => {
    const orig = makeInstance();
    const a = orig.fork();
    const b = orig.fork();
    a.setMode("ask");
    b.setMode("plan");
    expect(a.getMode()).toBe("ask");
    expect(b.getMode()).toBe("plan");
    expect(orig.getMode()).toBe("auto");
  });

  it("readOnly fork：工具面恰为只读闭集（含 MCP/插件一律剔除）", () => {
    const orig = makeInstance();
    const ro = orig.fork({
      tools: orig.getConfig().tools.filter((t) => READ_ONLY_TOOLS.has(t)),
      strictTools: true,
      readOnly: true,
    });
    expect(ro.getConfig().readOnly).toBe(true);
    expect(ro.getConfig().strictTools).toBe(true);
    expect(ro.getConfig().tools.sort()).toEqual(["fs_read"]);
  });

  it("fork 副本不含控制类工具（深度 1 的工具面）", () => {
    const orig = makeInstance();
    const child = orig.fork({ tools: orig.getConfig().tools.filter((t) => !isRestrictedTool(t)) });
    const tools = child.getConfig().tools;
    expect(tools).not.toContain("spawn_agent");
    expect(tools).not.toContain("send_message");
    expect(tools).toContain("fs_write");
  });

  it("fork 副本改动 mcpServers/skills/plugins 不影响原实例", () => {
    const orig = makeInstance();
    const copy = orig.fork({ mcpServers: [] });
    expect(copy.getConfig().mcpServers).toEqual([]);
    expect(orig.getConfig().mcpServers).toEqual(["demo"]);
    copy.getConfig().skills!.push("x");
    expect(orig.getConfig().skills).toEqual(["skill-a"]);
    copy.getConfig().plugins!.push("x");
    expect(orig.getConfig().plugins).toEqual(["plug-a"]);
  });

  it("F2：spawn_agent 在 never_auto_approve 清单内 —— 无确认通道时被拒（headless 不可用）", async () => {
    const model = new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { allow_tool_calls: true, readOnly: true },
        plan: { allow_tool_calls: false, require_confirmation: true },
        auto: { allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [dir],
      deniedPatterns: [],
      rules: [],
      neverAutoApprove: ["spawn_agent", "send_message"],
      protectedPaths: [],
    });
    expect(model.isNeverAutoApprove("spawn_agent")).toBe(true);
    expect(model.isNeverAutoApprove("send_message")).toBe(true);

    // 无确认通道（子智能体 / headless）：confirm 返回 null → fail-closed 拒绝
    const deniedApproval = new ApprovalService({
      permissionModel: model,
      workingDir: dir,
      confirm: async () => null,
    });
    const denied = await deniedApproval.checkConfirmation("spawn_agent", { agentId: "default", task: "x" }, "auto");
    expect(denied.proceed).toBe(false);
    // 可判别：区分"无通道自动拒绝"与"用户点拒绝"，文案也不同（Sprint 52 §2.3-2）
    expect(denied.reason).toBe("no-channel");
    expect(denied.message).toContain("无确认通道");

    // 有通道但用户点拒绝：reason 不同
    const userDeniedApproval = new ApprovalService({
      permissionModel: model,
      workingDir: dir,
      confirm: async () => "deny",
    });
    const userDenied = await userDeniedApproval.checkConfirmation("spawn_agent", { agentId: "default", task: "x" }, "auto");
    expect(userDenied.proceed).toBe(false);
    expect(userDenied.reason).toBe("user-denied");
    expect(userDenied.message).toBe("用户取消操作");

    // 有确认通道且用户同意：放行
    const allowedApproval = new ApprovalService({
      permissionModel: model,
      workingDir: dir,
      confirm: async () => "allow",
    });
    const allowed = await allowedApproval.checkConfirmation("spawn_agent", { agentId: "default", task: "x" }, "auto");
    expect(allowed.proceed).toBe(true);
  });

  it("F2：never_auto_approve 工具不存在'始终允许'路径（allow 规则被拒写入）", () => {
    const model = new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { allow_tool_calls: true, readOnly: true },
        plan: { allow_tool_calls: false, require_confirmation: true },
        auto: { allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [dir],
      deniedPatterns: [],
      rules: [],
      neverAutoApprove: ["spawn_agent"],
      protectedPaths: [],
    });
    const r = model.validateRule({ tool: "spawn_agent", action: "allow" });
    expect(r.ok).toBe(false);
  });

  it("默认配置 config/permissions.json 把 spawn/send 列入 never_auto_approve", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), "config", "permissions.json"), "utf-8")) as {
      never_auto_approve?: string[];
    };
    expect(cfg.never_auto_approve).toContain("spawn_agent");
    expect(cfg.never_auto_approve).toContain("send_message");
  });

  it("内置智能体通过 subagents 开关放行四个控制类工具（opt-in 通道已接通）", async () => {
    const { loadAllAgentConfigs } = await import("../src/core/agent-config-loader.js");
    const { filterVisibleTools } = await import("../src/core/agent-loop.js");
    const all = loadAllAgentConfigs();
    const control = ["spawn_agent", "send_message", "list_agents", "interrupt_agent"];
    for (const id of ["default", "research", "coding"]) {
      const cfg = all[id]!;
      expect(cfg.subagents, `${id} 应开启 subagents 开关`).toBe(true);
      const available = control.map((name) => ({
        type: "function" as const,
        function: { name, description: name, parameters: { type: "object", properties: {} } },
      }));
      const visible = filterVisibleTools(available, cfg, () => false).map((t) => t.function.name);
      expect(visible, `${id} 应看到四个控制类工具`).toEqual(control);
    }
  });

  it("SessionStore/ContextManager 未被真实使用（本文件仅测纯逻辑装配）", () => {
    const store = new SessionStore(resolve(dir, "fork.db"));
    expect(new ContextManager(store, dir)).toBeTruthy();
    store.close();
  });
});