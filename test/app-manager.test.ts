/**
 * 应用管理器测试（Sprint 34）— 状态机 / 持久化 / 恢复 / 工具注册
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppManager } from "../src/core/app-manager.js";
import { AppRuntime } from "../src/core/app-runtime.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { processManager } from "../src/core/process-manager.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";

const testDir = makeTestDir("app-manager");
const fixturesDir = resolve(testDir, "fixtures");

function writeFixture(id: string, manifest: Record<string, unknown>, entry: string): string {
  const dir = resolve(fixturesDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "app.json"), JSON.stringify(manifest, null, 2), "utf-8");
  writeFileSync(resolve(dir, "index.mjs"), entry, "utf-8");
  return dir;
}

const toolEntry = `
export default {
  async handleTool(name, args, ctx) {
    if (name === "hello_tool") return { success: true, content: "hello:" + (args.name ?? "x") };
    return { success: false, content: "", error: "unknown" };
  },
};
`;

const helloManifest = {
  id: "hello-tool",
  type: "tool",
  name: "Hello",
  version: "1.0.0",
  description: "测试工具应用",
  entry: "index.mjs",
  permissions: [],
  tools: [{ name: "hello_tool", description: "打招呼", parameters: { type: "object", properties: { name: { type: "string" } } } }],
};

let manager: AppManager;
let runtime: AppRuntime;

beforeAll(async () => {
  setupEnv(testDir);
  runtime = new AppRuntime({ dataDir: testDir, heartbeatMs: 0 });
  manager = new AppManager(testDir, runtime);
  await manager.init();
});

afterAll(() => {
  runtime.stopAll();
  teardownEnv();
});

describe("app-manager 生命周期", () => {
  it("install 复制到沙箱 + state 持久化", () => {
    const src = writeFixture("hello-tool", helloManifest, toolEntry);
    const r = manager.installFromDir(src);
    expect(r.ok).toBe(true);
    expect(r.app?.id).toBe("hello-tool");
    expect(r.app?.status).toBe("installed");
    expect(existsSync(resolve(testDir, "apps", "hello-tool", "index.mjs"))).toBe(true);
    const state = JSON.parse(readFileSync(resolve(testDir, "apps", "state.json"), "utf-8"));
    expect(state["hello-tool"].status).toBe("installed");
  });

  it("重复安装无 force 报错；force 覆盖", () => {
    const src = writeFixture("hello-tool", helloManifest, toolEntry);
    const r1 = manager.installFromDir(src);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/已存在/);
    const r2 = manager.installFromDir(src, { force: true });
    expect(r2.ok).toBe(true);
  });

  it("list 返回应用（含插件兼容视图不报错）", () => {
    const apps = manager.list();
    const hit = apps.find((a) => a.id === "hello-tool");
    expect(hit).toBeDefined();
    expect(hit?.type).toBe("tool");
  });

  it("start 启动子进程 + 注册工具（LLM 可调用）", async () => {
    const r = await manager.start("hello-tool");
    expect(r.ok).toBe(true);
    expect(r.app?.status).toBe("running");
    const reg = toolRegistry.getAll().find((t) => t.definition.function.name === "hello_tool");
    expect(reg).toBeDefined();
    const result = await reg!.handler({ name: "world" }, { agentId: "t", sessionId: "s", workingDir: testDir, permissions: "auto" });
    expect(result.success).toBe(true);
    expect(result.content).toBe("hello:world");
  });

  it("start 幂等（running 再 start 仍 ok）", async () => {
    const r = await manager.start("hello-tool");
    expect(r.ok).toBe(true);
  });

  it("stop 停止 + 工具注销", async () => {
    const r = await manager.stop("hello-tool");
    expect(r.ok).toBe(true);
    expect(r.app?.status).toBe("stopped");
    expect(toolRegistry.getAll().find((t) => t.definition.function.name === "hello_tool")).toBeUndefined();
  });

  it("destroy 删除沙箱 + 状态清理 + 幂等", async () => {
    const r1 = await manager.destroy("hello-tool");
    expect(r1.ok).toBe(true);
    expect(existsSync(resolve(testDir, "apps", "hello-tool"))).toBe(false);
    const r2 = await manager.destroy("hello-tool");
    expect(r2.ok).toBe(true);
  });

  it("未知应用 start/stop 报错", async () => {
    expect((await manager.start("nope")).ok).toBe(false);
    expect((await manager.stop("nope")).ok).toBe(false);
  });

  it("恢复：重启后非 autostart 应用回到 stopped，state 保留", async () => {
    const src = writeFixture("hello-tool", helloManifest, toolEntry);
    manager.installFromDir(src);
    await manager.start("hello-tool");
    await manager.stop("hello-tool");

    const manager2 = new AppManager(testDir, runtime);
    await manager2.init();
    const app = manager2.get("hello-tool");
    expect(app?.status).toBe("stopped");
    await manager2.destroy("hello-tool");
  });

  it("autostart: true 的应用启动时自动拉起", async () => {
    const src = writeFixture("auto-tool", { ...helloManifest, id: "auto-tool", autostart: true }, toolEntry);
    manager.installFromDir(src);
    await manager.stop("auto-tool");

    const manager2 = new AppManager(testDir, runtime);
    await manager2.init();
    const app = manager2.get("auto-tool");
    expect(app?.status).toBe("running");
    await manager2.destroy("auto-tool");
  });

  it("恢复 running 的 webapp 后进程已注册（进程列表不漏报）", async () => {
    // webapp（type: "app"）上次 running，服务器重启恢复时走 start() 幂等短路路径
    const dir = resolve(fixturesDir, "web-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "app.json"),
      JSON.stringify({ id: "web-app", type: "app", name: "Web", version: "1.0.0", description: "d", entry: "index.html", permissions: [] }, null, 2),
      "utf-8",
    );
    writeFileSync(resolve(dir, "index.html"), "<html>app</html>", "utf-8");
    manager.installFromDir(dir);
    await manager.start("web-app");

    const manager2 = new AppManager(testDir, runtime);
    await manager2.init();
    expect(manager2.get("web-app")?.status).toBe("running");
    const procs = processManager.list().filter((p) => p.kind === "app" && p.appId === "web-app");
    expect(procs.length).toBeGreaterThan(0);
    expect(procs[0]!.status).toBe("running");
    await manager2.destroy("web-app");
  });

  it("handleBridge：storage 自动允许 / 未授权 http 拒绝（Sprint 35）", async () => {
    const src = writeFixture("bridge-tool", { ...helloManifest, id: "bridge-tool", permissions: [] }, toolEntry);
    manager.installFromDir(src);
    await manager.start("bridge-tool");

    const ok = await manager.handleBridge("bridge-tool", "storage.set", { key: "k", value: 1 });
    expect(ok).toEqual({});

    await expect(manager.handleBridge("bridge-tool", "http.fetch", { url: "https://example.com" })).rejects.toMatchObject({
      code: "ERR_PERMISSION",
    });

    await expect(manager.handleBridge("nope", "storage.get", {})).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
    await manager.destroy("bridge-tool");
  });
});
