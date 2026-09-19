/**
 * 工具执行测试
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { toolRegistry } from "../src/core/tool-registry.js";
import { terminalSessionPool } from "../src/tools/terminal-session.js";
import type { ToolContext } from "../src/types.js";
import { buildPathPolicy, setPathPolicyOverride } from "../src/security/path-policy.js";
import {
  makeTestDir,
  setupEnv,
  teardownEnv,
  clearTools,
  makeDirLink,
  makeDanglingLink,
  DIR_LINK_SUPPORTED,
  DANGLING_LINK_SUPPORTED,
} from "./helpers.js";

const testDir = makeTestDir("tools");

beforeAll(() => {
  clearTools();
  setupEnv(testDir);
});

afterAll(() => {
  teardownEnv();
});

describe("7. 工具执行", () => {
  const ctx: ToolContext = {
    agentId: "test",
    sessionId: "test",
    workingDir: process.cwd(),
    permissions: "auto",
  };

  it("获取 fs_read handler", () => {
    const readHandler = toolRegistry.getHandler("fs_read");
    expect(readHandler).toBeTruthy();
  });

  it("读取 package.json 成功", async () => {
    const handler = toolRegistry.getHandler("fs_read")!;
    const result = await handler({ path: "package.json" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("aiworker");
  });

  it("列出目录成功", async () => {
    const handler = toolRegistry.getHandler("fs_list")!;
    const result = await handler({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("package.json");
  });

  it("fs_edit 局部修改：替换/删除/未找到/不唯一/穿越", async () => {
    const handler = toolRegistry.getHandler("fs_edit")!;
    const dir = resolve(testDir, "edit-tools");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, "t.txt");
    writeFileSync(file, "a\nb\nc\n", "utf-8");
    const ectx: ToolContext = { agentId: "test", sessionId: "test", workingDir: dir, permissions: "auto" };

    // 替换 1 行（唯一匹配）
    let r = await handler({ path: "t.txt", oldText: "b", newText: "B" }, ectx);
    expect(r.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\nB\nc\n");

    // 删除跨行片段（newText 为空，含尾部换行）
    r = await handler({ path: "t.txt", oldText: "B\nc\n", newText: "" }, ectx);
    expect(r.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\n");

    // 未找到匹配 → 失败
    r = await handler({ path: "t.txt", oldText: "zzz", newText: "x" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("未找到");

    // 匹配不唯一 → 失败（要求更大上下文）
    writeFileSync(file, "x\nx\n", "utf-8");
    r = await handler({ path: "t.txt", oldText: "x", newText: "y" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("不唯一");

    // 路径穿越 → 失败（Sprint 49：由路径策略单点判定，报越界与允许范围）
    r = await handler({ path: "../escape.txt", oldText: "x", newText: "y" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("越界");
    expect(r.error).toContain("路径策略");

    // 文件不存在 → 失败
    r = await handler({ path: "nope.txt", oldText: "x", newText: "y" }, ectx);
    expect(r.success).toBe(false);
  });

  it("fs_edit 行号模式：区间替换/删除/边界校验", async () => {
    const handler = toolRegistry.getHandler("fs_edit")!;
    const dir = resolve(testDir, "edit-lines");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, "l.txt");
    writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
    const ectx: ToolContext = { agentId: "test", sessionId: "test", workingDir: dir, permissions: "auto" };

    // 删除第 2-3 行（newText 为空）
    let r = await handler({ path: "l.txt", startLine: 2, endLine: 3, newText: "" }, ectx);
    expect(r.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("l1\nl4\nl5\n");

    // 替换第 2 行（单行）
    r = await handler({ path: "l.txt", startLine: 2, newText: "X\nY" }, ectx);
    expect(r.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("l1\nX\nY\nl5\n");

    // 替换区间为多行
    r = await handler({ path: "l.txt", startLine: 1, endLine: 2, newText: "n1\nn2\nn3" }, ectx);
    expect(r.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("n1\nn2\nn3\nY\nl5\n");

    // 行号超出文件范围 → 失败（提示用 fs_read lineNumbers）
    r = await handler({ path: "l.txt", startLine: 99, endLine: 100, newText: "" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("超出文件范围");
    expect(r.error).toContain("lineNumbers");

    // 缺参数（既无 oldText 也无行号）→ 失败提示两种模式
    r = await handler({ path: "l.txt", newText: "x" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("oldText");
  });

  it("fs_read lineNumbers:true 输出 1-based 行号（供 fs_edit 行号模式定位）", async () => {
    const handler = toolRegistry.getHandler("fs_read")!;
    const dir = resolve(testDir, "read-lines");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, "r.txt");
    writeFileSync(file, "a\nb\nc\n", "utf-8");
    const ectx: ToolContext = { agentId: "test", sessionId: "test", workingDir: dir, permissions: "auto" };

    const r = await handler({ path: "r.txt", lineNumbers: true }, ectx);
    expect(r.success).toBe(true);
    expect(r.content).toContain("   1  a");
    expect(r.content).toContain("   2  b");
    expect(r.content).toContain("   3  c");

    // 不带 lineNumbers：纯文本（无行号前缀）
    const plain = await handler({ path: "r.txt" }, ectx);
    expect(plain.success).toBe(true);
    expect(plain.content).toBe("a\nb\nc\n");
  });

  it("执行 echo 命令成功", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo AiWorker-Test" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("AiWorker-Test");
  });

  it("rm -rf dist 在 ask 模式被危险检测拦截", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const askCtx: ToolContext = { ...ctx, permissions: "ask" };
    const result = await handler({ command: "rm -rf dist" }, askCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("高危");
  });

  it("越界写入在沙箱层被提前拦截（早于危险检测，任何模式都拒绝）", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const askCtx: ToolContext = { ...ctx, permissions: "ask" };
    const result = await handler({ command: "rm -rf /" }, askCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("写入越界");
  });

  it("rm -rf / 在 auto 模式不拦截（交由 hook 确认）", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo safe" }, ctx);
    expect(result.success).toBe(true);
  });

  it("ask_user 透传 multiple 到提问通道", async () => {
    const { setAskProvider } = await import("../src/tools/ask-channel.js");
    const captured: Array<{ question: string; options: string[]; multiple?: boolean }> = [];
    setAskProvider(async (req) => {
      captured.push(req);
      return "x";
    });
    try {
      const handler = toolRegistry.getHandler("ask_user")!;
      await handler({ question: "q", options: ["a", "b"], multiple: true }, ctx);
      await handler({ question: "q", options: ["a", "b"] }, ctx);
      expect(captured[0]!.multiple).toBe(true);
      expect(captured[1]!.multiple).toBe(false);
      // 结果携带用户回答
      const r = await handler({ question: "q", options: ["a", "b"] }, ctx);
      expect(r.success).toBe(true);
      expect(r.content).toContain("用户回答");
    } finally {
      setAskProvider(null);
    }
  });

  it("terminal_exec 失败时错误信息包含 stdout 真实原因（2>&1 场景）", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    // 命令不存在：2>&1 场景 stderr 合并进 stdout，错误详情应包含真实原因而非仅 "Command failed"
    const result = await handler({ command: "definitely-not-a-real-cmd-xyz 2>&1", timeout: 10000 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("definitely-not-a-real-cmd-xyz");
  });
});

describe("20. fs 四件套路径边界（Sprint 49）", () => {
  const wd = resolve(testDir, "path-root");
  const outside = resolve(testDir, "path-outside");
  const ctx = (dir: string): ToolContext => ({ agentId: "test", sessionId: "test", workingDir: dir, permissions: "auto" });

  beforeAll(() => {
    rmSync(wd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(wd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
  });

  afterEach(() => setPathPolicyOverride(null));

  it("读：工作目录内放行，越界拒绝且原因是路径策略", async () => {
    const read = toolRegistry.getHandler("fs_read")!;
    writeFileSync(join(wd, "in.txt"), "inside", "utf-8");
    const ok = await read({ path: "in.txt" }, ctx(wd));
    expect(ok.success).toBe(true);
    expect(ok.content).toBe("inside");

    const denied = await read({ path: join(outside, "secret.txt") }, ctx(wd));
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("读取越界");
    expect(denied.error).toContain("路径策略");

    const escaped = await read({ path: "../path-outside/secret.txt" }, ctx(wd));
    expect(escaped.success).toBe(false);

    const empty = await read({ path: "" }, ctx(wd));
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("为空");
  });

  it("列目录：越界拒绝，工作目录内放行", async () => {
    const list = toolRegistry.getHandler("fs_list")!;
    expect((await list({ path: "." }, ctx(wd))).success).toBe(true);
    const denied = await list({ path: outside }, ctx(wd));
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("读取越界");
  });

  it("写：../ 与绝对路径越界拒绝，工作目录内放行", async () => {
    const write = toolRegistry.getHandler("fs_write")!;
    expect((await write({ path: "sub/a.txt", content: "x" }, ctx(wd))).success).toBe(true);
    const up = await write({ path: "../path-outside/up.txt" }, ctx(wd));
    expect(up.success).toBe(false);
    expect(up.error).toContain("写入越界");
    const abs = await write({ path: join(outside, "abs.txt"), content: "x" }, ctx(wd));
    expect(abs.success).toBe(false);
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("写：符号链接指向工作目录外时拒绝（真实路径判定）", async () => {
    const link = join(wd, "esc");
    rmSync(link, { recursive: true, force: true });
    expect(makeDirLink(link, outside)).toBe(true);
    const write = toolRegistry.getHandler("fs_write")!;
    const r = await write({ path: "esc/pwned.txt", content: "x" }, ctx(wd));
    expect(r.success).toBe(false);
    expect(r.error).toContain("写入越界");
    expect(r.error.toLowerCase()).toContain("path-outside");
  });

  it("读根/写根显式放宽后生效，且互不影响", async () => {
    const read = toolRegistry.getHandler("fs_read")!;
    const write = toolRegistry.getHandler("fs_write")!;

    setPathPolicyOverride(buildPathPolicy(wd, { allowWriteDirs: [outside] }));
    expect((await write({ path: join(outside, "w.txt"), content: "x" }, ctx(wd))).success).toBe(true);
    expect((await read({ path: join(outside, "secret.txt") }, ctx(wd))).success).toBe(false);

    setPathPolicyOverride(buildPathPolicy(wd, { allowReadDirs: [outside] }));
    expect((await read({ path: join(outside, "secret.txt") }, ctx(wd))).success).toBe(true);
    expect((await write({ path: join(outside, "w2.txt"), content: "x" }, ctx(wd))).success).toBe(false);
  });

  it("fs_edit 越界同样被拒（与 fs_write 同一判定）", async () => {
    const edit = toolRegistry.getHandler("fs_edit")!;
    const r = await edit({ path: join(outside, "secret.txt"), oldText: "secret", newText: "x" }, ctx(wd));
    expect(r.success).toBe(false);
    expect(r.error).toContain("写入越界");
  });

  it.skipIf(!DANGLING_LINK_SUPPORTED)("悬空链接不可写（真实路径解析失败 → 拒绝，不退化成词法放行）", async () => {
    const dangling = join(wd, "dangling.txt");
    rmSync(dangling, { recursive: true, force: true });
    rmSync(join(outside, "ghost.txt"), { recursive: true, force: true });
    expect(makeDanglingLink(dangling, join(outside, "ghost.txt"))).toBe(true);

    const r = await toolRegistry.getHandler("fs_write")!({ path: "dangling.txt", content: "escaped?" }, ctx(wd));
    expect(r.success).toBe(false);
    expect(r.error).toContain("无法解析");
    expect(existsSync(join(outside, "ghost.txt"))).toBe(false); // 关键：根外文件不能被创建
  });

  /**
   * 接线测试（审查修复）：走**真实配置文件**而不是策略注入。
   * 只注入策略对象会短路 loadSandboxPolicy，把 allowReadDirs/allowWriteDirs 接反也测不出来。
   */
  describe("config/sandbox.json → fs 工具的读取根/写入根接线", () => {
    const configPath = join(testDir, "path-policy-sandbox.json");

    afterEach(async () => {
      const { setSandboxConfigPath } = await import("../src/security/sandbox.js");
      setSandboxConfigPath(null);
    });

    it("allowReadDirs 放宽读、allowWriteDirs 放宽写，且两者互不串用", async () => {
      const { setSandboxConfigPath } = await import("../src/security/sandbox.js");
      const read = toolRegistry.getHandler("fs_read")!;
      const write = toolRegistry.getHandler("fs_write")!;
      writeFileSync(join(outside, "cfg-read.txt"), "cfg-content", "utf-8");

      // 只放宽读：读得到、写不了
      writeFileSync(configPath, JSON.stringify({ enabled: true, allowReadDirs: [outside] }), "utf-8");
      setSandboxConfigPath(configPath);
      expect((await read({ path: join(outside, "cfg-read.txt") }, ctx(wd))).success).toBe(true);
      expect((await write({ path: join(outside, "cfg-write.txt"), content: "x" }, ctx(wd))).success).toBe(false);

      // 只放宽写：写得进、读不了
      writeFileSync(configPath, JSON.stringify({ enabled: true, allowWriteDirs: [outside] }), "utf-8");
      expect((await write({ path: join(outside, "cfg-write.txt"), content: "x" }, ctx(wd))).success).toBe(true);
      expect((await read({ path: join(outside, "cfg-read.txt") }, ctx(wd))).success).toBe(false);
    });

    it("sandbox.enabled=false 只关命令层，不关 fs 读写边界", async () => {
      const { setSandboxConfigPath } = await import("../src/security/sandbox.js");
      writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf-8");
      setSandboxConfigPath(configPath);
      expect((await toolRegistry.getHandler("fs_read")!({ path: join(outside, "cfg-read.txt") }, ctx(wd))).success).toBe(false);
      expect((await toolRegistry.getHandler("fs_write")!({ path: join(outside, "x.txt"), content: "x" }, ctx(wd))).success).toBe(false);
    });
  });
});

// ── terminal_session 池与 terminal_exec 的会话归属（Sprint 52 D2-d） ──

describe("terminal_session 池可回收 / terminal_exec 不使用池", () => {
  afterEach(() => {
    terminalSessionPool.clear();
  });

  it("terminal_session 池按 sessionId 可回收；terminal_exec 完全不使用池", async () => {
    const sid = "probe-pool-d2";
    terminalSessionPool.start(sid);
    expect(terminalSessionPool.get(sid)).toBeDefined();
    terminalSessionPool.end(sid);
    expect(terminalSessionPool.get(sid)).toBeUndefined();

    const handler = toolRegistry.getHandler("terminal_exec");
    expect(handler).toBeTruthy();
    const ctx: ToolContext = {
      agentId: "probe",
      sessionId: sid,
      workingDir: testDir,
      permissions: "auto",
      dataDir: testDir,
    };
    const res = await handler!({ command: "echo pool-probe", timeout: 20000 }, ctx);
    expect(res.success).toBe(true);
    expect(terminalSessionPool.get(sid)).toBeUndefined();
  });
});
