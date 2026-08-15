/**
 * CLI 命令单测（方案 A：命令模块化 + CommandContext 注入）
 * 覆盖：exit / help 自动生成 / trace JSON / mode / new / skill 用法提示
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { buildCliCommands } from "../src/commands/registry.js";
import { pluginManager } from "../src/core/plugin-manager.js";
import type { CommandContext, CliCommand } from "../src/commands/types.js";
import type { ModelRouter } from "../src/core/model-router.js";
import type { TeamCoordinator } from "../src/core/team-coordinator.js";
import { SessionStore } from "../src/memory/session-store.js";

const commands: CliCommand[] = buildCliCommands();

function modelRouterMock() {
  return {
    resetTokenUsage: vi.fn(),
    getTokenUsage: vi.fn(() => 0),
    getPromptTokens: vi.fn(() => 0),
    getCompletionTokens: vi.fn(() => 0),
    getCurrentModel: vi.fn(() => "m"),
    getCost: vi.fn(() => 0),
  } as unknown as ModelRouter;
}

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const dir = makeTestDir("cli-commands");
  setupEnv(dir);
  const store = new SessionStore(resolve(dir, "aiworker.db"));
  const writes: string[] = [];
  const writeLines: string[] = [];
  const prefillQueue: string[] = [];
  const ctx: CommandContext = {
    mode: () => "auto",
    setMode: () => {},
    showThinking: () => false,
    toggleThinking: () => {},
    currentSessionId: () => undefined,
    setCurrentSessionId: () => {},
    prefillQueue,
    lastAnswer: { value: "answer" },
    agents: {},
    coordinator: {} as TeamCoordinator,
    modelRouter: modelRouterMock(),
    sessionStore: store,
    skillCount: 0,
    workingDir: dir,
    runtimeConfigPath: resolve(dir, "runtime-config.json"),
    persistRuntimeConfig: () => {},
    getContextBreakdown: () => ({
      systemPromptBase: 0,
      projectMemory: 0,
      userProfile: 0,
      episodicMemory: 0,
      injectedSkills: 0,
      conversationHistory: 0,
      currentTurn: 0,
      total: 0,
      windowSize: 1000,
      skillsMatched: [],
      skillsTotal: 0,
    }),
    listCommands: () => commands,
    write: (t) => writes.push(t),
    writeLine: (l) => writeLines.push(l),
    printStatus: () => {},
    ...overrides,
  };
  return { ctx, writes, writeLines, prefillQueue, store };
}

function find(name: string): CliCommand {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  return cmd;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  teardownEnv();
});

describe("命令注册表", () => {
  it("注册全部命令且无重名", () => {
    const names = commands.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(18);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exit 返回 exit 动作", async () => {
    const { ctx } = makeCtx();
    await expect(find("exit").handler(ctx, "", "/exit")).resolves.toBe("exit");
  });

  it("help 从注册表自动生成（含 trace/skill，杜绝遗漏）", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("help").handler(ctx, "", "/help");
    const joined = writeLines.join("\n");
    expect(joined).toContain("/trace");
    expect(joined).toContain("/skill");
    expect(joined).toContain("/plan");
    expect(joined).toContain("/exit");
  });

  it("help 表格对齐：所有行 | 分隔符数量一致，单元格内半角 | 被转义", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("help").handler(ctx, "", "/help");
    const tableLines = writeLines.filter((l) => l.includes("│"));
    expect(tableLines.length).toBeGreaterThan(3);
    const sepCounts = new Set(tableLines.map((l) => (l.match(/│/g) ?? []).length));
    expect(sepCounts.size).toBe(1);
    // usage 中的半角 | 已替换为 /（不再破坏表格列结构）
    const joined = writeLines.join("\n");
    expect(joined).not.toContain("<ask|plan|auto>");
    expect(joined).toContain("<ask/plan/auto>");
    expect(joined).not.toContain("[model|temperature");
  });
});

describe("会话命令", () => {
  it("new 清空会话并重置 token", async () => {
    const reset = vi.fn();
    let sessionId: string | undefined = "old-session";
    const { ctx } = makeCtx({
      setCurrentSessionId: (id) => {
        sessionId = id;
      },
      currentSessionId: () => sessionId,
      modelRouter: { resetTokenUsage: reset } as unknown as ModelRouter,
    });
    await find("new").handler(ctx, "", "/new");
    expect(sessionId).toBeUndefined();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("trace --json 输出事件投影 JSON", async () => {
    const { ctx, writes, store } = makeCtx();
    const sessionId = store.createSession("coding").id;
    store.appendMessage(sessionId, { role: "user", content: "hello" });
    const { ctx: ctx2, writes: w2 } = makeCtx({ currentSessionId: () => sessionId });
    await find("trace").handler(ctx2, "--json", "/trace --json");
    void ctx;
    const json = w2.join("");
    const parsed = JSON.parse(json) as { sessionId: string; items: unknown[]; stats: { turnCount: number } };
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.stats.turnCount).toBe(0);
    void writes;
  });
});

describe("模式命令", () => {
  it("mode plan 触发 setMode('plan')", async () => {
    const setMode = vi.fn();
    const { ctx } = makeCtx({ setMode });
    await find("mode").handler(ctx, "plan", "/mode plan");
    expect(setMode).toHaveBeenCalledWith("plan");
  });

  it("mode 无效值提示错误", async () => {
    const setMode = vi.fn();
    const { ctx, writeLines } = makeCtx({ setMode });
    await find("mode").handler(ctx, "evil", "/mode evil");
    expect(setMode).not.toHaveBeenCalled();
    expect(writeLines.some((l) => l.includes("无效模式"))).toBe(true);
  });
});

describe("技能命令", () => {
  it("skill 无参数提示用法", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("skill").handler(ctx, "", "/skill");
    expect(writeLines.some((l) => l.includes("/skill <名称>"))).toBe(true);
  });

  it("skill 未知名提示可用技能", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("skill").handler(ctx, "nonexistent", "/skill nonexistent");
    expect(writeLines.some((l) => l.includes("未找到技能"))).toBe(true);
  });
});

describe("配置命令", () => {
  it("config model 切换 profile 后刷新状态栏（printStatus）", async () => {
    const printStatus = vi.fn();
    const setDefaultModel = vi.fn();
    const modelRouter = {
      getAvailableModels: vi.fn(() => [
        { key: "default", model: "m1", provider: "deepseek", baseURL: "x", temperature: 0.5, maxTokens: 4096 },
        { key: "lite", model: "qwen", provider: "openai", baseURL: "http://localhost:8000/v1", temperature: 0.7, maxTokens: 4096 },
      ]),
      setDefaultModel,
      getRuntimeConfig: vi.fn(() => ({ profileKey: "", model: "", temperature: null, maxTokens: null })),
    } as unknown as ModelRouter;
    const { ctx, writes } = makeCtx({ printStatus, modelRouter });
    await find("config").handler(ctx, "", "/config model lite");
    expect(setDefaultModel).toHaveBeenCalledWith("lite");
    expect(printStatus).toHaveBeenCalled();
    expect(writes.some((l) => l.includes("via lite profile"))).toBe(true);
  });

  it("config model 无参数提示用法且刷新状态栏", async () => {
    const printStatus = vi.fn();
    const modelRouter = {
      getAvailableModels: vi.fn(() => []),
    } as unknown as ModelRouter;
    const { ctx, writeLines } = makeCtx({ printStatus, modelRouter });
    await find("config").handler(ctx, "", "/config model");
    expect(writeLines.some((l) => l.includes("/config model <名称>"))).toBe(true);
    expect(printStatus).toHaveBeenCalled();
  });
});

describe("trace 会话切换", () => {
  it("trace 指定不存在的会话提示无事件", async () => {
    const { ctx, writeLines } = makeCtx({ currentSessionId: () => "no-such-session" });
    await find("trace").handler(ctx, "", "/trace");
    expect(writeLines.some((l) => l.includes("暂无事件记录"))).toBe(true);
  });
});

describe("plugins 命令", () => {
  it("/plugins 列出已加载插件与注册工具", async () => {
    const pluginsDir = resolve(makeTestDir("cli-plugins"), "plugins");
    mkdirSync(resolve(pluginsDir, "demo"), { recursive: true });
    writeFileSync(
      resolve(pluginsDir, "demo", "plugin.ts"),
      `export default async function setup(c) {
        c.registerTool("demo_tool", { type: "function", function: { name: "demo_tool", description: "x", parameters: { type: "object", properties: {} } } }, async () => ({ tool_call_id: "", success: true, content: "ok" }));
      }`,
      "utf-8",
    );
    await pluginManager.loadFromDir(pluginsDir);

    const { ctx, writeLines } = makeCtx();
    await find("plugins").handler(ctx, "", "/plugins");
    const joined = writeLines.join("\n");
    expect(joined).toContain("demo");
    expect(joined).toContain("demo_tool");
  });

  it("/plugins 无插件时提示", async () => {
    pluginManager.clear();
    const { ctx, writeLines } = makeCtx();
    await find("plugins").handler(ctx, "", "/plugins");
    expect(writeLines.join("\n")).toContain("未加载任何插件");
  });
});
