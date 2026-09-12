/**
 * Sprint 48.1：headless 运行器（参数校验 / 三种输出格式 / 退出码 / 非交互 fail-closed）
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHeadlessCli, runHeadless, runHeadlessDetailed } from "../src/core/headless-runner.js";
import type { HeadlessConfig, HeadlessDeps } from "../src/core/headless-runner.js";
import { requestConfirm, setConfirmProvider } from "../src/hooks/confirm-channel.js";
import { requestAsk } from "../src/tools/ask-channel.js";
import type { BaseAgent } from "../src/agents/base-agent.js";
import type { AgentRunResult, StreamCallbacks } from "../src/types.js";

interface FakeRun {
  text?: string;
  truncated?: boolean;
  sessionId?: string;
  throwError?: string;
  toolCall?: { name: string; success: boolean; summary: string };
  askConfirm?: boolean;
  askQuestion?: boolean;
  aborted?: boolean;
}

function fakeAgent(run: FakeRun): BaseAgent {
  const result: AgentRunResult = {
    text: run.text ?? "完成",
    messages: [],
    iterations: 2,
    truncated: run.truncated ?? false,
    toolCallsExecuted: 1,
    sessionId: run.sessionId ?? "s-1",
  };
  return {
    getId: () => "fake",
    setMode: vi.fn(),
    setMaxIterations: vi.fn(),
    runStream: async (_task: unknown, _wd: string, callbacks: StreamCallbacks) => {
      if (run.throwError) throw new Error(run.throwError);
      callbacks.onThinkingDelta?.("思考中");
      if (run.toolCall) {
        callbacks.onToolCall?.(run.toolCall.name, "{}", "c1");
        callbacks.onToolResult?.(run.toolCall.name, run.toolCall.success, run.toolCall.summary, "c1");
      }
      if (run.askConfirm) await requestConfirm("terminal_exec 操作确认", [], "terminal_exec 操作确认");
      if (run.askQuestion) await requestAsk("选哪个？", ["A", "B"]);
      callbacks.onTextDelta?.(run.text ?? "完成");
      return result;
    },
  } as unknown as BaseAgent;
}

function makeDeps(agent: BaseAgent, extra: Partial<HeadlessDeps> = {}): { deps: HeadlessDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: HeadlessDeps = {
    agents: { default: agent, fake: agent },
    model: "test-model",
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    ...extra,
  };
  return { deps, out, err };
}

function makeConfig(overrides: Partial<HeadlessConfig> = {}): HeadlessConfig {
  return {
    prompt: "你好",
    outputFormat: "text",
    allowAll: false,
    mode: "auto",
    workingDir: process.cwd(),
    ...overrides,
  };
}

afterEach(() => {
  setConfirmProvider(null);
});

describe("resolveHeadlessCli（参数校验）", () => {
  it("缺提示词 / 空提示词报错", () => {
    expect(resolveHeadlessCli({}).ok).toBe(false);
    expect(resolveHeadlessCli({ print: "   " }).ok).toBe(false);
  });

  it("输出格式与权限模式白名单", () => {
    expect(resolveHeadlessCli({ print: "hi", outputFormat: "yaml" })).toEqual({
      ok: false,
      error: expect.stringContaining("未知输出格式"),
    });
    expect(resolveHeadlessCli({ print: "hi", mode: "yolo" }).ok).toBe(false);
  });

  it("迭代上限需为正整数", () => {
    expect(resolveHeadlessCli({ print: "hi", maxIterations: "0" }).ok).toBe(false);
    expect(resolveHeadlessCli({ print: "hi", maxIterations: "abc" }).ok).toBe(false);
    const ok = resolveHeadlessCli({ print: "hi", maxIterations: "7" });
    expect(ok.ok && ok.value.maxIterations).toBe(7);
  });

  it("缺省值与前缀空白裁剪", () => {
    const r = resolveHeadlessCli({ print: "  写个测试  ", session: " sess-1 ", agent: " coding ", yes: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      prompt: "写个测试",
      outputFormat: "text",
      sessionId: "sess-1",
      agentId: "coding",
      allowAll: true,
    });
  });
});

describe("runHeadless（输出格式与退出码）", () => {
  it("text：stdout 只留最终回答，工具与思考走 stderr", async () => {
    const agent = fakeAgent({ text: "答案是 2", toolCall: { name: "fs_read", success: true, summary: "ok" } });
    const { deps, out, err } = makeDeps(agent);
    const code = await runHeadless(makeConfig(), deps);
    expect(code).toBe(0);
    expect(out.join("")).toBe("答案是 2\n");
    expect(err.join("")).toContain("[工具] fs_read");
    expect(err.join("")).not.toContain("思考中");
  });

  it("json：stdout 为单行 JSON result，无增量输出", async () => {
    const agent = fakeAgent({ text: "答案是 2" });
    const { deps, out } = makeDeps(agent);
    const code = await runHeadless(makeConfig({ outputFormat: "json" }), deps);
    expect(code).toBe(0);
    const lines = out.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: "result", text: "答案是 2", sessionId: "s-1", iterations: 2, truncated: false });
  });

  it("stream-json：NDJSON 事件序列（system → … → result）", async () => {
    const agent = fakeAgent({ text: "好了", toolCall: { name: "fs_write", success: true, summary: "written" } });
    const { deps, out } = makeDeps(agent);
    const code = await runHeadless(makeConfig({ outputFormat: "stream-json" }), deps);
    expect(code).toBe(0);
    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]!.type).toBe("system");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["system", "thinking", "tool_call", "tool_result", "text", "result"]),
    );
    expect(events[events.length - 1]!.type).toBe("result");
  });

  it("迭代上限耗尽 → 退出码 4", async () => {
    const { deps, err } = makeDeps(fakeAgent({ truncated: true }));
    const code = await runHeadless(makeConfig(), deps);
    expect(code).toBe(4);
    expect(err.join("")).toContain("迭代上限");
  });

  it("运行异常 → 退出码 1", async () => {
    const { deps, err, out } = makeDeps(fakeAgent({ throwError: "连接失败" }));
    const code = await runHeadless(makeConfig({ outputFormat: "json" }), deps);
    expect(code).toBe(1);
    expect(err.join("")).toContain("连接失败");
    const payload = JSON.parse(out.join("").trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: "result", error: "连接失败", text: "" });
  });

  it("agent-loop 折成文本的循环异常 → 退出码 1（不当作成功结果）", async () => {
    const agent = fakeAgent({ text: "Agent 循环异常: Connection error." });
    (agent as unknown as { runStream: unknown }).runStream = async (
      _t: unknown,
      _w: string,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onTextDelta?.("Agent 循环异常: Connection error.");
      return {
        text: "Agent 循环异常: Connection error.",
        messages: [],
        iterations: 1,
        truncated: false,
        toolCallsExecuted: 0,
        sessionId: "s-err",
        error: "Connection error.",
      };
    };
    const { deps, err, out } = makeDeps(agent);
    const code = await runHeadless(makeConfig({ outputFormat: "json" }), deps);
    expect(code).toBe(1);
    expect(err.join("")).toContain("Connection error.");
    const payload = JSON.parse(out.join("").trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ error: "Connection error.", text: "", permissionDenied: false });
  });

  it("智能体不存在 → 退出码 2", async () => {
    const { deps, err } = makeDeps(fakeAgent({}), { agents: {} });
    const code = await runHeadless(makeConfig({ agentId: "nope" }), deps);
    expect(code).toBe(2);
    expect(err.join("")).toContain("智能体不存在");
  });

  it("已中断 → 退出码 130", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = makeDeps(fakeAgent({}), { signal: controller.signal });
    expect(await runHeadless(makeConfig(), deps)).toBe(130);
  });

  it("确认被拒（fail-closed）→ 退出码 3 且不挂起", async () => {
    const { deps, err } = makeDeps(fakeAgent({ askConfirm: true }));
    const outcome = await runHeadlessDetailed(makeConfig(), deps);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.denied).toHaveLength(1);
    expect(err.join("")).toContain("fail-closed");
  });

  it("工具被权限拦截（无确认请求）→ 退出码 3", async () => {
    const agent = fakeAgent({ toolCall: { name: "fs_write", success: false, summary: "操作被拦截: 用户取消操作" } });
    const { deps } = makeDeps(agent);
    expect(await runHeadless(makeConfig(), deps)).toBe(3);
  });

  it("ask_user 在 headless 下立即失败而非等待输入", async () => {
    const agent = fakeAgent({ askQuestion: true });
    const { deps, err, out } = makeDeps(agent, {});
    const code = await runHeadless(makeConfig({ outputFormat: "stream-json" }), deps);
    expect(code).toBe(0);
    expect(out.join("")).toContain("ask_unavailable");
    expect(err.join("")).toContain("无法回答提问");
  });

  it("运行结束后恢复原确认通道", async () => {
    const sentinel = async (): Promise<string> => "allow";
    setConfirmProvider(sentinel);
    const { deps } = makeDeps(fakeAgent({}));
    await runHeadless(makeConfig(), deps);
    expect(await requestConfirm("x")).toBe("allow");
  });

  it("--max-iterations 覆盖生效", async () => {
    const agent = fakeAgent({});
    const { deps } = makeDeps(agent);
    await runHeadless(makeConfig({ maxIterations: 9 }), deps);
    expect((agent as unknown as { setMaxIterations: ReturnType<typeof vi.fn> }).setMaxIterations).toHaveBeenCalledWith(9);
  });
});
