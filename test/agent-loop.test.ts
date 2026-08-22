/**
 * Agent 循环增强单测（Sprint 26）
 * 覆盖：D 工具调用统一超时（慢工具超时返回错误、不挂死）；E 防循环提醒（连续相同调用注入一次提醒）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { runAgentLoop } from "../src/core/agent-loop.js";
import type { AgentConfig, AgentRunResult, ModelResponse, ToolDefinition, Message } from "../src/types.js";
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
