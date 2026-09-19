/**
 * Sprint 52 / T0 诊断探针（D2 / D3 / D4 / D5）+ T0.5 修复验证
 * 结论见 plans/sprint-52-diagnosis.md；本文件保证结论可重跑
 *
 * T0 时本文件钉住的是**修复前**行为：D2-c（中断不杀工具）、D3-a（当前用户消息注入两次）、
 * D4-b（重启后 pendingTurn 错位）三项都是既有缺陷。T0.5 已修复后者两项，对应断言已改为
 * **修复后**期望值（D3-a / D4-b），并新增「T0.5 修复验证」一节钉住修复后的行为与反例。
 * D2-c 属于本 Sprint 的显式工作量（工具级真中断），仍钉住现状。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { ContextManager } from "../src/core/context-manager.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import { runAgentLoopStream } from "../src/core/agent-loop.js";
import { processManager } from "../src/core/process-manager.js";
import { terminalSessionPool } from "../src/tools/terminal-session.js";
import { CheckpointStore } from "../src/core/checkpoint-store.js";
import { RewindService } from "../src/core/rewind-service.js";
import { createCaptureDiff, createTurnLogger } from "../src/hooks/handlers.js";
import { pendingTurn, resetTurns, setCompletedTurnsResolver } from "../src/hooks/turn-registry.js";
import { BaseAgent } from "../src/agents/base-agent.js";
import { TelemetryCoordinator, readTelemetryFile } from "../src/memory/telemetry.js";
import type {
  AgentConfig,
  Message,
  SessionEvent,
  StreamChunk,
  ToolContext,
  ToolDefinition,
} from "../src/types.js";

/** OpenAI SDK mock：D5 用真实 ModelRouter 但不出网（复用 llm-adapter.test.ts 的做法） */
const h = vi.hoisted(() => ({
  mockCreate: undefined as undefined | ((params: unknown, options?: unknown) => unknown),
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    constructor(public config: unknown) {}
    chat = {
      completions: {
        create: (params: unknown, options?: unknown) => {
          if (!h.mockCreate) throw new Error("mockCreate not configured");
          return h.mockCreate(params, options);
        },
      },
    };
  },
}));

import { ModelRouter } from "../src/core/model-router.js";

let dir: string;
let store: SessionStore;
let ctxMgr: ContextManager;

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeConfig(): AgentConfig {
  return {
    id: "probe",
    name: "probe",
    displayName: "Probe",
    type: "probe",
    systemPrompt: "你是探针。",
    modelPreference: "default",
    maxIterations: 10,
    sandbox: false,
    tools: [],
    mcpServers: [],
    permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
  };
}

function def(name: string): ToolDefinition {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

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
  dir = makeTestDir("sprint-52-diagnosis");
  setupEnv(dir);
  store = new SessionStore(resolve(dir, "aiworker.db"));
  ctxMgr = new ContextManager(store, dir);
  resetTurns();
  h.mockCreate = undefined;
});

afterEach(() => {
  setCompletedTurnsResolver(null);
  store.close();
  teardownEnv();
  clearTools();
  terminalSessionPool.clear();
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
    await sleep(2600 - elapsed);
    expect(existsSync(doneFile)).toBe(false);
    expect(processManager.list().length).toBe(procsBefore);
  });

  it("D2-d terminal_session 池按 sessionId 可回收；terminal_exec 完全不使用池", async () => {
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
      workingDir: dir,
      permissions: "auto",
      dataDir: dir,
    };
    const res = await handler!({ command: "echo pool-probe", timeout: 20000 }, ctx);
    expect(res.success).toBe(true);
    expect(terminalSessionPool.get(sid)).toBeUndefined();
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

// ── D4：检查点归属 ──

describe("D4 检查点归属（父会话 /rewind 与子会话改动）", () => {
  it("D4-a 子会话写入只进子会话检查点，父 /rewind 看不见；turn 号来自进程内计数器", async () => {
    const projDir = resolve(dir, "proj");
    mkdirSync(projDir, { recursive: true });
    const cps = new CheckpointStore(dir);
    const parentSid = store.createSession("probe").id;
    const childSid = store.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore: store, checkpointStore: cps });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: dir,
      checkpointStore: cps,
      scanThrottleMs: 0,
    });

    // 真实钩子路径：父会话与子会话各自触发 onMessage
    await turnLogger({
      event: "onMessage",
      agentId: "probe",
      sessionId: parentSid,
      data: { instruction: "父问题" },
    });
    await turnLogger({
      event: "onMessage",
      agentId: "probe",
      sessionId: childSid,
      data: { instruction: "子任务" },
    });

    expect(cps.getManifest(parentSid, 1)?.userInput).toBe("父问题");
    expect(cps.getManifest(parentSid, 1)?.messageSeqBefore).toBe(1);
    // 两个会话各自从 turn-1 开始 → 计数器按会话独立，与 getLastMessageSeq 无关
    expect(cps.getManifest(childSid, 1)?.userInput).toBe("子任务");

    const write = async (sessionId: string, file: string, content: string) => {
      const args = JSON.stringify({ path: file, content });
      await capture({ event: "onToolCallPre", agentId: "probe", sessionId, data: { toolName: "fs_write", args } });
      writeFileSync(file, content);
      await capture({
        event: "onToolCallPost",
        agentId: "probe",
        sessionId,
        data: { toolName: "fs_write", args, result: { success: true, content: "写入完成" } },
      });
    };

    const parentFile = resolve(projDir, "parent.txt");
    const childFile = resolve(projDir, "child.txt");
    await write(parentSid, parentFile, "P");
    await write(childSid, childFile, "C");

    const preview = new RewindService({ sessionStore: store, checkpointStore: cps }).preview(
      parentSid,
      1,
      "all",
    );
    const paths = preview.files.map((f) => f.path);
    expect(paths).toContain(parentFile);
    expect(paths).not.toContain(childFile);
    expect(cps.getManifest(childSid, 1)!.files.map((f) => f.path)).toEqual([childFile]);
  });

  it("D4-b 进程重启后 pendingTurn 从已提交回合回填：新回合落到 turn-N+1，不并入旧 manifest（T0.5 修复后）", async () => {
    const projDir = resolve(dir, "proj2");
    mkdirSync(projDir, { recursive: true });
    const cps = new CheckpointStore(dir);
    const sid = store.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore: store, checkpointStore: cps });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: dir,
      checkpointStore: cps,
      scanThrottleMs: 0,
    });

    // 第 1 回合（真实顺序：onMessage → 落库 user → 工具写入 → onTaskComplete 提交）
    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "老问题" } });
    store.appendMessage(sid, { role: "user", content: "老问题" });
    const first = resolve(projDir, "first.txt");
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: first }) },
    });
    await turnLogger({
      event: "onTaskComplete",
      agentId: "probe",
      sessionId: sid,
      data: { messages: [], truncated: false, toolCallsExecuted: 1, iterations: 1 },
    });
    // 「已提交回合」的真源：turn_logs.seq（onTaskComplete 与 commitTurn 同批写入）
    expect(store.getTurnLogs(sid).map((t) => t.seq)).toEqual([1]);

    // 与 bootstrap 一致的回填接线（生产在 bootstrap 注入；测试里按同一口径接线）
    setCompletedTurnsResolver((sessionId) => store.getLastTurnSeq(sessionId));

    resetTurns(sid); // 模拟进程重启：内存计数清空，DB 保留

    // 修复后：pendingTurn 从已提交回合回填 → 2（修复前恒为 1，新回合会并入旧 turn-1）
    expect(pendingTurn(sid)).toBe(2);

    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "重启后的问题" } });
    store.appendMessage(sid, { role: "user", content: "重启后的问题" });
    const second = resolve(projDir, "second.txt");
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: second }) },
    });

    expect(cps.listTurns(sid).map((m) => m.turn)).toEqual([1, 2]);
    const oldTurn = cps.getManifest(sid, 1)!;
    expect(oldTurn.userInput).toBe("老问题");
    expect(oldTurn.files.map((f) => f.path)).toEqual([first]);
    const newTurn = cps.getManifest(sid, 2)!;
    expect(newTurn.userInput).toBe("重启后的问题");
    expect(newTurn.files.map((f) => f.path)).toEqual([second]);
    // 元数据是新回合的值，不是旧回合的（messageSeqBefore: turn1=1, turn2=2）
    expect(oldTurn.messageSeqBefore).toBe(1);
    expect(newTurn.messageSeqBefore).toBe(2);
  });
});

// ── D5：usage 聚合 ──

describe("D5 usage 聚合", () => {
  it("D5-a 全局计数含子会话、会话账本按 scope 隔离，父会话/按 agent 的聚合入口不存在", async () => {
    const cfgPath = resolve(dir, "models.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: {
          provider: "deepseek",
          model: "m1",
          baseURL: "https://t.local/v1",
          apiKey: "sk-1",
          temperature: 0.5,
          maxTokens: 4096,
          adapter: "openai-compatible",
        },
        profiles: { coding: { temperature: 0.2 } },
        routing: { strategy: "profile-based", fallback: "default" },
      }),
    );
    const router = new ModelRouter(cfgPath);
    const ok = (p: number, c: number) => ({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
    });

    h.mockCreate = vi.fn().mockResolvedValue(ok(10, 5));
    await router.completeWithProfile("default", [{ role: "user", content: "父问题" }], undefined, {
      scope: "probe-parent",
    });
    h.mockCreate = vi.fn().mockResolvedValue(ok(7, 3));
    await router.completeWithProfile("default", [{ role: "user", content: "子任务" }], undefined, {
      scope: "wk-probe-child",
    });

    expect(router.getTokenUsage()).toBe(25);
    expect(router.getSessionTokens("probe-parent")).toEqual({ prompt: 10, completion: 5 });
    expect(router.getSessionTokens("wk-probe-child")).toEqual({ prompt: 7, completion: 3 });
    expect(
      (router as unknown as Record<string, unknown>).getParentTokens,
    ).toBeUndefined();
  });

  it("D5-b TurnLog 有 agent_id 但只按 session 查；getRecentTurnLogs 不是跨会话聚合；遥测按会话分文件", async () => {
    const parentSid = store.createSession("probe").id;
    const childSid = store.createSession("probe").id;
    const base = {
      seq: 1,
      iterations: 1,
      toolCallsTotal: 0,
      toolCallsSuccess: 0,
      toolCallsFailed: 0,
      finishReason: "stop",
    };
    store.createTurnLog({
      ...base,
      id: "tl-parent",
      sessionId: parentSid,
      agentId: "default",
      userInput: "父问题",
      startedAt: 1000,
      finishedAt: 1100,
      tokensPrompt: 100,
      tokensCompletion: 50,
    });
    store.createTurnLog({
      ...base,
      id: "tl-child",
      sessionId: childSid,
      agentId: "researcher",
      userInput: "子任务",
      startedAt: 2000,
      finishedAt: 2100,
      tokensPrompt: 7,
      tokensCompletion: 3,
    });

    expect(store.getTurnLogs(parentSid).map((t) => t.tokensPrompt)).toEqual([100]);
    expect(store.getTurnLogs(childSid).map((t) => t.tokensPrompt)).toEqual([7]);
    // 名字像"最近的跨会话轮次"，实际只返回 started_at 最新的那一个会话
    expect(store.getRecentTurnLogs(50).map((t) => t.sessionId)).toEqual([childSid]);
    expect((store as unknown as Record<string, unknown>).getTurnLogsByAgent).toBeUndefined();

    const telemetry = new TelemetryCoordinator(dir);
    const ev: SessionEvent = {
      seq: 1,
      sessionId: childSid,
      type: "assistant/message",
      data: { message: { role: "assistant", content: "子回答" }, usage },
      createdAt: Date.now(),
    };
    await telemetry.capture(childSid, [ev]);
    await telemetry.shutdown();
    expect(readTelemetryFile(dir, childSid)).toHaveLength(1);
    expect(readTelemetryFile(dir, parentSid)).toHaveLength(0);
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

describe("T0.5 缺陷② 重启后回合号从已提交回合回填", () => {
  it("未注入解析器时行为与修复前完全一致：重启后 pendingTurn 回到 1（无回填）", async () => {
    const cps = new CheckpointStore(dir);
    const sid = store.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore: store, checkpointStore: cps });

    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "Q1" } });
    store.appendMessage(sid, { role: "user", content: "Q1" });
    await turnLogger({
      event: "onTaskComplete",
      agentId: "probe",
      sessionId: sid,
      data: { messages: [], truncated: false, toolCallsExecuted: 0, iterations: 1 },
    });
    expect(store.getLastTurnSeq(sid)).toBe(1);

    resetTurns(sid);
    expect(pendingTurn(sid)).toBe(1);
  });

  it("解析器抛错时不把异常抛给工具调用路径（按无回填处理）", () => {
    setCompletedTurnsResolver(() => {
      throw new Error("模拟 DB 不可读");
    });
    expect(() => pendingTurn("sess-resolver-throw")).not.toThrow();
    expect(pendingTurn("sess-resolver-throw")).toBe(1);
  });

  it("口径实测：回合已开始未提交 → manifest 已建而 turn_logs 为空；用 turn_logs 回填不跳号", async () => {
    const projDir = resolve(dir, "proj3");
    mkdirSync(projDir, { recursive: true });
    const cps = new CheckpointStore(dir);
    const sid = store.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore: store, checkpointStore: cps });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: dir,
      checkpointStore: cps,
      scanThrottleMs: 0,
    });

    // 回合开始（beginTurn 建 manifest）→ 写了文件 → **未提交**（没有 onTaskComplete）
    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "未提交的问题" } });
    store.appendMessage(sid, { role: "user", content: "未提交的问题" });
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: resolve(projDir, "orphan.txt") }) },
    });

    // 两个候选数据源在此分叉：manifest 口径 = 1，turn_logs 口径 = 0
    expect(cps.listTurns(sid).map((m) => m.turn)).toEqual([1]);
    expect(store.getLastTurnSeq(sid)).toBe(0);

    setCompletedTurnsResolver((sessionId) => store.getLastTurnSeq(sessionId));
    resetTurns(sid);
    // 选 turn_logs：异常回合的号被复用（不跳号、不把号推高）
    expect(pendingTurn(sid)).toBe(1);
  });
});

// ── Q6 探针：Windows 进程树杀法实测 ──

describe("Q6 工具级中断探针", () => {
  it("Q6-a exec+signal 对孙进程的杀伤力不可靠（平台/Node版本相关）", async () => {
    // 此探针记录 exec+signal 对 detached 孙进程的实际行为。
    // 结果因平台/Node版本而异：有些环境杀整棵树，有些只杀直接子进程。
    // 无论结果如何，都证明"不能依赖 exec+signal 做可靠的进程树杀法"。
    const marker = resolve(dir, `grandchild-marker-${Date.now()}.txt`);
    const midScript = resolve(dir, "mid-process.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(midScript, `
      const { spawn } = require("child_process");
      const child = spawn("node", ["-e", "setTimeout(()=>{require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','alive')},3000)"], { detached: true, stdio: "ignore" });
      child.unref();
      setTimeout(() => {}, 10000);
    `);

    const parentCmd = process.platform === "win32"
      ? `chcp 65001 >nul & node "${midScript}"`
      : `node "${midScript}"`;

    const { exec } = await import("node:child_process");
    const controller = new AbortController();
    const child = exec(parentCmd, { signal: controller.signal, timeout: 20000 });

    await sleep(1000);
    controller.abort();
    await sleep(4000);

    const { existsSync, unlinkSync } = await import("node:fs");
    const grandchildSurvived = existsSync(marker);

    try { if (existsSync(marker)) unlinkSync(marker); } catch {}
    try { unlinkSync(midScript); } catch {}
    try { child.kill(); } catch {}

    // 仅记录行为，不做 pass/fail 断言——结果因环境而异
    console.log(`[Q6-a] exec+signal 后孙进程${grandchildSurvived ? "存活" : "被杀"}（${process.platform} ${process.version}）`);
    // 但无论如何，这证明了需要显式的进程树杀法（见 Q6-b）
    expect(typeof grandchildSurvived).toBe("boolean");
  }, 15000);

  it.skipIf(process.platform !== "win32")("Q6-b Windows taskkill /T /F 能杀孙进程", async () => {
    const marker = resolve(dir, `taskkill-marker-${Date.now()}.txt`);
    const midScript = resolve(dir, "mid-taskkill.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(midScript, `
      const { spawn } = require("child_process");
      const child = spawn("node", ["-e", "setTimeout(()=>{require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','alive')},3000)"], { detached: true, stdio: "ignore" });
      child.unref();
      setTimeout(() => {}, 10000);
    `);

    const parentCmd = `chcp 65001 >nul & node "${midScript}"`;

    const { exec, execSync } = await import("node:child_process");
    const child = exec(parentCmd, { timeout: 20000 });

    await sleep(1000);

    try {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } catch {}

    await sleep(4000);

    const { existsSync, unlinkSync } = await import("node:fs");
    const grandchildSurvived = existsSync(marker);

    try { if (existsSync(marker)) unlinkSync(marker); } catch {}
    try { unlinkSync(midScript); } catch {}
    try { child.kill(); } catch {}

    // taskkill /T /F 应杀掉整棵树包括 detached 孙进程
    expect(grandchildSurvived).toBe(false);
  }, 15000);
});
