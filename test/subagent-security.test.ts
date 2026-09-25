/**
 * Sprint 52 安全反例测试（T2）
 * 覆盖：受限工具空白名单不可见 / readOnly 闭集 / 写型 MCP 在 readOnly 下不可见 /
 *       执行层硬校验（手工注入越权 tool_call 被拒 + 审计）/ 深度 1 四工具全拒
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { SessionStore, WORKER_SESSION_PREFIX } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { runAgentLoop, filterVisibleTools, READ_ONLY_TOOLS } from "../src/core/agent-loop.js";
import { registerSubagentTools } from "../src/core/subagent-tools.js";
import { auditLogger, initAuditLog } from "../src/core/audit-logger.js";
import type { AgentConfig, ModelResponse, ToolDefinition, Message, ToolContext } from "../src/types.js";
import type { ModelRouter } from "../src/core/model-router.js";

let dir: string;
let store: SessionStore;
let ctxMgr: ContextManager;

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test",
    name: "test",
    displayName: "Test",
    type: "test",
    systemPrompt: "测试助手。",
    modelPreference: "coding",
    maxIterations: 5,
    sandbox: false,
    tools: [],
    mcpServers: [],
    permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
    ...overrides,
  };
}

function def(name: string): ToolDefinition {
  return { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } };
}

function toolCallResp(id: string, name: string, args = "{}"): ModelResponse {
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

describe("Sprint 52 安全反例", () => {
  beforeEach(() => {
    dir = makeTestDir("sprint-52-security");
    setupEnv(dir);
    store = new SessionStore(resolve(dir, "aiworker.db"));
    ctxMgr = new ContextManager(store, dir);
    initAuditLog(dir);
    registerSubagentTools();
  });

  afterEach(() => {
    store.close();
    teardownEnv();
    clearTools();
  });

  it("反例3：白名单为空时受限工具不可见，普通工具仍可见", () => {
    const available = [def("fs_read"), def("spawn_agent"), def("send_message"), def("list_agents"), def("interrupt_agent")];
    const visible = filterVisibleTools(available, makeConfig({ tools: [] }), () => false);
    const names = visible.map((t) => t.function.name);
    expect(names).toContain("fs_read");
    expect(names).not.toContain("spawn_agent");
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("list_agents");
    expect(names).not.toContain("interrupt_agent");
  });

  it("受限工具显式列出时可见", () => {
    const available = [def("fs_read"), def("spawn_agent")];
    const visible = filterVisibleTools(available, makeConfig({ tools: ["spawn_agent"] }), () => false);
    expect(visible.map((t) => t.function.name)).toEqual(["spawn_agent"]);
  });

  it("subagents 开关开启时控制面工具可见（无需逐个列入白名单）", () => {
    const available = [def("fs_read"), def("spawn_agent"), def("send_message"), def("list_agents"), def("interrupt_agent")];
    const visible = filterVisibleTools(available, makeConfig({ tools: ["fs_read"], subagents: true }), () => false);
    const names = visible.map((t) => t.function.name);
    expect(names).toEqual(["fs_read", "spawn_agent", "send_message", "list_agents", "interrupt_agent"]);
  });

  it("subagents 开关缺省关闭，且 readOnly 下不生效（闭集优先）", () => {
    const available = [def("fs_read"), def("spawn_agent")];
    const off = filterVisibleTools(available, makeConfig({ tools: ["fs_read"] }), () => false);
    expect(off.map((t) => t.function.name)).toEqual(["fs_read"]);
    const readOnly = filterVisibleTools(available, makeConfig({ tools: ["fs_read"], subagents: true, readOnly: true }), () => false);
    expect(readOnly.map((t) => t.function.name)).toEqual(["fs_read"]);
  });

  it("strictTools 下 subagents 开关不再自动放行（strict = 仅白名单可见）", () => {
    const available = [def("fs_read"), def("spawn_agent"), def("send_message")];
    const strict = filterVisibleTools(
      available,
      makeConfig({ tools: ["fs_read"], subagents: true, strictTools: true }),
      () => false,
    );
    expect(strict.map((t) => t.function.name)).toEqual(["fs_read"]);
    const explicit = filterVisibleTools(
      available,
      makeConfig({ tools: ["fs_read", "spawn_agent"], subagents: true, strictTools: true }),
      () => false,
    );
    expect(explicit.map((t) => t.function.name)).toEqual(["fs_read", "spawn_agent"]);
  });

  it("反例：readOnly 闭集只保留四个只读工具", () => {
    const available = [def("fs_read"), def("fs_list"), def("web_search"), def("web_fetch"), def("fs_write"), def("fs_edit"), def("terminal_exec")];
    const visible = filterVisibleTools(available, makeConfig({ readOnly: true }), () => false);
    const names = visible.map((t) => t.function.name).sort();
    expect(names).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it("反例：写型 MCP 在 readOnly 下不可见（无豁免）", () => {
    const available = [def("fs_read"), def("mcp_github_create_issue"), def("mcp_fs_write_file")];
    const visible = filterVisibleTools(available, makeConfig({ readOnly: true, tools: [] }), () => false);
    const names = visible.map((t) => t.function.name);
    expect(names).toEqual(["fs_read"]);
    expect(names).not.toContain("mcp_github_create_issue");
  });

  it("反例：readOnly 下插件工具不可见", () => {
    const available = [def("fs_read"), def("plugin_writer")];
    const visible = filterVisibleTools(available, makeConfig({ readOnly: true }), (n) => n === "plugin_writer");
    expect(visible.map((t) => t.function.name)).toEqual(["fs_read"]);
  });

  it("反例11：readOnly 子智能体手工注入 fs_write tool_call → 执行层拒绝 + 审计", async () => {
    let writeExecuted = false;
    toolRegistry.register("fs_read", def("fs_read"), async () => ({ tool_call_id: "", success: true, content: "read-ok" }));
    toolRegistry.register("fs_write", def("fs_write"), async () => {
      writeExecuted = true;
      return { tool_call_id: "", success: true, content: "written" };
    });

    const sessionId = store.createSession("test").id;
    const modelRouter = {
      completeWithProfile: async () => toolCallResp("t1", "fs_write", '{"path":"x.txt","content":"evil"}'),
    } as unknown as ModelRouter;

    const result = await runAgentLoop(makeConfig({ readOnly: true }), "尝试写入", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: dir,
    });

    expect(writeExecuted).toBe(false);
    const toolMsg = result.messages.find((m: Message) => m.role === "tool");
    expect(toolMsg?.content).toContain("不可见");
    const blocked = auditLogger.queryBySession(sessionId).filter((e) => e.action === "tool:fs_write" && e.result === "blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  });

  it("反例：普通 agent 手工注入白名单外工具 → 执行层同样拒绝（执行层校验不依赖白名单形态）", async () => {
    let execCount = 0;
    toolRegistry.register("alpha", def("alpha"), async () => {
      execCount++;
      return { tool_call_id: "", success: true, content: "a" };
    });
    toolRegistry.register("beta", def("beta"), async () => {
      execCount++;
      return { tool_call_id: "", success: true, content: "b" };
    });

    const sessionId = store.createSession("test").id;
    let round = 0;
    const modelRouter = {
      completeWithProfile: async () => {
        round++;
        return round === 1 ? toolCallResp("t1", "beta") : plain("完成");
      },
    } as unknown as ModelRouter;

    const result = await runAgentLoop(makeConfig({ tools: ["alpha"] }), "越权调用", {
      modelRouter,
      contextManager: ctxMgr,
      sessionStore: store,
      sessionId,
      workingDir: dir,
    });

    expect(execCount).toBe(0);
    const toolMsg = result.messages.find((m: Message) => m.role === "tool");
    expect(toolMsg?.content).toContain("不可见");
  });

  it("反例1：深度 1 —— 四个控制类工具在 wk- 会话下全部被执行层拒绝", async () => {
    const handlers: Array<[string, Record<string, unknown>]> = [
      ["spawn_agent", { agentId: "default", task: "递归" }],
      ["send_message", { id: "sub-x", message: "hi" }],
      ["list_agents", {}],
      ["interrupt_agent", { id: "sub-x" }],
    ];
    const workerCtx: ToolContext = {
      agentId: "default",
      sessionId: `${WORKER_SESSION_PREFIX}child-1`,
      workingDir: dir,
      permissions: "auto",
    };

    for (const [name, args] of handlers) {
      const handler = toolRegistry.getHandler(name)!;
      expect(handler, `${name} 应已注册`).toBeTruthy();
      const r = await handler(args, workerCtx);
      expect(r.success, `${name} 应被拒绝`).toBe(false);
      expect(r.error).toContain("深度限制");
    }

    const blocked = auditLogger.queryBySession(`${WORKER_SESSION_PREFIX}child-1`).filter((e) => e.result === "blocked");
    expect(blocked.length).toBe(4);
  });

  it("主智能体（非 wk-）可正常调用 list_agents", async () => {
    const handler = toolRegistry.getHandler("list_agents")!;
    const r = await handler({}, {
      agentId: "default",
      sessionId: "main-1",
      workingDir: dir,
      permissions: "auto",
    });
    expect(r.success).toBe(true);
  });

  it("端到端：readOnly 子智能体经 runner 派生后，模型侧可见工具恰为只读闭集", async () => {
    const { SubagentRunner } = await import("../src/core/subagent-runner.js");
    const seen: string[][] = [];
    const seenModes: string[] = [];
    const agent = {
      runStream: async (task: { mode?: string }, _wd: string, _cb: unknown) => {
        seenModes.push(String(task.mode));
        return { text: "ok", truncated: false, iterations: 1, toolCallsExecuted: 0, messages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
      getConfig: () => ({
        tools: ["fs_read", "fs_write", "terminal_exec", "web_search", "spawn_agent"],
        mcpServers: [],
        skills: [],
        plugins: [],
        permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
      }),
      fork: (patch: { tools?: string[]; readOnly?: boolean; strictTools?: boolean }) => {
        seen.push(patch.tools ?? []);
        forked.readOnly = patch.readOnly;
        forked.strictTools = patch.strictTools;
        return forked;
      },
    };
    const forked = {
      readOnly: undefined as boolean | undefined,
      strictTools: undefined as boolean | undefined,
      runStream: agent.runStream,
      getConfig: agent.getConfig,
      fork: agent.fork,
    };

    const r = new SubagentRunner();
    r.init({
      createAgent: () => agent as never,
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const ro = r.spawn("default", "只读调研");
    await new Promise((res) => setTimeout(res, 60));
    expect(seen[0]!.sort()).toEqual(["fs_read", "web_search"]);
    expect(forked.readOnly).toBe(true);
    expect(forked.strictTools).toBe(true);
    // 只读子智能体权限模式收窄为 ask（权限层只读）
    expect(seenModes[0]).toBe("ask");

    // 可写子智能体：保留父工具面但剔除控制类工具，模式沿用父会话
    const rw = r.spawn("default", "可写任务", { readOnly: false });
    await new Promise((res) => setTimeout(res, 60));
    expect(seen[1]).toContain("fs_write");
    expect(seen[1]).not.toContain("spawn_agent");
    expect(seenModes[1]).toBe("auto");
    r.clear();
  });

  it("F7 回归：编辑含危险字样的文件不被误判为高危（检测输入是路径不是 content）", async () => {
    const { ApprovalService } = await import("../src/security/approval-service.js");
    const { PermissionModel } = await import("../src/security/permission-model.js");
    const model = new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { allow_tool_calls: true, readOnly: true },
        plan: { allow_tool_calls: false, require_confirmation: true },
        auto: { allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [dir],
      deniedPatterns: [],
      rules: [],
      neverAutoApprove: [],
      protectedPaths: [],
    });
    let asked = false;
    const approval = new ApprovalService({
      permissionModel: model,
      workingDir: dir,
      confirm: async () => {
        asked = true;
        return "allow";
      },
    });
    const res = await approval.checkConfirmation(
      "fs_edit",
      { path: resolve(dir, "docs.md"), content: "示例：rm -rf / 与 shutdown 是危险命令" },
      "auto",
    );
    expect(res.proceed).toBe(true);
    expect(asked).toBe(false);
  });
});