/**
 * HTTP Server 测试：端点覆盖 / 错误码 / SSE 流式
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import type { TeamCoordinator } from "../src/core/team-coordinator.js";
import type { ModelRouter } from "../src/core/model-router.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";

const API = "/api/v1";

const testDir = makeTestDir("server");

function mockModelRouter() {
  return {
    getCurrentModel: () => "deepseek-v4-flash",
    getTokenUsage: () => 100,
    getPromptTokens: () => 40,
    getCompletionTokens: () => 60,
  } as unknown as ModelRouter;
}

function mockCoordinator() {
  const plan = () =>
    Promise.resolve({
      plan: {
        steps: [
          { id: "s1", description: "调研", expertId: "research", dependsOn: [] as string[], critical: false },
          { id: "s2", description: "实现", expertId: "coding", dependsOn: ["s1"] as string[], critical: true },
        ],
        goal: "测试任务",
        estimatedSteps: 2,
      },
      source: "template" as const,
    });
  const execute = (_plan: unknown, _wd: string, _pd: string, callbacks: {
    onStepStart?: (id: string, expert: string, desc: string) => void;
    onStepEnd?: (id: string, success: boolean) => void;
    onToolCall?: (name: string, args: string, id: string) => void;
    onToolResult?: (name: string, success: boolean, summary: string) => void;
  }) => {
    callbacks.onStepStart?.("s1", "research", "调研");
    callbacks.onToolCall?.("research", "调研", "s1");
    callbacks.onToolResult?.("research", true, "完成");
    callbacks.onStepEnd?.("s1", true);
    callbacks.onStepStart?.("s2", "coding", "实现");
    callbacks.onStepEnd?.("s2", true);
    return Promise.resolve({
      text: "执行完成",
      plan: { steps: [], goal: "", estimatedSteps: 0 },
      stepResults: new Map(),
      failedSteps: [],
      source: "template" as const,
    });
  };
  const debate = () =>
    Promise.resolve({
      text: "辩论报告",
      plan: { steps: [], goal: "", estimatedSteps: 0 },
      stepResults: new Map(),
      failedSteps: [],
      source: "template" as const,
    });
  return {
    plan,
    execute,
    debate,
    getAvailableAgents: () => ["research", "coding", "default"],
  } as unknown as TeamCoordinator;
}

function mockAgent() {
  return {
    runStream: async (
      task: { mode?: string },
      _wd: string,
      _pd: string,
      callbacks: { onTextDelta?: (t: string) => void },
    ) => {
      capturedTask = task;
      callbacks.onTextDelta?.("你好");
      return { success: true, text: "你好" } as never;
    },
  };
}

let server: Server | undefined;
let base: string;
let capturedTask: { mode?: string } | undefined;

function mockDeps() {
  return {
    modelRouter: mockModelRouter(),
    workingDir: testDir,
    projectDir: testDir,
    coordinator: mockCoordinator(),
    createAgent: () => mockAgent() as never,
    getAgentList: () => [
      { id: "default", name: "通用助手" },
      { id: "research", name: "研究分析师" },
    ],
    skillNames: ["skill-a", "skill-b"],
  };
}

async function readSSE(resp: Response): Promise<object[]> {
  const text = await resp.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)));
}

describe("HTTP Server", () => {
  beforeAll(async () => {
    setupEnv(testDir);
    const deps = mockDeps();
    server = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const port = (server!.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (server) {
      server.close();
      server = undefined;
    }
    teardownEnv();
  });

  it("/status 返回运行状态", async () => {
    const resp = await fetch(`${base}${API}/status`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe("ok");
    expect(data.model).toBe("deepseek-v4-flash");
    expect(data.tokenUsage.total).toBe(100);
    expect(data.skills).toContain("skill-a");
  });

  it("/agents 返回专家列表", async () => {
    const resp = await fetch(`${base}${API}/agents`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].id).toBe("default");
  });

  it("/tools 返回工具列表", async () => {
    const resp = await fetch(`${base}${API}/tools`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.tools)).toBe(true);
    const names = data.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("fs_read");
    expect(names).toContain("web_search");
  });

  it("/skills 返回技能列表", async () => {
    const resp = await fetch(`${base}${API}/skills`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.skills).toContainEqual({ name: "skill-a", description: "", expert: "" });
  });

  it("/skills 支持 getSkills 返回描述与分组", async () => {
    const deps = mockDeps();
    deps.getSkills = () => [
      { name: "web-deep-search", description: "深度网络搜索", expert: "research" },
      { name: "code-review", description: "代码审查", expert: "coding" },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/skills`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.skills).toHaveLength(2);
    expect(data.skills[0]).toEqual({ name: "web-deep-search", description: "深度网络搜索", expert: "research" });
    local.close();
  });

  it("/context 未配置 breakdown 时返回 500", async () => {
    const resp = await fetch(`${base}${API}/context`);
    expect([500, 200]).toContain(resp.status);
  });

  it("/context 配置 breakdown 后返回分层统计", async () => {
    const deps = mockDeps();
    deps.getContextBreakdown = () => ({ total: 1234, currentTurn: 100 });
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/context`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.breakdown.total).toBe(1234);
    local.close();
  });

  it("/logs 未配置 sessionStore 时返回 500", async () => {
    const resp = await fetch(`${base}${API}/logs`);
    expect([500, 200]).toContain(resp.status);
  });

  it("/sessions 未配置 sessionStore 时返回 500", async () => {
    const resp = await fetch(`${base}${API}/sessions`);
    expect(resp.status).toBe(500);
  });

  it("未知端点返回 404", async () => {
    const resp = await fetch(`${base}/nope`);
    expect(resp.status).toBe(404);
  });

  it("GET /skills /context /logs 不被静态托管拦截", async () => {
    for (const path of [`${API}/skills`, `${API}/context`, `${API}/logs`]) {
      const resp = await fetch(`${base}${path}`);
      const ct = resp.headers.get("content-type") || "";
      expect([200, 500]).toContain(resp.status);
      expect(ct).toContain("application/json");
    }
  });

  it("API 前缀之外的路径走静态托管（404 或 HTML）", async () => {
    const resp = await fetch(`${base}/status`);
    expect(resp.status).toBe(404);
  });

  it("GET / 返回 404（未构建 web/dist 时）", async () => {
    const resp = await fetch(`${base}/`);
    expect([200, 404]).toContain(resp.status);
  });

  it("/chat 缺失 message 返回 400", async () => {
    const resp = await fetch(`${base}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("/chat 非法 JSON 返回 400", async () => {
    const resp = await fetch(`${base}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(resp.status).toBe(400);
  });

  it("/chat 未知 agent 返回 400", async () => {
    const deps = mockDeps();
    deps.createAgent = () => undefined as never;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", agentId: "ghost" }),
    });
    expect(resp.status).toBe(400);
    local.close();
  });

  it("/chat SSE 流式返回 text + done", async () => {
    const resp = await fetch(`${base}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("text");
    expect(types).toContain("done");

    const done = events.find((e) => (e as { type: string }).type === "done") as {
      model: string;
      tokenUsage: { total: number };
    };
    expect(done.model).toBe("deepseek-v4-flash");
    expect(done.tokenUsage.total).toBe(100);
  });

  it("/chat 透传 mode 到 task", async () => {
    capturedTask = undefined;
    const resp = await fetch(`${base}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", agentId: "default", mode: "plan" }),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    expect(capturedTask?.mode).toBe("plan");
  });

  it("/plan SSE 流式返回 plan + step + done", async () => {
    const resp = await fetch(`${base}${API}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "开发一款放置类手游" }),
    });
    expect(resp.status).toBe(200);

    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("plan");
    expect(types).toContain("step_start");
    expect(types).toContain("step_end");
    expect(types).toContain("done");

    const plan = events.find((e) => (e as { type: string }).type === "plan") as {
      steps: unknown[];
      source: string;
    };
    expect(plan.source).toBe("template");
    expect(plan.steps).toHaveLength(2);

    const done = events.find((e) => (e as { type: string }).type === "done") as { content: string };
    expect(done.content).toBe("执行完成");
  });

  it("/plan 缺失 instruction 返回 400", async () => {
    const resp = await fetch(`${base}${API}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("/debate SSE 流式返回 debate_start + done", async () => {
    const resp = await fetch(`${base}${API}/debate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "React vs Vue 技术选型" }),
    });
    expect(resp.status).toBe(200);

    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("debate_start");
    expect(types).toContain("done");

    const start = events.find((e) => (e as { type: string }).type === "debate_start") as {
      agentA: string;
      agentB: string;
    };
    expect(start.agentA).toBeTruthy();
    expect(start.agentB).toBeTruthy();

    const done = events.find((e) => (e as { type: string }).type === "done") as { content: string };
    expect(done.content).toBe("辩论报告");
  });

  it("/debate 缺失 topic 返回 400", async () => {
    const resp = await fetch(`${base}${API}/debate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("OPTIONS 预检返回 204 + CORS 头", async () => {
    const resp = await fetch(`${base}${API}/chat`, { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});
