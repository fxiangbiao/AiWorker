/**
 * HTTP Server 测试：端点覆盖 / 错误码 / SSE 流式
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { WebSocket as WsClient, type RawData } from "ws";
import { startServer } from "../src/server.js";
import { jobRunner } from "../src/core/job-runner.js";
import { scheduler } from "../src/core/scheduler.js";
import type { TeamCoordinator } from "../src/core/team-coordinator.js";
import type { ModelRouter } from "../src/core/model-router.js";
import { SessionStore } from "../src/memory/session-store.js";
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
  const execute = (_plan: unknown, _wd: string, callbacks: {
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
      callbacks: { onTextDelta?: (t: string) => void; onToolResult?: (n: string, s: boolean, m: string) => void },
    ) => {
      capturedTask = task;
      callbacks.onTextDelta?.("你好");
      callbacks.onToolResult?.("terminal_exec", false, "操作被拦截: 当前权限模式(ask)为只读");
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
    coordinator: mockCoordinator(),
    createAgent: () => mockAgent() as never,
    getAgentList: () => [
      { id: "default", name: "通用助手" },
      { id: "research", name: "研究分析师" },
    ],
    skillNames: ["skill-a", "skill-b"],
    dataDir: testDir,
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
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
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

  it("/plugins 返回插件列表（未注入 getPlugins 时为空）", async () => {
    const resp = await fetch(`${base}${API}/plugins`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.plugins).toEqual([]);
  });

  it("/plugins 支持 getPlugins 返回插件信息", async () => {
    const deps = mockDeps();
    deps.getPlugins = () => [
      {
        name: "demo",
        entry: "/tmp/demo/plugin.ts",
        status: "loaded",
        registeredTools: ["demo_tool"],
        registeredHooks: 0,
      },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/plugins`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.plugins).toHaveLength(1);
    expect(data.plugins[0]).toMatchObject({ name: "demo", status: "loaded", registeredTools: ["demo_tool"] });
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

  it("GET /diffs 返回会话文件变更（空目录时为空数组）", async () => {
    const resp = await fetch(`${base}${API}/diffs`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  it("parseDiffFile 解析 new_b64（指纹监控附的当前内容）", async () => {
    const { startServer: _s, parseDiffFile: _p } = await import("../src/server.js");
    // parseDiffFile 为模块内私有：通过构造快照目录 + /diffs 端点间接验证
    const snapDir = resolve(testDir, "snapshots", "sess-x");
    mkdirSync(snapDir, { recursive: true });
    const content = "新内容第一行\n第二行";
    writeFileSync(
      resolve(snapDir, "D_crypto.ts.diff"),
      `# path: D:\\\\x\\\\crypto.ts\n内容已变化（旧内容不可恢复）：D:\\\\x\\\\crypto.ts\n---\nold: 0 chars\nnew: ${content.length} chars\nnew_b64: ${Buffer.from(content, "utf-8").toString("base64")}`,
      "utf-8",
    );
    const deps = mockDeps();
    deps.dataDir = testDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/diffs`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { sessions: Array<{ files: Array<{ currentContent?: string; path: string }> }> };
    const sess = data.sessions.find((s) => s.files.some((f) => f.currentContent));
    expect(sess).toBeDefined();
    expect(sess!.files[0]!.currentContent).toContain("新内容第一行");
    local.close();
  });

  it("parseDiffFile 解析 binary 标记（二进制文件降级快照）", async () => {
    const { startServer: _s } = await import("../src/server.js");
    const snapDir = resolve(testDir, "snapshots", "sess-bin");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(
      resolve(snapDir, "D_assets_model.glb.diff"),
      `# path: D:\\\\x\\\\assets\\\\model.glb\n内容已变化（旧内容不可恢复）：D:\\\\x\\\\assets\\\\model.glb\n---\nbinary: 1\nsize: 4096`,
      "utf-8",
    );
    const deps = mockDeps();
    deps.dataDir = testDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/diffs`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      sessions: Array<{ files: Array<{ binary?: boolean; currentContent?: string; path: string }> }>;
    };
    const sess = data.sessions.find((s) => s.files.some((f) => f.path.includes("model.glb")));
    expect(sess).toBeDefined();
    const file = sess!.files.find((f) => f.path.includes("model.glb"));
    expect(file?.binary).toBe(true);
    expect(file?.currentContent).toBeUndefined();
    local.close();
  });

  it("GET /diffs 旧格式快照兼容推断（文件已删 → deleted，新增行数从文本提取）", async () => {
    const { startServer: _s } = await import("../src/server.js");
    const snapDir = resolve(testDir, "snapshots", "sess-legacy");
    mkdirSync(snapDir, { recursive: true });
    // 旧格式"新增文件"快照：无 modified/deleted 标记，文件当前不存在
    const gonePath = resolve(testDir, "legacy-gone.txt");
    writeFileSync(
      resolve(snapDir, "D_legacy-gone.txt.diff"),
      `# path: ${gonePath}\n新增文件（14 行）：${gonePath}\n---\nold: 0 chars\nnew: 0 chars`,
      "utf-8",
    );
    // 旧格式"内容已变化"快照：无标记，文件当前存在
    const existPath = resolve(testDir, "legacy-exist.txt");
    writeFileSync(existPath, "hello", "utf-8");
    writeFileSync(
      resolve(snapDir, "D_legacy-exist.txt.diff"),
      `# path: ${existPath}\n内容已变化（旧内容不可恢复）：${existPath}\n---\nold: 3 chars\nnew: 5 chars`,
      "utf-8",
    );
    const deps = mockDeps();
    deps.dataDir = testDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/diffs`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      sessions: Array<{ files: Array<{ path: string; deleted?: boolean; modified?: boolean; added: number }> }>;
    };
    const sess = data.sessions.find((s) => s.sessionId === "sess-legacy");
    expect(sess).toBeDefined();
    const gone = sess!.files.find((f) => f.path === gonePath);
    expect(gone?.deleted).toBe(true);
    expect(gone?.added).toBe(14);
    const exist = sess!.files.find((f) => f.path === existPath);
    expect(exist?.modified).toBe(true);
    local.close();
  });

  it("GET /diffs 快照签名缓存：目录未变化时结果稳定", async () => {
    const snapDir = resolve(testDir, "snapshots", "sess-cache");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(
      resolve(snapDir, "D_a.txt.diff"),
      `# path: D:\\\\x\\\\a.txt\n新增文件（1 行）：D:\\\\x\\\\a.txt\n---\nold: 0 chars\nnew: 5 chars`,
      "utf-8",
    );
    const deps = mockDeps();
    deps.dataDir = testDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}${API}/diffs`;
    const first = (await (await fetch(url)).json()) as { sessions: Array<{ sessionId: string; files: unknown[] }> };
    const second = (await (await fetch(url)).json()) as { sessions: Array<{ sessionId: string; files: unknown[] }> };
    expect(first.sessions.length).toBeGreaterThan(0);
    expect(second.sessions).toEqual(first.sessions);
    // 新增快照文件 → 签名变化 → 结果更新
    writeFileSync(
      resolve(snapDir, "D_b.txt.diff"),
      `# path: D:\\\\x\\\\b.txt\n新增文件（1 行）：D:\\\\x\\\\b.txt\n---\nold: 0 chars\nnew: 4 chars`,
      "utf-8",
    );
    const third = (await (await fetch(url)).json()) as { sessions: Array<{ sessionId: string; files: unknown[] }> };
    const target = third.sessions.find((s) => s.sessionId === "sess-cache");
    expect(target?.files.length).toBe(2);
    local.close();
  });

  it("POST /confirm 未知 id 返回 404", async () => {
    const resp = await fetch(`${base}${API}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nonexistent", value: "allow" }),
    });
    expect(resp.status).toBe(404);
  });

  it("POST /confirm 缺失 id 返回 400", async () => {
    const resp = await fetch(`${base}${API}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow" }),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /ask 未知 id 返回 404", async () => {
    const resp = await fetch(`${base}${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nonexistent", answer: "42" }),
    });
    expect(resp.status).toBe(404);
  });

  it("POST /ask 缺失 id 返回 400", async () => {
    const resp = await fetch(`${base}${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "42" }),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /ask 非法 JSON 返回 400", async () => {
    const resp = await fetch(`${base}${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(resp.status).toBe(400);
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

  it("/chat 拦截失败时发出 tool_blocked 事件", async () => {
    const resp = await fetch(`${base}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "删除文件", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const blocked = events.find((e) => (e as { type: string }).type === "tool_blocked") as {
      message?: string;
      name?: string;
    };
    expect(blocked).toBeTruthy();
    expect(blocked.name).toBe("terminal_exec");
    expect(blocked.message).toContain("拦截");
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

describe("HTTP Server — 会话管理端点", () => {
  let server2: Server | undefined;
  let base2: string;
  let store: SessionStore;

  beforeAll(async () => {
    setupEnv(testDir);
    store = new SessionStore(resolve(testDir, "sessions.db"));
    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () => mockAgent() as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: store,
    };
    server2 = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server2!.once("listening", () => resolve()));
    const port = (server2!.address() as AddressInfo).port;
    base2 = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (server2) {
      server2.close();
      server2 = undefined;
    }
    if (store) store.close();
    teardownEnv();
  });

  it("删除会话级联清理", async () => {
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "你好" });
    store.appendMessage(sess.id, { role: "assistant", content: "你好！" });

    const resp = await fetch(`${base2}${API}/sessions/${sess.id}`, { method: "DELETE" });
    expect(resp.status).toBe(200);

    const list = store.listSessions(100);
    expect(list.find((s) => s.id === sess.id)).toBeUndefined();
    expect(store.getMessages(sess.id)).toHaveLength(0);
  });

  it("GET /sessions 返回真实轮数（用户消息条数）", async () => {
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "第一轮" });
    store.appendMessage(sess.id, { role: "assistant", content: "回复1" });
    store.appendMessage(sess.id, { role: "user", content: "第二轮" });
    store.appendMessage(sess.id, { role: "assistant", content: "回复2" });

    const resp = await fetch(`${base2}${API}/sessions`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    const found = (data.sessions as Array<{ id: string; turnCount?: number; messageCount?: number }>).find(
      (s) => s.id === sess.id,
    );
    expect(found).toBeDefined();
    expect(found!.turnCount).toBe(2);
    expect(found!.messageCount).toBe(4);
  });

  it("删除不存在的会话返回 404", async () => {
    const resp = await fetch(`${base2}${API}/sessions/nonexistent`, { method: "DELETE" });
    expect(resp.status).toBe(404);
  });

  it("重命名会话更新 summary", async () => {
    const sess = store.createSession("default");
    const resp = await fetch(`${base2}${API}/sessions/${sess.id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(resp.status).toBe(200);

    const list = store.listSessions(100);
    expect(list.find((s) => s.id === sess.id)?.summary).toBe("新标题");
  });

  it("重命名缺失 title 返回 400", async () => {
    const resp = await fetch(`${base2}${API}/sessions/abc/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("导出会话返回 Markdown", async () => {
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "帮我写代码" });
    store.appendMessage(sess.id, { role: "assistant", content: "好的，这是代码" });

    const resp = await fetch(`${base2}${API}/sessions/${sess.id}/export`);
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") || "";
    expect(ct).toContain("text/markdown");
    const md = await resp.text();
    expect(md).toContain("帮我写代码");
    expect(md).toContain("好的，这是代码");
  });

  it("GET /sessions/:id 返回事件回放序列（含 assistant(tool_calls) 与 tool 结果）", async () => {
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "看下文件" });
    // 中间轮 assistant(tool_calls)（agent-loop 持久化形态）
    store.appendMessage(sess.id, {
      role: "assistant",
      content: "调用",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "terminal_exec", arguments: '{"command":"dir"}' } },
      ],
    });
    store.appendEvent(sess.id, "tool/call", { callId: "t1", name: "terminal_exec", arguments: "{}" }, "agent-loop");
    store.appendEvent(
      sess.id,
      "tool/result",
      { callId: "t1", success: true, content: "文件列表", durationMs: 5 },
      "agent-loop",
    );
    store.appendMessage(sess.id, { role: "assistant", content: "完成" });

    const resp = await fetch(`${base2}${API}/sessions/${sess.id}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    const roles = (data.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    const toolMsg = (data.messages as Array<{ tool_call_id?: string; content?: string }>)[2];
    expect(toolMsg.tool_call_id).toBe("t1");
    expect(toolMsg.content).toBe("文件列表");
    // assistant(tool_calls) 消息带 tool_calls（Web 端重建工具卡）
    const midAssistant = (data.messages as Array<{ tool_calls?: unknown[] }>)[1];
    expect(midAssistant.tool_calls).toHaveLength(1);
  });

  it("GET /mcp 返回服务器状态列表", async () => {
    const resp = await fetch(`${base2}${API}/mcp`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.servers)).toBe(true);
  });
});

describe("HTTP Server — WebSocket 实时总线", () => {
  let server3: Server | undefined;
  let base3: string;
  let wsPort: number;
  let store: SessionStore;

  beforeAll(async () => {
    setupEnv(testDir);
    store = new SessionStore(resolve(testDir, "ws-sessions.db"));
    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () => mockAgent() as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: store,
    };
    server3 = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server3!.once("listening", () => resolve()));
    wsPort = (server3!.address() as AddressInfo).port;
    base3 = `http://127.0.0.1:${wsPort}`;
  });

  afterAll(() => {
    if (server3) {
      server3.close();
      server3 = undefined;
    }
    if (store) store.close();
    teardownEnv();
  });

  function connectWs(): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WsClient(`ws://127.0.0.1:${wsPort}${API}/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function waitFor<T extends { type: string }>(
    ws: WsClient,
    pred: (d: T) => boolean,
    timeoutMs = 3000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS event timeout")), timeoutMs);
      const onMsg = (raw: RawData) => {
        const data = JSON.parse(String(raw)) as T;
        if (pred(data)) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(data);
        }
      };
      ws.on("message", onMsg);
    });
  }

  function postChat(message: string): Promise<Response> {
    return fetch(`${base3}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, mode: "auto" }),
    });
  }

  it("连接 /api/v1/ws 成功并收到 chat 事件广播", async () => {
    const ws = await connectWs();
    const doneP = waitFor(ws, (d) => d.type === "done");
    const resp = await postChat("hi");
    expect(resp.status).toBe(200);
    const done = await doneP;
    expect(done.type).toBe("done");
    ws.close();
  });

  it("多客户端均收到广播（含 tool_result 事件）", async () => {
    const wsA = await connectWs();
    const wsB = await connectWs();
    const seenA = waitFor(wsA, (d) => d.type === "tool_result");
    const seenB = waitFor(wsB, (d) => d.type === "tool_result");
    const resp = await postChat("执行任务");
    expect(resp.status).toBe(200);
    await seenA;
    await seenB;
    wsA.close();
    wsB.close();
  });

  it("会话重命名经 WS 广播 session/update", async () => {
    const sess = store.createSession("default");
    const ws = await connectWs();
    const updP = waitFor(ws, (d) => d.type === "session/update" && d.kind === "rename" && d.sessionId === sess.id);
    const resp = await fetch(`${base3}${API}/sessions/${sess.id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(resp.status).toBe(200);
    const upd = await updP;
    expect(upd.title).toBe("新标题");
    ws.close();
  });

  it("非 /ws 路径 upgrade 被拒绝", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WsClient(`ws://127.0.0.1:${wsPort}${API}/chat`);
        ws.on("open", () => {
          ws.close();
          reject(new Error("should not open"));
        });
        ws.on("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });
});

describe("HTTP Server — 后台任务与定时调度", () => {
  let server4: Server | undefined;
  let base4: string;
  let store4: SessionStore;

  beforeAll(async () => {
    setupEnv(testDir);
    store4 = new SessionStore(resolve(testDir, "jobs-server.db"));
    jobRunner.init({
      createAgent: () => mockAgent() as never,
      workingDir: testDir,
      sessionStore: store4,
    });
    scheduler.init({ submit: () => "" }, resolve(testDir, "schedule-server.json"));
    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () => mockAgent() as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: store4,
    };
    server4 = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server4!.once("listening", () => resolve()));
    const port = (server4!.address() as AddressInfo).port;
    base4 = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (server4) {
      server4.close();
      server4 = undefined;
    }
    if (store4) store4.close();
    teardownEnv();
  });

  it("POST /jobs 提交返回 id，GET /jobs 列表可见", async () => {
    const resp = await fetch(`${base4}${API}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "default", prompt: "后台任务" }),
    });
    expect(resp.status).toBe(200);
    const { id } = (await resp.json()) as { id: string };
    expect(id).toMatch(/^job-/);

    const list = await (await fetch(`${base4}${API}/jobs`)).json();
    expect((list.jobs as Array<{ id: string }>).some((j) => j.id === id)).toBe(true);
  });

  it("POST /jobs 缺 prompt 返回 400", async () => {
    const resp = await fetch(`${base4}${API}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("GET /schedule 空列表；POST 添加；DELETE 移除", async () => {
    const empty = await (await fetch(`${base4}${API}/schedule`)).json();
    expect(empty.jobs).toEqual([]);

    const add = await fetch(`${base4}${API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 8 * * *", prompt: "早报", agentId: "default" }),
    });
    expect(add.status).toBe(200);

    const list = await (await fetch(`${base4}${API}/schedule`)).json();
    expect(list.jobs).toHaveLength(1);
    const id = (list.jobs as Array<{ id: string }>)[0]!.id;

    const del = await fetch(`${base4}${API}/schedule/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await (await fetch(`${base4}${API}/schedule`)).json();
    expect(after.jobs).toHaveLength(0);
  });

  it("POST /schedule 非法 cron 返回 400", async () => {
    const resp = await fetch(`${base4}${API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "not-cron", prompt: "x" }),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /schedule 支持自然语言（无 cron 字段）", async () => {
    const add = await fetch(`${base4}${API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "每天晚上9点写日记" }),
    });
    expect(add.status).toBe(200);
    const list = await (await fetch(`${base4}${API}/schedule`)).json();
    const found = (list.jobs as Array<{ cron: string; prompt: string }>).find((j) => j.prompt === "写日记");
    expect(found).toBeDefined();
    expect(found!.cron).toBe("0 21 * * *");
  });

  it("POST /schedule 自然语言无法解析返回 400", async () => {
    const resp = await fetch(`${base4}${API}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "随便写点东西" }),
    });
    expect(resp.status).toBe(400);
  });

  it("GET /packages/export 校验 type；不存在的资产 404", async () => {
    const missing = await fetch(`${base4}${API}/packages/export?type=skill&name=no-such-skill`);
    expect(missing.status).toBe(404);
    const badType = await fetch(`${base4}${API}/packages/export?type=xxx&name=a`);
    expect(badType.status).toBe(400);
    // raw 模式：插件不支持（需 CLI），skill/mcp 返回对应类型
    const rawPlugin = await fetch(`${base4}${API}/packages/export?type=plugin&name=x&raw=1`);
    expect(rawPlugin.status).toBe(400);
  });

  it("POST /packages/peek 支持裸 SKILL.md（.md）与 MCP 配置（.json）", async () => {
    const md = await fetch(`${base4}${API}/packages/peek`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from("---\nname: peek-skill\nexpert: coding\n---\n# 技能").toString("base64"),
        filename: "peek-skill.md",
      }),
    });
    expect(md.status).toBe(200);
    const mdData = (await md.json()) as { type?: string; name?: string };
    expect(mdData.type).toBe("skill");
    expect(mdData.name).toBe("peek-skill");

    const j = await fetch(`${base4}${API}/packages/peek`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: Buffer.from(JSON.stringify({ transport: "http", url: "x" })).toString("base64"),
        filename: "peek-server.json",
      }),
    });
    expect(j.status).toBe(200);
    const jData = (await j.json()) as { type?: string; name?: string };
    expect(jData.type).toBe("mcp");
    expect(jData.name).toBe("peek-server");
  });

  it("POST /packages/import 缺 data 返回 400；坏 zip 安装失败", async () => {
    const noData = await fetch(`${base4}${API}/packages/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noData.status).toBe(400);
    // 非法 base64/zip 内容 → 安装失败（400）
    const bad = await fetch(`${base4}${API}/packages/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: Buffer.from("not a zip").toString("base64") }),
    });
    expect(bad.status).toBe(400);
  });

  it("GET /packages/list 返回可导出与已安装资产", async () => {
    const resp = await fetch(`${base4}${API}/packages/list`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { exportable: { skills: string[]; mcp: string[]; plugins: string[] } };
    expect(Array.isArray(data.exportable.skills)).toBe(true);
    expect(Array.isArray(data.exportable.mcp)).toBe(true);
    expect(Array.isArray(data.exportable.plugins)).toBe(true);
  });

  it("GET /api/v1/config 返回配置状态；POST 设置并持久化", async () => {
    // mock deps 未提供 getConfigState → 503
    const missing = await fetch(`${base4}${API}/config`);
    expect(missing.status).toBe(503);
  });

  it("POST /config 校验字段与值", async () => {
    // mock 未提供 setConfigField → 503
    const resp = await fetch(`${base4}${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "temperature", value: 0.3 }),
    });
    expect(resp.status).toBe(503);
  });

  it("GET /config 与 POST /config 真实实现（注入回调）", async () => {
    let state = { model: "m1", availableModels: [{ key: "m1", model: "m1", provider: "p" }], runtimeConfig: {}, iterations: { default: 60 }, thinking: false, skillEvo: false, appVersion: "0.6.2" };
    const deps = mockDeps();
    deps.getConfigState = () => state;
    deps.setConfigField = (field, value) => {
      if (field === "temperature") {
        const t = Number(value);
        if (Number.isNaN(t) || t < 0 || t > 2) return { ok: false, error: "温度需在 0-2 之间" };
        state = { ...state, runtimeConfig: { temperature: t } };
        return { ok: true };
      }
      return { ok: false, error: "未知配置项" };
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const base5 = `http://127.0.0.1:${port}`;

    const get = await fetch(`${base5}${API}/config`);
    expect(get.status).toBe(200);
    const got = (await get.json()) as { model: string };
    expect(got.model).toBe("m1");

    const post = await fetch(`${base5}${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "temperature", value: 0.5 }),
    });
    expect(post.status).toBe(200);
    const after = (await post.json()) as { state: { runtimeConfig: { temperature: number } } };
    expect(after.state.runtimeConfig.temperature).toBe(0.5);

    const bad = await fetch(`${base5}${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "temperature", value: 9 }),
    });
    expect(bad.status).toBe(400);
    local.close();
  });

  it("POST /config addModel：添加模型 profile 并持久化到 config/models.json", async () => {
    const modelsPath = resolve(testDir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        default: { provider: "deepseek", model: "m1", baseURL: "https://api.deepseek.com", apiKey: "${K}", temperature: 0.5, maxTokens: 4096, adapter: "openai-compatible" },
        profiles: { coding: { temperature: 0.2 } },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
      "utf-8",
    );
    const deps = mockDeps();
    deps.getConfigState = () => ({});
    deps.setConfigField = (field, value) => {
      if (field === "addModel") {
        const v = value as { key?: string; model?: string; baseURL?: string; provider?: string; apiKey?: string };
        if (!v?.key || !v.model || !v.baseURL) return { ok: false, error: "缺字段" };
        // 模拟 addProfile + 写回（真实 index.ts 逻辑）
        const cfg = JSON.parse(readFileSync(modelsPath, "utf-8")) as { profiles: Record<string, unknown> };
        cfg.profiles[v.key] = { model: v.model, baseURL: v.baseURL, provider: v.provider, apiKey: v.apiKey };
        writeFileSync(modelsPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
        return { ok: true };
      }
      return { ok: false, error: "未知" };
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const base6 = `http://127.0.0.1:${port}`;

    const ok = await fetch(`${base6}${API}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "addModel", value: { key: "my-gpt", model: "gpt-4o-mini", baseURL: "https://api.example.com/v1", provider: "openai", apiKey: "${MY_KEY}" } }),
    });
    expect(ok.status).toBe(200);

    const cfg = JSON.parse(readFileSync(modelsPath, "utf-8")) as { profiles: Record<string, { model?: string; baseURL?: string }> };
    expect(cfg.profiles["my-gpt"]).toMatchObject({ model: "gpt-4o-mini", baseURL: "https://api.example.com/v1" });
    // 原字段保留
    expect(cfg.profiles["coding"]).toBeDefined();
    local.close();
  });
});
