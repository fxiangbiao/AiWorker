/**
 * 后台任务兼容层测试（Sprint 52 统一）
 * 覆盖：jobRunner → subagentRunner 转发 / 状态 idle↔done 映射 / cancel 即中断 / job/done 广播 / 后台无交互通道
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { JobRunner } from "../src/core/job-runner.js";
import { subagentRunner } from "../src/core/subagent-runner.js";
import { eventBus } from "../src/server/event-bus.js";
import type { BaseAgent } from "../src/agents/base-agent.js";
import type { Task, StreamCallbacks } from "../src/types.js";

const dir = makeTestDir("job-runner");

function makeAgent(behavior: "ok" | "throw" | "truncated" | "hangFirst" = "ok") {
  let calls = 0;
  const agent = {
    runStream: async (_task: Task, _wd: string, callbacks: StreamCallbacks, signal?: AbortSignal) => {
      calls++;
      callbacks.onTextDelta?.("后台结果摘要");
      if (behavior === "throw") throw new Error("模拟失败");
      if (behavior === "hangFirst" && calls === 1) {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return {
        text: behavior === "truncated" ? "" : "后台结果摘要",
        truncated: behavior === "truncated",
        iterations: 1,
        toolCallsExecuted: 0,
        messages: [],
      };
    },
    getConfig: () => ({
      tools: ["fs_read", "fs_write", "terminal_exec", "web_search"],
      mcpServers: [],
      skills: [],
      plugins: [],
      permissions: { defaultMode: "auto", allowedTools: ["*"], deniedTools: [] },
    }),
    fork: () => agent,
  };
  return agent as unknown as BaseAgent;
}

describe("21. JobRunner 后台任务（统一到 subagentRunner 后的兼容层）", () => {
  let store: SessionStore;
  let runner: JobRunner;

  beforeEach(() => {
    setupEnv(dir);
    store = new SessionStore(resolve(dir, "jobs.db"));
    subagentRunner.clear();
    subagentRunner.init({
      createAgent: () => makeAgent(),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    runner = new JobRunner();
  });

  afterEach(() => {
    subagentRunner.clear();
    store.close();
    teardownEnv();
  });

  function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (pred()) return resolve();
        if (Date.now() - start > ms) return reject(new Error("timeout"));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it("submit → 子智能体 id，idle 映射为 done，结果写 wk- 会话", async () => {
    const id = runner.submit("default", "后台任务A");
    expect(id).toMatch(/^sub-/);
    expect(runner.isInitialized()).toBe(true);
    await waitFor(() => runner.get(id)!.status === "done");
    const job = runner.get(id)!;
    expect(job.prompt).toBe("后台任务A");
    expect(job.summary).toContain("后台结果摘要");
    expect(job.sessionId).toMatch(/^wk-/);
    expect(job.interrupted).toBe(false);
  });

  it("list 反映同一批对象；失败任务映射 error", async () => {
    const bad = new JobRunner();
    subagentRunner.clear();
    subagentRunner.init({
      createAgent: () => makeAgent("throw"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = bad.submit("default", "会失败");
    await waitFor(() => bad.get(id)!.status === "failed");
    expect(bad.get(id)!.error).toContain("模拟失败");
    expect(bad.list().map((j) => j.id)).toContain(id);
    expect(bad.get("no-such")).toBeUndefined();
  });

  it("cancel 即中断：运行中也能中断，且会话保留可续接", async () => {
    subagentRunner.clear();
    // runner 每轮都会 createAgent()，续接用例必须复用同一实例（首轮挂住的计数在实例上）
    const agent = makeAgent("hangFirst");
    subagentRunner.init({
      createAgent: () => agent,
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = runner.submit("default", "长任务");
    await waitFor(() => subagentRunner.get(id)!.status === "running");
    expect(runner.cancel(id)).toBe(true);
    await waitFor(() => subagentRunner.get(id)!.status === "idle");
    expect(runner.get(id)!.status).toBe("done");
    // 被中断 ≠ 自然完成：兼容视图要能区分（否则 /jobs、Web 任务面板会显示成"完成"）
    expect(runner.get(id)!.interrupted).toBe(true);
    expect(subagentRunner.get(id)!.pending).toHaveLength(0);
    expect(subagentRunner.send(id, "继续")).toBe(true);
    await waitFor(() => subagentRunner.get(id)!.rounds >= 1);
    expect(runner.cancel("no-such")).toBe(false);
  });

  it("完成后广播 job/done 事件（兼容事件带 resumable）", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = eventBus.subscribe((d) => {
      if ((d as { type?: string }).type === "job/done") events.push(d as Record<string, unknown>);
    });
    const id = runner.submit("default", "广播任务");
    await waitFor(() => runner.get(id)!.status === "done");
    unsub();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.jobId).toBe(id);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.resumable).toBe(true);
  });

  it("后台运行期间确认/提问立即被拒（不落到 stdin 交互提示），结束后恢复", async () => {
    const { requestConfirm, setConfirmProvider } = await import("../src/hooks/confirm-channel.js");
    const { requestAsk, setAskProvider } = await import("../src/tools/ask-channel.js");

    const restoreConfirm = setConfirmProvider(async () => "allow");
    const restoreAsk = setAskProvider(async () => "x");
    let confirmAnswer: string | null | undefined;
    let askAnswer: string | null | undefined;

    const probing = {
      runStream: async () => {
        confirmAnswer = await requestConfirm("危险操作？", [
          { value: "allow", label: "允许" },
          { value: "deny", label: "拒绝" },
        ]);
        askAnswer = await requestAsk({ question: "q", options: [], multiple: false });
        return { text: "ok", truncated: false, iterations: 1, toolCallsExecuted: 0, messages: [] };
      },
      getConfig: () => ({
        tools: [],
        mcpServers: [],
        skills: [],
        plugins: [],
        permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
      }),
      fork: () => probing,
    } as unknown as BaseAgent;

    subagentRunner.clear();
    subagentRunner.init({
      createAgent: () => probing,
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = runner.submit("default", "需确认的任务");
    await waitFor(() => runner.get(id)!.status === "done");
    expect(confirmAnswer).toBeNull();
    expect(askAnswer).toBeNull();

    expect(await requestConfirm("恢复了吗？", [{ value: "allow", label: "允许" }])).toBe("allow");
    setConfirmProvider(restoreConfirm);
    setAskProvider(restoreAsk);
  });

  it("超配额时抛错而非排队（旧 jobRunner 行为变更的显式断言）", () => {
    subagentRunner.clear();
    subagentRunner.init({
      createAgent: () => makeAgent(),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxPerParent: 1,
    });
    runner.submit("default", "第一个", { parentSessionId: "p-1" });
    expect(() => runner.submit("default", "第二个", { parentSessionId: "p-1" })).toThrow(/上限/);
  });
});
