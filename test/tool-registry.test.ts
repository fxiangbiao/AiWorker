/**
 * ToolRegistry 作用域视图单测（Sprint 27，报告 #2）
 * 覆盖：scope 创建 / 同名遮蔽全局 / 全局回退 / getAvailableDefinitions 过滤 / unregister / listScopeTools / plugin 归属
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toolRegistry } from "../src/core/tool-registry.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import type { ToolDefinition, ToolContext } from "../src/types.js";

function def(name: string): ToolDefinition {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

const ctx: ToolContext = {
  agentId: "test",
  sessionId: "s1",
  workingDir: process.cwd(),
  permissions: "auto",
};

beforeEach(() => {
  setupEnv(makeTestDir("tool-registry"));
});

afterEach(() => {
  teardownEnv();
  clearTools();
});

describe("ToolRegistry 作用域视图", () => {
  it("无 scope 注册时 view 回退全局", async () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "global" }));
    const view = toolRegistry.getScope("coding");
    expect(view.isAvailable("alpha")).toBe(true);
    const names = (await view.getAvailableDefinitions(ctx)).map((d) => d.function.name);
    expect(names).toContain("alpha");
  });

  it("scope 同名注册遮蔽全局（handler 解析走 scope）", async () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "global" }));
    const view = toolRegistry.getScope("coding");
    view.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "scoped" }));

    const scopedResult = await view.getHandler("alpha")!({}, ctx);
    expect(scopedResult.content).toBe("scoped");
    const globalResult = await toolRegistry.getHandler("alpha")!({}, ctx);
    expect(globalResult.content).toBe("global");
    // 可见定义中同名合并为 scope 版（只出现一次）
    const defs = await view.getAvailableDefinitions(ctx);
    expect(defs.filter((d) => d.function.name === "alpha")).toHaveLength(1);
  });

  it("scope unregister 后回退全局", () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "global" }));
    const view = toolRegistry.getScope("coding");
    view.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "scoped" }));
    expect(view.unregister("alpha")).toBe(true);
    expect(view.getHandler("alpha")).toBeDefined(); // 回退全局
  });

  it("getAvailableDefinitions 过滤 disabled 与 availabilityCheck", async () => {
    toolRegistry.register("beta", def("beta"), async () => ({ tool_call_id: "", success: true, content: "" }));
    toolRegistry.register("gamma", def("gamma"), async () => ({ tool_call_id: "", success: true, content: "" }), {
      enabled: false,
    });
    toolRegistry.register("delta", def("delta"), async () => ({ tool_call_id: "", success: true, content: "" }), {
      availabilityCheck: () => false,
    });
    const view = toolRegistry.getScope("coding");
    const names = (await view.getAvailableDefinitions(ctx)).map((d) => d.function.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("gamma");
    expect(names).not.toContain("delta");
  });

  it("listScopeTools 只返回 scope 独立注册（不含全局回退）", () => {
    toolRegistry.register("global_tool", def("global_tool"), async () => ({ tool_call_id: "", success: true, content: "" }));
    const view = toolRegistry.getScope("coding");
    view.register("scoped_tool", def("scoped_tool"), async () => ({ tool_call_id: "", success: true, content: "" }));
    const names = toolRegistry.listScopeTools("coding").map((t) => t.definition.function.name);
    expect(names).toEqual(["scoped_tool"]);
  });

  it("scope 注册的工具带 plugin 归属标记", () => {
    const view = toolRegistry.getScope("coding");
    view.register("p_tool", def("p_tool"), async () => ({ tool_call_id: "", success: true, content: "" }), {
      plugin: "demo",
    });
    expect(toolRegistry.listScopeTools("coding")[0]!.plugin).toBe("demo");
  });

  it("isPluginTool 区分插件工具（全局与 scope 回退）", () => {
    toolRegistry.register("plain", def("plain"), async () => ({ tool_call_id: "", success: true, content: "" }));
    toolRegistry.register("plug", def("plug"), async () => ({ tool_call_id: "", success: true, content: "" }), {
      plugin: "demo",
    });
    expect(toolRegistry.isPluginTool("plain")).toBe(false);
    expect(toolRegistry.isPluginTool("plug")).toBe(true);

    const view = toolRegistry.getScope("coding");
    view.register("scoped_plug", def("scoped_plug"), async () => ({ tool_call_id: "", success: true, content: "" }), {
      plugin: "demo2",
    });
    expect(view.isPluginTool("scoped_plug")).toBe(true);
    expect(view.isPluginTool("plug")).toBe(true); // 回退全局
    expect(view.isPluginTool("plain")).toBe(false);
  });
});
