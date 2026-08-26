/**
 * AI OS HTTP 端点测试（Sprint 34）— /apps /processes
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../src/server.js";
import { AppManager } from "../src/core/app-manager.js";
import { AppRuntime } from "../src/core/app-runtime.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";

const API = "/api/v1";
const testDir = makeTestDir("apps-api");

const fixtureManifest = {
  id: "api-tool",
  type: "tool",
  name: "API 工具",
  version: "1.0.0",
  description: "端点测试",
  entry: "index.mjs",
  permissions: [],
  tools: [{ name: "api_hello", description: "hi", parameters: { type: "object", properties: {} } }],
};

const fixtureEntry = `
export default {
  async handleTool(name) {
    if (name === "api_hello") return { success: true, content: "api:ok" };
    return { success: false, content: "", error: "unknown" };
  },
};
`;

let server: Server | undefined;
let base: string;
let manager: AppManager;

beforeAll(async () => {
  setupEnv(testDir);
  const fixtureDir = resolve(testDir, "fixtures", "api-tool");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(resolve(fixtureDir, "app.json"), JSON.stringify(fixtureManifest, null, 2), "utf-8");
  writeFileSync(resolve(fixtureDir, "index.mjs"), fixtureEntry, "utf-8");

  const runtime = new AppRuntime({ dataDir: testDir, heartbeatMs: 0 });
  manager = new AppManager(testDir, runtime);
  await manager.init();
  manager.installFromDir(fixtureDir);

  const deps = {
    modelRouter: {
      getCurrentModel: () => "deepseek-v4-flash",
      getTokenUsage: () => 0,
      getPromptTokens: () => 0,
      getCompletionTokens: () => 0,
    },
    workingDir: testDir,
    coordinator: {} as never,
    createAgent: () => undefined,
    getAgentList: () => [],
    skillNames: [],
    dataDir: testDir,
    appManager: manager,
  };
  server = startServer(deps as never, 0);
  await new Promise<void>((resolveReady) => server!.once("listening", () => resolveReady()));
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

describe("AI OS 端点", () => {
  it("GET /apps 返回应用列表", async () => {
    const resp = await fetch(`${base}${API}/apps`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { apps?: { id: string; status: string }[] };
    expect(data.apps?.some((a) => a.id === "api-tool")).toBe(true);
  });

  it("POST /apps/:id/start 启动应用", async () => {
    const resp = await fetch(`${base}${API}/apps/api-tool/start`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean; app?: { status?: string } };
    expect(data.ok).toBe(true);
    expect(data.app?.status).toBe("running");
  });

  it("POST /apps/:id/stop 停止应用", async () => {
    const resp = await fetch(`${base}${API}/apps/api-tool/stop`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean; app?: { status?: string } };
    expect(data.ok).toBe(true);
    expect(data.app?.status).toBe("stopped");
  });

  it("POST /apps/:id/destroy 销毁应用", async () => {
    const resp = await fetch(`${base}${API}/apps/api-tool/destroy`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
  });

  it("未知应用操作返回错误", async () => {
    const resp = await fetch(`${base}${API}/apps/nope/start`, { method: "POST" });
    expect(resp.status).toBe(400);
  });

  it("GET /processes 返回进程列表与统计", async () => {
    const resp = await fetch(`${base}${API}/processes`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { processes?: unknown[]; stats?: { agent: number; app: number; job: number } };
    expect(Array.isArray(data.processes)).toBe(true);
    expect(data.stats).toBeDefined();
  });
});
