import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server | undefined;
let base: string;
const testDir = mkdtempSync(join(tmpdir(), "agents-api-"));

const saved: Record<string, unknown> = {};
const deleted: string[] = [];

const baseAgent = {
  id: "default",
  name: "通用助手",
  displayName: "通用助手",
  type: "default",
  modelPreference: "default",
  maxIterations: 30,
  tools: [],
  skills: [],
  mcpServers: [],
  plugins: [],
  strictTools: false,
  permissions: { defaultMode: "ask", allowedTools: [], deniedTools: [] },
  systemPrompt: "默认助手",
  isCustom: false,
  hasConfig: false,
};

const deps = {
  modelRouter: { getCurrentModel: () => "test" } as never,
  workingDir: testDir,
  coordinator: {} as never,
  createAgent: () => ({ runStream: async () => ({ text: "", messages: [], iterations: 0, truncated: false }) }) as never,
  getAgentList: () => [baseAgent],
  saveAgentConfig: (id: string, cfg: unknown) => {
    saved[id] = cfg;
    return { ok: true };
  },
  deleteAgentConfig: (id: string) => {
    deleted.push(id);
    return { ok: true };
  },
  isBuiltinAgent: (id: string) => id === "default",
  getAgentMeta: () => ({
    tools: [{ name: "fs_read", description: "读取文件" }],
    skills: [{ name: "skill-a", expert: "general", description: "示例技能" }],
    mcp: [{ name: "github", connected: true, toolCount: 2 }],
    plugins: [{ name: "my-plugin", tools: ["tool_x"], status: "loaded" }],
  }),
  skillNames: ["skill-a"],
  dataDir: testDir,
};

async function post(url: string, body?: unknown): Promise<{ status: number; data: { ok?: boolean; error?: string } }> {
  const r = await fetch(base + url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as { ok?: boolean; error?: string } };
}

describe("Agents API", () => {
  beforeAll(async () => {
    server = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    if (server) server.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("GET /agents 返回完整配置列表", async () => {
    const r = await fetch(`${base}/api/v1/agents`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { agents: typeof baseAgent[] };
    expect(d.agents.length).toBe(1);
    expect(d.agents[0]!.displayName).toBe("通用助手");
    expect(d.agents[0]!.systemPrompt).toBe("默认助手");
    expect(d.agents[0]!.isCustom).toBe(false);
  });

  it("GET /agents/meta 返回表单选项", async () => {
    const r = await fetch(`${base}/api/v1/agents/meta`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { tools: { name: string }[]; skills: { name: string }[]; mcp: { name: string }[]; plugins: { name: string }[] };
    expect(d.tools[0]!.name).toBe("fs_read");
    expect(d.skills[0]!.name).toBe("skill-a");
    expect(d.mcp[0]!.name).toBe("github");
    expect(d.plugins[0]!.name).toBe("my-plugin");
  });

  it("POST /agents/<id>/config 新建自定义智能体", async () => {
    const { status } = await post("/api/v1/agents/my-agent/config", {
      displayName: "我的智能体",
      systemPrompt: "你是测试助手。",
      modelPreference: "coding",
      maxIterations: 40,
      tools: ["fs_read"],
      skills: ["skill-a"],
      mcpServers: ["github"],
      plugins: ["my-plugin"],
      strictTools: true,
      permissions: { defaultMode: "plan" },
    });
    expect(status).toBe(200);
    expect(saved["my-agent"]).toBeTruthy();
    const cfg = saved["my-agent"] as {
      id: string;
      type: string;
      skills: string[];
      mcpServers: string[];
      strictTools: boolean;
      permissions: { defaultMode: string };
    };
    expect(cfg.id).toBe("my-agent");
    expect(cfg.type).toBe("custom");
    expect(cfg.skills).toEqual(["skill-a"]);
    expect(cfg.mcpServers).toEqual(["github"]);
    expect(cfg.strictTools).toBe(true);
    expect(cfg.permissions.defaultMode).toBe("plan");
  });

  it("POST config 校验失败返回 400", async () => {
    const bad1 = await post("/api/v1/agents/bad-agent/config", { displayName: "", systemPrompt: "x" });
    expect(bad1.status).toBe(400);
    const bad2 = await post("/api/v1/agents/bad-agent/config", { displayName: "x", systemPrompt: "y", modelPreference: "nope" });
    expect(bad2.status).toBe(400);
    const bad3 = await post("/api/v1/agents/Upper-Case/config", { displayName: "x", systemPrompt: "y" });
    expect(bad3.status).toBe(400);
  });

  it("内置智能体 reset 恢复默认；自定义不可 reset（无 body 也应 200/400，不报 Invalid JSON）", async () => {
    const ok = await post("/api/v1/agents/default/reset");
    expect(ok.status).toBe(200);
    expect(ok.data.ok).toBe(true);
    expect(deleted).toContain("default");
    const bad = await post("/api/v1/agents/my-agent/reset");
    expect(bad.status).toBe(400);
    expect(bad.data.error).not.toContain("Invalid JSON");
  });

  it("自定义智能体可删除；内置不可删除（无 body 形态）", async () => {
    const bad = await post("/api/v1/agents/default/delete");
    expect(bad.status).toBe(400);
    const ok = await post("/api/v1/agents/my-agent/delete");
    expect(ok.status).toBe(200);
    expect(ok.data.ok).toBe(true);
    expect(deleted).toContain("my-agent");
  });

  it("POST /agents/<id>/config 保存 permissions.allowedTools/deniedTools（嵌套内层，Bug 修复）", async () => {
    saved["perm-agent"] = undefined;
    const { status } = await post("/api/v1/agents/perm-agent/config", {
      displayName: "权限智能体",
      systemPrompt: "你按白名单执行。",
      modelPreference: "default",
      maxIterations: 30,
      tools: ["fs_read", "fs_write"],
      skills: [],
      mcpServers: [],
      plugins: [],
      strictTools: false,
      permissions: { defaultMode: "ask", allowedTools: ["fs_read", "fs_write"], deniedTools: ["terminal_exec"] },
    });
    expect(status).toBe(200);
    const cfg = saved["perm-agent"] as {
      permissions?: { defaultMode?: string; allowedTools?: string[]; deniedTools?: string[] };
    };
    expect(cfg.permissions?.allowedTools).toEqual(["fs_read", "fs_write"]);
    expect(cfg.permissions?.deniedTools).toEqual(["terminal_exec"]);
    expect(cfg.permissions?.defaultMode).toBe("ask");
  });
});
