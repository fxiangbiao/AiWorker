/**
 * Sprint 52 T5：子智能体 HTTP 端点测试
 * 覆盖：4 个端点 + 写面三件套（403/401/400）+ purge 语义 + 父会话校验
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store.js";
import { SubagentRunner } from "../src/core/subagent-runner.js";
import type { BaseAgent } from "../src/agents/base-agent.js";

let server: Server | undefined;
let base: string;
let token: string;
const testDir = mkdtempSync(join(tmpdir(), "subagents-api-"));
let store: SessionStore;
let runner: SubagentRunner;

const agentMock = {
  runStream: async () => ({
    text: "ok",
    truncated: false,
    iterations: 1,
    toolCallsExecuted: 0,
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }),
  getConfig: () => ({
    tools: [],
    mcpServers: [],
    skills: [],
    plugins: [],
    permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
  }),
  fork: () => agentMock,
} as unknown as BaseAgent;

const deps = {
  modelRouter: { getCurrentModel: () => "test" } as never,
  workingDir: testDir,
  coordinator: {} as never,
  createAgent: () => agentMock,
  dataDir: testDir,
  sessionStore: undefined as unknown as SessionStore,
};

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", "X-AiWorker-Token": token, ...extra };
}

describe("Subagents API（Sprint 52 T5）", () => {
  beforeAll(async () => {
    store = new SessionStore(join(testDir, "sub.db"));
    deps.sessionStore = store;
    runner = new SubagentRunner();
    runner.init({
      createAgent: () => agentMock,
      workingDir: testDir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const { subagentRunner } = await import("../src/core/subagent-runner.js");
    subagentRunner.init({
      createAgent: () => agentMock,
      workingDir: testDir,
      sessionStore: store,
      getMode: () => "auto",
    });
    server = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    token = readFileSync(join(testDir, "server-token"), "utf-8").trim();
  });

  afterAll(() => {
    if (server) server.close();
    store?.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { subagentRunner } = await import("../src/core/subagent-runner.js");
    subagentRunner.clear();
  });

  it("GET /subagents 返回列表（缺 parentSessionId 时返回全部）", async () => {
    const r = await fetch(`${base}/api/v1/subagents`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { subagents: unknown[] };
    expect(Array.isArray(d.subagents)).toBe(true);
  });

  it("POST /subagents 无 token → 401", async () => {
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "default", task: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /subagents 缺参数 → 400", async () => {
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ agentId: "default" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /subagents 跨站 → 403", async () => {
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth({ "Sec-Fetch-Site": "cross-site" }),
      body: JSON.stringify({ agentId: "default", task: "x" }),
    });
    expect(r.status).toBe(403);
  });

  it("POST /subagents 正常创建 → 200 + id", async () => {
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ agentId: "default", task: "调研" }),
    });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string };
    expect(d.id).toMatch(/^sub-/);
  });

  it("POST /subagents 父会话不存在 → 400", async () => {
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ agentId: "default", task: "x", parentSessionId: "no-such-session" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /subagents 合法父会话 → 200", async () => {
    const parent = store.createSession("default").id;
    const r = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ agentId: "default", task: "x", parentSessionId: parent }),
    });
    expect(r.status).toBe(200);
    const list = await fetch(`${base}/api/v1/subagents?parentSessionId=${parent}`);
    const d = (await list.json()) as { subagents: Array<{ parentSessionId: string }> };
    expect(d.subagents.length).toBe(1);
    expect(d.subagents[0]!.parentSessionId).toBe(parent);
  });

  it("POST /subagents/:id/messages 无 token → 401；不存在 → 400", async () => {
    const noTok = await fetch(`${base}/api/v1/subagents/sub-x/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(noTok.status).toBe(401);

    const missing = await fetch(`${base}/api/v1/subagents/sub-x/messages`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ message: "hi" }),
    });
    expect(missing.status).toBe(400);
  });

  it("DELETE /subagents/:id 无 token → 401；interrupt 缺失 → 404", async () => {
    const noTok = await fetch(`${base}/api/v1/subagents/sub-x`, { method: "DELETE" });
    expect(noTok.status).toBe(401);

    const missing = await fetch(`${base}/api/v1/subagents/sub-x`, { method: "DELETE", headers: auth() });
    expect(missing.status).toBe(404);
  });

  it("DELETE /subagents/:id?purge=1 彻底释放槽位", async () => {
    const create = await fetch(`${base}/api/v1/subagents`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ agentId: "default", task: "任务" }),
    });
    const { id } = (await create.json()) as { id: string };
    const purge = await fetch(`${base}/api/v1/subagents/${id}?purge=1`, { method: "DELETE", headers: auth() });
    expect(purge.status).toBe(200);
    const d = (await purge.json()) as { purged: boolean };
    expect(d.purged).toBe(true);
    const list = await fetch(`${base}/api/v1/subagents`);
    const body = (await list.json()) as { subagents: Array<{ id: string }> };
    expect(body.subagents.find((s) => s.id === id)).toBeUndefined();
  });

  it("POST /agents/:id/reset 与 /delete 无 token → 401（写面三件套）", async () => {
    for (const p of ["/api/v1/agents/my-agent/reset", "/api/v1/agents/my-agent/delete"]) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(r.status, `${p} 应 401`).toBe(401);
    }
  });
});