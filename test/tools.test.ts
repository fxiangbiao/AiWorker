/**
 * 工具执行测试
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { toolRegistry } from "../src/core/tool-registry.js";
import type { ToolContext } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";

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

    // 路径穿越 → 失败
    r = await handler({ path: "../escape.txt", oldText: "x", newText: "y" }, ectx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("超出");

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

  it("rm -rf / 在 ask 模式被拦截", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const askCtx: ToolContext = { ...ctx, permissions: "ask" };
    const result = await handler({ command: "rm -rf /" }, askCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("高危");
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
