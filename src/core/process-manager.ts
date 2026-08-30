/**
 * 进程管理器（Sprint 34）— Agent/App/Job 统一进程注册表
 * 职责：进程登记/注销/状态更新 + 事件广播（process/start|end|update）
 * 预算：MVP 记录优先级标记（front > bg > app），配额执行机制后续 Sprint
 */

import { eventBus } from "../server/event-bus.js";
import type { OsProcess } from "../types.js";

export type ProcessSubscriber = (data: object) => void;

export class ProcessManager {
  private processes = new Map<string, OsProcess>();
  private subscribers = new Set<ProcessSubscriber>();
  private seq = 0;

  subscribe(cb: ProcessSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  list(): OsProcess[] {
    return [...this.processes.values()];
  }

  get(pid: string): OsProcess | undefined {
    return this.processes.get(pid);
  }

  /** 登记进程（重复 pid 覆盖） */
  register(proc: OsProcess): void {
    this.processes.set(proc.pid, proc);
    this.broadcast({ type: "process/start", process: proc });
  }

  /** 更新进程状态（存在才更新，广播 update） */
  update(pid: string, patch: Partial<OsProcess>): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    Object.assign(proc, patch);
    this.broadcast({ type: "process/update", process: proc });
  }

  /** 注销进程（广播 end；不存在为幂等 no-op） */
  unregister(pid: string): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    this.processes.delete(pid);
    this.broadcast({ type: "process/end", process: proc });
  }

  /** 清空（测试用） */
  clear(): void {
    this.processes.clear();
  }

  nextPid(prefix: string): string {
    this.seq++;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }

  /** 按 kind 统计（状态栏/控制台展示） */
  stats(): { agent: number; app: number; job: number } {
    let agent = 0;
    let app = 0;
    let job = 0;
    for (const p of this.processes.values()) {
      if (p.kind === "agent") agent++;
      else if (p.kind === "app") app++;
      else job++;
    }
    return { agent, app, job };
  }

  private broadcast(data: object): void {
    eventBus.broadcast(data);
    for (const cb of this.subscribers) {
      try {
        cb(data);
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }
}

export const processManager = new ProcessManager();
