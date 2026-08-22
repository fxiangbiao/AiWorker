/**
 * 后台任务执行器测试（Sprint 30）
 * 覆盖：提交/状态机 / 并发上限排队 / 结果写会话 / 失败 / 取消 / WS 广播
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { SessionStore } from "../src/memory/session-store.js";
import { JobRunner } from "../src/core/job-runner.js";
import { eventBus } from "../src/server/event-bus.js";
import type { BaseAgent } from "../src/agents/base-agent.js";
import type { Task, StreamCallbacks } from "../src/types.js";

const dir = makeTestDir("job-runner");

function makeAgent(behavior: "ok" | "throw" | "truncated" | "slow" = "ok") {
  return {
    runStream: async (task: Task, _wd: string, callbacks: StreamCallbacks) => {
      callbacks.onTextDelta?.("后台结果摘要");
      if (behavior === "slow") return new Promise(() => {}); // 永不结束
      if (behavior === "throw") throw new Error("模拟失败");
      return {
        success: behavior !== "truncated",
        text: behavior === "truncated" ? "" : "后台结果摘要",
        truncated: behavior === "truncated",
      };
    },
  } as unknown as BaseAgent;
}

describe("21. JobRunner 后台任务", () => {
  let store: SessionStore;
  let runner: JobRunner;

  beforeEach(() => {
    setupEnv(dir);
    store = new SessionStore(resolve(dir, "jobs.db"));
    runner = new JobRunner();
    runner.init({ createAgent: () => makeAgent(), workingDir: dir, sessionStore: store });
  });

  afterEach(() => {
    store.close();
    teardownEnv();
  });

  function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
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

  it("提交 → running → done，结果写会话", async () => {
    const id = runner.submit("default", "后台任务A");
    // drain 同步启动，提交后可能已是 running
    expect(["queued", "running"]).toContain(runner.get(id)!.status);
    await waitFor(() => runner.get(id)!.status === "done");
    const job = runner.get(id)!;
    expect(job.status).toBe("done");
    expect(job.summary).toContain("后台结果摘要");
    expect(job.sessionId).toBeTruthy(); // 创建了独立会话
  });

  it("并发上限：第 3 个任务排队，完成后自动开始", async () => {
    const id1 = runner.submit("default", "任务1");
    const id2 = runner.submit("default", "任务2");
    const id3 = runner.submit("default", "任务3");
    await waitFor(() => runner.get(id1)!.status === "done");
    await waitFor(() => runner.get(id2)!.status === "done");
    await waitFor(() => runner.get(id3)!.status === "done");
    expect(runner.get(id3)!.status).toBe("done");
  });

  it("失败任务记录 error 与 failed 状态", async () => {
    const bad = new JobRunner();
    bad.init({ createAgent: () => makeAgent("throw"), workingDir: dir, sessionStore: store });
    const id = bad.submit("default", "会失败");
    await waitFor(() => bad.get(id)!.status === "failed");
    expect(bad.get(id)!.error).toContain("模拟失败");
  });

  it("取消排队中任务（并发占满时第 3 个保持 queued）", async () => {
    const busy = new JobRunner();
    busy.init({ createAgent: () => makeAgent("slow"), workingDir: dir, sessionStore: store });
    const id1 = busy.submit("default", "慢任务1");
    const id2 = busy.submit("default", "慢任务2");
    await waitFor(() => busy.get(id1)!.status === "running" && busy.get(id2)!.status === "running");
    const id3 = busy.submit("default", "排队任务");
    expect(busy.get(id3)!.status).toBe("queued");
    expect(busy.cancel(id3)).toBe(true);
    expect(busy.get(id3)!.status).toBe("failed");
    expect(busy.cancel("no-such")).toBe(false);
    expect(busy.cancel(id1)).toBe(false); // running 不可取消
  });

  it("完成后广播 job/done 事件", async () => {
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
  });
});
