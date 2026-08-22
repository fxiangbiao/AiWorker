/**
 * 定时调度器 — config/schedule.json 定义 cron 任务，到点提交到 JobRunner
 * 依赖 cron-parser 解析 5 字段 cron（分 时 日 月 周）；解析失败的任务跳过并记审计
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { auditLogger } from "./audit-logger.js";

/** cron-parser v5 为 6 字段（秒 分 时 日 月 周）；5 字段标准 cron 自动补秒前缀 */
function normalizeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 ? `0 ${expr.trim()}` : expr.trim();
}

/** 定时任务定义 */
export interface ScheduledJob {
  id: string;
  cron: string;
  prompt: string;
  agentId: string;
}

export interface SchedulerDeps {
  submit: (agentId: string, prompt: string) => string;
}

const DEFAULT_JOBS: ScheduledJob[] = [];

export function loadScheduleConfig(configPath?: string): ScheduledJob[] {
  try {
    const path = configPath ?? resolve(process.cwd(), "config", "schedule.json");
    if (!existsSync(path)) return DEFAULT_JOBS;
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as { jobs?: Array<Partial<ScheduledJob> & { id?: string; cron?: string; prompt?: string }> };
    return (parsed.jobs ?? [])
      .map((j, i) => ({
        id: j.id ?? `job-${i}`,
        cron: j.cron ?? "",
        prompt: j.prompt ?? "",
        agentId: j.agentId ?? "default",
      }))
      .filter((j) => j.cron && j.prompt);
  } catch {
    return DEFAULT_JOBS;
  }
}

export function saveScheduleConfig(jobs: ScheduledJob[], configPath?: string): void {
  const path = configPath ?? resolve(process.cwd(), "config", "schedule.json");
  writeFileSync(path, JSON.stringify({ jobs }, null, 2) + "\n");
}

/** 计算 cron 表达式下一次触发的时间戳；无效返回 null */
export function nextFireAt(cronExpr: string, from = Date.now()): number | null {
  try {
    return CronExpressionParser.parse(normalizeCron(cronExpr), { currentDate: new Date(from) }).next().getTime();
  } catch {
    return null;
  }
}

export class Scheduler {
  private deps: SchedulerDeps | null = null;
  private jobs: ScheduledJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private configPath?: string;

  init(deps: SchedulerDeps, configPath?: string): void {
    this.deps = deps;
    this.configPath = configPath;
    this.jobs = loadScheduleConfig(configPath);
  }

  getJobs(): ScheduledJob[] {
    return this.jobs;
  }

  addJob(job: ScheduledJob): boolean {
    if (!this.deps || !job.cron || !job.prompt) return false;
    if (nextFireAt(job.cron) === null) return false;
    this.jobs = this.jobs.filter((j) => j.id !== job.id);
    this.jobs.push(job);
    this.schedule(job);
    saveScheduleConfig(this.jobs, this.configPath);
    return true;
  }

  removeJob(id: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.jobs.splice(idx, 1);
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    saveScheduleConfig(this.jobs, this.configPath);
    return true;
  }

  /** 启动全部任务调度（首次注册） */
  start(): void {
    if (!this.deps) return;
    for (const job of this.jobs) this.schedule(job);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(job: ScheduledJob): void {
    const next = nextFireAt(job.cron);
    if (next === null) {
      auditLogger.log({
        timestamp: Date.now(),
        agentId: job.agentId,
        sessionId: "",
        action: "schedule:invalid",
        target: job.id,
        result: "error",
        detail: `cron=${job.cron}`,
      });
      return;
    }
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      auditLogger.log({
        timestamp: Date.now(),
        agentId: job.agentId,
        sessionId: "",
        action: "schedule:fire",
        target: job.id,
        result: "success",
        detail: `cron=${job.cron}`,
      });
      this.deps?.submit(job.agentId, job.prompt);
      // 重新调度下一轮
      this.schedule(job);
    }, delay);
    // 长延时（>24.8 天）Node 定时器溢出保护：分段
    if (delay > 2_147_000_000) {
      clearTimeout(timer);
      const step = setTimeout(() => this.schedule(job), 2_147_000_000);
      this.timers.set(job.id, step);
      return;
    }
    this.timers.set(job.id, timer);
  }
}

export const scheduler = new Scheduler();
