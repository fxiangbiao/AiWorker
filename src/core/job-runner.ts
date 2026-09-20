/**
 * 后台任务兼容层（Sprint 52 统一）：执行一律落到 `subagentRunner`，本模块只保留旧视图
 * 状态映射 `idle ↔ done`：/bg、/jobs、POST /jobs、scheduler 等既有消费方零改动
 */

import { subagentRunner, type SubagentHandle } from "./subagent-runner.js";

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
  /** 被用户中断（而非自然跑完）：状态仍是 idle/可续接，但视图不能显示成"完成" */
  interrupted?: boolean;
}

export interface JobRunnerSubmitOptions {
  /** 绑定父会话（/bg 传当前 TUI 会话）：子改动随父 /rewind 连带回滚 */
  parentSessionId?: string;
  /** 缺省 false（保留 /bg 既有语义：用户显式提交即完整工具面） */
  readOnly?: boolean;
}

function toJob(h: SubagentHandle): BackgroundJob {
  return {
    id: h.id,
    agentId: h.agentId,
    prompt: h.task,
    status: h.status === "idle" ? "done" : h.status,
    summary: h.summary,
    error: h.lastError,
    sessionId: h.sessionId,
    startedAt: h.startedAt,
    finishedAt: h.finishedAt,
    interrupted: h.status === "idle" && h.abortRequested,
  };
}

export class JobRunner {
  isInitialized(): boolean {
    return subagentRunner.isInitialized();
  }

  submit(agentId: string, prompt: string, opts?: JobRunnerSubmitOptions): string {
    return subagentRunner.spawn(agentId, prompt, {
      parentSessionId: opts?.parentSessionId,
      readOnly: opts?.readOnly ?? false,
    });
  }

  list(): BackgroundJob[] {
    return subagentRunner.list().map(toJob);
  }

  get(id: string): BackgroundJob | undefined {
    const h = subagentRunner.get(id);
    return h ? toJob(h) : undefined;
  }

  /** 旧语义"仅排队中可取消"→ 统一后为 interrupt（中断当前轮并保留会话，可续接） */
  cancel(id: string): boolean {
    return subagentRunner.interrupt(id);
  }

  clear(): void {
    subagentRunner.clear();
  }
}

export const jobRunner = new JobRunner();
