/**
 * 生成/更新任务队列（Sprint 35 补丁；Sprint 37 扩展 update）
 * 入队即返 jobId（连接零阻塞）；后台调 factory.generate / factory.update；状态流转 + gen/* 事件广播
 * 取消：仅可取消排队中任务；并发 1（LLM 资源限制，可调）
 */

import { eventBus } from "../server/event-bus.js";
import type { AppFactory } from "./app-factory.js";
import type { AppSpec, GenerateResult } from "../types.js";

export type GenTask =
  | { kind: "generate"; spec: AppSpec }
  | { kind: "update"; appId: string; description: string; sessionId?: string };

export interface GenJob {
  id: string;
  task: GenTask;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  step?: string;
  progressPct?: number;
  result?: GenerateResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const MAX_CONCURRENT = 1;
/** 完成态任务保留上限（防 jobs Map 无限增长） */
const MAX_KEPT_JOBS = 20;

export class GeneratorQueue {
  private factory: AppFactory | null = null;
  private jobs = new Map<string, GenJob>();
  private queue: string[] = [];
  private running = 0;

  init(factory: AppFactory): void {
    this.factory = factory;
  }

  isInitialized(): boolean {
    return this.factory !== null;
  }

  /** 入队生成（立即返回 jobId） */
  submit(spec: AppSpec): string {
    if (!this.factory) throw new Error("GeneratorQueue 未初始化");
    return this.enqueue({ kind: "generate", spec });
  }

  /** 入队应用迭代更新（立即返回 jobId；后台 factory.update + gen/* 进度事件） */
  submitUpdate(appId: string, description: string, sessionId?: string): string {
    if (!this.factory) throw new Error("GeneratorQueue 未初始化");
    return this.enqueue({ kind: "update", appId, description, sessionId });
  }

  private enqueue(task: GenTask): string {
    const id = `genjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.jobs.set(id, { id, task, status: "queued", createdAt: Date.now() });
    this.queue.push(id);
    eventBus.broadcast({ type: "gen/queued", jobId: id });
    this.drain();
    return id;
  }

  get(id: string): GenJob | undefined {
    return this.jobs.get(id);
  }

  list(): GenJob[] {
    return [...this.jobs.values()];
  }

  /** 仅可取消排队中任务 */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "canceled";
      job.finishedAt = Date.now();
      this.queue = this.queue.filter((q) => q !== id);
      eventBus.broadcast({ type: "gen/canceled", jobId: id });
      return true;
    }
    return false;
  }

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

  private async run(job: GenJob): Promise<void> {
    const factory = this.factory!;
    this.running++;
    job.status = "running";
    job.startedAt = Date.now();
    eventBus.broadcast({ type: "gen/running", jobId: job.id });
    const onProgress = (step: string, index: number, total: number, detail?: string): void => {
      job.step = step;
      job.progressPct = Math.round((index / total) * 100);
      eventBus.broadcast({
        type: "gen/progress",
        jobId: job.id,
        step,
        index,
        total,
        pct: job.progressPct,
        detail,
        at: Date.now(),
      });
    };
    try {
      const result =
        job.task.kind === "generate"
          ? await factory.generate(job.task.spec, onProgress)
          : await factory.update(job.task.appId, job.task.description, job.task.sessionId, onProgress);
      job.result = result;
      job.status = result.ok ? "done" : "failed";
      if (!result.ok) job.error = result.error;
      eventBus.broadcast({ type: result.ok ? "gen/done" : "gen/failed", jobId: job.id, result });
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
      eventBus.broadcast({ type: "gen/failed", jobId: job.id, error: job.error });
    } finally {
      job.finishedAt = Date.now();
      this.running--;
      this.trimFinished();
      this.drain();
    }
  }

  /** 完成态任务保留最近 MAX_JOBS 条（防长运行内存持续增长） */
  private trimFinished(): void {
    if (this.jobs.size <= MAX_KEPT_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status === "done" || j.status === "failed" || j.status === "canceled")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const j of finished.slice(MAX_KEPT_JOBS)) {
      this.jobs.delete(j.id);
    }
  }
}

export const generatorQueue = new GeneratorQueue();
