/**
 * 智能体基类
 * 所有预置智能体的公共逻辑
 */

import type { AgentConfig, AgentRunResult, PermissionMode, Task, StreamCallbacks } from "../types.js";
import { runAgentLoop, runAgentLoopStream } from "../core/agent-loop.js";
import type { ModelRouter } from "../core/model-router.js";
import type { ContextManager } from "../core/context-manager.js";
import type { SessionStore } from "../memory/session-store.js";
import type { ProcessManager } from "../core/process-manager.js";
import { hookManager } from "../hooks/hook-manager.js";
import { auditLogger } from "../core/audit-logger.js";

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected modelRouter: ModelRouter;
  protected contextManager: ContextManager;
  protected sessionStore: SessionStore;
  protected dataDir?: string;
  protected processManager?: ProcessManager;

  constructor(
    config: AgentConfig,
    deps: {
      modelRouter: ModelRouter;
      contextManager: ContextManager;
      sessionStore: SessionStore;
      dataDir?: string;
      processManager?: ProcessManager;
    },
  ) {
    this.config = config;
    this.modelRouter = deps.modelRouter;
    this.contextManager = deps.contextManager;
    this.sessionStore = deps.sessionStore;
    this.dataDir = deps.dataDir;
    this.processManager = deps.processManager;
  }

  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.displayName;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  setMaxIterations(n: number): void {
    this.config.maxIterations = n;
  }

  getMaxIterations(): number {
    return this.config.maxIterations;
  }

  setMode(mode: PermissionMode): void {
    this.config.permissions.defaultMode = mode;
  }

  getMode(): PermissionMode {
    return this.config.permissions.defaultMode;
  }

  /**
   * 执行任务
   */
  async run(task: Task, workingDir: string): Promise<AgentRunResult> {
    const sessionId =
      task.sessionId ?? this.sessionStore.createSession(this.config.id).id;

    if (task.sessionId) {
      this.sessionStore.ensureSession(sessionId, this.config.id);
    }

    await hookManager.trigger("onMessage", {
      agentId: this.config.id,
      sessionId,
      data: { instruction: task.instruction, mode: task.mode ?? this.config.permissions.defaultMode },
    });

    // 应用任务指定的权限模式
    if (task.mode) {
      this.setMode(task.mode);
    }

    // 持久化用户消息
    this.sessionStore.appendMessage(sessionId, { role: "user", content: task.instruction });

    // 运行循环
    const result = await runAgentLoop(this.config, task.instruction, {
      modelRouter: this.modelRouter,
      contextManager: this.contextManager,
      sessionStore: this.sessionStore,
      sessionId,
      workingDir: task.workingDir ?? workingDir,
      dataDir: this.dataDir,
      toolScope: this.config.id,
      processManager: this.processManager,
    });

    // 持久化助手回复（携带本轮主请求 usage，供轨迹/遥测；来自 loop 显式返回，避免被压缩请求覆盖）
    this.sessionStore.appendMessage(
      sessionId,
      { role: "assistant", content: result.text },
      result.usage,
    );

    // 总结会话并写入 MEMORY.md（有界 ≈2200 字符）
    this.contextManager.summarizeSession(result.messages, task.instruction, sessionId).catch(() => {
      /* 静默失败，不影响主流程 */
    });

    // onTaskComplete Hook — 传入 messages 供 skill evolution 等 handler 使用
    await hookManager.trigger("onTaskComplete", {
      agentId: this.config.id,
      sessionId,
      data: {
        iterations: result.iterations,
        toolCallsExecuted: result.toolCallsExecuted,
        truncated: result.truncated,
        messages: result.messages,
      },
    });

    // 审计
    auditLogger.log({
      timestamp: Date.now(),
      agentId: this.config.id,
      sessionId,
      action: "task_complete",
      result: "success",
      detail: `iterations=${result.iterations}, toolCalls=${result.toolCallsExecuted}`,
    });

    return { ...result, sessionId, messages: [] }; // 不返回完整 messages 避免内存膨胀
  }

  /**
   * 流式执行任务 — 支持 streaming 输出 + 工具回调 + AbortSignal
   */
  async runStream(
    task: Task,
    workingDir: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const sessionId =
      task.sessionId ?? this.sessionStore.createSession(this.config.id).id;

    if (task.sessionId) {
      this.sessionStore.ensureSession(sessionId, this.config.id);
    }

    await hookManager.trigger("onMessage", {
      agentId: this.config.id,
      sessionId,
      data: { instruction: task.instruction, mode: task.mode ?? this.config.permissions.defaultMode },
    });

    if (task.mode) {
      this.setMode(task.mode);
    }

    this.sessionStore.appendMessage(sessionId, { role: "user", content: task.instruction });

    const result = await runAgentLoopStream(
      this.config,
      task.instruction,
      {
        modelRouter: this.modelRouter,
        contextManager: this.contextManager,
        sessionStore: this.sessionStore,
        sessionId,
        workingDir: task.workingDir ?? workingDir,
        dataDir: this.dataDir,
        toolScope: this.config.id,
        processManager: this.processManager,
      },
      callbacks,
      signal,
    );

    if (result.text) {
      this.sessionStore.appendMessage(
        sessionId,
        { role: "assistant", content: result.text },
        result.usage,
      );
    }

    this.contextManager.summarizeSession(result.messages, task.instruction, sessionId).catch(() => {});

    await hookManager.trigger("onTaskComplete", {
      agentId: this.config.id,
      sessionId,
      data: {
        iterations: result.iterations,
        toolCallsExecuted: result.toolCallsExecuted,
        truncated: result.truncated,
        messages: result.messages,
      },
    });

    auditLogger.log({
      timestamp: Date.now(),
      agentId: this.config.id,
      sessionId,
      action: "task_complete",
      result: "success",
      detail: `iterations=${result.iterations}, toolCalls=${result.toolCallsExecuted}`,
    });

    return { ...result, sessionId, messages: [] };
  }
}
