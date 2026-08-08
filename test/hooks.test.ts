/**
 * Hooks 系统测试：生命周期事件 + Phase 3 Hook Handlers
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { writeFileSync, existsSync, readdirSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { hookManager } from "../src/hooks/hook-manager.js";
import { SessionStore } from "../src/memory/session-store.js";
import { DangerDetector } from "../src/security/danger-detector.js";
import type { HookContext } from "../src/types.js";
import { makeTestDir, setupEnv } from "./helpers.js";

const testDir = makeTestDir("hooks");

beforeAll(() => {
  setupEnv(testDir);
});

describe("6. Hooks 系统", () => {
  it("onToolCallPre Hook 被调用", async () => {
    hookManager.clear();
    let hookCalled = false;
    hookManager.on("onToolCallPre", async () => {
      hookCalled = true;
      return void 0;
    });
    await hookManager.trigger("onToolCallPre", {
      agentId: "test",
      sessionId: "test",
      data: { toolName: "fs_read" },
    });
    expect(hookCalled).toBe(true);
  });

  it("Hook 拦截生效", async () => {
    hookManager.clear();
    hookManager.on("onToolCallPre", async () => ({
      proceed: false,
      message: "测试拦截",
    }));
    const result = await hookManager.trigger("onToolCallPre", {
      agentId: "test",
      sessionId: "test",
      data: {},
    });
    expect(result.proceed).toBe(false);
  });

  it("拦截消息正确传递", async () => {
    hookManager.clear();
    hookManager.on("onToolCallPre", async () => ({
      proceed: false,
      message: "测试拦截",
    }));
    const result = await hookManager.trigger("onToolCallPre", {
      agentId: "test",
      sessionId: "test",
      data: {},
    });
    expect(result.message).toBe("测试拦截");
  });
});

describe("13. Phase 3 Hook Handlers", () => {
  const makeCtx = (overrides: Partial<HookContext> = {}): HookContext => ({
    event: "onToolCallPre",
    agentId: "test-agent",
    sessionId: "test-session",
    data: {},
    ...overrides,
  });

  // 13a. SensitiveDataFilter
  it("sensitiveDataFilter 拦截 OpenAI API Key", async () => {
    const { createSensitiveDataFilter } = await import("../src/hooks/handlers.js");
    const handler = createSensitiveDataFilter();
    const ctx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "terminal_exec", args: "echo sk-abc123def456ghi789jkl012" },
    });
    const result = await handler(ctx);
    expect(result).toBeDefined();
    expect(result!.proceed).toBe(false);
    expect(result!.message).toContain("敏感信息");
  });

  it("sensitiveDataFilter 拦截私钥", async () => {
    const { createSensitiveDataFilter } = await import("../src/hooks/handlers.js");
    const handler = createSensitiveDataFilter();
    const ctx = makeCtx({
      event: "onToolCallPre",
      data: {
        toolName: "fs_write",
        args: JSON.stringify({ path: "/tmp/key.pem", content: "-----BEGIN PRIVATE KEY-----\nABCD" }),
      },
    });
    const result = await handler(ctx);
    expect(result).toBeDefined();
    expect(result!.proceed).toBe(false);
  });

  it("sensitiveDataFilter 放过安全命令", async () => {
    const { createSensitiveDataFilter } = await import("../src/hooks/handlers.js");
    const handler = createSensitiveDataFilter();
    const ctx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "terminal_exec", args: "echo hello" },
    });
    const result = await handler(ctx);
    expect(result).toBeUndefined();
  });

  it("sensitiveDataFilter 在 onMessage 中拦截", async () => {
    const { createSensitiveDataFilter } = await import("../src/hooks/handlers.js");
    const handler = createSensitiveDataFilter();
    const ctx = makeCtx({
      event: "onMessage",
      data: { instruction: "帮我设置 key sk-xxx12345678901234567890" },
    });
    const result = await handler(ctx);
    expect(result).toBeDefined();
    expect(result!.proceed).toBe(false);
  });

  // 13b. AutoLoadProjectMemory
  it("autoLoadProjectMemory 自动加载项目文件", async () => {
    const { createAutoLoadProjectMemory } = await import("../src/hooks/handlers.js");
    const sessionStore = new SessionStore(resolve(testDir, "test-memory.db"));
    const handler = createAutoLoadProjectMemory({ sessionStore });

    // 创建临时项目文件
    const projectFile = resolve(testDir, "README.md");
    writeFileSync(projectFile, "# Test Project", "utf-8");

    const originalCwd = process.cwd;
    process.cwd = () => testDir;

    const ctx = makeCtx({
      event: "onMessage",
      data: { instruction: "帮我看看项目" },
    });
    const result = await handler(ctx);

    process.cwd = originalCwd;

    // 应该不拦截（proceed undefined = 继续）
    expect(result).toBeUndefined();

    // 验证 episodic 记忆被写入
    const entries = sessionStore.searchEpisodic("项目", 5);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.content.includes("README.md"))).toBe(true);

    sessionStore.close();
  });

  // 13c. CaptureDiff
  it("captureDiff 在 fs_write 前后捕获快照", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const handler = createCaptureDiff({});

    const testFile = resolve(testDir, "test-diff.txt");
    writeFileSync(testFile, "line1\nline2\n", "utf-8");

    // Pre-hook: 保存旧内容
    const preCtx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "fs_write", args: JSON.stringify({ path: testFile, content: "line1\nmodified\n" }) },
    });
    await handler(preCtx);

    // 写入新内容
    writeFileSync(testFile, "line1\nmodified\n", "utf-8");

    // Post-hook: 计算 diff
    const postCtx = makeCtx({
      event: "onToolCallPost",
      data: {
        toolName: "fs_write",
        args: JSON.stringify({ path: testFile }),
        result: { success: true, content: "ok" },
      },
    });
    await handler(postCtx);

    // 验证 diff 文件被写入（handler 用 process.cwd()，测试用项目根）
    const snapDir = resolve(process.cwd(), "data", "snapshots", "test-session");
    expect(existsSync(snapDir)).toBe(true);
  });

  it("captureDiff 对新文件写入磁盘快照（added = 新文件行数）", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const handler = createCaptureDiff({});

    const newFile = resolve(testDir, "new-file.txt");
    try {
      rmSync(newFile, { force: true });
    } catch {
      /* ignore */
    }

    // Pre-hook: 文件不存在，不保存快照
    const preCtx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "fs_write", args: JSON.stringify({ path: newFile, content: "line1\nline2\nline3\n" }) },
    });
    await handler(preCtx);

    // 创建新文件
    writeFileSync(newFile, "line1\nline2\nline3\n", "utf-8");

    const postCtx = makeCtx({
      event: "onToolCallPost",
      data: { toolName: "fs_write", args: JSON.stringify({ path: newFile }), result: { success: true, content: "ok" } },
    });
    await handler(postCtx);

    // 磁盘快照包含 diff 内容（含 + line 行）
    const snapDir = resolve(process.cwd(), "data", "snapshots", "test-session");
    expect(existsSync(snapDir)).toBe(true);
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".diff"));
    expect(snapFiles.length).toBeGreaterThan(0);
    const content = readFileSync(resolve(snapDir, snapFiles[0]), "utf-8");
    expect(content).toContain("+ line1");
  });

  it("captureDiff 相对路径以 projectDir 为基准解析（与 fs_write 一致）", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const proj = resolve(testDir, "proj-diff");
    const handler = createCaptureDiff({ projectDir: proj, dataDir: resolve(testDir, "snap") });

    const relFile = resolve(proj, "sub", "rel-file.txt");
    mkdirSync(dirname(relFile), { recursive: true });
    writeFileSync(relFile, "old\n", "utf-8");

    // Pre: 保存旧内容（相对路径应解析到 projectDir 下）
    const preCtx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "fs_write", args: JSON.stringify({ path: "sub/rel-file.txt", content: "new\n" }) },
    });
    await handler(preCtx);

    // 写入新内容
    writeFileSync(relFile, "new\n", "utf-8");

    const postCtx = makeCtx({
      event: "onToolCallPost",
      data: {
        toolName: "fs_write",
        args: JSON.stringify({ path: "sub/rel-file.txt" }),
        result: { success: true, content: "ok" },
      },
    });
    await handler(postCtx);

    // 快照应写入 dataDir/snapshots/<sessionId>，且 diff 包含 - old / + new
    const snapDir = resolve(testDir, "snap", "snapshots", "test-session");
    expect(existsSync(snapDir)).toBe(true);
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".diff"));
    expect(snapFiles.length).toBe(1);
    const content = readFileSync(resolve(snapDir, snapFiles[0]), "utf-8");
    expect(content).toContain("# path: " + relFile);
    expect(content).toContain("- old");
    expect(content).toContain("+ new");
  });

  it("captureDiff 输出目录指纹监控捕获 terminal_exec 写入的新文件", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const proj = resolve(testDir, "proj-monitor");
    const snap = resolve(testDir, "snap-monitor");
    const tracked = new Set<string>();
    const handler = createCaptureDiff({ projectDir: proj, dataDir: snap, onFileDiff: (p) => tracked.add(p) });

    const outFile = resolve(proj, "terminal-out.txt");
    rmSync(outFile, { force: true });
    mkdirSync(proj, { recursive: true });

    // 首次 onToolCallPost（任何工具）建立指纹基线
    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "terminal_exec", args: "{}", result: { success: true, content: "ok" } } }));

    // terminal_exec 写入新文件
    writeFileSync(outFile, "hello\nworld\n", "utf-8");

    // 第二次 onToolCallPost 触发指纹对比（同一实例共享 dirSnapshots）
    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "terminal_exec", args: "{}", result: { success: true, content: "ok" } } }));

    // 检测到新增文件并写快照
    expect(tracked.size).toBe(1);
    const snapDir = resolve(snap, "snapshots", "test-session");
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".diff"));
    expect(snapFiles.length).toBe(1);
    const content = readFileSync(resolve(snapDir, snapFiles[0]), "utf-8");
    expect(content).toContain("# path: " + outFile);
    expect(content).toContain("新增文件");
    expect(content).toContain("2 行");
  });

  it("captureDiff 输出目录指纹监控捕获 terminal_exec 对已存在文件的修改", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const proj = resolve(testDir, "proj-monitor-mod");
    const snap = resolve(testDir, "snap-monitor-mod");
    const handler = createCaptureDiff({ projectDir: proj, dataDir: snap });

    const modFile = resolve(proj, "mod-file.txt");
    mkdirSync(proj, { recursive: true });
    writeFileSync(modFile, "old\n", "utf-8");

    // 首次 onToolCallPost 建立基线（此时文件已存在）
    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "terminal_exec", args: "{}", result: { success: true, content: "ok" } } }));

    // terminal_exec 修改该文件
    writeFileSync(modFile, "old\nnew\n", "utf-8");

    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "terminal_exec", args: "{}", result: { success: true, content: "ok" } } }));

    const snapDir = resolve(snap, "snapshots", "test-session");
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".diff"));
    expect(snapFiles.length).toBe(1);
    const content = readFileSync(resolve(snapDir, snapFiles[0]), "utf-8");
    expect(content).toContain("# path: " + modFile);
    expect(content).toContain("内容已变化");
  });

  it("captureDiff fs_write 写入不触发目录指纹重复记录", async () => {
    const { createCaptureDiff } = await import("../src/hooks/handlers.js");
    const proj = resolve(testDir, "proj-dedup");
    const snap = resolve(testDir, "snap-dedup");
    const handler = createCaptureDiff({ projectDir: proj, dataDir: snap });

    const newFile = resolve(proj, "fs-new.txt");
    rmSync(newFile, { force: true });
    mkdirSync(proj, { recursive: true });

    // 首次 onToolCallPost 建立目录指纹基线
    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "fs_list", args: "{}", result: { success: true, content: "ok" } } }));

    // fs_write pre：记录路径到 fsWritePaths（不保存旧内容，因为文件不存在）
    await handler(makeCtx({ event: "onToolCallPre", data: { toolName: "fs_write", args: JSON.stringify({ path: newFile, content: "a\nb\n" }) } }));

    // 写入新文件
    writeFileSync(newFile, "a\nb\n", "utf-8");

    // fs_write post：应只由 fs_write 精确逻辑记录一次（目录指纹跳过 fsWritePaths）
    await handler(makeCtx({ event: "onToolCallPost", data: { toolName: "fs_write", args: JSON.stringify({ path: newFile }), result: { success: true, content: "ok" } } }));

    const snapDir = resolve(snap, "snapshots", "test-session");
    const snapFiles = readdirSync(snapDir).filter((f) => f.endsWith(".diff"));
    expect(snapFiles.length).toBe(1);
    const content = readFileSync(resolve(snapDir, snapFiles[0]), "utf-8");
    expect(content).toContain("# path: " + newFile);
  });

  // 13d. EvaluateSkillCreation
  it("evaluateSkillCreation 低于阈值不创建", async () => {
    const { createEvaluateSkillCreation } = await import("../src/hooks/handlers.js");
    const handler = createEvaluateSkillCreation({});

    const ctx = makeCtx({
      event: "onTaskComplete",
      data: { iterations: 2, toolCallsExecuted: 3 },
    });
    const result = await handler(ctx);
    expect(result).toBeUndefined();
  });

  it("evaluateSkillCreation 高于阈值创建 SKILL.md", async () => {
    const { createEvaluateSkillCreation } = await import("../src/hooks/handlers.js");
    const handler = createEvaluateSkillCreation({});

    const originalCwd = process.cwd;
    process.cwd = () => testDir;

    const ctx = makeCtx({
      event: "onTaskComplete",
      data: { iterations: 6, toolCallsExecuted: 10 },
    });
    await handler(ctx);

    process.cwd = originalCwd;

    // 验证 pending 目录有 skill 文件
    const pendingDir = resolve(testDir, "skills", "pending");
    expect(existsSync(pendingDir)).toBe(true);
    const files = readdirSync(pendingDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].endsWith(".md")).toBe(true);
  });

  // 13e. ConfirmHighRisk (without interactive prompt)
  it("confirmHighRisk 在 ask 模式不触发", async () => {
    const { createConfirmHighRisk } = await import("../src/hooks/handlers.js");
    const detector = new DangerDetector();
    const handler = createConfirmHighRisk({ dangerDetector: detector });

    const ctx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "terminal_exec", args: "echo hello", permissions: "ask" },
    });

    // ask 模式应该跳过（只处理 Auto）
    const timeoutPromise = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200));
    const result = await Promise.race([handler(ctx), timeoutPromise]);
    expect(result).toBeUndefined();
  });

  it("confirmHighRisk 在 auto 模式 fs_write 内容含 rm/del 等词不误报", async () => {
    const { createConfirmHighRisk } = await import("../src/hooks/handlers.js");
    const detector = new DangerDetector();
    const handler = createConfirmHighRisk({ dangerDetector: detector });

    // content 含 "rm xxx"（普通文本，非命令），路径安全 → 不应触发确认
    const ctx = makeCtx({
      event: "onToolCallPre",
      data: {
        toolName: "fs_write",
        args: JSON.stringify({ path: "src/notes.md", content: "删除文件用 rm 命令即可\n" }),
        permissions: "auto",
      },
    });
    const result = await handler(ctx);
    expect(result).toBeUndefined();
  });

  it("permissionCheck 在 ask 模式放行只读工具", async () => {
    const { createPermissionCheck } = await import("../src/hooks/handlers.js");
    const { PermissionModel } = await import("../src/security/permission-model.js");
    const model = new PermissionModel({
      defaultMode: "ask",
      modes: {
        ask: { description: "只读", allow_tool_calls: true, readOnly: true },
        plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
        auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [],
      deniedPatterns: [],
    });
    const handler = createPermissionCheck({ permissionModel: model });

    const readCtx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "fs_list", args: "{}", permissions: "ask" },
    });
    const readResult = await handler(readCtx);
    expect(readResult).toBeUndefined();

    const writeCtx = makeCtx({
      event: "onToolCallPre",
      data: { toolName: "fs_write", args: "{}", permissions: "ask" },
    });
    const writeResult = await handler(writeCtx);
    expect(writeResult?.proceed).toBe(false);
    expect(writeResult?.message).toContain("只读");
  });

  it("confirm-channel 挂起等待响应并精确路由", async () => {
    const { createHttpConfirmProvider, confirmResponse } = await import("../src/hooks/confirm-channel.js");
    const sent: { id: string; message: string }[] = [];
    const provider = createHttpConfirmProvider((req) => sent.push({ id: req.id, message: req.message }), 2000);

    const p1 = provider({ id: "cf-1", title: "t", message: "允许执行?", options: [] });
    const p2 = provider({ id: "cf-2", title: "t", message: "允许执行?", options: [] });
    expect(sent).toHaveLength(2);

    // 响应 cf-2（乱序），应只 resolve cf-2
    confirmResponse("cf-2", "allow");
    expect(await p2).toBe("allow");
    // cf-1 未响应，等待超时返回 null
    expect(await p1).toBeNull();
  });

  // 13f. TurnLogger token 增量
  it("turnLogger onMessage 记录基线，onTaskComplete 结算增量", async () => {
    const { createTurnLogger } = await import("../src/hooks/handlers.js");
    const sessionStore = new SessionStore(resolve(testDir, "test-turnlog.db"));
    let promptTokens = 100;
    let completionTokens = 50;
    const modelRouter = {
      getPromptTokens: () => promptTokens,
      getCompletionTokens: () => completionTokens,
    };
    const handler = createTurnLogger({ sessionStore, modelRouter } as never);
    const sess = sessionStore.createSession("test-agent");

    await handler({ event: "onMessage", agentId: "test-agent", sessionId: sess.id, data: {} } as never);
    promptTokens = 1500;
    completionTokens = 800;
    await handler({
      event: "onTaskComplete",
      agentId: "test-agent",
      sessionId: sess.id,
      data: { iterations: 5, toolCallsExecuted: 3, truncated: false, messages: [{ role: "user", content: "问题" }] },
    } as never);

    const turns = sessionStore.getTurnLogs(sess.id);
    expect(turns.length).toBe(1);
    expect(turns[0].tokensPrompt).toBe(1400); // 1500 - 100
    expect(turns[0].tokensCompletion).toBe(750); // 800 - 50
    expect(turns[0].userInput).toBe("问题");
    sessionStore.close();
  });
});
