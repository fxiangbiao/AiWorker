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
let fixtureDir: string;

beforeAll(async () => {
  setupEnv(testDir);
  fixtureDir = resolve(testDir, "fixtures", "api-tool");
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
    appFactory: {
      generate: async () => ({ ok: true, app: { id: "mock-app", name: "Mock", version: "1.0.0", type: "app", status: "running" } }),
    } as never,
    generatorQueue: {
      submit: () => "genjob-test",
      get: () => ({ id: "genjob-test", status: "done", spec: { description: "x", type: "app" }, createdAt: 0 }),
      cancel: () => true,
    } as never,
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

  it("POST /apps/generate 异步生成（返回 jobId）", async () => {
    const resp = await fetch(`${base}${API}/apps/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "番茄钟" }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean; jobId?: string };
    expect(data.ok).toBe(true);
    expect(data.jobId).toMatch(/^genjob-/);
  });

  it("GET /apps/gen/:id 查询生成任务", async () => {
    const resp = await fetch(`${base}${API}/apps/gen/genjob-test`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { job?: { id?: string; status?: string } };
    expect(data.job?.id).toBe("genjob-test");
    expect(data.job?.status).toBe("done");
  });

  it("POST /apps/gen/:id/cancel 取消生成", async () => {
    const resp = await fetch(`${base}${API}/apps/gen/genjob-test/cancel`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
  });

  it("GET /apps/generate 缺 description 返回 400", async () => {
    const resp = await fetch(`${base}${API}/apps/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /apps/:id/bridge storage 能力（自动允许）", async () => {
    manager.installFromDir(fixtureDir, { force: true });
    await fetch(`${base}${API}/apps/api-tool/start`, { method: "POST" });
    const resp = await fetch(`${base}${API}/apps/api-tool/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "storage.set", params: { key: "k", value: 1 } }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    await fetch(`${base}${API}/apps/api-tool/stop`, { method: "POST" });
  });

  it("POST /apps/:id/bridge 未授权能力返回 400（fail-closed）", async () => {
    manager.installFromDir(fixtureDir, { force: true });
    const resp = await fetch(`${base}${API}/apps/api-tool/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "http.fetch", params: { url: "https://example.com" } }),
    });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error?: string };
    expect(data.error).toMatch(/权限|ERR_PERMISSION/);
  });

  it("GET /apps/:id/index.html 静态服务沙箱文件", async () => {
    writeFileSync(resolve(fixtureDir, "index.html"), "<html>app</html>", "utf-8");
    manager.installFromDir(fixtureDir, { force: true });
    const resp = await fetch(`${base}/apps/api-tool/index.html`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("<html>app</html>");
  });

  it("GET /apps/:id/index.html?surface=widget 注入透明背景规则（webapp 小部件）", async () => {
    const webDir = resolve(testDir, "fixtures", "api-webapp");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(
      resolve(webDir, "app.json"),
      JSON.stringify(
        { id: "api-webapp", type: "app", name: "Web", version: "1.0.0", description: "d", entry: "index.html", permissions: [], ui: { surface: "widget" } },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(webDir, "index.html"),
      '<!doctype html><html><head></head><body><div id="app"></div><script src="app.js"></script></body></html>',
      "utf-8",
    );
    writeFileSync(resolve(webDir, "app.js"), "document.body.style.background = '#fff';", "utf-8");
    manager.installFromDir(webDir);

    // 普通形态：注入桥 + reset，但不强制透明
    const plain = await fetch(`${base}/apps/api-webapp/index.html`);
    const plainHtml = await plain.text();
    expect(plainHtml).toContain("__AIWORKER_BRIDGE__");
    expect(plainHtml).not.toContain("background:transparent!important");
    // widget 形态：框架强制 html/body/#app 透明（覆盖应用自设背景）
    const widget = await fetch(`${base}/apps/api-webapp/index.html?surface=widget`);
    expect(widget.status).toBe(200);
    const widgetHtml = await widget.text();
    expect(widgetHtml).toContain("html,body,#app{background:transparent!important}");
  });

  it("GET /apps/:id/style.css 缺失时返回空 CSS（200，非 404）", async () => {
    // api-webapp 未生成 style.css（可选文件）
    const resp = await fetch(`${base}/apps/api-webapp/style.css`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/css");
    expect(await resp.text()).toBe("");
  });

  it("GET /apps/:id/../.. 路径穿越拒绝（404）", async () => {
    const resp = await fetch(`${base}/apps/api-tool/../../package.json`);
    expect(resp.status).toBe(404);
  });

  it("GET /apps/unknown/index.html 未知应用 404", async () => {
    const resp = await fetch(`${base}/apps/unknown/index.html`);
    expect(resp.status).toBe(404);
  });
});
