/**
 * Agent 循环 — 系统心脏
 * 设计依据：
 * - Claude Code "简单优先"哲学
 * - HermesAgent 同步循环设计：瓶颈是 LLM 延迟而非 I/O 并发；同步更易调试
 *
 * 核心流程：组装上下文 → 调用模型 → 无工具调用则终止 → 压缩检查 → 执行工具 → 追加结果 → 循环
 */

import type {
  ToolCall,
  ToolResult,
  ToolContext,
  AgentRunResult,
  AgentConfig,
  StreamCallbacks,
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
  projectDir: string;
}

export async function runAgentLoop(
  config: AgentConfig,
  userMessage: string,
  deps: AgentLoopDeps,
): Promise<AgentRunResult> {
  const { modelRouter, contextManager, sessionId, workingDir, projectDir } = deps;

  contextManager.freezeSnapshot();

  let messages = await contextManager.assembleContext(config.systemPrompt, sessionId, userMessage, config.id);

  let iterations = 0;
  const MAX_ITER = config.maxIterations ?? 50;
  let toolCallsExecuted = 0;
  let consecutiveLength = 0;
  let emptyResponseCount = 0;
  const mode = config.permissions.defaultMode;

  const toolCtx: ToolContext = {
    agentId: config.id,
    sessionId,
    workingDir,
    projectDir,
    permissions: mode,
  };

  while (iterations < MAX_ITER) {
    try {
      const { messages: compressed, compressed: didCompress } = await contextManager.maybeCompress(messages);
      if (didCompress) {
        messages = compressed;
      } else if (iterations >= 5 && iterations % 5 === 0) {
        const { messages: forced } = await contextManager.maybeCompress(messages);
        messages = forced;
      }

      const availableTools = await toolRegistry.getAvailableDefinitions(toolCtx);
      const tools = mode === "ask" ? undefined : availableTools;

      const response = await modelRouter.completeWithProfile(config.modelPreference, messages, tools);

      // 模型达到 token 上限导致截断 → 压缩重试（含断路器）
      if (response.finishReason === "length" && !response.hasToolCalls) {
        consecutiveLength++;
        if (consecutiveLength >= 3) {
          return {
            text: response.text || "上下文过长，无法继续",
            messages,
            iterations: iterations + 1,
            truncated: true,
            toolCallsExecuted,
          };
        }
        const { messages: compressed } = await contextManager.maybeCompress(messages);
        messages = compressed;
        iterations++;
        continue;
      }

      if (!response.hasToolCalls) {
        // 空响应保护：模型可能因上下文过长放弃回答
        if (!response.text || response.text.trim().length === 0) {
          emptyResponseCount++;
          if (emptyResponseCount >= 3) {
            return {
              text: "Agent 连续返回空响应，任务可能无法完成",
              messages,
              iterations: iterations + 1,
              truncated: true,
              toolCallsExecuted,
            };
          }
          messages.push({ role: "user", content: "请继续完成任务。如果已完成，请给出总结。" });
          iterations++;
          continue;
        }
        consecutiveLength = 0;
        emptyResponseCount = 0;
        return {
          text: response.text,
          messages,
          iterations: iterations + 1,
          truncated: false,
          toolCallsExecuted,
        };
      }

      messages.push({
        role: "assistant",
        content: response.text,
        tool_calls: response.toolCalls,
      });

      const toolResults = await Promise.all(response.toolCalls.map((tc) => executeTool(tc, toolCtx, config)));

      toolCallsExecuted += toolResults.length;

      for (const result of toolResults) {
        messages.push({
          role: "tool",
          content: result.success ? result.content : `Error: ${result.error}`,
          tool_call_id: result.tool_call_id,
        });
      }

      consecutiveLength = 0;
      emptyResponseCount = 0;
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
 * 流式 Agent 循环 — 逐 token 输出 + AbortSignal 中断 + 工具调用回调
 */
export async function runAgentLoopStream(
  config: AgentConfig,
  userMessage: string,
  deps: AgentLoopDeps,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const { modelRouter, contextManager, sessionId, workingDir, projectDir } = deps;

  contextManager.freezeSnapshot();

  let messages = await contextManager.assembleContext(config.systemPrompt, sessionId, userMessage, config.id);

  let iterations = 0;
  const MAX_ITER = config.maxIterations ?? 50;
  let toolCallsExecuted = 0;
  let consecutiveLength = 0;
  let emptyResponseCount = 0;
  const mode = config.permissions.defaultMode;

  const toolCtx: ToolContext = {
    agentId: config.id,
    sessionId,
    workingDir,
    projectDir,
    permissions: mode,
  };

  while (iterations < MAX_ITER) {
    if (signal?.aborted) {
      return {
        text: "",
        messages,
        iterations,
        truncated: true,
        toolCallsExecuted,
      };
    }

    try {
      const { messages: compressed, compressed: didCompress } = await contextManager.maybeCompress(messages);
      if (didCompress) {
        messages = compressed;
      } else if (iterations >= 5 && iterations % 5 === 0) {
        const { messages: forced } = await contextManager.maybeCompress(messages);
        messages = forced;
      }

      const availableTools = await toolRegistry.getAvailableDefinitions(toolCtx);
      const tools = mode === "ask" ? undefined : availableTools;

      // 流式调用
      callbacks.onIterationStart?.(iterations);
      callbacks.onThinkingStart?.();
      const stream = modelRouter.completeStream(config.modelPreference, messages, tools, { signal });

      let fullText = "";
      let streamFinishReason = "";
      const tcAcc: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        switch (chunk.type) {
          case "thinking":
            callbacks.onThinkingDelta?.(chunk.content!);
            break;
          case "text":
            fullText += chunk.content!;
            callbacks.onTextDelta?.(chunk.content!);
            break;
          case "tool_call_start":
            {
              const acc = { id: chunk.toolCallId!, name: chunk.toolName!, args: "" };
              tcAcc.set(tcAcc.size, acc);
            }
            break;
          case "tool_call_delta":
            // 累积工具调用参数片段
            for (const [, acc] of tcAcc) {
              if (acc.id === chunk.toolCallId) {
                acc.args += chunk.content ?? "";
                break;
              }
            }
            break;
          case "done":
            streamFinishReason = chunk.finishReason ?? "";
            break;
          case "error":
            throw new Error(chunk.error ?? "stream error");
        }
      }

      if (signal?.aborted) {
        return {
          text: fullText,
          messages,
          iterations: iterations + 1,
          truncated: true,
          toolCallsExecuted,
        };
      }

      // 解析工具调用
      if (tcAcc.size > 0) {
        const toolCalls: ToolCall[] = [];
        for (const [, acc] of tcAcc) {
          if (acc.id && acc.name) {
            callbacks.onToolCall?.(acc.name, acc.args, acc.id);
            toolCalls.push({
              id: acc.id,
              type: "function",
              function: { name: acc.name, arguments: acc.args },
            });
          }
        }

        if (toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: fullText,
            tool_calls: toolCalls,
          });

          const toolResults = await Promise.all(toolCalls.map((tc) => executeTool(tc, toolCtx, config)));

          toolCallsExecuted += toolResults.length;

          for (const result of toolResults) {
            const tc = toolCalls.find((t) => t.id === result.tool_call_id);
            const toolName = tc?.function.name ?? "";
            callbacks.onToolResult?.(
              toolName,
              result.success,
              result.success ? result.content.slice(0, 100) : (result.error ?? ""),
              result.tool_call_id,
            );
            messages.push({
              role: "tool",
              content: result.success ? result.content : `Error: ${result.error}`,
              tool_call_id: result.tool_call_id,
            });
          }

          iterations++;
          consecutiveLength = 0;
          emptyResponseCount = 0;
          continue;
        }
      }

      // 纯文本响应 — 空响应保护 + finish_reason 检查
      if (streamFinishReason === "length") {
        consecutiveLength++;
        if (consecutiveLength >= 3) {
          return {
            text: fullText || "上下文过长，无法继续",
            messages,
            iterations: iterations + 1,
            truncated: true,
            toolCallsExecuted,
          };
        }
        const { messages: compressed } = await contextManager.maybeCompress(messages);
        messages = compressed;
        iterations++;
        continue;
      }

      if (!fullText || fullText.trim().length === 0) {
        emptyResponseCount++;
        if (emptyResponseCount >= 3) {
          return {
            text: "Agent 连续返回空响应，任务可能无法完成",
            messages,
            iterations: iterations + 1,
            truncated: true,
            toolCallsExecuted,
          };
        }
        messages.push({ role: "user", content: "请继续完成任务。如果已完成，请给出总结。" });
        iterations++;
        continue;
      }

      consecutiveLength = 0;
      emptyResponseCount = 0;
      return {
        text: fullText,
        messages,
        iterations: iterations + 1,
        truncated: false,
        toolCallsExecuted,
      };
    } catch (err) {
      if (signal?.aborted) {
        return {
          text: "",
          messages,
          iterations,
          truncated: true,
          toolCallsExecuted,
        };
      }
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
        detail: `iteration=${iterations}, toolCalls=${toolCallsExecuted}`,
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

async function executeTool(toolCall: ToolCall, ctx: ToolContext, config: AgentConfig): Promise<ToolResult> {
  const toolName = toolCall.function.name;

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

  const handler = toolRegistry.getHandler(toolName);
  if (!handler) {
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `工具 ${toolName} 未注册`,
    };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
    args = coerceToolArgs(args);
  } catch (err) {
    return {
      tool_call_id: toolCall.id,
      success: false,
      content: "",
      error: `工具 ${toolName} 参数解析失败: ${(err as Error).message}。原始参数: ${toolCall.function.arguments.slice(0, 200)}`,
    };
  }

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

  await hookManager.trigger("onToolCallPost", {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    data: { toolName, args, result: { success: result.success, content: result.content.slice(0, 200) } },
  });

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

function coerceToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      if (value === "true") {
        coerced[key] = true;
      } else if (value === "false") {
        coerced[key] = false;
      } else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && value !== "") {
        // Only coerce strings that look like numbers in standard JSON form
        const num = parseFloat(value);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
          coerced[key] = num;
        } else {
          coerced[key] = value;
        }
      } else {
        coerced[key] = value;
      }
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}
