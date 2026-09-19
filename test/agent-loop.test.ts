/**
 * Agent 循环增强单测（Sprint 26）
 * 覆盖：D 工具调用统一超时（慢工具超时返回错误、不挂死）；E 防循环提醒（连续相同调用注入一次提醒）
 * 另含 Sprint 52 T0 诊断用例：D2 AbortSignal 真实语义（含 terminal_exec 真中断杀树）、D3 同 sessionId 二次 runStream 的消息组装、T0.5① 当前用户消息只注入一次
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { runAgentLoop, runAgentLoopStream } from "../src/core/agent-loop.js";
import { processManager } from "../src/core/process-manager.js";
import { BaseAgent } from "../src/agents/base-agent.js";
import type {
  AgentConfig,
  AgentRunResult,
  ModelResponse,
  StreamChunk,
  ToolDefinition,
  Message,
} from "../src/types.js";
import type { ModelRouter } from "../src/core/model-router.js";

let dir: string;
let store: SessionStore;
let ctxMgr: ContextManager;

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function makeConfig(): AgentConfig {
  return {
    id: "test",
    name: "test",
    displayName: "Test",
    type: "test",
    systemPrompt: "你是一个测试助手。",
    modelPreference: "coding",
    maxIterations: 10,
    sandbox: false,
    tools: [],
    mcpServers: [],
    permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
  };
}

/** 依次返回预设响应的 mock 模型路由 */
function mockRouter(script: Array<() => ModelResponse>): ModelRouter {
  const responses = [...script];
  return {
    completeWithProfile: async () => {
      const next = responses.shift()!;
      return next();
    },
  } as unknown as ModelRouter;
}

function toolCall(id: string, name: string, args: string): ModelResponse {
  return {
    text: "调用工具",
    toolCalls: [{ id, type: "function", function: { name, arguments: args } }],
    hasToolCalls: true,
    usage,
    finishReason: "tool_calls",
  };
}

function plain(text: string): ModelResponse {
  return { text, toolCalls: [], hasToolCalls: false, usage, finishReason: "stop" };
}

function def(name: string): ToolDefinition {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toolTurn(id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: "tool_call_start", toolCallId: id, toolName: name },
    { type: "tool_call_delta", toolCallId: id, content: args },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function textTurn(text: string): StreamChunk[] {
  return [{ type: "text", content: text }, { type: "done", finishReason: "stop" }];
}

/** 一次模型请求实际收到的 messages 快照（必须拷贝：messages 数组在循环里继续被改动） */
interface Captured {
  roles: string[];
  texts: string[];
}

function captureMessages(msgs: Message[]): Captured {
  return {
    roles: msgs.map((m) => m.role),
    texts: msgs.map((m) => (typeof m.content === "string" ? m.content : "<多模态>")),
  };
}

function streamRouter(turns: StreamChunk[][], calls: Captured[] = []): ModelRouter {
  const queue = [...turns];
  return {
    completeStream: async function* (
      _pref: string,
      msgs: Message[],
      _tools?: unknown,
      opts?: { onUsage?: (u: typeof usage) => void },
    ) {
      calls.push(captureMessages(msgs));
      const turn = queue.shift() ?? textTurn("（无更多响应）");
      for (const c of turn) yield c;
      opts?.onUsage?.(usage);
    },
  } as unknown as ModelRouter;
}

function deps(modelRouter: ModelRouter, sessionId: string) {
  return { modelRouter, contextManager: ctxMgr, sessionStore: store, sessionId, workingDir: dir };
}

class ProbeAgent extends BaseAgent {}

beforeEach(() => {
  dir = makeTestDir("agent-loop");
  setupEnv(dir);
  store = new SessionStore(resolve(dir, "aiworker.db"));
  ctxMgr = new ContextManager(store, dir);
});

afterEach(() => {
  store.close();
  teardownEnv();
  clearTools();
});

describe("D. 工具调用统一超时", () => {
  it("慢工具超时返回错误而非挂死，循环继续", async () => {
    // 永不 resolve 的慢工具
    const def: ToolDefinition = {
      type: "function",
      function: { name: "slow_tool", description: "慢工具", parameters: { type: "object", properties: {} } },
    };
    toolRegistry.register("slow_tool", def, () => new Promise(() => {}));

    const sessionId = store.createSession("test").id;
    const modelRouter = mockRouter([() => toolCall("t1", "slow_tool", "{}"), () => plain("完成")]);

    const result: AgentRunResult = await runAgentLoop(makeConfig(), "跑一次慢工具", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
      toolTimeoutMs: 300,
    });

    expect(result.toolCallsExecuted).toBe(1);
    expect(result.text).toBe("完成");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("调用超时");
    expect(toolMsg?.content).toContain("slow_tool");
  });

  it("快速工具正常执行不受超时影响", async () => {
    const sessionId = store.createSession("test").id;
    const modelRouter = mockRouter([() => toolCall("t1", "fs_read", '{"path":"package.json"}'), () => plain("完成")]);

    const result = await runAgentLoop(makeConfig(), "读取文件", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
      toolTimeoutMs: 5000,
    });

    expect(result.toolCallsExecuted).toBe(1);
    expect(result.text).toBe("完成");
  });
});

describe("E. 防循环提醒", () => {
  it("连续 3 次以上相同 (工具, 参数) 调用注入一次 system 提醒", async () => {
    const sessionId = store.createSession("test").id;
    // 前 5 次都返回相同 fs_read 调用（参数一致，< 强停阈值 6），第 6 次收尾
    const script: Array<() => ModelResponse> = [];
    for (let i = 1; i <= 5; i++) {
      script.push(() => toolCall(`t${i}`, "fs_read", '{"path":"package.json"}'));
    }
    script.push(() => plain("完成"));
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(makeConfig(), "循环读取", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    const reminders = result.messages.filter(
      (m) => m.role === "system" && m.content.includes("连续") && m.content.includes("fs_read"),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.content).toContain("停止重复调用");
    expect(result.text).toBe("完成");
  });

  it("不同参数交替调用不触发提醒", async () => {
    const sessionId = store.createSession("test").id;
    // 交替读存在的文件（全部成功，避免触发工具失败终止），参数不同不触发提醒
    const files = ["package.json", "README.md", "src/types.ts", "package.json"];
    const script: Array<() => ModelResponse> = files.map((f, i) =>
      () => toolCall(`t${i}`, "fs_read", JSON.stringify({ path: f })),
    );
    script.push(() => plain("完成"));
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(makeConfig(), "依次读取", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    const reminders = result.messages.filter((m) => m.role === "system" && m.content.includes("停止重复调用"));
    expect(reminders).toHaveLength(0);
    expect(result.text).toBe("完成");
  });
});

describe("Sprint 29: 迭代预算与智能收敛", () => {
  it("剩余迭代 ≤5 时注入一次收敛提示", async () => {
    const sessionId = store.createSession("test").id;
    // 6 次成功调用（交替读文件避免强停/失败终止）+ 收尾；maxIterations=10
    const script: Array<() => ModelResponse> = [];
    const files = ["package.json", "README.md", "src/types.ts"];
    for (let i = 1; i <= 6; i++) {
      const f = files[i % files.length]!;
      script.push(() => toolCall(`t${i}`, "fs_read", JSON.stringify({ path: f })));
    }
    script.push(() => plain("完成"));
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(makeConfig(), "长任务", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    const budgetMsgs = result.messages.filter(
      (m) => m.role === "system" && m.content.includes("剩余迭代预算"),
    );
    expect(budgetMsgs).toHaveLength(1);
    expect(budgetMsgs[0]!.content).toContain("立即收敛");
    expect(result.text).toBe("完成");
  });

  it("连续 6 次相同调用强制终止", async () => {
    const sessionId = store.createSession("test").id;
    const script: Array<() => ModelResponse> = [];
    for (let i = 1; i <= 6; i++) {
      script.push(() => toolCall(`t${i}`, "fs_read", '{"path":"package.json"}'));
    }
    script.push(() => plain("完成")); // 不会执行到
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(makeConfig(), "死循环", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("已强制终止");
    expect(result.text).toContain("重复循环调用");
    expect(result.toolCallsExecuted).toBe(6);
  });

  it("工具连续失败 4 轮提前终止", async () => {
    const sessionId = store.createSession("test").id;
    const script: Array<() => ModelResponse> = [];
    for (let i = 1; i <= 4; i++) {
      script.push(() => toolCall(`t${i}`, "fs_read", JSON.stringify({ path: `not-exist-${i}.txt` })));
    }
    script.push(() => plain("完成")); // 不会执行到
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(makeConfig(), "读不存在文件", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("工具连续失败");
    expect(result.toolCallsExecuted).toBe(4);
  });

  it("撞顶返回带进展与建议（不再裸返回）", async () => {
    const sessionId = store.createSession("test").id;
    const config = makeConfig();
    config.maxIterations = 3;
    // 3 次成功工具调用（不同参数）后撞顶
    const script: Array<() => ModelResponse> = [
      () => toolCall("t1", "fs_read", '{"path":"package.json"}'),
      () => toolCall("t2", "fs_read", '{"path":"README.md"}'),
      () => toolCall("t3", "fs_read", '{"path":"src/types.ts"}'),
    ];
    const modelRouter = mockRouter(script);

    const result = await runAgentLoop(config, "撞顶任务", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("已达迭代上限 3 轮");
    expect(result.text).toContain("调用工具"); // 最后进展保留
    expect(result.text).toContain("/plan");
  });
});

describe("Sprint 27: 工具可见性白名单 + 作用域遮蔽", () => {
  it("config.tools 白名单收窄模型可见工具（mcp_ 前缀保留）", async () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "a" }));
    toolRegistry.register("beta", def("beta"), async () => ({ tool_call_id: "", success: true, content: "b" }));
    toolRegistry.register("mcp_demo_lookup", def("mcp_demo_lookup"), async () => ({ tool_call_id: "", success: true, content: "m" }));

    const config = makeConfig();
    config.tools = ["alpha"];

    const sessionId = store.createSession("test").id;
    let seenTools: ToolDefinition[] = [];
    const modelRouter = {
      completeWithProfile: async (_pref: string, _msgs: Message[], tools?: ToolDefinition[]) => {
        seenTools = tools ?? [];
        return plain("完成");
      },
    } as unknown as ModelRouter;

    await runAgentLoop(config, "可见性", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    const names = seenTools.map((t) => t.function.name);
    expect(names).toContain("alpha");
    expect(names).not.toContain("beta");
    expect(names).toContain("mcp_demo_lookup");
  });

  it("tools 为空时不过滤（保持全部可见）", async () => {
    toolRegistry.register("beta", def("beta"), async () => ({ tool_call_id: "", success: true, content: "b" }));

    const sessionId = store.createSession("test").id;
    let seenTools: ToolDefinition[] = [];
    const modelRouter = {
      completeWithProfile: async (_pref: string, _msgs: Message[], tools?: ToolDefinition[]) => {
        seenTools = tools ?? [];
        return plain("完成");
      },
    } as unknown as ModelRouter;

    await runAgentLoop(makeConfig(), "可见性", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    expect(seenTools.map((t) => t.function.name)).toContain("beta");
  });

  it("插件注册的工具豁免白名单（即插即用，无需加入 agent tools）", async () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "a" }));
    toolRegistry.register("beta", def("beta"), async () => ({ tool_call_id: "", success: true, content: "b" }));
    toolRegistry.register("plugin_tool", def("plugin_tool"), async () => ({ tool_call_id: "", success: true, content: "p" }), {
      plugin: "demo",
    });

    const config = makeConfig();
    config.tools = ["alpha"];

    const sessionId = store.createSession("test").id;
    let seenTools: ToolDefinition[] = [];
    const modelRouter = {
      completeWithProfile: async (_pref: string, _msgs: Message[], tools?: ToolDefinition[]) => {
        seenTools = tools ?? [];
        return plain("完成");
      },
    } as unknown as ModelRouter;

    await runAgentLoop(config, "可见性", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
    });

    const names = seenTools.map((t) => t.function.name);
    expect(names).toContain("alpha");
    expect(names).toContain("plugin_tool"); // 插件工具豁免
    expect(names).not.toContain("beta"); // 普通工具仍被白名单过滤
  });

  it("toolScope 传参：执行走 scope view（遮蔽全局同名 handler）", async () => {
    toolRegistry.register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "global-alpha" }));
    toolRegistry.getScope("coding").register("alpha", def("alpha"), async () => ({ tool_call_id: "", success: true, content: "scoped-alpha" }));

    const sessionId = store.createSession("test").id;
    const modelRouter = mockRouter([() => toolCall("t1", "alpha", "{}"), () => plain("完成")]);

    const result = await runAgentLoop(makeConfig(), "遮蔽", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: process.cwd(),
      toolScope: "coding",
    });

    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("scoped-alpha");
  });
});

// ── D2：AbortSignal 的真实语义 ──

describe("D2 AbortSignal 真实语义", () => {
  it("D2-a 工具执行中触发 signal：runStream 返回（不抛）且 truncated，正在跑的工具体不中断", async () => {
    let toolStarted = false;
    let toolFinished = false;
    toolRegistry.register("probe_slow_tool", def("probe_slow_tool"), async () => {
      toolStarted = true;
      await sleep(700);
      toolFinished = true;
      return { tool_call_id: "", success: true, content: "slow-done" };
    });

    const sessionId = store.createSession("probe").id;
    const calls: Captured[] = [];
    const router = streamRouter(
      [toolTurn("t1", "probe_slow_tool", "{}"), textTurn("第二轮不该发生")],
      calls,
    );
    const controller = new AbortController();
    let seenToolCall!: () => void;
    const seen = new Promise<void>((r) => (seenToolCall = r));

    const running = runAgentLoopStream(
      makeConfig(),
      "跑慢工具",
      deps(router, sessionId),
      { onToolCall: () => seenToolCall() },
      controller.signal,
    );
    await seen;
    controller.abort();

    let settled = false;
    void running.then(() => (settled = true));
    await sleep(250);
    expect(settled).toBe(false);
    expect(toolStarted).toBe(true);

    const result = await running;
    expect(result.truncated).toBe(true);
    expect(result.toolCallsExecuted).toBe(1);
    expect(toolFinished).toBe(true);
    expect(result.messages.find((m) => m.role === "tool")?.content).toBe("slow-done");
    expect(calls).toHaveLength(1);
  });

  it("D2-b 流式请求期间 signal 触发且适配器抛错：仍返回不抛（catch 分支），已生成文本被丢弃", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const router = {
      completeStream: async function* (
        _pref: string,
        _msgs: unknown,
        _tools: unknown,
        opts?: { signal?: AbortSignal },
      ) {
        yield { type: "text", content: "半截输出" };
        await gate;
        if (opts?.signal?.aborted) throw new Error("mock stream aborted");
        yield { type: "text", content: "尾巴" };
      },
    } as unknown as ModelRouter;

    const sessionId = store.createSession("probe").id;
    const controller = new AbortController();
    let firstDelta = false;
    const running = runAgentLoopStream(
      makeConfig(),
      "问一句",
      deps(router, sessionId),
      { onTextDelta: () => (firstDelta = true) },
      controller.signal,
    );
    await sleep(50);
    expect(firstDelta).toBe(true);
    controller.abort();
    release();

    const result = await running;
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("");
    expect(result.toolCallsExecuted).toBe(0);
  });

  it("D2-b2 流式请求正常收尾但收尾瞬间已 abort：走「流后判定」路径，部分文本保留", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const router = {
      completeStream: async function* () {
        yield { type: "text", content: "半截输出" };
        await gate;
        yield { type: "text", content: "尾巴" };
      },
    } as unknown as ModelRouter;

    const controller = new AbortController();
    let firstDelta = false;
    const running = runAgentLoopStream(
      makeConfig(),
      "问一句",
      deps(router, store.createSession("probe").id),
      { onTextDelta: () => (firstDelta = true) },
      controller.signal,
    );
    await sleep(50);
    expect(firstDelta).toBe(true);
    controller.abort();
    release();

    const result = await running;
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("半截输出");
  });

  it("D2-c 真实 terminal_exec 走完整循环：T1b 后 signal 透传到工具，abort 立即杀进程树（不再等命令跑完）", async () => {
    // 完成标记落到文件（不写进命令文本，避免 error 回显命令时误命中）
    const doneFile = resolve(dir, "d2c-done.txt");
    if (existsSync(doneFile)) rmSync(doneFile, { force: true });
    const command = `node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'x'),2500)" "${doneFile}"`;
    const calls: Captured[] = [];
    const router = streamRouter(
      [toolTurn("t1", "terminal_exec", JSON.stringify({ command, timeout: 20000 })), textTurn("不该到达")],
      calls,
    );
    const controller = new AbortController();
    const procsBefore = processManager.list().length;

    const running = runAgentLoopStream(
      makeConfig(),
      "跑一个慢命令",
      deps(router, store.createSession("probe").id),
      {},
      controller.signal,
    );
    await sleep(400);
    controller.abort();
    const abortedAt = Date.now();

    // T1b：工具级真中断 —— abort 后命令被 taskkill /T /F（win32）或 SIGKILL（posix）终止，
    // 不再等 2500ms 自然跑完
    const result = await running;
    const elapsed = Date.now() - abortedAt;
    expect(result.truncated).toBe(true);
    expect(result.toolCallsExecuted).toBe(1);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("已被中断");
    // 上限 2000ms：本地实测 <300ms；CI 上 taskkill/事件循环延迟取宽松余量。
    // 若 signal 早于工具内监听器注册（竞态），杀树要等 exec 到期 → elapsed≈2100ms+，
    // 仍会失败——这个余量是"容忍调度延迟"而不是"容忍竞态"
    expect(elapsed).toBeLessThan(2000);

    // 等待原本的完成时刻已过：进程树确已被杀，命令体没能跑完写文件
    // （兜底结算最迟 1s 返回，elapsed≈1000 → 此处再等约 1600ms，总时长越过 2500ms 定时器）
    await sleep(2600 - elapsed);
    expect(existsSync(doneFile)).toBe(false);
    expect(processManager.list().length).toBe(procsBefore);
  });
});

// ── D3：同 sessionId 二次 runStream ──

describe("D3 同 sessionId 二次 runStream 的消息组装", () => {
  it("D3-a 三轮连续提问：历史被完整带上（可续接成立），且每条当前问题恰好一次（T0.5 修复后）", async () => {
    const cfg = makeConfig();
    const sessionId = store.createSession("probe").id;
    const calls: Captured[] = [];
    const router = streamRouter(
      [
        textTurn("回答一"),
        toolTurn("t1", "fs_list", JSON.stringify({ path: "." })),
        textTurn("回答二"),
        textTurn("回答三"),
      ],
      calls,
    );
    const agent = new ProbeAgent(cfg, {
      modelRouter: router,
      contextManager: ctxMgr,
      sessionStore: store,
      dataDir: dir,
    });

    await agent.runStream({ instruction: "第一个问题", sessionId }, dir, {});
    await agent.runStream({ instruction: "第二个问题", sessionId }, dir, {});
    await agent.runStream({ instruction: "第三个问题", sessionId }, dir, {});

    const dump = calls.map((c, i) => `  call${i + 1}: ${c.roles.join(" → ")}`).join("\n");
    console.log(`[D3] 三次 runStream 共 ${calls.length} 次模型请求：\n${dump}`);

    expect(calls).toHaveLength(4);
    // 历史确实被带上（第一轮的问题与回答出现在第二轮请求里）
    expect(calls[1]!.texts).toContain("第一个问题");
    expect(calls[1]!.texts).toContain("回答一");
    // 修复后：当前问题不再重复（此前是 system → user → user）
    expect(calls[0]!.roles).toEqual(["system", "user"]);
    expect(calls[1]!.roles).toEqual(["system", "user", "assistant", "user"]);
    expect(calls[1]!.texts.slice(-2)).toEqual(["回答一", "第二个问题"]);
    // 第三轮：tool 消息紧跟带 tool_calls 的 assistant（顺序正确）
    expect(calls[2]!.roles).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
    ]);
    // 第四轮：三轮问题全在（无截断），且各出现恰好一次
    expect(calls[3]!.roles).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    const asked = calls[3]!.texts.filter((t) =>
      ["第一个问题", "第二个问题", "第三个问题"].includes(t),
    );
    expect(asked).toEqual(["第一个问题", "第二个问题", "第三个问题"]);
  });
});

// ── T0.5：两个既有缺陷的修复验证 ──

describe("T0.5 缺陷① 当前用户消息只注入一次", () => {
  it("带图片时既不去重丢图也不重复注入：当轮一条多模态 user，历史里是上一轮的纯文本版本", async () => {
    const cfg = makeConfig();
    const sessionId = store.createSession("probe").id;
    const raw: Message[][] = [];
    const router = {
      completeStream: async function* (
        _pref: string,
        msgs: Message[],
        _tools?: unknown,
        opts?: { onUsage?: (u: typeof usage) => void },
      ) {
        raw.push(msgs.map((m) => ({ ...m })));
        yield { type: "text", content: "看图回答" } as StreamChunk;
        yield { type: "done", finishReason: "stop" } as StreamChunk;
        opts?.onUsage?.(usage);
      },
    } as unknown as ModelRouter;
    const agent = new ProbeAgent(cfg, {
      modelRouter: router,
      contextManager: ctxMgr,
      sessionStore: store,
      dataDir: dir,
    });

    await agent.runStream(
      { instruction: "看这张图", sessionId, images: ["data:image/png;base64,AAA"] },
      dir,
      {},
    );

    const first = raw[0]!;
    const firstUsers = first.filter((m) => m.role === "user");
    expect(firstUsers).toHaveLength(1);
    expect(Array.isArray(firstUsers[0]!.content)).toBe(true);
    const parts = firstUsers[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toMatchObject({ type: "text", text: "看这张图" });
    expect(parts[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });

    await agent.runStream(
      { instruction: "第二次提问", sessionId, images: ["data:image/png;base64,BBB"] },
      dir,
      {},
    );

    const second = raw[1]!;
    const secondUsers = second.filter((m) => m.role === "user");
    expect(secondUsers).toHaveLength(2);
    // 历史存文本（图片仅当轮上下文），当轮为多模态数组 —— 两者都在，且同一条问题只有一份
    expect(secondUsers[0]!.content).toBe("看这张图");
    expect(secondUsers[1]!.content).toEqual([
      { type: "text", text: "第二次提问" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
    ]);
  });
});
