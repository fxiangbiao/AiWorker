/**
 * 子智能体运行器（Sprint 52）— 后台可续接、可控制、可观测的子智能体
 * 从 job-runner.ts 演进：状态机 queued→running→idle|failed；支持 send/interrupt/续接
 * 保留 jobRunner 导出兼容 scheduler；新增 subagentRunner 作为主入口
 */

import { eventBus } from "../server/event-bus.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { SessionStore } from "../memory/session-store.js";
import type { StreamCallbacks, PermissionMode, AgentRunResult } from "../types.js";
import { setConfirmProvider } from "../hooks/confirm-channel.js";
import { setAskProvider } from "../tools/ask-channel.js";
import { auditLogger } from "./audit-logger.js";
import { processManager } from "./process-manager.js";
import { WORKER_SESSION_PREFIX } from "../memory/session-store.js";
import { isRestrictedTool, READ_ONLY_TOOLS } from "./subagent-rules.js";
import { registerOwnership, unregisterChild } from "./subagent-ownership.js";
import { pendingTurn } from "../hooks/turn-registry.js";

export interface SubagentHandle {
  id: string;
  agentId: string;
  sessionId: string;
  parentSessionId: string | null;
  status: "queued" | "running" | "idle" | "failed";
  abortRequested: boolean;
  readOnly: boolean;
  rounds: number;
  pending: string[];
  summary: string;
  usage: { prompt: number; completion: number };
  lastError?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SubagentRunnerDeps {
  createAgent: (agentId: string) => BaseAgent | undefined;
  workingDir: string;
  sessionStore: SessionStore;
  /** 动态读取当前权限模式（每次 spawn/run 时调用，避免启动时钉死） */
  getMode: () => PermissionMode;
  maxConcurrent?: number;
  maxPending?: number;
  maxPerParent?: number;
  maxGlobal?: number;
  /** 单次 run 总时长上限（看门狗，默认 10 分钟）：防挂死持有 deny 通道与并发槽位 */
  runTimeoutMs?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PENDING = 5;
const DEFAULT_MAX_PER_PARENT = 4;
const DEFAULT_MAX_GLOBAL = 8;
const DONE_RETAIN = 50;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;

export class SubagentRunner {
  private deps: SubagentRunnerDeps | null = null;
  private handles = new Map<string, SubagentHandle>();
  private queue: string[] = [];
  private runningCount = 0;
  private pids = new Map<string, string>();
  private abortControllers = new Map<string, AbortController>();
  private runningPromises = new Set<Promise<void>>();
  private denyRefCount = 0;
  private savedConfirm: ReturnType<typeof setConfirmProvider> = null;
  private savedAsk: ReturnType<typeof setAskProvider> = null;

  init(deps: SubagentRunnerDeps): void {
    this.deps = deps;
  }

  isInitialized(): boolean {
    return this.deps !== null;
  }

  spawn(
    agentId: string,
    prompt: string,
    opts?: { parentSessionId?: string; readOnly?: boolean; mode?: PermissionMode },
  ): string {
    if (!this.deps) throw new Error("SubagentRunner 未初始化");
    const maxGlobal = this.deps.maxGlobal ?? DEFAULT_MAX_GLOBAL;
    const maxPerParent = this.deps.maxPerParent ?? DEFAULT_MAX_PER_PARENT;

    // 配额只计"占用槽位"的 queued/running；idle 是可续接的已结束态，不该继续占额
    // （否则同一父会话累计 spawn 到上限后无任何 API 能释放，只能删父会话或重启）
    const activeCount = [...this.handles.values()].filter(
      (h) => h.status === "queued" || h.status === "running",
    ).length;
    if (activeCount >= maxGlobal) {
      throw new Error(`全局子智能体上限 ${maxGlobal} 已达`);
    }

    if (opts?.parentSessionId) {
      const parentCount = [...this.handles.values()].filter(
        (h) => h.parentSessionId === opts.parentSessionId && (h.status === "queued" || h.status === "running"),
      ).length;
      if (parentCount >= maxPerParent) {
        throw new Error(`父会话 ${opts.parentSessionId} 子智能体上限 ${maxPerParent} 已达`);
      }
    }

    const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const sessionId = `${WORKER_SESSION_PREFIX}${crypto.randomUUID()}`;
    this.deps.sessionStore.ensureSession(sessionId, agentId);

    if (opts?.parentSessionId) {
      const parentTurn = pendingTurn(opts.parentSessionId);
      registerOwnership({
        parentSessionId: opts.parentSessionId,
        parentTurnAtSpawn: parentTurn,
        childSessionId: sessionId,
        spawnedAt: Date.now(),
      });
    }

    const handle: SubagentHandle = {
      id,
      agentId,
      sessionId,
      parentSessionId: opts?.parentSessionId ?? null,
      status: "queued",
      abortRequested: false,
      readOnly: opts?.readOnly !== false,
      rounds: 0,
      pending: [prompt],
      summary: "",
      usage: { prompt: 0, completion: 0 },
    };
    this.handles.set(id, handle);
    this.queue.push(id);

    const pid = processManager.nextPid("subagent");
    this.pids.set(id, pid);
    processManager.register({ kind: "subagent", pid, subagentId: id, status: "queued" });

    this.drain();
    return id;
  }

  send(id: string, message: string): boolean {
    const h = this.handles.get(id);
    if (!h) return false;
    if (h.status === "failed") return false;

    if (h.status === "running") {
      const maxPending = this.deps?.maxPending ?? DEFAULT_MAX_PENDING;
      if (h.pending.length >= maxPending) return false;
      h.pending.push(message);
      return true;
    }

    if (h.status === "idle" || h.status === "queued") {
      if (h.status === "idle") {
        h.status = "queued";
        h.abortRequested = false;
        h.pending.push(message);
        this.queue.push(id);
        this.drain();
      } else {
        h.pending.push(message);
      }
      return true;
    }

    return false;
  }

  interrupt(id: string): boolean {
    const h = this.handles.get(id);
    if (!h) return false;
    if (h.status !== "running" && h.status !== "queued") return false;

    h.abortRequested = true;
    h.pending = [];

    if (h.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      h.status = "idle";
      h.finishedAt = Date.now();
      const pid = this.pids.get(id);
      if (pid) {
        processManager.update(pid, { status: "idle", endedAt: h.finishedAt } as never);
      }
      eventBus.broadcast({
        type: "subagent/done",
        subagentId: id,
        status: "idle",
        agentId: h.agentId,
        summary: h.summary.slice(0, 200),
      });
      return true;
    }

    const ac = this.abortControllers.get(id);
    if (ac) ac.abort();

    return true;
  }

  list(parentSessionId?: string): SubagentHandle[] {
    const all = [...this.handles.values()];
    if (!parentSessionId) return all;
    return all.filter((h) => h.parentSessionId === parentSessionId);
  }

  get(id: string): SubagentHandle | undefined {
    return this.handles.get(id);
  }

  /** 父会话删除：中断其子智能体并移出注册表（会话已不存在，续接无意义） */
  interruptByParent(parentSessionId: string): number {
    let count = 0;
    for (const h of this.handles.values()) {
      if (h.parentSessionId !== parentSessionId) continue;
      count++;
      if (h.status === "running" || h.status === "queued") {
        this.interrupt(h.id);
      }
      this.handles.delete(h.id);
      unregisterChild(h.sessionId);
      const pid = this.pids.get(h.id);
      if (pid) {
        processManager.unregister(pid);
        this.pids.delete(h.id);
      }
    }
    this.queue = this.queue.filter((q) => this.handles.has(q));
    return count;
  }

  cancel(id: string): boolean {
    const h = this.handles.get(id);
    if (h && h.status === "queued") {
      h.status = "failed";
      h.lastError = "已取消";
      h.finishedAt = Date.now();
      this.queue = this.queue.filter((q) => q !== id);
      return true;
    }
    return false;
  }

  clear(): void {
    for (const h of this.handles.values()) unregisterChild(h.sessionId);
    this.handles.clear();
    this.queue = [];
  }

  async shutdown(): Promise<void> {
    for (const [id, ac] of this.abortControllers) {
      const h = this.handles.get(id);
      if (h) {
        h.abortRequested = true;
        auditLogger.log({
          timestamp: Date.now(),
          agentId: h.agentId,
          sessionId: h.sessionId,
          action: "subagent:shutdown",
          target: id,
          result: "blocked",
          detail: "shutdown interrupted",
        });
      }
      ac.abort();
    }
    // 上限等待：挂死的 run 不能阻塞进程退出（看门狗兜底释放 deny 通道）
    const pending = [...this.runningPromises];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          const t = setTimeout(r, SHUTDOWN_GRACE_MS);
          t.unref?.();
        }),
      ]);
    }
    this.abortControllers.clear();
    this.queue = [];
  }

  private drain(): void {
    const maxConcurrent = this.deps?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    while (this.runningCount < maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const h = this.handles.get(id);
      if (!h || h.status !== "queued") continue;
      const p = this.run(h);
      this.runningPromises.add(p);
      void p.finally(() => this.runningPromises.delete(p));
    }
  }

  private installDenyProvider(): void {
    this.denyRefCount++;
    if (this.denyRefCount === 1) {
      this.savedConfirm = setConfirmProvider(async () => null);
      this.savedAsk = setAskProvider(async () => null);
    }
  }

  private uninstallDenyProvider(): void {
    if (this.denyRefCount <= 0) return;
    this.denyRefCount--;
    if (this.denyRefCount === 0) {
      setConfirmProvider(this.savedConfirm);
      setAskProvider(this.savedAsk);
      this.savedConfirm = null;
      this.savedAsk = null;
    }
  }

  private pruneDone(): void {
    const doneHandles = [...this.handles.values()]
      .filter((h) => h.status === "idle" || h.status === "failed")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    if (doneHandles.length > DONE_RETAIN) {
      for (const h of doneHandles.slice(DONE_RETAIN)) {
        this.handles.delete(h.id);
        unregisterChild(h.sessionId);
        const pid = this.pids.get(h.id);
        if (pid) {
          processManager.unregister(pid);
          this.pids.delete(h.id);
        }
      }
    }
  }

  /** 显式释放一个子智能体（关闭会话、清归属、释放槽位）；用于 UI/HTTP 主动回收 */
  close(id: string): boolean {
    const h = this.handles.get(id);
    if (!h) return false;
    if (h.status === "running" || h.status === "queued") {
      h.abortRequested = true;
      const ac = this.abortControllers.get(id);
      if (ac) ac.abort();
      this.queue = this.queue.filter((q) => q !== id);
    }
    this.handles.delete(id);
    unregisterChild(h.sessionId);
    const pid = this.pids.get(id);
    if (pid) {
      processManager.unregister(pid);
      this.pids.delete(id);
    }
    this.queue = this.queue.filter((q) => this.handles.has(q));
    return true;
  }

  private async run(handle: SubagentHandle): Promise<void> {
    const deps = this.deps!;
    this.runningCount++;
    handle.status = "running";
    handle.startedAt = Date.now();
    const pid = this.pids.get(handle.id);
    if (pid) processManager.update(pid, { status: "running", startedAt: handle.startedAt } as never);

    const ac = new AbortController();
    this.abortControllers.set(handle.id, ac);
    this.installDenyProvider();
    let denyReleased = false;
    const releaseDeny = (): void => {
      if (denyReleased) return;
      denyReleased = true;
      this.uninstallDenyProvider();
    };
    // 看门狗：单次 run 挂死（LLM 流不返回且不响应 signal）时强制释放 deny 通道，
    // 否则 refCount 永不为 0 → 整个进程的 confirm/ask 静默拒绝（功能性 DoS）
    const runTimeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const watchdog = setTimeout(() => {
      if (handle.status !== "running") return;
      handle.status = "failed";
      handle.lastError = `子智能体运行超过 ${Math.round(runTimeoutMs / 1000)}s，已强制终止`;
      handle.abortRequested = true;
      auditLogger.log({
        timestamp: Date.now(),
        agentId: handle.agentId,
        sessionId: handle.sessionId,
        action: "subagent:watchdog",
        target: handle.id,
        result: "error",
        detail: handle.lastError,
      });
      ac.abort();
      releaseDeny();
    }, runTimeoutMs);
    watchdog.unref?.();

    try {
      while (true) {
        if (handle.abortRequested) break;

        const messages = [...handle.pending];
        handle.pending = [];
        if (messages.length === 0 && handle.rounds > 0) break;

        const prompt = messages.length > 0 ? messages.join("\n\n") : "";
        if (handle.rounds === 0 && !prompt) break;

        const agent = deps.createAgent(handle.agentId);
        if (!agent) throw new Error(`未知专家: ${handle.agentId}`);

        // per-spawn 副本：隔离 mode 与工具面（同名并发不互踩）
        // 工具面一律剔除控制类工具（深度 1）；readOnly 再收窄到只读闭集（关闭 MCP/插件豁免）
        const parentTools = agent.getConfig().tools;
        const spawnAgent = handle.readOnly
          ? agent.fork({
              tools: parentTools.filter((t) => READ_ONLY_TOOLS.has(t)),
              strictTools: true,
              readOnly: true,
            })
          : agent.fork({ tools: parentTools.filter((t) => !isRestrictedTool(t)) });

        // 模式只允许收窄不许放宽：readOnly 强制 ask（权限层只读），否则沿用父会话当前模式
        const parentMode = deps.getMode();
        const mode = handle.readOnly ? "ask" : parentMode;

        const callbacks: StreamCallbacks = {
          onTextDelta: (text) => {
            handle.summary = (handle.summary + text).slice(-2000);
          },
        };

        let result: AgentRunResult;
        try {
          result = await spawnAgent.runStream(
            { instruction: prompt, sessionId: handle.sessionId, mode },
            deps.workingDir,
            callbacks,
            ac.signal,
          );
        } catch (err) {
          if (ac.signal.aborted || handle.abortRequested) break;
          throw err;
        }

        handle.rounds++;
        if (result.usage) {
          handle.usage.prompt += result.usage.promptTokens ?? 0;
          handle.usage.completion += result.usage.completionTokens ?? 0;
        }

        if (handle.abortRequested) break;

        if (result.truncated && !handle.abortRequested) {
          handle.status = "failed";
          handle.lastError = "任务未完成（可能已达迭代上限）";
          break;
        }

        if (handle.pending.length === 0) break;
      }

      if (handle.status === "running") {
        handle.status = "idle";
      }

      // 中断窗口内新到达的 pending（interrupt 清空后、run 退出前又被 send 写入）：
// 这些是中断**之后**的新工作，已回报"发送成功"，必须重新入队消费，否则静默搁置到下一次 send
      if (handle.status === "idle" && handle.pending.length > 0) {
        handle.status = "queued";
        handle.abortRequested = false;
        this.queue.push(handle.id);
      }

      auditLogger.log({
        timestamp: Date.now(),
        agentId: handle.agentId,
        sessionId: handle.sessionId,
        action: "subagent:done",
        target: handle.id,
        result: handle.status === "failed" ? "error" : "success",
        detail: `rounds=${handle.rounds}, parent=${handle.parentSessionId ?? "none"}`,
      });
    } catch (err) {
      handle.status = "failed";
      handle.lastError = (err as Error).message;
      auditLogger.log({
        timestamp: Date.now(),
        agentId: handle.agentId,
        sessionId: handle.sessionId,
        action: "subagent:failed",
        target: handle.id,
        result: "error",
        detail: (err as Error).message.slice(0, 200),
      });
    } finally {
      clearTimeout(watchdog);
      handle.finishedAt = Date.now();
      this.runningCount--;
      this.abortControllers.delete(handle.id);
      releaseDeny();

      if (pid) {
        processManager.update(pid, { status: handle.status, endedAt: handle.finishedAt } as never);
        if (handle.status !== "idle") {
          processManager.unregister(pid);
          this.pids.delete(handle.id);
        }
      }

      eventBus.broadcast({
        type: handle.status === "idle" ? "subagent/done" : "subagent/failed",
        subagentId: handle.id,
        status: handle.status,
        agentId: handle.agentId,
        summary: handle.summary.slice(0, 200),
        error: handle.lastError,
        rounds: handle.rounds,
        usage: handle.usage,
      });

      // 兼容旧 job/done 事件：idle 映射为 done，并带 resumable 标记让新消费方区分"可续接"
      eventBus.broadcast({
        type: "job/done",
        jobId: handle.id,
        status: handle.status === "idle" ? "done" : "failed",
        agentId: handle.agentId,
        summary: handle.summary.slice(0, 200),
        error: handle.lastError,
        resumable: handle.status === "idle",
      });

      this.pruneDone();
      this.drain();
    }
  }
}

export const subagentRunner = new SubagentRunner();
