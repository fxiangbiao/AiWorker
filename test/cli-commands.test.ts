/**
 * CLI 命令单测（方案 A：命令模块化 + CommandContext 注入）
 * 覆盖：exit / help 自动生成 / trace JSON / mode / new / skill 用法提示
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { buildCliCommands } from "../src/commands/registry.js";
import { modelDir, modelManifest } from "../src/media/model-manager.js";
import { pluginManager } from "../src/core/plugin-manager.js";
import type { CommandContext, CliCommand } from "../src/commands/types.js";
import { PermissionModel } from "../src/security/permission-model.js";
import { PermissionMemory } from "../src/security/permission-memory.js";
import type { PermissionConfig } from "../src/types.js";
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
    getDisplayModel: vi.fn(() => "test-model"),
    getContextWindow: vi.fn(() => 32768),
    getSessionTokens: vi.fn(() => ({ prompt: 0, completion: 0 })),
    getAvailableModels: vi.fn(() => [{ key: "default", model: "m", provider: "deepseek", baseURL: "", temperature: 0, maxTokens: 100, contextWindow: 32768 }]),
  } as unknown as ModelRouter;
}

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const dir = makeTestDir("cli-commands");
  setupEnv(dir);
  const store = new SessionStore(resolve(dir, "aiworker.db"));
  const writes: string[] = [];
  const writeLines: string[] = [];
  const prefillQueue: string[] = [];
  let currentSid: string | undefined;
  const mockAgent = {
    getId: () => "default",
    getName: () => "测试专家",
    getMaxIterations: () => 100,
    setMaxIterations: vi.fn(),
    getConfig: () => ({ id: "default", maxIterations: 100, systemPrompt: "p", tools: [], mcpServers: [] }),
  };
  const ctx: CommandContext = {
    mode: () => "auto",
    setMode: () => {},
    showThinking: () => false,
    toggleThinking: () => {},
    currentSessionId: () => currentSid,
    setCurrentSessionId: (id) => { currentSid = id; },
    prefillQueue,
    lastAnswer: { value: "answer" },
    agents: {},
    currentAgent: () => mockAgent as unknown as CommandContext["agents"][string],
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
    ask: () => Promise.resolve(null),
    dataDir: dir,
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
    await find("help").handler(ctx, "", "/help");    const joined = writeLines.join("\n");
    expect(joined).toContain("/trace");
    expect(joined).toContain("/skill");
    expect(joined).toContain("/plan");
    expect(joined).toContain("/exit");
  });

  it("help 表格精简：命令列含全部命令，usage 参数不显示在表格", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("help").handler(ctx, "", "/help");
    const joined = writeLines.join("\n");
    expect(joined).toContain("/trace");
    expect(joined).toContain("/skill");
    expect(joined).toContain("/plan");
    expect(joined).toContain("/exit");
    // 精简后：usage 长参数不再出现在表格（下沉到 --help）
    expect(joined).not.toContain("<ask/plan/auto>");
    expect(joined).not.toContain("<skill|mcp|plugin>");
  });

  it("/help <命令> 显示命令级详细帮助（usage/功能/说明）", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("help").handler(ctx, "install", "/help install");
    const joined = writeLines.join("\n");
    expect(joined).toContain("/install");
    expect(joined).toContain("用法");
    expect(joined).toContain("说明");
  });

  it("renderCommandHelp 输出命令级帮助（--help 分发层调用此函数）", async () => {
    const { ctx, writeLines } = makeCtx();
    const { renderCommandHelp } = await import("../src/commands/misc.js");
    renderCommandHelp(find("install"), ctx);
    const joined = writeLines.join("\n");
    expect(joined).toContain("/install");
    expect(joined).toContain("用法");
    expect(joined).toContain("功能");
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
    const { ctx, writes } = makeCtx();
    const sessionId = ctx.sessionStore.createSession("coding").id;
    ctx.sessionStore.appendMessage(sessionId, { role: "user", content: "hello" });
    // 复用同一 ctx/store，只覆盖 currentSessionId（避免第二个空 store 导致事件为空）
    const traceCtx = { ...ctx, currentSessionId: () => sessionId };
    await find("trace").handler(traceCtx, "--json", "/trace --json");
    const json = writes.join("");
    const parsed = JSON.parse(json) as { sessionId: string; items: unknown[]; stats: { turnCount: number } };
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.stats.turnCount).toBe(0);
  });

  it("/dir 无参数展示生效目录（自定义 ?? 默认）", async () => {
    const { ctx, writeLines, store } = makeCtx();
    const sessionId = store.createSession("default").id;
    const dirCtx = { ...ctx, currentSessionId: () => sessionId };
    await find("dir").handler(dirCtx, "", "/dir");
    expect(writeLines.join("\n")).toContain("默认");
    // 设置后再无参查看：显示自定义
    const proj = resolve(dirCtx.workingDir, "proj");
    mkdirSync(proj, { recursive: true });
    await find("dir").handler(dirCtx, proj, `/dir ${proj}`);
    expect(store.getWorkingDir(sessionId)).toBe(proj);
    await find("dir").handler(dirCtx, "", "/dir");
    expect(writeLines.join("\n")).toContain("自定义");
    // empty 恢复默认
    await find("dir").handler(dirCtx, "empty", "/dir empty");
    expect(store.getWorkingDir(sessionId)).toBeNull();
  });

  it("/dir 校验：相对路径/不存在拒绝；无会话提示", async () => {
    const { ctx, writeLines, store } = makeCtx();
    const sessionId = store.createSession("default").id;
    const dirCtx = { ...ctx, currentSessionId: () => sessionId };
    await find("dir").handler(dirCtx, "relative/path", "/dir relative/path");
    expect(writeLines.join("\n")).toContain("绝对路径");
    await find("dir").handler(dirCtx, resolve(ctx.workingDir, "no-such-dir"), "/dir no-such");
    expect(writeLines.join("\n")).toContain("不存在");
    expect(store.getWorkingDir(sessionId)).toBeNull();
    // 无会话
    const noSessCtx = { ...ctx, currentSessionId: () => undefined };
    const writes2: string[] = [];
    await find("dir").handler({ ...noSessCtx, writeLine: (l) => writes2.push(l) }, resolve(ctx.workingDir), "/dir set");
    expect(writes2.join("\n")).toContain("无会话");
  });
});

describe("语音模型命令（Sprint 43）", () => {
  it("/media status 空模型 → 未就绪并列出缺失", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("media").handler(ctx, "status", "/media status");
    const joined = writeLines.join("\n");
    expect(joined).toContain("未就绪");
    expect(joined).toContain("model.onnx");
  });

  it("/media download asr 已就绪 → 无需下载（不触网）", async () => {
    const { ctx, writeLines } = makeCtx();
    const base = modelDir(ctx.dataDir, "asr");
    for (const f of modelManifest("asr").files) {
      const p = resolve(base, f.local);
      mkdirSync(resolve(p, ".."), { recursive: true });
      writeFileSync(p, f.minSize > 0 ? "x".repeat(4) : "", "utf-8");
    }
    await find("media").handler(ctx, "download asr", "/media download asr");
    expect(writeLines.join("\n")).toContain("无需下载");
  });

  it("/media download 非法 kind → 用法提示", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("media").handler(ctx, "download xxx", "/media download xxx");
    expect(writeLines.join("\n")).toContain("asr|tts");
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

  it("status 显示版本与专家列表", async () => {
    const agents = {
      default: { getName: () => "通用助手" },
      coding: { getName: () => "编码工程师" },
      financial: { getName: () => "理财投资顾问" },
    } as never;
    const { ctx, writes } = makeCtx({ agents });
    await find("status").handler(ctx, "", "/status");
    const joined = writes.join("");
    expect(joined).toMatch(/AiWorker v\d+\.\d+\.\d+/);
    expect(joined).toContain("专家:");
    expect(joined).toContain("通用助手");
    expect(joined).toContain("编码工程师");
    expect(joined).toContain("理财投资顾问");
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

  it("config iterations 设置当前专家上限并持久化到 YAML（智能体配置）", async () => {
    const persist = vi.fn();
    const printStatus = vi.fn();
    const saveAgentConfig = vi.fn(() => ({ ok: true }));
    const { ctx, writeLines } = makeCtx({ persistRuntimeConfig: persist, printStatus, saveAgentConfig });
    await find("config").handler(ctx, "", "/config iterations 150");
    expect(saveAgentConfig).toHaveBeenCalledTimes(1);
    const cfg = saveAgentConfig.mock.calls[0]![0] as { id: string; maxIterations: number };
    expect(cfg.id).toBe("default");
    expect(cfg.maxIterations).toBe(150);
    expect(persist).not.toHaveBeenCalled();
    expect(printStatus).toHaveBeenCalled();
    expect(writeLines.some((l) => l.includes("迭代上限 → 150") && l.includes("config/agents/default.yaml"))).toBe(true);
  });

  it("config iterations 无 saveAgentConfig 时仅内存生效", async () => {
    const printStatus = vi.fn();
    const { ctx, writeLines } = makeCtx({ printStatus });
    await find("config").handler(ctx, "", "/config iterations 150");
    const agent = (ctx as CommandContext).currentAgent() as {
      setMaxIterations: ReturnType<typeof vi.fn>;
    };
    expect(agent.setMaxIterations).toHaveBeenCalledWith(150);
    expect(writeLines.some((l) => l.includes("内存生效，未持久化"))).toBe(true);
  });

  it("config iterations 越界值被拒绝", async () => {
    const saveAgentConfig = vi.fn();
    const { ctx, writeLines } = makeCtx({ saveAgentConfig });
    await find("config").handler(ctx, "", "/config iterations 5");
    expect(writeLines.some((l) => l.includes("10-1000"))).toBe(true);
    await find("config").handler(ctx, "", "/config iterations 5000");
    expect(writeLines.some((l) => l.includes("10-1000"))).toBe(true);
    expect(saveAgentConfig).not.toHaveBeenCalled();
  });

  it("config iterations 无参数显示当前专家上限", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("config").handler(ctx, "", "/config iterations");
    expect(writeLines.some((l) => l.includes("当前专家 测试专家 上限: 100"))).toBe(true);
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

describe("bg / jobs / schedule 命令", () => {
  it("/bg 提交后台任务并返回任务 ID", async () => {
    const dir = makeTestDir("cli-jobs");
    const { jobRunner } = await import("../src/core/job-runner.js");
    const { SessionStore } = await import("../src/memory/session-store.js");
    const store = new SessionStore(resolve(dir, "jobs.db"));
    jobRunner.init({
      createAgent: () =>
        ({
          runStream: async () => ({ success: true, text: "ok", truncated: false }),
        }) as never,
      workingDir: dir,
      sessionStore: store,
    });
    const { ctx, writeLines } = makeCtx();
    await find("bg").handler(ctx, "整理报告", "/bg 整理报告");
    expect(writeLines.some((l) => l.includes("后台任务已提交") && l.includes("job-"))).toBe(true);
    store.close();
  });

  it("/jobs 空列表提示；/bg 后可列出", async () => {
    const dir = makeTestDir("cli-jobs2");
    const { jobRunner } = await import("../src/core/job-runner.js");
    const { SessionStore } = await import("../src/memory/session-store.js");
    const store = new SessionStore(resolve(dir, "jobs.db"));
    jobRunner.init({
      createAgent: () =>
        ({
          runStream: async () => ({ success: true, text: "ok", truncated: false }),
        }) as never,
      workingDir: dir,
      sessionStore: store,
    });
    const { ctx, writeLines } = makeCtx();
    jobRunner.clear();
    await find("jobs").handler(ctx, "", "/jobs");
    expect(writeLines.some((l) => l.includes("暂无后台任务"))).toBe(true);

    jobRunner.submit("default", "任务X");
    writeLines.length = 0;
    await find("jobs").handler(ctx, "", "/jobs");
    expect(writeLines.some((l) => l.includes("job-"))).toBe(true);
    store.close();
  });

  it("/schedule add 合法添加 / 非法 cron 拒绝 / remove", async () => {
    const dir = makeTestDir("cli-schedule");
    const { scheduler } = await import("../src/core/scheduler.js");
    scheduler.init({ submit: () => "" }, resolve(dir, "schedule.json"));
    const { ctx, writeLines } = makeCtx();

    await find("schedule").handler(ctx, "", '/schedule add "0 8 * * *" "每日早报"');
    expect(writeLines.some((l) => l.includes("定时任务已添加"))).toBe(true);

    await find("schedule").handler(ctx, "", '/schedule add "junk" "坏任务"');
    // 非 cron 首参 → 自然语言解析失败（mock 无 LLM 兜底）
    expect(writeLines.some((l) => l.includes("无法解析调度需求"))).toBe(true);

    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(1);
    await find("schedule").handler(ctx, "", `/schedule remove ${jobs[0]!.id}`);
    expect(scheduler.getJobs()).toHaveLength(0);
  });

  it("/schedule add 支持自然语言（规则解析）", async () => {
    const dir = makeTestDir("cli-schedule-nl");
    const { scheduler } = await import("../src/core/scheduler.js");
    scheduler.init({ submit: () => "" }, resolve(dir, "schedule.json"));
    const { ctx, writeLines } = makeCtx();

    await find("schedule").handler(ctx, "", '/schedule add "每天早上8点生成早报"');
    expect(writeLines.some((l) => l.includes("定时任务已添加"))).toBe(true);
    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cron).toBe("0 8 * * *");
    expect(jobs[0]!.prompt).toBe("生成早报");
  });

  it("/schedule add 自然语言无法解析时提示", async () => {
    const dir = makeTestDir("cli-schedule-nl2");
    const { scheduler } = await import("../src/core/scheduler.js");
    scheduler.init({ submit: () => "" }, resolve(dir, "schedule.json"));
    const { ctx, writeLines } = makeCtx();
    // "帮我写个程序" 无时间无频率 → 规则失败；mock modelRouter 无 complete → LLM 兜底失败
    await find("schedule").handler(ctx, "", '/schedule add "帮我写个程序"');
    expect(writeLines.some((l) => l.includes("无法解析调度需求"))).toBe(true);
    expect(scheduler.getJobs()).toHaveLength(0);
  });

  it("/sessions 显示真实轮数（用户消息数）", async () => {
    const { ctx, store, writes } = makeCtx();
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "第一轮" });
    store.appendMessage(sess.id, { role: "assistant", content: "回复1" });
    store.appendMessage(sess.id, { role: "user", content: "第二轮" });

    await find("sessions").handler(ctx, "", "/sessions");
    const joined = writes.join("");
    expect(joined).toContain("轮数");
    expect(joined).toContain("消息数");
    // 行内容包含 2 轮、3 消息（含摘要"第一轮"）
    const row = joined.split("\n").find((l) => l.includes("第一轮")) ?? "";
    expect(row).toContain(" 2 ");
    expect(row).toContain(" 3 ");
  });

  it("/export 导出当前会话为 Markdown 文件", async () => {
    const dir = makeTestDir("export-cli");
    const { ctx, store, writeLines } = makeCtx({ workingDir: dir });
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "你好" });
    store.appendMessage(sess.id, { role: "assistant", content: "你好！" });
    ctx.setCurrentSessionId(sess.id);

    await find("export").handler(ctx, "", "/export");
    expect(writeLines.some((l) => l.includes("已导出会话"))).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const md = readFileSync(resolve(dir, files[0]!), "utf-8");
    expect(md).toContain("你好！");
  });

  it("/export 指定序号导出（/sessions 序号）", async () => {
    const dir = makeTestDir("export-cli2");
    const { ctx, store, writeLines } = makeCtx({ workingDir: dir });
    const sess = store.createSession("default");
    store.appendMessage(sess.id, { role: "user", content: "指定会话" });
    store.appendMessage(sess.id, { role: "assistant", content: "内容A" });

    await find("export").handler(ctx, "1", "/export 1");
    expect(writeLines.some((l) => l.includes("已导出会话"))).toBe(true);
  });

  it("/pkg list 列出可导出资产（.aw）", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("pkg").handler(ctx, "", "/pkg list");
    const joined = writeLines.join("\n");
    expect(joined).toContain("可导出资产");
    expect(joined).toContain("技能");
  });

  it("/pkg export 不存在的资产提示未找到", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("pkg").handler(ctx, "", "/pkg export skill no-such-skill");
    expect(writeLines.some((l) => l.includes("未找到"))).toBe(true);
  });

  it("/install 未知格式被拒绝（不再限 .aw）", async () => {
    const dir = makeTestDir("install-unknown");
    const file = resolve(dir, "thing.txt");
    writeFileSync(file, "hi", "utf-8");
    const { ctx, writeLines } = makeCtx();
    await find("install").handler(ctx, file, `/install ${file}`);
    expect(writeLines.some((l) => l.includes("不支持的格式"))).toBe(true);
  });

  it("/install 不存在路径提示", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("install").handler(ctx, "no-such-file.aw", "/install no-such-file.aw");
    expect(writeLines.some((l) => l.includes("路径不存在"))).toBe(true);
  });
});

describe("permissions 命令（Sprint 49）", () => {
  function makePermCtx() {
    const dir = makeTestDir("cli-perms");
    const configPath = resolve(dir, "config", "permissions.json");
    mkdirSync(resolve(dir, "config"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ rules: [] }, null, 2)}\n`, "utf-8");
    const model = new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { description: "只读", allow_tool_calls: true, readOnly: true },
        plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
        auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [],
      deniedPatterns: [],
      neverAutoApprove: ["terminal_exec"],
      protectedPaths: [".env"],
    } as PermissionConfig);
    const memory = new PermissionMemory({ model, configPath, log: () => {} });
    const { ctx, writeLines, writes } = makeCtx({ permissionMemory: memory });
    const fileRules = () => (JSON.parse(readFileSync(configPath, "utf-8")).rules as unknown[]) ?? [];
    return { ctx, writeLines, writes, memory, configPath, fileRules };
  }

  it("未注入权限记忆时给出明确提示", async () => {
    const { ctx, writeLines } = makeCtx();
    await find("permissions").handler(ctx, "", "/permissions");
    expect(writeLines.join("\n")).toContain("权限记忆不可用");
  });

  it("空规则列表给出用法示例", async () => {
    const { ctx, writeLines } = makePermCtx();
    await find("permissions").handler(ctx, "", "/permissions");
    const joined = writeLines.join("\n");
    expect(joined).toContain("暂无规则");
    expect(joined).toContain("/permissions allow");
  });

  it("allow 写入项目级规则并立即列出（含来源与目标）", async () => {
    const h = makePermCtx();
    await find("permissions").handler(h.ctx, "allow fs_write(*notes*)", "/permissions allow fs_write(*notes*)");
    expect(h.writeLines.join("\n")).toContain("已写入项目级规则");
    expect(h.fileRules()).toEqual([{ tool: "fs_write", match: "*notes*", action: "allow" }]);
    expect(h.writes.join("")).toContain("ALLOW");
    expect(h.writes.join("")).toContain("*notes*");
    expect(h.writes.join("")).toContain("项目");
  });

  it("allow 触及受保护路径或永不自动批准清单时被拒绝（文件不变）", async () => {
    const h = makePermCtx();
    await find("permissions").handler(h.ctx, "allow fs_write(.env)", "/permissions allow fs_write(.env)");
    expect(h.writeLines.join("\n")).toContain("受保护路径");
    expect(h.fileRules()).toEqual([]);

    await find("permissions").handler(h.ctx, "allow terminal_exec", "/permissions allow terminal_exec");
    expect(h.writeLines.join("\n")).toContain("never_auto_approve");
    expect(h.fileRules()).toEqual([]);
  });

  it("规则格式非法与未知子命令都给出提示", async () => {
    const h = makePermCtx();
    await find("permissions").handler(h.ctx, "allow fs_write(", "/permissions allow fs_write(");
    expect(h.writeLines.join("\n")).toContain("格式非法");

    h.writeLines.length = 0;
    await find("permissions").handler(h.ctx, "wat", "/permissions wat");
    expect(h.writeLines.join("\n")).toContain("未知子命令");
  });

  it("revoke 按序号撤销；reset 与 clear-session 分别清理两级规则", async () => {
    const h = makePermCtx();
    await find("permissions").handler(h.ctx, "deny fs_write(*.log)", "/permissions deny fs_write(*.log)");
    h.memory.add({ tool: "fs_read", action: "allow" }, "session");
    // 列表顺序 = 生效顺序：会话级规则置于最前（不进配置文件）
    expect(h.memory.list().map((r) => r.source)).toEqual(["session", "project"]);

    await find("permissions").handler(h.ctx, "revoke 1", "/permissions revoke 1");
    expect(h.writeLines.join("\n")).toContain("已撤销（会话级）");
    expect(h.fileRules()).toHaveLength(1);

    await find("permissions").handler(h.ctx, "revoke 1", "/permissions revoke 1");
    expect(h.writeLines.join("\n")).toContain("已撤销（项目级）");
    expect(h.fileRules()).toEqual([]);
    expect(h.memory.list()).toEqual([]);

    // 序号越界
    await find("permissions").handler(h.ctx, "revoke 9", "/permissions revoke 9");
    expect(h.writeLines.join("\n")).toContain("序号需在");

    h.memory.add({ tool: "fs_read", action: "allow" }, "session");
    await find("permissions").handler(h.ctx, "clear-session", "/permissions clear-session");
    expect(h.memory.list()).toEqual([]);
  });

  it("reset 清空项目级规则", async () => {
    const h = makePermCtx();
    await find("permissions").handler(h.ctx, "ask fs_write", "/permissions ask fs_write");
    h.memory.add({ tool: "fs_read", action: "allow" }, "session");
    await find("permissions").handler(h.ctx, "reset", "/permissions reset");
    expect(h.fileRules()).toEqual([]);
    expect(h.memory.list().map((r) => r.source)).toEqual(["session"]);
  });

  it("revoke 支持按来源限定（--project / --session），来源不符则拒绝", async () => {
    const h = makePermCtx();
    h.memory.add({ tool: "fs_read", action: "allow" }, "session");
    await find("permissions").handler(h.ctx, "deny fs_write", "/permissions deny fs_write");
    expect(h.memory.list().map((r) => r.source)).toEqual(["session", "project"]);

    // 序号 1 是会话级；用 --project 限定 → 拒绝而不是撤错
    await find("permissions").handler(h.ctx, "revoke 1 --project", "/permissions revoke 1 --project");
    expect(h.writeLines.join("\n")).toContain("与 --project 不符");
    expect(h.memory.list()).toHaveLength(2);

    await find("permissions").handler(h.ctx, "revoke 1 --session", "/permissions revoke 1 --session");
    expect(h.memory.list().map((r) => r.source)).toEqual(["project"]);
    expect(h.fileRules()).toHaveLength(1);
  });
});
