/**
 * 进程管理器测试（Sprint 34）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ProcessManager } from "../src/core/process-manager.js";

describe("process-manager", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    pm = new ProcessManager();
  });

  it("注册/查询/统计", () => {
    pm.register({ kind: "agent", pid: "agent-1", agentId: "coding", sessionId: "s1", status: "running", priority: "front", startedAt: 1 });
    pm.register({ kind: "app", pid: "app-1", appId: "hello", status: "running", startedAt: 1 });
    pm.register({ kind: "job", pid: "job-1", jobId: "j1", status: "queued" });

    expect(pm.list()).toHaveLength(3);
    expect(pm.get("agent-1")?.kind).toBe("agent");
    expect(pm.stats()).toEqual({ agent: 1, app: 1, job: 1, subagent: 0 });
  });

  it("Sprint 52：子智能体独立计数（不再并入 job）", () => {
    pm.register({ kind: "job", pid: "job-1", jobId: "j1", status: "queued" });
    pm.register({ kind: "subagent", pid: "subagent-1", subagentId: "sub-1", status: "running" });
    expect(pm.stats()).toEqual({ agent: 0, app: 0, job: 1, subagent: 1 });
  });

  it("update 存在才生效；unregister 幂等", () => {
    pm.register({ kind: "job", pid: "job-1", jobId: "j1", status: "queued" });
    pm.update("job-1", { status: "running" });
    expect(pm.get("job-1")?.status).toBe("running");
    pm.update("nope", { status: "done" });
    expect(pm.list()).toHaveLength(1);

    pm.unregister("job-1");
    expect(pm.list()).toHaveLength(0);
    pm.unregister("job-1");
    expect(pm.list()).toHaveLength(0);
  });

  it("事件订阅收到 process/start|update|end", () => {
    const events: string[] = [];
    pm.subscribe((data) => events.push((data as { type: string }).type));
    pm.register({ kind: "app", pid: "app-1", appId: "x", status: "running", startedAt: 1 });
    pm.update("app-1", { status: "stopped" });
    pm.unregister("app-1");
    expect(events).toEqual(["process/start", "process/update", "process/end"]);
  });

  it("nextPid 生成唯一前缀 id", () => {
    const a = pm.nextPid("agent");
    const b = pm.nextPid("agent");
    expect(a.startsWith("agent-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
