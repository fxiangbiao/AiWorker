/**
 * 子智能体运行器测试（Sprint 52 T1a）
 * 覆盖：spawn/send/interrupt/list/状态机/pending上限/确认通道作用域/并发配额
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { SubagentRunner } from "../src/core/subagent-runner.js";
import { eventBus } from "../src/server/event-bus.js";
import type { BaseAgent } from "../src/agents/base-agent.js";
import type { Task, StreamCallbacks } from "../src/types.js";

const dir = makeTestDir("subagent-runner");

function makeAgent(behavior: "ok" | "slow" | "abortable" | "throw" | "truncated" = "ok", delayMs = 0) {
  const agent = {
    runStream: async (task: Task, _wd: string, callbacks: StreamCallbacks, signal?: AbortSignal) => {
      if (behavior === "abortable") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs || 5000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
          if (signal?.aborted) { clearTimeout(timer); reject(new Error("aborted")); }
        });
      }
      callbacks.onTextDelta?.("子智能体结果");
      if (behavior === "slow") return new Promise(() => {});
      if (behavior === "throw") throw new Error("模拟失败");
      return {
        text: behavior === "truncated" ? "" : "子智能体结果",
        truncated: behavior === "truncated",
        iterations: 1,
        toolCallsExecuted: 0,
        messages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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

describe("Sprint 52 SubagentRunner", () => {
  let store: SessionStore;
  let runner: SubagentRunner;

  beforeEach(() => {
    setupEnv(dir);
    store = new SessionStore(resolve(dir, "sub.db"));
    runner = new SubagentRunner();
    runner.init({
      createAgent: () => makeAgent(),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
  });

  afterEach(() => {
    runner.clear();
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

  it("spawn → running → idle，会话以 wk- 前缀创建", async () => {
    const id = runner.spawn("default", "测试任务", { parentSessionId: "parent-1" });
    expect(id).toMatch(/^sub-/);
    const h = runner.get(id)!;
    expect(h.sessionId).toMatch(/^wk-/);
    expect(h.parentSessionId).toBe("parent-1");
    await waitFor(() => runner.get(id)!.status === "idle");
    expect(runner.get(id)!.rounds).toBe(1);
  });

  it("spawn 广播 subagent/spawned 事件（T6b：Web 面板据此即时刷新）", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsub = eventBus.subscribe((d) => {
      if ((d as { type?: string }).type === "subagent/spawned") events.push(d as Record<string, unknown>);
    });
    const id = runner.spawn("default", "广播任务", { parentSessionId: "parent-1", readOnly: true });
    unsub();
    expect(events).toHaveLength(1);
    expect(events[0]!.subagentId).toBe(id);
    expect(events[0]!.agentId).toBe("default");
    expect(events[0]!.status).toBe("queued");
    expect(events[0]!.readOnly).toBe(true);
    expect(events[0]!.parentSessionId).toBe("parent-1");
    await waitFor(() => runner.get(id)!.status === "idle");
  });

  it("子代 fork 恒关掉 subagents 开关（深度 1 不依赖子智能体自身 YAML）", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const child = {
      runStream: async () => ({ text: "ok", truncated: false, iterations: 1, toolCallsExecuted: 0, messages: [] }),
      getConfig: () => ({
        tools: ["fs_read", "spawn_agent", "send_message"],
        mcpServers: [],
        skills: [],
        plugins: [],
        subagents: true,
        permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
      }),
      fork: (p: Record<string, unknown>) => {
        patches.push(p);
        return child;
      },
    } as unknown as BaseAgent;
    const mk = new SubagentRunner();
    mk.init({ createAgent: () => child, workingDir: dir, sessionStore: store, getMode: () => "auto" });

    const writable = mk.spawn("default", "可写子代", { readOnly: false });
    await waitFor(() => mk.get(writable)?.status === "idle");
    expect(patches[0]!.subagents).toBe(false);
    expect(patches[0]!.tools).not.toContain("spawn_agent");

    const readOnly = mk.spawn("default", "只读子代", { readOnly: true });
    await waitFor(() => mk.get(readOnly)?.status === "idle");
    expect(patches[1]!.subagents).toBe(false);
    expect(patches[1]!.readOnly).toBe(true);
    expect(patches[1]!.tools).toEqual(["fs_read"]);

    mk.clear();
  });

  it("send 到 idle 子智能体起新轮", async () => {
    const id = runner.spawn("default", "首轮");
    await waitFor(() => runner.get(id)?.status === "idle");
    const ok = runner.send(id, "第二轮追问");
    expect(ok).toBe(true);
    await waitFor(() => (runner.get(id)?.rounds ?? 0) >= 2);
  });

  it("pending 上限 MAX_PENDING=5，第六条返回 false", async () => {
    const slow = new SubagentRunner();
    slow.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = slow.spawn("default", "慢任务");
    await waitFor(() => slow.get(id)!.status === "running");
    for (let i = 0; i < 5; i++) {
      expect(slow.send(id, `msg-${i}`)).toBe(true);
    }
    expect(slow.send(id, "overflow")).toBe(false);
    slow.clear();
  });

  it("queued 状态同样受 MAX_PENDING 约束（新入口不再无界堆积）", async () => {
    const mk = new SubagentRunner();
    mk.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxConcurrent: 1,
      maxPending: 2,
    });
    const running = mk.spawn("default", "占用并发槽位");
    await waitFor(() => mk.get(running)!.status === "running");
    const queued = mk.spawn("default", "排队任务"); // pending 里已有初始任务
    expect(mk.get(queued)!.status).toBe("queued");
    expect(mk.send(queued, "第二条")).toBe(true);
    expect(mk.send(queued, "第三条")).toBe(false);
    mk.clear();
  });

  it("interrupt running → idle，pending 清空", async () => {
    const slow = new SubagentRunner();
    slow.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = slow.spawn("default", "可中断");
    await waitFor(() => slow.get(id)!.status === "running");
    slow.send(id, "pending-1");
    slow.send(id, "pending-2");
    expect(slow.get(id)!.pending.length).toBe(2);
    const ok = slow.interrupt(id);
    expect(ok).toBe(true);
    expect(slow.get(id)!.abortRequested).toBe(true);
    expect(slow.get(id)!.pending.length).toBe(0);
    slow.clear();
  });

  it("interrupt queued → idle 立即生效", () => {
    const busy = new SubagentRunner();
    busy.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxConcurrent: 1,
    });
    busy.spawn("default", "占位");
    const id2 = busy.spawn("default", "排队中");
    expect(busy.get(id2)!.status).toBe("queued");
    const ok = busy.interrupt(id2);
    expect(ok).toBe(true);
    expect(busy.get(id2)!.status).toBe("idle");
    busy.clear();
  });

  it("全局配额超限抛错", () => {
    const limited = new SubagentRunner();
    limited.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxGlobal: 2,
      maxConcurrent: 2,
    });
    limited.spawn("default", "a");
    limited.spawn("default", "b");
    expect(() => limited.spawn("default", "c")).toThrow(/上限/);
    limited.clear();
  });

  it("每父会话配额超限抛错", () => {
    const limited = new SubagentRunner();
    limited.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxPerParent: 2,
      maxConcurrent: 4,
    });
    limited.spawn("default", "a", { parentSessionId: "p1" });
    limited.spawn("default", "b", { parentSessionId: "p1" });
    expect(() => limited.spawn("default", "c", { parentSessionId: "p1" })).toThrow(/上限/);
    limited.spawn("default", "d", { parentSessionId: "p2" });
    limited.clear();
  });

  it("list 按父会话过滤", async () => {
    runner.spawn("default", "a", { parentSessionId: "p1" });
    runner.spawn("default", "b", { parentSessionId: "p2" });
    runner.spawn("default", "c", { parentSessionId: "p1" });
    const p1List = runner.list("p1");
    expect(p1List.length).toBe(2);
    const all = runner.list();
    expect(all.length).toBe(3);
  });

  it("failed 子智能体 send 返回 false", async () => {
    const failRunner = new SubagentRunner();
    failRunner.init({
      createAgent: () => makeAgent("throw"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = failRunner.spawn("default", "会失败");
    await waitFor(() => failRunner.get(id)!.status === "failed");
    expect(failRunner.send(id, "续接")).toBe(false);
    failRunner.clear();
  });

  it("usage 累加", async () => {
    const id = runner.spawn("default", "首轮");
    await waitFor(() => runner.get(id)!.status === "idle");
    expect(runner.get(id)!.usage.prompt).toBeGreaterThanOrEqual(10);
    expect(runner.get(id)!.usage.completion).toBeGreaterThanOrEqual(5);
  });

  it("T7：spawn 时登记归属（childSessionId → parentSessionId + parentTurnAtSpawn）", async () => {
    const { getOwner, clearRegistry } = await import("../src/core/subagent-ownership.js");
    clearRegistry();
    const id = runner.spawn("default", "任务", { parentSessionId: "parent-own" });
    const childSessionId = runner.get(id)!.sessionId;
    const rec = getOwner(childSessionId);
    expect(rec).toBeTruthy();
    expect(rec!.parentSessionId).toBe("parent-own");
    expect(rec!.parentTurnAtSpawn).toBeGreaterThanOrEqual(1);
  });

  it("T7：父会话删除时中断子智能体并清理归属", async () => {
    const { getOwner, clearRegistry } = await import("../src/core/subagent-ownership.js");
    clearRegistry();
    const id = runner.spawn("default", "任务", { parentSessionId: "parent-del" });
    const childSessionId = runner.get(id)!.sessionId;
    expect(getOwner(childSessionId)).toBeTruthy();
    const removed = runner.interruptByParent("parent-del");
    expect(removed).toBe(1);
    expect(runner.get(id)).toBeUndefined();
    expect(getOwner(childSessionId)).toBeUndefined();
  });

  it("readOnly 默认 true，显式 false 才可写", () => {
    const ro = runner.get(runner.spawn("default", "只读"))!;
    expect(ro.readOnly).toBe(true);
    const rw = runner.get(runner.spawn("default", "可写", { readOnly: false }))!;
    expect(rw.readOnly).toBe(false);
  });

  it("F3 回归：配额只计 queued/running —— 4 次成功 spawn 变 idle 后第 5 次仍可 spawn", async () => {
    const limited = new SubagentRunner();
    limited.init({
      createAgent: () => makeAgent(),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxPerParent: 4,
      maxConcurrent: 4,
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(limited.spawn("default", `任务${i}`, { parentSessionId: "p-quota" }));
    }
    await waitFor(() => ids.every((id) => limited.get(id)?.status === "idle"));
    // 全部 idle 后不再占额：第 5 次必须成功（此前会永久报"上限 4 已达"）
    const fifth = limited.spawn("default", "第5次", { parentSessionId: "p-quota" });
    expect(limited.get(fifth)).toBeTruthy();
    limited.clear();
  });

  it("F3 回归：close() 可显式释放槽位", async () => {
    const limited = new SubagentRunner();
    limited.init({
      createAgent: () => makeAgent("slow"),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      maxGlobal: 2,
      maxConcurrent: 2,
    });
    const a = limited.spawn("default", "a");
    limited.spawn("default", "b");
    expect(() => limited.spawn("default", "c")).toThrow(/上限/);
    expect(limited.close(a)).toBe(true);
    expect(limited.close("no-such")).toBe(false);
    expect(() => limited.spawn("default", "c")).not.toThrow();
    limited.clear();
  });

  it("F14 回归：interrupt running 后 run 循环真的退出，状态落到 idle", async () => {
    const mk = new SubagentRunner();
    mk.init({
      createAgent: () => makeAgent("abortable", 5000),
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
    });
    const id = mk.spawn("default", "可中断的慢任务");
    await waitFor(() => mk.get(id)?.status === "running");
    expect(mk.interrupt(id)).toBe(true);
    // 不断言 flag，断言循环真的退出（此前中断静默失效也测不出来）
    await waitFor(() => mk.get(id)?.status === "idle", 3000);
    expect(mk.get(id)!.abortRequested).toBe(true);
    expect(mk.get(id)!.pending).toEqual([]);
    mk.clear();
  });

  it("F12 回归：interrupt 之后到达的 send 不会被静默搁置", async () => {
    const seen: string[] = [];
    const agent = {
      runStream: async (task: Task, _wd: string, _cb: StreamCallbacks, signal?: AbortSignal) => {
        seen.push(task.instruction);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 3000);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
        return { text: "ok", truncated: false, iterations: 1, toolCallsExecuted: 0, messages: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      getConfig: () => ({ tools: [], mcpServers: [], skills: [], plugins: [], permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] } }),
      fork: () => agent,
    } as unknown as BaseAgent;

    const mk = new SubagentRunner();
    mk.init({ createAgent: () => agent, workingDir: dir, sessionStore: store, getMode: () => "auto" });
    const id = mk.spawn("default", "首轮");
    await waitFor(() => mk.get(id)?.status === "running");
    mk.interrupt(id);
    // 中断窗口内追发：必须最终被真正执行（而非停在 pending 等下一次 send）
    expect(mk.send(id, "中断后的新工作")).toBe(true);
    await waitFor(() => seen.includes("中断后的新工作"), 8000);
    expect(mk.get(id)!.pending).toEqual([]);
    mk.clear();
  }, 15000);

  it("F11 回归：看门狗超时强制终止并释放并发槽位（不替换全局确认通道）", async () => {
    const { requestConfirm, setConfirmProvider } = await import("../src/hooks/confirm-channel.js");
    const restore = setConfirmProvider(async () => "allow");
    const hung = {
      runStream: () => new Promise(() => {}),
      getConfig: () => ({ tools: [], mcpServers: [], skills: [], plugins: [], permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] } }),
      fork: () => hung,
    } as unknown as BaseAgent;
    const mk = new SubagentRunner();
    mk.init({
      createAgent: () => hung,
      workingDir: dir,
      sessionStore: store,
      getMode: () => "auto",
      runTimeoutMs: 300,
    });
    const id = mk.spawn("default", "挂死任务");
    await waitFor(() => mk.get(id)?.status === "failed", 3000);
    expect(mk.get(id)!.lastError).toContain("强制终止");
    // 作用域隔离：跑完一轮子智能体后，全局 provider 仍是调用方装的那个（未被换成 deny 再还原）
    const displaced = setConfirmProvider(async () => "deny");
    expect(await requestConfirm("恢复了吗？", [{ value: "allow", label: "允许" }])).toBe("deny");
    setConfirmProvider(displaced);
    expect(await requestConfirm("还是原来的 provider 吗？", [{ value: "allow", label: "允许" }])).toBe("allow");
    setConfirmProvider(restore);
    mk.clear();
  });

  it("子智能体运行期间，父会话的确认与提问通道不受影响（作用域隔离）", async () => {
    const { requestConfirm, setConfirmProvider } = await import("../src/hooks/confirm-channel.js");
    const { requestAsk, setAskProvider } = await import("../src/tools/ask-channel.js");
    const restoreConfirm = setConfirmProvider(async () => "allow");
    const restoreAsk = setAskProvider(async () => "父会话回答");
    const mk = new SubagentRunner();
    mk.init({ createAgent: () => makeAgent("abortable", 5000), workingDir: dir, sessionStore: store, getMode: () => "auto" });
    const id = mk.spawn("default", "运行中的子智能体");
    await waitFor(() => mk.get(id)!.status === "running");

    // 此前实现会在这里被子智能体装的 deny provider 顶掉 → 返回 null（父会话功能级自锁）
    expect(await requestConfirm("父会话危险操作？", [{ value: "allow", label: "允许" }])).toBe("allow");
    expect(await requestAsk("父会话提问", [], false)).toBe("父会话回答");

    mk.interrupt(id);
    await waitFor(() => mk.get(id)!.status === "idle");
    setConfirmProvider(restoreConfirm);
    setAskProvider(restoreAsk);
    mk.clear();
  });
});
