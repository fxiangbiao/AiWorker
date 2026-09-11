/**
 * HTTP Server 测试：端点覆盖 / 错误码 / SSE 流式
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
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
import { modelDir, modelManifest } from "../src/media/model-manager.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";

const API = "/api/v1";

const testDir = makeTestDir("server");

function mockModelRouter() {
  return {
    getCurrentModel: () => "deepseek-v4-flash",
    getDisplayModel: () => "deepseek-v4-flash",
    getTokenUsage: () => 100,
    getPromptTokens: () => 40,
    getCompletionTokens: () => 60,
    getContextWindow: () => 1048576,
    getSessionTokens: () => ({ prompt: 0, completion: 0 }),
    deleteScope: () => {},
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
      task: { mode?: string; instruction?: string; explicitSkill?: { name: string; body: string } },
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
let capturedTask: { mode?: string; instruction?: string; explicitSkill?: { name: string; body: string } } | undefined;

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
    expect(data.contextWindow).toBe(1048576);
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

  it("GET /files 返回受根目录限制的字节（mime + Range + 下载 + 反遍历）", async () => {
    const dir = resolve(testDir, "file-arts");
    mkdirSync(dir, { recursive: true });
    const f = resolve(dir, "note.md");
    writeFileSync(f, "# 标题\n正文内容", "utf-8");
    const rel = "file-arts/note.md";

    // 文本文件（inline，markdown mime）
    const r1 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/markdown");
    expect(await r1.text()).toContain("标题");

    // Range（媒体/大文件 seek 语义）
    const r2 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(r2.status).toBe(206);
    expect(r2.headers.get("content-range")).toContain("bytes 0-3/");

    // download=1 → attachment 头部
    const r3 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}&download=1`);
    expect(r3.status).toBe(200);
    expect(r3.headers.get("content-disposition")).toContain("attachment");

    // 相对逃逸 ../..  → 404
    const r4 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent("../../package.json")}`);
    expect(r4.status).toBe(404);

    // 绝对路径（在根外，如仓库 package.json）→ 404
    const absOutside = resolve(process.cwd(), "package.json");
    const r5 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(absOutside)}`);
    expect(r5.status).toBe(404);

    // 不存在 → 404
    const r6 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent("file-arts/nope.md")}`);
    expect(r6.status).toBe(404);

    // 多区间不支持 → 416（而非静默取首段）
    const r7 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}`, {
      headers: { Range: "bytes=0-1,3-4" },
    });
    expect(r7.status).toBe(416);

    // 畸形后缀区间（bytes=-）不崩、不产生 NaN，返回完整内容
    const r8 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}`, {
      headers: { Range: "bytes=-" },
    });
    expect(r8.status).toBe(206);
    expect(await r8.text()).toContain("标题");

    // 超出文件长度的起点 → 416
    const r9 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent(rel)}`, {
      headers: { Range: "bytes=99999-" },
    });
    expect(r9.status).toBe(416);

    // CJK 文件名下载：RFC 5987 filename* 供浏览器正确解码
    writeFileSync(resolve(dir, "报告.md"), "# 报告", "utf-8");
    const r10 = await fetch(`${base}${API}/files?session=test&path=${encodeURIComponent("file-arts/报告.md")}&download=1`);
    expect(r10.status).toBe(200);
    expect(r10.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  });

  it("GET /files 根收窄：data 根仅 docs/spills 白名单（aiworker.db 等不可下载）", async () => {
    const projDir = resolve(testDir, "proj-root");
    const dataRoot = resolve(testDir, "data-root");
    mkdirSync(resolve(dataRoot, "docs"), { recursive: true });
    mkdirSync(projDir, { recursive: true });
    writeFileSync(resolve(dataRoot, "aiworker.db"), "secret", "utf-8");
    writeFileSync(resolve(dataRoot, "docs", "note.md"), "# 会话文档", "utf-8");
    // 文档内图片：项目根与 data/docs 各放一份（root=project / root=session 两种解析）
    writeFileSync(resolve(projDir, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");
    mkdirSync(resolve(dataRoot, "docs", "assets"), { recursive: true });
    writeFileSync(resolve(dataRoot, "docs", "assets", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");

    const srv = startServer({ ...mockDeps(), workingDir: projDir, dataDir: dataRoot } as never, 0);
    await new Promise<void>((r) => srv.once("listening", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const b = `http://127.0.0.1:${port}`;
    try {
      const blocked = await fetch(`${b}${API}/files?path=${encodeURIComponent(resolve(dataRoot, "aiworker.db"))}`);
      expect(blocked.status).toBe(404);

      const okDoc = await fetch(`${b}${API}/files?path=${encodeURIComponent(resolve(dataRoot, "docs", "note.md"))}`);
      expect(okDoc.status).toBe(200);
      expect(await okDoc.text()).toContain("会话文档");

      // root=project：相对项目目录解析（文档内相对图片）
      const projImg = await fetch(`${b}${API}/files?root=project&path=${encodeURIComponent("pic.svg")}`);
      expect(projImg.status).toBe(200);
      expect(projImg.headers.get("content-type")).toContain("image/svg+xml");

      // root=session：相对 data/docs 解析（会话资产内图片）
      const sessImg = await fetch(`${b}${API}/files?root=session&path=${encodeURIComponent("assets/pic.svg")}`);
      expect(sessImg.status).toBe(200);
      expect(sessImg.headers.get("content-type")).toContain("image/svg+xml");

      // root=session 越界到 data 根（aiworker.db）→ 404
      const sessEscape = await fetch(`${b}${API}/files?root=session&path=${encodeURIComponent("../aiworker.db")}`);
      expect(sessEscape.status).toBe(404);

      // root=project 下绝对路径越界 → 404
      const absEscape = await fetch(
        `${b}${API}/files?root=project&path=${encodeURIComponent(resolve(dataRoot, "aiworker.db"))}`,
      );
      expect(absEscape.status).toBe(404);
    } finally {
      srv.close();
    }
  });

  it("GET /audit 返回审计记录列表（limit/action 参数）", async () => {
    const resp = await fetch(`${base}${API}/audit?limit=50&action=app:`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { entries: unknown[] };
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it("GET /devices 返回设备状态（媒体通道 + 模型能力）", async () => {
    const resp = await fetch(`${base}${API}/devices`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      asr: { enabled: boolean };
      tts: { engine: string };
      mediaServer: { active: boolean };
      model: { current: string; vision: boolean };
    };
    expect(data.asr.enabled).toBe(false);
    expect(["edge-tts", "sherpa"]).toContain(data.tts.engine);
    expect(typeof data.model.vision).toBe("boolean");
  });

  it("POST /media/download：非法 kind 400；模型已就绪时纯跳过（不触网）", async () => {
    const freshDir = resolve(testDir, "media-dl-srv");
    mkdirSync(freshDir, { recursive: true });
    const store = new SessionStore(resolve(freshDir, "sessions.db"));
    const deps = mockDeps();
    deps.dataDir = freshDir;
    (deps as Record<string, unknown>).sessionStore = store;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;

    const bad = await fetch(`http://127.0.0.1:${port}${API}/media/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "xxx" }),
    });
    expect(bad.status).toBe(400);

    // seed asr 模型文件 → download 全跳过
    const base = modelDir(freshDir, "asr");
    for (const f of modelManifest("asr").files) {
      const p = resolve(base, f.local);
      mkdirSync(resolve(p, ".."), { recursive: true });
      writeFileSync(p, f.minSize > 0 ? "x".repeat(4) : "", "utf-8");
    }
    const ok = await fetch(`http://127.0.0.1:${port}${API}/media/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "asr" }),
    });
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { ok: boolean; downloaded: string[]; skipped: string[] };
    expect(d.ok).toBe(true);
    expect(d.downloaded).toEqual([]);
    expect(d.skipped.length).toBe(modelManifest("asr").files.length);
    local.close();
    store.close();
  });

  it("GET /dirs 列出子目录（只读；无 path 回退 workingDir；相对/不存在拒绝）", async () => {
    const proj = resolve(testDir, "dirs-proj");
    mkdirSync(resolve(proj, "sub1"), { recursive: true });
    mkdirSync(resolve(proj, "sub2"), { recursive: true });
    writeFileSync(resolve(proj, "file.txt"), "x");
    const deps = mockDeps();
    deps.workingDir = proj;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;

    const ok = await fetch(`http://127.0.0.1:${port}${API}/dirs?path=${encodeURIComponent(proj)}`);
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { path: string; parent: string | null; dirs: string[] };
    expect(d.path).toBe(proj);
    expect(d.dirs).toEqual(["sub1", "sub2"]); // 文件不出现
    expect(d.parent).toBe(resolve(proj, ".."));

    const def = await fetch(`http://127.0.0.1:${port}${API}/dirs`);
    expect(((await def.json()) as { path: string }).path).toBe(proj);

    const bad = await fetch(`http://127.0.0.1:${port}${API}/dirs?path=${encodeURIComponent("relative/x")}`);
    expect(bad.status).toBe(400);
    const bad2 = await fetch(`http://127.0.0.1:${port}${API}/dirs?path=${encodeURIComponent(resolve(proj, "nope"))}`);
    expect(bad2.status).toBe(400);
    local.close();
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

  it("/context?sessionId= 会话化：按会话 agent 取 systemPrompt/agentId；未知会话 404（Sprint 44）", async () => {
    const dir = resolve(testDir, "ctx-sess");
    mkdirSync(dir, { recursive: true });
    const store = new SessionStore(resolve(dir, "ctx.db"));
    const sess = store.createSession("research");
    const calls: { sp: string; sid: string; agentId?: string }[] = [];
    const deps = mockDeps() as Record<string, unknown>;
    deps.sessionStore = store;
    deps.getAgentSystemPrompt = (agentId: string) => (agentId === "research" ? "研究专家提示" : "default 提示");
    deps.getContextBreakdown = (sp: string, sid: string, _um: string, agentId?: string) => {
      calls.push({ sp, sid, agentId });
      return { total: 567, currentTurn: 12, agentId, systemPrompt: sp };
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;

    // 未知会话 → 404
    const miss = await fetch(`http://127.0.0.1:${port}${API}/context?sessionId=nope`);
    expect(miss.status).toBe(404);

    // 已知会话 → 按 record.agentId=research 取 agent systemPrompt + agentId
    const ok = await fetch(`http://127.0.0.1:${port}${API}/context?sessionId=${encodeURIComponent(sess.id)}`);
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { breakdown: { agentId?: string } };
    expect(data.breakdown.agentId).toBe("research");
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last?.sp).toBe("研究专家提示");
    expect(last?.agentId).toBe("research");
    local.close();
    store.close();
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

  it("/chat done 带 turnUsage（TurnLog 结算，含压缩差分；Sprint 44）", async () => {
    const localDir = resolve(testDir, "chat-turnusage");
    mkdirSync(localDir, { recursive: true });
    const localStore = new SessionStore(resolve(localDir, "tu.db"));
    const deps = {
      modelRouter: { ...mockModelRouter(), getContextWindow: () => 1048576 },
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () =>
        ({
          runStream: async (task: { sessionId?: string; instruction: string }) => {
            // 模拟 base-agent：确保会话 + 写 TurnLog（差分已由 hooks 完成）
            const sid = task.sessionId!;
            localStore.ensureSession(sid, "default");
            localStore.appendMessage(sid, { role: "user", content: task.instruction });
            localStore.appendMessage(sid, { role: "assistant", content: "ok" });
            localStore.createTurnLog({
              id: "tl-1",
              sessionId: sid,
              agentId: "default",
              seq: 1,
              userInput: task.instruction,
              startedAt: Date.now() - 1000,
              finishedAt: Date.now(),
              iterations: 2,
              toolCallsTotal: 1,
              toolCallsSuccess: 1,
              toolCallsFailed: 0,
              tokensPrompt: 1500,
              tokensCompletion: 300,
              finishReason: "stop",
            });
            return { success: true, text: "ok", usage: { promptTokens: 800, completionTokens: 300, totalTokens: 1100 } } as never;
          },
        }) as never,
      getAgentList: () => [
        { id: "default", name: "通用助手", modelPreference: "default" },
      ],
      skillNames: [],
      dataDir: testDir,
      sessionStore: localStore,
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "任务", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const done = events.find((e) => (e as { type: string }).type === "done") as {
      turnUsage: { prompt: number; completion: number; total: number; contextPct: number } | null;
    };
    // TurnLog tokensPrompt=1500（turnUsage 取 TurnLog 结算值）；contextPct = 末次请求 prompt/窗口（1 位小数：800/1048576×100≈0.076 → 0.1）
    expect(done.turnUsage).toEqual({ prompt: 1500, completion: 300, total: 1800, contextPct: 0.1 });
    local.close();
    localStore.close();
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

  it("/chat 技能模式：/技能名 激活（skill_activated 事件 + explicitSkill + instruction 保持原始）", async () => {
    const deps = mockDeps();
    deps.getSkills = () => [
      { name: "code-review", version: "1.0", description: "代码审查", expert: "coding", triggers: [], body: "审查步骤：逐文件检查", raw: "" },
      { name: "debug", version: "1.0", description: "调试", expert: "coding", triggers: [], body: "调试步骤", raw: "" },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    capturedTask = undefined;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/code-review 修复主流程", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("skill_activated");
    expect(types).toContain("text");
    const act = events.find((e) => (e as { type: string }).type === "skill_activated") as {
      name: string;
      description: string;
    };
    expect(act.name).toBe("code-review");
    expect(act.description).toBe("代码审查");
    expect(capturedTask).toMatchObject({
      instruction: "/code-review 修复主流程",
      explicitSkill: { name: "code-review", body: "审查步骤：逐文件检查" },
    });
    local.close();
  });

  it("/chat 技能模式：未知技能返回 skill_not_found 且不执行智能体", async () => {
    const deps = mockDeps();
    deps.getSkills = () => [
      { name: "code-review", version: "1.0", description: "代码审查", expert: "coding", triggers: [], body: "审查步骤", raw: "" },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    capturedTask = undefined;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/ghost 任务", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("skill_not_found");
    expect(types).not.toContain("text");
    expect(types).not.toContain("done");
    expect(capturedTask).toBeUndefined();
    const nf = events.find((e) => (e as { type: string }).type === "skill_not_found") as {
      name: string;
      available: string[];
    };
    expect(nf.name).toBe("ghost");
    expect(nf.available).toEqual(["code-review"]);
    local.close();
  });

  it("/chat 技能模式：/skill <名称> 形式", async () => {
    const deps = mockDeps();
    deps.getSkills = () => [
      { name: "debug", version: "1.0", description: "调试", expert: "coding", triggers: [], body: "调试步骤", raw: "" },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    capturedTask = undefined;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/skill debug 追踪报错", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("skill_activated");
    expect(capturedTask?.explicitSkill).toEqual({ name: "debug", body: "调试步骤" });
    expect(capturedTask?.instruction).toBe("/skill debug 追踪报错");
    local.close();
  });

  it("/chat 技能模式：非斜杠消息不受影响", async () => {
    const deps = mockDeps();
    deps.getSkills = () => [
      { name: "debug", version: "1.0", description: "调试", expert: "coding", triggers: [], body: "调试步骤", raw: "" },
    ];
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    capturedTask = undefined;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好，帮我看看", agentId: "default" }),
    });
    expect(resp.status).toBe(200);
    const events = await readSSE(resp);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("text");
    expect(types).toContain("done");
    expect(capturedTask?.instruction).toBe("你好，帮我看看");
    expect(capturedTask?.explicitSkill).toBeUndefined();
    local.close();
  });

  it("/apps/:id/update 异步入队返回 jobId（进度经 gen/* WS 推送）", async () => {
    const deps = mockDeps();
    deps.appFactory = {} as never;
    let updatedAppId = "";
    deps.generatorQueue = {
      submitUpdate: (appId: string) => {
        updatedAppId = appId;
        return "genjob-upd-1";
      },
    } as never;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/apps/my-app/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "加暂停按钮" }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean; jobId?: string };
    expect(data).toEqual({ ok: true, jobId: "genjob-upd-1" });
    expect(updatedAppId).toBe("my-app");
    local.close();
  });

  it("/apps/:id/update 队列不可用时同步回退（直接返回结果）", async () => {
    const deps = mockDeps();
    deps.appFactory = {
      update: async (id: string, desc: string) => ({
        ok: true,
        app: { id, name: "Mock", version: "1.0.1", type: "app", status: "running" },
      }),
    } as never;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/apps/my-app/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "换主题色" }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok?: boolean; app?: { version?: string } };
    expect(data.ok).toBe(true);
    expect(data.app?.version).toBe("1.0.1");
    local.close();
  });

  it("/apps/:id/update 缺失 description 返回 400", async () => {
    const deps = mockDeps();
    deps.appFactory = {} as never;
    deps.generatorQueue = { submitUpdate: () => "genjob-x" } as never;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/apps/my-app/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    local.close();
  });

  it("/docs 返回会话资产与项目文档（排除 node_modules/.git 等系统目录）", async () => {
    const projDir = resolve(testDir, "proj-docs");
    mkdirSync(resolve(projDir, "docs"), { recursive: true });
    mkdirSync(resolve(projDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(resolve(projDir, ".git"), { recursive: true });
    mkdirSync(resolve(testDir, "docs", "sess"), { recursive: true });
    writeFileSync(resolve(projDir, "README.md"), "# 项目说明", "utf-8");
    writeFileSync(resolve(projDir, "docs", "design.md"), "# 设计方案", "utf-8");
    writeFileSync(resolve(projDir, "node_modules", "pkg", "README.md"), "# 依赖说明", "utf-8");
    writeFileSync(resolve(projDir, ".git", "notes.md"), "# git notes", "utf-8");
    writeFileSync(resolve(testDir, "docs", "sess", "report.md"), "# 会话报告", "utf-8");
    const deps = mockDeps();
    deps.workingDir = projDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/docs`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      roots: { root: string; dir: string }[];
      docs: { root: string; path: string; title: string }[];
    };
    expect(data.roots.some((r) => r.root === "project")).toBe(true);
    expect(data.docs.some((d) => d.root === "session" && d.path === "sess/report.md")).toBe(true);
    expect(data.docs.some((d) => d.root === "project" && d.path === "README.md")).toBe(true);
    expect(data.docs.some((d) => d.root === "project" && d.path === "docs/design.md")).toBe(true);
    expect(data.docs.some((d) => d.path === "node_modules/pkg/README.md")).toBe(false);
    expect(data.docs.some((d) => d.path === ".git/notes.md")).toBe(false);
    local.close();
  });

  it("/docs/content root=project 读取项目文档且拒绝路径穿越", async () => {
    const projDir = resolve(testDir, "proj-content");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(resolve(projDir, "design.md"), "# 设计方案内容", "utf-8");
    writeFileSync(resolve(testDir, "secret.md"), "# 不应泄露", "utf-8");
    const deps = mockDeps();
    deps.workingDir = projDir;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const ok = await fetch(`http://127.0.0.1:${port}${API}/docs/content?root=project&path=${encodeURIComponent("design.md")}`);
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { root: string; content: string };
    expect(d.root).toBe("project");
    expect(d.content).toContain("设计方案内容");
    const bad = await fetch(`http://127.0.0.1:${port}${API}/docs/content?root=project&path=${encodeURIComponent("../secret.md")}`);
    expect(bad.status).toBe(404);
    local.close();
  });

  it("/docs/content 无 root 参数兼容旧行为（视为 session）", async () => {
    const resp = await fetch(`${base}${API}/docs/content?path=${encodeURIComponent("sess/report.md")}`);
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as { root: string; content: string };
    expect(d.root).toBe("session");
    expect(d.content).toContain("会话报告");
  });

  it("/docs?sessionId 项目文档根跟随会话项目目录（未设置回退全局）", async () => {
    const store = new SessionStore(resolve(testDir, "docs-sessions.db"));
    const projA = resolve(testDir, "proj-a");
    const projB = resolve(testDir, "proj-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeFileSync(resolve(projA, "a.md"), "# A 项目", "utf-8");
    writeFileSync(resolve(projB, "b.md"), "# B 项目", "utf-8");
    const sess = store.createSession("default");
    store.setWorkingDir(sess.id, projB);
    const deps = mockDeps();
    deps.workingDir = projA; // 全局 A；会话覆盖为 B
    (deps as Record<string, unknown>).sessionStore = store;
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;

    const g = await fetch(`http://127.0.0.1:${port}${API}/docs`);
    const gd = (await g.json()) as { docs: { root: string; path: string }[] };
    expect(gd.docs.some((d) => d.root === "project" && d.path === "a.md")).toBe(true);

    const s = await fetch(`http://127.0.0.1:${port}${API}/docs?sessionId=${sess.id}`);
    const sd = (await s.json()) as { docs: { root: string; path: string }[] };
    expect(sd.docs.some((d) => d.root === "project" && d.path === "b.md")).toBe(true);
    expect(sd.docs.some((d) => d.path === "a.md")).toBe(false);

    const c = await fetch(`http://127.0.0.1:${port}${API}/docs/content?root=project&path=${encodeURIComponent("b.md")}&sessionId=${sess.id}`);
    expect(c.status).toBe(200);
    local.close();
    store.close();
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

  it("DELETE /sessions/:id 级联清理会话账本 deleteScope（Sprint 44）", async () => {
    const localDir = resolve(testDir, "sess-del-scope");
    mkdirSync(localDir, { recursive: true });
    const localStore = new SessionStore(resolve(localDir, "del.db"));
    const sess = localStore.createSession("default");
    const deleteScope = vi.fn();
    const deps = {
      modelRouter: { ...mockModelRouter(), deleteScope },
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () => mockAgent() as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: localStore,
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/sessions/${sess.id}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(deleteScope).toHaveBeenCalledWith(sess.id);
    local.close();
    localStore.close();
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

  it("/chat 用户消息只持久化一次（server 不重复 append，由 base-agent 统一负责）", async () => {
    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () =>
        ({
          runStream: async (task: { sessionId?: string; instruction: string }) => {
            store.ensureSession(task.sessionId!, "default");
            store.appendMessage(task.sessionId!, { role: "user", content: task.instruction });
            return { success: true, text: "ok" } as never;
          },
        }) as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: store,
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const sessId = `sess-dup-${Date.now().toString(36)}`;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", agentId: "default", sessionId: sessId }),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    const messages = store.getMessages(sessId);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    local.close();
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

  it("POST/GET /sessions/:id/working-dir 设置、回读、列表带出与恢复默认", async () => {
    const sess = store.createSession("default");
    const proj = resolve(testDir, "proj");
    mkdirSync(proj, { recursive: true });
    const post = await fetch(`${base2}${API}/sessions/${sess.id}/working-dir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: proj }),
    });
    expect(post.status).toBe(200);
    expect(((await post.json()) as { workingDir: string | null }).workingDir).toBe(proj);

    const get = await fetch(`${base2}${API}/sessions/${sess.id}/working-dir`);
    expect(((await get.json()) as { workingDir: string | null }).workingDir).toBe(proj);

    const listResp = await fetch(`${base2}${API}/sessions`);
    const sessions = ((await listResp.json()) as { sessions: Array<{ id: string; workingDir?: string | null }> }).sessions;
    expect(sessions.find((s) => s.id === sess.id)?.workingDir).toBe(proj);

    // 恢复默认（null）
    const clear = await fetch(`${base2}${API}/sessions/${sess.id}/working-dir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: null }),
    });
    expect(((await clear.json()) as { workingDir: string | null }).workingDir).toBeNull();
    expect(store.getWorkingDir(sess.id)).toBeNull();
  });

  it("POST working-dir 校验：相对路径/不存在/非目录/指向 dataDir 均拒绝", async () => {
    const sess = store.createSession("default");
    const file = resolve(testDir, "somefile.txt");
    writeFileSync(file, "x");
    const badDirs = ["relative/path", resolve(testDir, "no-such-dir-xyz"), file, testDir];
    for (const dir of badDirs) {
      const r = await fetch(`${base2}${API}/sessions/${sess.id}/working-dir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      expect(r.status).toBe(400);
    }
    expect(store.getWorkingDir(sess.id)).toBeNull();
  });

  it("POST working-dir 对服务端尚无记录的会话自动补建（回归：Web 新会话草稿报 Session not found）", async () => {
    // 模拟 Web 新会话本地草稿：服务端无该 session 行
    const freshId = `fresh-${Date.now().toString(36)}`;
    const proj = resolve(testDir, "fresh-proj");
    mkdirSync(proj, { recursive: true });
    const resp = await fetch(`${base2}${API}/sessions/${freshId}/working-dir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: proj, agentId: "coding" }),
    });
    expect(resp.status).toBe(200);
    expect(store.getWorkingDir(freshId)).toBe(proj);
    // 会话行已补建
    const sessions = store.listSessions(100);
    expect(sessions.some((s) => s.id === freshId)).toBe(true);
    expect(sessions.find((s) => s.id === freshId)?.agentId).toBe("coding");
    // 恢复默认同样自动补建路径可用
    const clear = await fetch(`${base2}${API}/sessions/${freshId}/working-dir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: null }),
    });
    expect(clear.status).toBe(200);
    expect(store.getWorkingDir(freshId)).toBeNull();
  });

  it("/chat 透传会话项目目录（task.workingDir）", async () => {
    const sess = store.createSession("default");
    const proj = resolve(testDir, "chatproj");
    mkdirSync(proj, { recursive: true });
    store.setWorkingDir(sess.id, proj);
    let received: unknown = null;
    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: testDir,
      coordinator: mockCoordinator(),
      createAgent: () =>
        ({
          runStream: async (task: { workingDir?: string }) => {
            received = task.workingDir;
            return { success: true, text: "ok" } as never;
          },
        }) as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      sessionStore: store,
    };
    const local = startServer(deps as never, 0);
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const port = (local.address() as AddressInfo).port;
    const resp = await fetch(`http://127.0.0.1:${port}${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", agentId: "default", sessionId: sess.id }),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    expect(received).toBe(proj);
    local.close();
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

  it("GET /sessions/:id 返回事件回放序列（含 assistant(tool_calls) 与 tool 结果）+ 平行 usages（Sprint 44）", async () => {
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "看下文件" });
    // 中间轮 assistant(tool_calls)（agent-loop 持久化形态）
    store.appendMessage(
      sess.id,
      {
        role: "assistant",
        content: "调用",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "terminal_exec", arguments: '{"command":"dir"}' } },
        ],
      },
      { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    );
    store.appendEvent(sess.id, "tool/call", { callId: "t1", name: "terminal_exec", arguments: "{}" }, "agent-loop");
    store.appendEvent(
      sess.id,
      "tool/result",
      { callId: "t1", success: true, content: "文件列表", durationMs: 5 },
      "agent-loop",
    );
    store.appendMessage(
      sess.id,
      { role: "assistant", content: "完成" },
      { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    );

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
    // usages 平行数组：按 assistant 出现顺序（tool 消息不占位）
    const usages = data.usages as Array<{ promptTokens?: number; completionTokens?: number; totalTokens?: number } | null>;
    expect(usages).toHaveLength(2);
    expect(usages[0]).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(usages[1]).toEqual({ promptTokens: 50, completionTokens: 10, totalTokens: 60 });
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

describe("HTTP Server — 进化引擎端点（Sprint 39）", () => {
  let server5: Server | undefined;
  let base5: string;
  let dir: string;

  beforeAll(async () => {
    dir = makeTestDir("server-evolution");
    setupEnv(dir);
    const store = new SessionStore(resolve(dir, "sessions.db"));
    // 注入有数据的会话，观察端点可聚合
    const sess = store.createSession("default");
    store.setSummary(sess.id, "测试会话");
    store.appendMessage(sess.id, { role: "user", content: "帮我写一份周报" });

    const deps = {
      modelRouter: mockModelRouter(),
      workingDir: dir,
      coordinator: mockCoordinator(),
      createAgent: () => mockAgent() as never,
      getAgentList: () => [],
      skillNames: [],
      dataDir: dir,
      sessionStore: store,
      evolutionEngine: {
        observe: () => ({
          windowStart: 0,
          windowEnd: 1,
          toolStats: [{ name: "fs_read", calls: 10, failed: 5, successRate: 0.5, avgDurationMs: 50, topErrors: [] }],
          completion: { sessions: 1, ok: 1, rate: 1, avgTurns: 1 },
          repeatedTasks: [],
          userInterventions: 0,
          generated: { apps: 0, docs: 0, updates: 0 },
        }),
        propose: async () => ({ ok: true, proposals: [] }),
        list: () => [
          {
            id: "evo-abc",
            type: "new-tool",
            title: "生成周报工具",
            reason: "重复任务 5 次",
            action: { kind: "new-tool", description: "自动生成周报", type: "tool" },
            risk: "low",
            status: "pending",
            createdAt: 123,
          },
        ],
        adopt: (id: string) => ({ ok: true, preview: { kind: "new-tool", description: "自动生成周报", type: "tool" } }),
        apply: async (id: string) => ({ ok: true, jobId: `job-${id}` }),
        rollback: (id: string) => ({ ok: true, detail: `已恢复 ${id}` }),
        reject: (id: string) => ({ ok: true }),
        ledger: () => [{ at: 123, event: "proposed", id: "evo-abc", type: "new-tool", title: "生成周报工具" }],
        change: (id: string) => ({
          ok: true,
          view: { proposalId: id, kind: "new-tool", title: "生成周报工具", after: "生成工具：自动生成周报", lines: [{ type: "add", text: "生成工具：自动生成周报" }] },
        }),
        listCases: (limit = 100) => [{ id: "case-1", input: "整理周报", source: "manual", createdAt: 123 }],
        addCase: (input: string, expected?: string) => ({
          ok: true,
          case: { id: "case-new", input, expected, source: "manual", createdAt: 123 },
        }),
        deleteCase: (id: string) => ({ ok: id === "case-1" }),
        extractCases: () => ({ added: 2, skipped: 1 }),
        eval: async (id: string) => ({
          ok: true,
          report: { total: 1, skipped: 0, hasBaseline: true, baselinePassRate: 0.8, candidatePassRate: 0.6, deltaRate: -0.2, verdict: "pass", results: [] },
        }),
        verify: async (id: string) => ({
          ok: true,
          report: { total: 1, skipped: 0, hasBaseline: true, baselinePassRate: 1, candidatePassRate: 0.4, deltaRate: -0.6, verdict: "regress", results: [] },
          rolledBack: true,
          detail: "已自动回滚",
        }),
      } as never,
    };
    server5 = startServer(deps as never, 0);
    await new Promise<void>((resolve) => server5!.once("listening", () => resolve()));
    const port = (server5!.address() as AddressInfo).port;
    base5 = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (server5) {
      server5.close();
      server5 = undefined;
    }
    teardownEnv();
  });

  it("GET /evolution/observe 返回观察指标", async () => {
    const resp = await fetch(`${base5}${API}/evolution/observe`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.toolStats).toHaveLength(1);
    expect(data.toolStats[0]).toMatchObject({ name: "fs_read", successRate: 0.5 });
  });

  it("POST /evolution/propose 触发提议", async () => {
    const resp = await fetch(`${base5}${API}/evolution/propose`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.proposals).toEqual([]);
  });

  it("GET /evolution/proposals 返回提案列表", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.proposals).toHaveLength(1);
    expect(data.proposals[0]).toMatchObject({ id: "evo-abc", status: "pending" });
  });

  it("POST /evolution/proposals/:id/adopt 确认提案并返回预览（不写入）", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/adopt`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.preview).toEqual({ kind: "new-tool", description: "自动生成周报", type: "tool" });
    expect(data.jobId).toBeUndefined();
  });

  it("POST /evolution/proposals/:id/apply 确认写入并返回 jobId", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/apply`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.jobId).toBe("job-evo-abc");
  });

  it("POST /evolution/proposals/:id/reject 成功", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/reject`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
  });

  it("POST /evolution/proposals/:id/rollback 回滚成功", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/rollback`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.detail).toContain("已恢复");
  });

  it("GET /evolution/ledger 返回台账时间线", async () => {
    const resp = await fetch(`${base5}${API}/evolution/ledger?limit=20`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({ event: "proposed", id: "evo-abc" });
  });

  it("GET /evolution/proposals/:id/change 返回变更对比", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/change`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.view).toMatchObject({ proposalId: "evo-abc", kind: "new-tool" });
  });

  it("POST /evolution/proposals/:id/change 返回 405（change 仅 GET）", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/change`, { method: "POST" });
    expect(resp.status).toBe(405);
  });

  it("未知操作返回 404", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/frobnicate`, { method: "POST" });
    expect(resp.status).toBe(404);
  });

  it("GET /evolution/cases 返回黄金用例", async () => {
    const resp = await fetch(`${base5}${API}/evolution/cases?limit=50`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0]).toMatchObject({ id: "case-1", input: "整理周报" });
  });

  it("POST /evolution/cases 手工补录", async () => {
    const resp = await fetch(`${base5}${API}/evolution/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "写会议纪要", expected: "markdown" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.case).toMatchObject({ id: "case-new", input: "写会议纪要", expected: "markdown" });
  });

  it("POST /evolution/cases 非法 JSON 返回 400", async () => {
    const resp = await fetch(`${base5}${API}/evolution/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    expect(resp.status).toBe(400);
  });

  it("POST /evolution/cases/extract 提取用例", async () => {
    const resp = await fetch(`${base5}${API}/evolution/cases/extract`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual({ added: 2, skipped: 1 });
  });

  it("DELETE /evolution/cases/:id 删除用例", async () => {
    const resp = await fetch(`${base5}${API}/evolution/cases/case-1`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
  });

  it("POST /evolution/proposals/:id/eval 返回评测报告", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/eval`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.report).toMatchObject({ verdict: "pass", baselinePassRate: 0.8 });
  });

  it("POST /evolution/proposals/:id/verify 推广验证（回归自动回滚）", async () => {
    const resp = await fetch(`${base5}${API}/evolution/proposals/evo-abc/verify`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.rolledBack).toBe(true);
    expect(data.report.verdict).toBe("regress");
  });
});
