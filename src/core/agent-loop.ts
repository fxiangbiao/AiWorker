/**
 * Agent 循环 — 系统心脏
 * 设计依据：
 * - Claude Code "简单优先"哲学
 * - HermesAgent 同步循环设计：瓶颈是 LLM 延迟而非 I/O 并发；同步更易调试
 *
 * 核心流程：组装上下文 → 调用模型 → 无工具调用则终止 → 压缩检查 → 执行工具 → 追加结果 → 循环
 */

import type {
  Message,
  ToolCall,
  ToolResult,
  ToolContext,
  AgentRunResult,
  AgentConfig,
  PermissionMode,
} from "../types.js";
import type { ModelRouter } from "./model-router.js";
import type { ContextManager } from "./context-manager.js";
import { toolRegistry } from "./tool-registry.js";
import { hookManager } from "../hooks/hook-manager.js";
import { auditLogger } from "./audit-logger.js";

export interface AgentLoopDeps {
  modelRouter: ModelRouter;
  contextManager: ContextManager;
  sessionId: string;
  workingDir: string;
}

/**
 * 执行单次 Agent 循环
 */
export async function runAgentLoop(
  config: AgentConfig,
  userMessage: string,
  deps: AgentLoopDeps
): Promise<AgentRunResult> {
  const { modelRouter, contextManager, sessionId, workingDir } = deps;

  // 冻结快照：会话开始时捕获，保证前缀缓存有效
  contextManager.freezeSnapshot();

  // 组装上下文
  let messages = await contextManager.assembleContext(
    config.systemPrompt,
    sessionId,
    userMessage,
    config.id
  );

  // 持久化用户消息
  // (sessionStore.appendMessage 由调用方处理，这里只管循环)

  let iterations = 0;
  const MAX_ITER = config.maxIterations ?? 50;
  let toolCallsExecuted = 0;
  const mode = config.permissions.defaultMode;

  const toolCtx: ToolContext = {
    agentId: config.id,
    sessionId,
    workingDir,
    permissions: mode,
  };

  while (iterations < MAX_ITER) {
    try {
      // 压缩检查 (92% 阈值)
      const { messages: compressed, compressed: didCompress } =
        await contextManager.maybeCompress(messages);
      if (didCompress) {
        messages = compressed;
      }

      // 获取可用工具
      const availableTools = await toolRegistry.getAvailableDefinitions(toolCtx);

      // 根据权限模式决定是否传工具
      const tools = mode === "ask" ? undefined : availableTools;

      // 1. 调用模型
      const response = await modelRouter.completeWithProfile(
        config.modelPreference,
        messages,
        tools
      );

      // 2. 无工具调用 → 循环自然终止
      if (!response.hasToolCalls) {
        return {
          text: response.text,
          messages,
          iterations: iterations + 1,
          truncated: false,
          toolCallsExecuted,
        };
      }

      // 3. 追加 assistant 消息 (含 tool_calls)
      messages.push({
        role: "assistant",
        content: response.text,
        tool_calls: response.toolCalls,
      });

      // 4. 执行工具调用 (可并行)
      const toolResults = await Promise.all(
        response.toolCalls.map((tc) => executeTool(tc, toolCtx, config))
      );

      toolCallsExecuted += toolResults.length;

      // 5. 追加结果到消息历史
      for (const result of toolResults) {
        messages.push({
          role: "tool",
          content: result.success ? result.content : `Error: ${result.error}`,
          tool_call_id: result.tool_call_id,
        });
      }

      iterations++;
    } catch (err) {
      const errorMsg = (err as Error).message;
      await hookManager.trigger("onError", {
        agentId: config.id,
        sessionId,
        data: { error: errorMsg, iteration: iterations },
      });

      auditLogger.log({
        timestamp: Date.now(),
        agentId: config.id,
        sessionId,
        action: "loop_error",
        target: errorMsg.slice(0, 200),
        result: "error",
        detail: `iteration=${iterations}`,
      });

      return {
        text: `Agent 循环异常: ${errorMsg}`,
        messages,
        iterations: iterations + 1,
        truncated: false,
        toolCallsExecuted,
      };
    }
  }

  return {
    text: "达到迭代上限",
    messages,
    iterations,
    truncated: true,
    toolCallsExecuted,
  };
}

/**
 * 执行单个工具调用
 * 包含 Hooks 拦截 + 危险检测 + 审计日志
 */
async function executeTool(
  toolCall: ToolCall,
  ctx: ToolContext,
  config: AgentConfig
): Promise<ToolResult> {
  const toolName = toolCall.function.name;

  // onToolCallPre Hook
  const preHookResult = await hookManager.trigger("onToolCallPre", {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    data: { toolName, args: toolCall.function.arguments, permissions: ctx.permissions },
  });

  if (!preHookResult.proceed) {
    auditLogger.log({
      timestamp: Date.now(),
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      action: `tool:${toolName}`,
      target: toolCall.function.arguments,
      result: "blocked",
      detail: preHookResult.message ?? "被 Hook 拦截",
    });
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `操作被拦截: ${preHookResult.message ?? "Hook 拦截"}`,
    };
  }

  // 检查工具是否在允许列表
  if (
    config.permissions.allowedTools.length > 0 &&
    !config.permissions.allowedTools.includes(toolName) &&
    !config.permissions.allowedTools.includes("*")
  ) {
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `工具 ${toolName} 不在允许列表中`,
    };
  }

  if (config.permissions.deniedTools.includes(toolName)) {
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `工具 ${toolName} 被禁用`,
    };
  }

  // 获取处理器
  const handler = toolRegistry.getHandler(toolName);
  if (!handler) {
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `工具 ${toolName} 未注册`,
    };
  }

  // 解析参数 (带 coerce)
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
    args = coerceToolArgs(args);
  } catch {
    args = {};
  }

  // 执行
  let result: ToolResult;
  try {
    result = await handler(args, ctx);
    result.tool_call_id = toolCall.id;
  } catch (err) {
    result = {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: (err as Error).message,
    };
  }

  // onToolCallPost Hook
  await hookManager.trigger("onToolCallPost", {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    data: { toolName, args, result: { success: result.success, content: result.content.slice(0, 200) } },
  });

  // 审计日志
  auditLogger.log({
    timestamp: Date.now(),
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    action: `tool:${toolName}`,
    target: toolCall.function.arguments.slice(0, 200),
    result: result.success ? "success" : "error",
    detail: result.success ? result.content.slice(0, 200) : result.error,
  });

  return result;
}

/**
 * 参数强转 — HermesAgent coerce_tool_args()
 * LLM 返回字符串与 JSON Schema 比对自动强转
 */
function coerceToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      // 尝试转 number
      if (/^-?\d+\.?\d*$/.test(value) && value !== "") {
        coerced[key] = parseFloat(value);
      } else if (value === "true") {
        coerced[key] = true;
      } else if (value === "false") {
        coerced[key] = false;
      } else {
        coerced[key] = value;
      }
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}
