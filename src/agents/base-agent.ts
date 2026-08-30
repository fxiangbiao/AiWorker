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
import { skillRegistry } from "../core/skill-registry.js";

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
    // 拷贝配置：避免修改共享默认（如内置 agent 的模块级 config）与污染后续实例
    this.config = {
      ...config,
      tools: [...config.tools],
      mcpServers: [...config.mcpServers],
      skills: config.skills ? [...config.skills] : [],
      plugins: config.plugins ? [...config.plugins] : [],
      permissions: {
        defaultMode: config.permissions.defaultMode,
        allowedTools: [...config.permissions.allowedTools],
        deniedTools: [...config.permissions.deniedTools],
      },
    };
    this.modelRouter = deps.modelRouter;
    this.contextManager = deps.contextManager;
    this.sessionStore = deps.sessionStore;
    this.dataDir = deps.dataDir;
    this.processManager = deps.processManager;
  }

  /** 绑定技能注入：按 config.skills 声明查技能，拼段进 systemPrompt（每次执行前调用，技能更新即时生效）。
   * 用 marker 定位替换：即使配置被持久化过（systemPrompt 已含技能段），也替换而非追加，避免重复 */
  protected applyDeclaredSkills(): void {
    const declared = this.config.skills ?? [];
    if (declared.length === 0) return;
    const list = declared
      .map((name) => skillRegistry.getAll().find((s) => s.name.toLowerCase() === name.toLowerCase()))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    if (list.length === 0) return;
    const MARKER_START = "-- 绑定技能 --";
    const MARKER_END = "-- 绑定技能结束 --";
    const section =
      `\n\n${MARKER_START}\n` +
      list.map((s) => `### ${s.name}\n${s.body.slice(0, 1200)}`).join("\n\n") +
      `\n${MARKER_END}`;
    const startIdx = this.config.systemPrompt.indexOf(MARKER_START);
    const endIdx = startIdx >= 0 ? this.config.systemPrompt.indexOf(MARKER_END, startIdx) : -1;
    if (startIdx >= 0 && endIdx >= 0) {
      this.config.systemPrompt =
        this.config.systemPrompt.slice(0, Math.max(0, startIdx - 2)) + section + this.config.systemPrompt.slice(endIdx + MARKER_END.length);
    } else {
      this.config.systemPrompt += section;
    }
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
    this.applyDeclaredSkills();
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

    // 持久化用户消息（图片仅当轮上下文，历史存文本）
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
      images: task.images,
      explicitSkill: task.explicitSkill,
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
    this.applyDeclaredSkills();
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
        images: task.images,
        explicitSkill: task.explicitSkill,
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
