/**
 * 应用运行时测试（Sprint 34）— 子进程能力桥
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AppRuntime, AppError } from "../src/core/app-runtime.js";
import { makeTestDir, teardownEnv } from "./helpers.js";
import { initAuditLog } from "../src/core/audit-logger.js";
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
  // readyTimeoutMs 放宽到 15s：CI（2 vCPU、多 worker 并发起子进程）下重启的子进程可能远慢于本地
  runtime = new AppRuntime({ dataDir: testDir, heartbeatMs: 0, readyTimeoutMs: 15000 });
  // 审计日志落到本测试目录：崩溃路径会写 app:crash，不能依赖 cwd 下存在 data/
  initAuditLog(testDir);
});

afterAll(() => {
  runtime.stopAll();
  teardownEnv();
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
    // 等待退避重启（首次 1s + 启动耗时；CI 负载高，留足余量）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (runtime.isRunning("hello-tool")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runtime.isRunning("hello-tool")).toBe(true);
    // 重启后仍可调用
    const r = await runtime.callTool("hello-tool", "hello_tool", { name: "again" });
    expect(r.success).toBe(true);
    await runtime.stop("hello-tool");
  }, 40000);

  it("启动始终未就绪：按崩溃计入退避，≤3 次重启后 onCrashed（不再静默丢弃/无限重启）", async () => {
    const badDir = resolve(testDir, "never-ready");
    mkdirSync(badDir, { recursive: true });
    // 顶层 await 永不 resolve：bootstrap 不会发出 app.ready
    writeFileSync(resolve(badDir, "index.mjs"), "await new Promise(() => {});\n", "utf-8");
    const crashed: number[] = [];
    const rt = new AppRuntime({
      dataDir: testDir,
      heartbeatMs: 0,
      readyTimeoutMs: 300,
      crashDelaysMs: [30, 30, 30],
      onCrashed: (_id, n) => crashed.push(n),
    });
    try {
      await expect(rt.start({ ...app, id: "never-ready", dir: badDir })).rejects.toMatchObject({ code: "ERR_TIMEOUT" });
      const deadline = Date.now() + 8000;
      while (crashed.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      // 首次 + 3 次退避重启 = 4 次崩溃后放弃
      expect(crashed).toEqual([4]);
      expect(rt.isRunning("never-ready")).toBe(false);
    } finally {
      rt.stopAll();
    }
  }, 20000);
});
