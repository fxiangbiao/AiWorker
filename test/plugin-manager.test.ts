/**
 * 插件管理器单测（Sprint 27，报告 #1）
 * 覆盖：setup 调用 / 工具注册生效 / 对象导出 / config.json 注入 / hook 注册 / scope 注册 / fail-soft / 幂等
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { PluginManager } from "../src/core/plugin-manager.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { hookManager } from "../src/hooks/hook-manager.js";
import type { ToolContext } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("plugins-test");
  setupEnv(dir);
});

afterEach(() => {
  teardownEnv();
  clearTools();
  hookManager.clear();
});

function writePlugin(name: string, source: string): string {
  const pDir = resolve(dir, name);
  mkdirSync(pDir, { recursive: true });
  writeFileSync(resolve(pDir, "plugin.ts"), source, "utf-8");
  return pDir;
}

const toolCtx: ToolContext = {
  agentId: "coding",
  sessionId: "s",
  workingDir: process.cwd(),
  permissions: "auto",
};

describe("PluginManager", () => {
  it("加载插件调用 setup，注册的工具全局可见可执行", async () => {
    writePlugin(
      "hello",
      `export default async function setup(ctx) {
        ctx.registerTool("hello_tool", {
          type: "function",
          function: { name: "hello_tool", description: "打招呼", parameters: { type: "object", properties: {} } },
        }, async (_args, toolCtx) => ({ tool_call_id: "", success: true, content: "你好，" + toolCtx.agentId }));
      }`,
    );
    const manager = new PluginManager();
    const summary = await manager.loadFromDir(dir, { dataDir: resolve(dir, "data") });
    expect(summary).toEqual({ loaded: 1, failed: 0 });
    expect(manager.getPlugin("hello")?.status).toBe("loaded");
    expect(manager.getPlugin("hello")?.registeredTools).toEqual(["hello_tool"]);
    expect(toolRegistry.isAvailable("hello_tool")).toBe(true);
    const result = await toolRegistry.getHandler("hello_tool")!({}, toolCtx);
    expect(result.content).toBe("你好，coding");
  });

  it("支持对象导出 { setup, version, description }", async () => {
    writePlugin(
      "obj",
      `export default {
        version: "1.2.0",
        description: "对象导出",
        setup: (ctx) => {
          ctx.registerTool("obj_tool", { type: "function", function: { name: "obj_tool", description: "x", parameters: { type: "object", properties: {} } } }, async () => ({ tool_call_id: "", success: true, content: "ok" }));
        },
      };`,
    );
    const manager = new PluginManager();
    await manager.loadFromDir(dir);
    const info = manager.getPlugin("obj");
    expect(info?.status).toBe("loaded");
    expect(info?.version).toBe("1.2.0");
    expect(info?.description).toBe("对象导出");
    expect(toolRegistry.isAvailable("obj_tool")).toBe(true);
  });

  it("config.json 注入 ctx.config", async () => {
    const pDir = writePlugin(
      "cfg",
      `export default async function setup(ctx) {
        if (ctx.config && ctx.config.greeting === "hello") {
          ctx.registerTool("cfg_tool", { type: "function", function: { name: "cfg_tool", description: "x", parameters: { type: "object", properties: {} } } }, async () => ({ tool_call_id: "", success: true, content: "configured" }));
        }
      }`,
    );
    writeFileSync(resolve(pDir, "config.json"), JSON.stringify({ greeting: "hello" }), "utf-8");
    const manager = new PluginManager();
    await manager.loadFromDir(dir);
    expect(toolRegistry.isAvailable("cfg_tool")).toBe(true);
  });

  it("注册 hook 生效", async () => {
    writePlugin(
      "hooky",
      `export default async function setup(ctx) {
        ctx.registerHook("onMessage", async (hc) => {
          if (hc.data && hc.data.instruction === "ping") return { proceed: true, modifiedData: { pong: true } };
        });
      }`,
    );
    const manager = new PluginManager();
    await manager.loadFromDir(dir);
    expect(manager.getPlugin("hooky")?.registeredHooks).toBe(1);
    const result = await hookManager.trigger("onMessage", {
      agentId: "t",
      sessionId: "s",
      data: { instruction: "ping" },
    });
    expect(result.modifiedData).toMatchObject({ pong: true });
  });

  it("scope 注册：仅 scope view 可见，全局不可见", async () => {
    writePlugin(
      "scoper",
      `export default async function setup(ctx) {
        ctx.registerTool("secret_tool", { type: "function", function: { name: "secret_tool", description: "x", parameters: { type: "object", properties: {} } } }, async () => ({ tool_call_id: "", success: true, content: "secret" }), { scope: "coding" });
      }`,
    );
    const manager = new PluginManager();
    await manager.loadFromDir(dir);
    expect(manager.getPlugin("scoper")?.registeredTools).toEqual(["coding:secret_tool"]);
    expect(toolRegistry.isAvailable("secret_tool")).toBe(false);
    expect(toolRegistry.getScope("coding").isAvailable("secret_tool")).toBe(true);
  });

  it("入口缺失 → status error，不抛异常", async () => {
    mkdirSync(resolve(dir, "empty"), { recursive: true });
    const manager = new PluginManager();
    const summary = await manager.loadFromDir(dir);
    expect(summary.failed).toBe(1);
    expect(manager.getPlugin("empty")?.status).toBe("error");
    expect(manager.getPlugin("empty")?.error).toContain("缺少入口");
  });

  it("导出非函数 → status error", async () => {
    writePlugin("bad", "export default 42;");
    const manager = new PluginManager();
    const summary = await manager.loadFromDir(dir);
    expect(summary.failed).toBe(1);
    expect(manager.getPlugin("bad")?.status).toBe("error");
  });

  it("重复加载幂等：不重复注册", async () => {
    writePlugin(
      "idem",
      `export default async function setup(ctx) {
        ctx.registerTool("idem_tool", { type: "function", function: { name: "idem_tool", description: "x", parameters: { type: "object", properties: {} } } }, async () => ({ tool_call_id: "", success: true, content: "ok" }));
      }`,
    );
    const manager = new PluginManager();
    await manager.loadFromDir(dir);
    await manager.loadFromDir(dir);
    expect(manager.getPlugin("idem")?.registeredTools).toEqual(["idem_tool"]);
    expect(toolRegistry.isAvailable("idem_tool")).toBe(true);
  });

  it("目录不存在返回 0", async () => {
    const manager = new PluginManager();
    expect(await manager.loadFromDir(resolve(dir, "nonexistent"))).toEqual({ loaded: 0, failed: 0 });
  });
});
