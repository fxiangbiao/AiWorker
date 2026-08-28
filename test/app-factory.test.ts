/**
 * 应用工厂测试（Sprint 35 v2）— agent-loop + fs_write 生成全链路
 * mock 模型路由按序返回流式回合（工具调用 / 纯文本），驱动 runAgentLoopStream
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AppFactory, checkJsSyntax, MAX_GEN_ITERATIONS } from "../src/core/app-factory.js";
import { AppManager } from "../src/core/app-manager.js";
import { AppRuntime } from "../src/core/app-runtime.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import type { ModelRouter } from "../src/core/model-router.js";
import type { StreamChunk } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";

const testDir = makeTestDir("app-factory");

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

const appJs =
  'document.addEventListener("DOMContentLoaded", () => { document.getElementById("app").innerHTML = "<h1>番茄钟</h1>"; });';

/** 工具调用回合（流式 chunk 序列：start → delta(完整 args) → done） */
function toolTurn(id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: "tool_call_start", toolCallId: id, toolName: name },
    { type: "tool_call_delta", toolCallId: id, content: args },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function writeTurn(id: string, path: string, content: string): StreamChunk[] {
  return toolTurn(id, "fs_write", JSON.stringify({ path, content }));
}

/** 纯文本回合（agent-loop 终止） */
function textTurn(text: string): StreamChunk[] {
  return [{ type: "text", content: text }, { type: "done", finishReason: "stop" }];
}

/** mock 模型路由：按序返回流式回合，供 runAgentLoopStream 消费 */
function mockStreamRouter(turns: StreamChunk[][]): ModelRouter {
  const queue = [...turns];
  return {
    completeStream: async function* (
      _pref: string,
      _msgs: unknown,
      _tools: unknown,
      opts?: { onUsage?: (u: { promptTokens: number; completionTokens: number; totalTokens: number }) => void },
    ) {
      const turn = queue.shift() ?? textTurn("（无更多响应）");
      for (const c of turn) yield c;
      opts?.onUsage?.(usage);
    },
  } as unknown as ModelRouter;
}

function makeFactory(router: ModelRouter): AppFactory {
  return new AppFactory(
    { modelRouter: router, contextManager: ctxMgr, sessionStore: store, dataDir: testDir },
    manager,
  );
}

let manager: AppManager;
let runtime: AppRuntime;
let store: SessionStore;
let ctxMgr: ContextManager;

beforeAll(async () => {
  setupEnv(testDir);
  runtime = new AppRuntime({ dataDir: testDir, heartbeatMs: 0 });
  manager = new AppManager(testDir, runtime);
  await manager.init();
  store = new SessionStore(resolve(testDir, "aiworker.db"));
  ctxMgr = new ContextManager(store, testDir);
});

afterAll(() => {
  store.close();
  runtime.stopAll();
  teardownEnv();
  clearTools();
});

describe("checkJsSyntax", () => {
  it("截断/语法错误拦截，正常通过", () => {
    expect(checkJsSyntax("const a = 1;")).toBeNull();
    expect(checkJsSyntax("function f() { return 1; }")).toBeNull();
    expect(checkJsSyntax("")).toBeNull();
    expect(checkJsSyntax("const a = ")).toMatch(/语法错误/);
    expect(checkJsSyntax("function f() { return")).toMatch(/语法错误/);
  });
});

describe("app-factory v2 即时生成（agent-loop + fs_write）", () => {
  it("全链路：fs_write 写 app.js → 校验 → 安装 → 启动（webapp）", async () => {
    const factory = makeFactory(
      mockStreamRouter([writeTurn("t1", "app.js", appJs), textTurn("完成，已写入 app.js")]),
    );
    const r = await factory.generate({ description: "番茄钟", type: "app", sessionId: "s1" });
    if (!r.ok) console.error("generate error:", r.error);
    expect(r.ok).toBe(true);
    expect(r.app?.type).toBe("app");
    expect(r.app?.status).toBe("running");
    expect(r.app?.id).toMatch(/^gen-/);
    const appDir = resolve(testDir, "apps", r.app!.id);
    expect(existsSync(resolve(appDir, "index.html"))).toBe(true);
    expect(existsSync(resolve(appDir, "app.js"))).toBe(true);
    expect(existsSync(resolve(appDir, "app.json"))).toBe(true);
    expect(readFileSync(resolve(appDir, "app.js"), "utf-8")).toContain("番茄钟");
    // style.css 可选：模型未生成时不引用，避免 404
    expect(readFileSync(resolve(appDir, "index.html"), "utf-8")).not.toContain("style.css");
    const manifest = JSON.parse(readFileSync(resolve(appDir, "app.json"), "utf-8")) as {
      permissions: string[];
      ui: { surface: string };
    };
    // 权限按模板白名单写入（能力桥"直接用"契约成立），fs 用 genId 展开
    expect(manifest.permissions).toEqual(["notify", "llm", `fs:data/apps/${r.app!.id}`, "network"]);
    expect(manifest.ui.surface).toBe("panel");
    await manager.destroy(r.app!.id);
  });

  it("多轮 fs_write：app.js + style.css 两个文件都落沙箱", async () => {
    const factory = makeFactory(
      mockStreamRouter([
        writeTurn("t1", "app.js", appJs),
        writeTurn("t2", "style.css", "body { font-family: sans-serif; }"),
        textTurn("完成"),
      ]),
    );
    const r = await factory.generate({ description: "番茄钟", type: "app" });
    expect(r.ok).toBe(true);
    const appDir = resolve(testDir, "apps", r.app!.id);
    expect(existsSync(resolve(appDir, "style.css"))).toBe(true);
    expect(readFileSync(resolve(appDir, "style.css"), "utf-8")).toContain("sans-serif");
    // 模型生成了 style.css → 宿主骨架引用它
    expect(readFileSync(resolve(appDir, "index.html"), "utf-8")).toContain("style.css");
    await manager.destroy(r.app!.id);
  });

  it("校验失败 → 反馈 LLM 修复（第 2 轮成功）", async () => {
    const factory = makeFactory(
      mockStreamRouter([
        writeTurn("t1", "app.js", "const a = "), // 语法错误
        textTurn("完成"),
        writeTurn("t2", "app.js", appJs), // 修复轮
        textTurn("修复完成"),
      ]),
    );
    const r = await factory.generate({ description: "番茄钟", type: "app" });
    if (!r.ok) console.error("fix generate error:", r.error);
    expect(r.ok).toBe(true);
    expect(readFileSync(resolve(testDir, "apps", r.app!.id, "app.js"), "utf-8")).toContain("番茄钟");
    await manager.destroy(r.app!.id);
  });

  it("模型始终不写文件 → 反馈 2 轮后仍失败", async () => {
    const factory = makeFactory(mockStreamRouter([textTurn("拒绝"), textTurn("拒绝"), textTurn("拒绝")]));
    const r = await factory.generate({ description: "空应用", type: "app" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/缺少 app\.js/);
  });

  it("tool 型：越权权限声明 → 反馈修复 → 安装运行", async () => {
    const badManifest = JSON.stringify({
      id: "x-tool",
      type: "tool",
      name: "坏工具",
      version: "1.0.0",
      description: "d",
      entry: "index.mjs",
      permissions: ["terminal"],
      tools: [],
    });
    const goodManifest = JSON.stringify({
      id: "x-tool",
      type: "tool",
      name: "好工具",
      version: "1.0.0",
      description: "d",
      entry: "index.mjs",
      permissions: [],
      tools: [],
    });
    const indexMjs = 'export default { async handleTool() { return { success: true, content: "x" }; } };';
    const factory = makeFactory(
      mockStreamRouter([
        writeTurn("t1", "app.json", badManifest),
        writeTurn("t2", "index.mjs", indexMjs),
        textTurn("完成"),
        writeTurn("t3", "app.json", goodManifest),
        textTurn("修复完成"),
      ]),
    );
    const r = await factory.generate({ description: "危险工具", type: "tool" });
    if (!r.ok) console.error("tool generate error:", r.error);
    expect(r.ok).toBe(true);
    expect(r.app?.type).toBe("tool");
    // id 被工厂覆盖为 gen-
    expect(r.app?.id).toMatch(/^gen-/);
    await manager.destroy(r.app!.id);
  });

  it("doc 型：report.md + data.json 落 data/docs/，不安装为应用", async () => {
    const factory = makeFactory(
      mockStreamRouter([
        writeTurn("t1", "report.md", "# 周报\n\n## 进展\n- 完成 A"),
        writeTurn("t2", "data.json", '{"chart":{"type":"bar","labels":["a"],"values":[1]}}'),
        textTurn("完成"),
      ]),
    );
    const r = await factory.generate({ description: "一份项目周报", type: "doc", sessionId: "sess-1" });
    if (!r.ok) console.error("doc generate error:", r.error);
    expect(r.ok).toBe(true);
    expect(r.docPath).toContain("docs");
    expect(r.app).toBeUndefined();
    expect(manager.get("weekly-report")).toBeUndefined();
  });

  it("onProgress 轨迹：fs_write 事件驱动（正在写入/写入完成）", async () => {
    const factory = makeFactory(
      mockStreamRouter([writeTurn("t1", "app.js", appJs), textTurn("完成")]),
    );
    const details: string[] = [];
    const r = await factory.generate({ description: "番茄钟", type: "app" }, (_s, _i, _t, detail) => {
      if (detail) details.push(detail);
    });
    expect(r.ok).toBe(true);
    expect(details.some((d) => d.includes("正在写入 app.js"))).toBe(true);
    expect(details.some((d) => d.includes("app.js 写入完成"))).toBe(true);
    expect(MAX_GEN_ITERATIONS).toBeGreaterThan(0);
    await manager.destroy(r.app!.id);
  });

  it("update：agent-loop 重写 app.js + 版本递增 + 沙箱数据保留", async () => {
    const r1 = await makeFactory(mockStreamRouter([writeTurn("t1", "app.js", appJs), textTurn("完成")])).generate({
      description: "番茄钟",
      type: "app",
      sessionId: "s1",
    });
    expect(r1.ok).toBe(true);
    const id = r1.app!.id;
    const appDir = resolve(testDir, "apps", id);
    mkdirSync(resolve(appDir, "data"), { recursive: true });
    writeFileSync(resolve(appDir, "data", "user.json"), '{"count":5}', "utf-8");

    const newJs =
      'document.addEventListener("DOMContentLoaded", () => { document.getElementById("app").innerHTML = "<button>暂停</button>"; });';
    const r2 = await makeFactory(
      mockStreamRouter([writeTurn("t1", "app.js", newJs), textTurn("完成")]),
    ).update(id, "加暂停按钮", "s1");
    expect(r2.ok).toBe(true);
    expect(r2.app?.version).toBe("1.0.1");
    expect(readFileSync(resolve(appDir, "app.js"), "utf-8")).toContain("暂停");
    expect(readFileSync(resolve(appDir, "data", "user.json"), "utf-8")).toBe('{"count":5}');
    await manager.destroy(id);
  });
});
