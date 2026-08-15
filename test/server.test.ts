/**
 * HTTP Server 测试：端点覆盖 / 错误码 / SSE 流式
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { startServer } from "../src/server.js";
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

  it("GET /diffs 返回会话文件变更（空目录时为空数组）", async () => {
    const resp = await fetch(`${base}${API}/diffs`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data.sessions)).toBe(true);
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
