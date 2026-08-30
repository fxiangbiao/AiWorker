/**
 * 应用运行时测试（Sprint 34）— 子进程能力桥
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AppRuntime, AppError } from "../src/core/app-runtime.js";
import { makeTestDir } from "./helpers.js";
import type { AppInfo } from "../src/types.js";

const testDir = makeTestDir("app-runtime");
const appDir = resolve(testDir, "hello-tool");

const app: AppInfo & { dir: string } = {
  id: "hello-tool",
  type: "tool",
  name: "Hello",
  version: "1.0.0",
  description: "测试",
  entry: "index.mjs",
  permissions: ["fs:data/apps/hello-tool", "notify"],
  tools: ["hello_tool"],
  status: "running",
  autostart: false,
  dir: appDir,
};

let runtime: AppRuntime;

beforeAll(() => {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    resolve(appDir, "index.mjs"),
    `
export default {
  async handleTool(name, args, ctx) {
    if (name === "hello_tool") return { success: true, content: "hello:" + (args.name ?? "x") };
    if (name === "save") { await ctx.storage.set("k", args.value); return { success: true, content: "saved" }; }
    if (name === "load") { const v = await ctx.storage.get("k"); return { success: true, content: String(v) }; }
    if (name === "notify_me") { await ctx.notify("标题", "内容"); return { success: true, content: "notified" }; }
    if (name === "bad_fs") { try { await ctx.fs.write("../escape.txt", "x"); return { success: true, content: "escaped" }; } catch (e) { return { success: false, content: "", error: e.message }; } }
    if (name === "hang") { await new Promise((r) => setTimeout(r, 10000)); return { success: true, content: "never" }; }
    return { success: false, content: "", error: "unknown:" + name };
  },
};
`,
  );
  runtime = new AppRuntime({ dataDir: testDir, heartbeatMs: 0, readyTimeoutMs: 5000 });
});

afterAll(() => {
  runtime.stopAll();
});

describe("app-runtime 子进程能力桥", () => {
  it("start 后 ready，callTool 正常", async () => {
    await runtime.start(app);
    expect(runtime.isRunning("hello-tool")).toBe(true);
    const r = await runtime.callTool("hello-tool", "hello_tool", { name: "world" });
    expect(r.success).toBe(true);
    expect(r.content).toBe("hello:world");
  });

  it("storage 能力读写（自动允许）", async () => {
    const r1 = await runtime.callTool("hello-tool", "save", { value: "v1" });
    expect(r1.success).toBe(true);
    const r2 = await runtime.callTool("hello-tool", "load", {});
    expect(r2.content).toBe("v1");
  });

  it("notify 能力（声明权限）广播事件", async () => {
    // 通过 callTool 触发 notify，验证不报错
    const r = await runtime.callTool("hello-tool", "notify_me", {});
    expect(r.success).toBe(true);
  });

  it("fs 越界被能力桥拒绝（沙箱内仅允许自身目录）", async () => {
    const r = await runtime.callTool("hello-tool", "bad_fs", {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/越界|ERR_PERMISSION|非法/);
  });

  it("未授权能力直接拒绝（无 ask 通道 fail-closed）", async () => {
    // http 未声明 network 权限且未注入 requestAsk → ERR_PERMISSION
    await expect(
      runtime.handleCapability(app, "http.fetch", { url: "https://example.com" }),
    ).rejects.toThrow(AppError);
    await expect(
      runtime.handleCapability(app, "http.fetch", { url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "ERR_PERMISSION" });
  });

  it("stop 后子进程退出，isRunning false", async () => {
    await runtime.stop("hello-tool");
    expect(runtime.isRunning("hello-tool")).toBe(false);
  });

  it("崩溃指数退避重启（kill 后自动拉起）", async () => {
    await runtime.start(app);
    const proc = runtime["procs"].get("hello-tool");
    expect(proc).toBeDefined();
    proc!.child.kill();
    // 等 exit 事件处理完（旧进程从注册表移除），避免轮询误判残留 running
    const exitDeadline = Date.now() + 5000;
    while (runtime["procs"].get("hello-tool") && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // 等待退避重启（首次 1s + 启动耗时）
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (runtime.isRunning("hello-tool")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runtime.isRunning("hello-tool")).toBe(true);
    // 重启后仍可调用
    const r = await runtime.callTool("hello-tool", "hello_tool", { name: "again" });
    expect(r.success).toBe(true);
    await runtime.stop("hello-tool");
  }, 20000);
});
