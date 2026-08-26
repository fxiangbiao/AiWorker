/**
 * 后台任务执行器 — 长任务不阻塞 TUI 交互
 * 状态机 queued → running → done | failed；并发上限；结果写会话 + 审计 + WS 广播
 * 后台任务不注册 ask/confirm 通道（fail-closed 自动拒高危）；不写 TUI 消息区（避免抢渲染）
 */

import { eventBus } from "../server/event-bus.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { SessionStore } from "../memory/session-store.js";
import type { StreamCallbacks, PermissionMode } from "../types.js";
import { auditLogger } from "./audit-logger.js";
import { processManager } from "./process-manager.js";

export interface BackgroundJob {
  id: string;
  agentId: string;
  prompt: string;
  status: "queued" | "running" | "done" | "failed";
  summary: string;
  error?: string;
  sessionId?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 同时运行的后台任务上限，超出排队（FIFO） */
const MAX_CONCURRENT = 2;

export interface JobRunnerDeps {
  createAgent: (agentId: string) => BaseAgent | undefined;
  workingDir: string;
  sessionStore: SessionStore;
  mode?: PermissionMode;
}

export class JobRunner {
  private deps: JobRunnerDeps | null = null;
  private jobs = new Map<string, BackgroundJob>();
  private queue: string[] = [];
  private running = 0;
  private jobPids = new Map<string, string>();

  init(deps: JobRunnerDeps): void {
    this.deps = deps;
  }

  isInitialized(): boolean {
    return this.deps !== null;
  }

  submit(agentId: string, prompt: string): string {
    if (!this.deps) throw new Error("JobRunner 未初始化");
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.jobs.set(id, { id, agentId, prompt, status: "queued", summary: "" });
    this.queue.push(id);
    const pid = processManager.nextPid("job");
    this.jobPids.set(id, pid);
    processManager.register({ kind: "job", pid, jobId: id, status: "queued" });
    this.drain();
    return id;
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /** 仅可取消排队中任务 */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "failed";
      job.error = "已取消";
      job.finishedAt = Date.now();
      this.queue = this.queue.filter((q) => q !== id);
      return true;
    }
    return false;
  }

  /** 清空全部任务记录（测试/重置用；运行中任务不受影响） */
  clear(): void {
    this.jobs.clear();
    this.queue = [];
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job) continue;
      void this.run(job);
    }
  }

  private async run(job: BackgroundJob): Promise<void> {
    const deps = this.deps!;
    this.running++;
    job.status = "running";
    job.startedAt = Date.now();
    const pid = this.jobPids.get(job.id);
    if (pid) processManager.update(pid, { status: "running", startedAt: job.startedAt } as never);

    try {
      const agent = deps.createAgent(job.agentId);
      if (!agent) throw new Error(`未知专家: ${job.agentId}`);

      const sessionId = deps.sessionStore.createSession(job.agentId).id;
      job.sessionId = sessionId;

      // 仅收集文本摘要；不注册 ask/confirm 通道（fail-closed 自动拒高危）
      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => {
          job.summary = (job.summary + text).slice(-2000);
        },
      };

      const result = await agent.runStream(
        { instruction: job.prompt, sessionId, mode: deps.mode ?? "auto" },
        deps.workingDir,
        callbacks,
      );

      if (!job.summary && result.text) job.summary = result.text.slice(-2000);
      job.status = result.truncated ? "failed" : "done";
      if (job.status === "failed" && !job.error) {
        job.error = "任务未完成（可能已达迭代上限）";
      }
      auditLogger.log({
        timestamp: Date.now(),
        agentId: job.agentId,
        sessionId,
        action: "job:done",
        target: job.prompt.slice(0, 100),
        result: job.status === "done" ? "success" : "error",
        detail: `job=${job.id}`,
      });
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
      auditLogger.log({
        timestamp: Date.now(),
        agentId: job.agentId,
        sessionId: job.sessionId ?? "",
        action: "job:failed",
        target: job.prompt.slice(0, 100),
        result: "error",
        detail: `job=${job.id}`,
      });
    } finally {
      job.finishedAt = Date.now();
      this.running--;
      const pid = this.jobPids.get(job.id);
      if (pid) {
        processManager.update(pid, { status: job.status, endedAt: job.finishedAt } as never);
        processManager.unregister(pid);
      }
      eventBus.broadcast({
        type: "job/done",
        jobId: job.id,
        status: job.status,
        agentId: job.agentId,
        summary: job.summary.slice(0, 200),
        error: job.error,
      });
      this.drain();
    }
  }
}

export const jobRunner = new JobRunner();
