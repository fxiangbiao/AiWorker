/**
 * 子智能体控制工具（Sprint 52 T2）— spawn_agent / send_message / list_agents / interrupt_agent
 * 受限工具：仅主智能体可见（filterVisibleTools 按 restricted 标记过滤）
 */

import type { ToolDefinition, ToolHandler, ToolContext, ToolResult } from "../types.js";
import { subagentRunner } from "./subagent-runner.js";
import { WORKER_SESSION_PREFIX } from "../memory/session-store.js";
import { toolRegistry } from "./tool-registry.js";
import { auditLogger } from "./audit-logger.js";
import { isRestrictedTool } from "./subagent-rules.js";

export { isRestrictedTool };

const spawnAgentDef: ToolDefinition = {
  type: "function",
  function: {
    name: "spawn_agent",
    description:
      "起一个后台子智能体执行独立任务（可续接、可中断、可观测）。" +
      "何时用：用户要求并行处理多个独立对象时（多方案/多产品/多版本的调研对比、多数据源分析、多文件审查），**为每个对象各调用一次**，" +
      "而不是自己串行跑完全部对象；单对象或轻量任务不必使用。" +
      "参数：agentId 为专家 id（如 research/default/coding），task 为该对象的完整任务描述（子智能体看不到本会话上下文）。" +
      "默认只读（readOnly 缺省 true，工具面收窄为 fs_read/fs_list/web_search/web_fetch）；readOnly:false 可写但要用户逐次确认（本工具在永不自动批准清单内，每次调用都需确认）。" +
      "返回子智能体 id，随后用 list_agents 看进度、send_message 追问、interrupt_agent 中断。" +
      "注意：无确认通道（headless / 子智能体内部）时不可用。",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "专家 id（如 default/research/coding）" },
        task: { type: "string", description: "任务描述" },
        readOnly: { type: "boolean", description: "是否只读（默认 true）" },
      },
      required: ["agentId", "task"],
    },
  },
};

const sendMessageDef: ToolDefinition = {
  type: "function",
  function: {
    name: "send_message",
    description: "向运行中或空闲的子智能体追加一轮消息。运行中时入 pending 队列（上限 5），空闲时起新轮。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "子智能体 id" },
        message: { type: "string", description: "追加的消息" },
      },
      required: ["id", "message"],
    },
  },
};

const listAgentsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "list_agents",
    description: "列出当前会话的子智能体状态（id/agentId/status/task/rounds/usage/summary）。仅主智能体可见；只能查本会话。",
    parameters: {
      type: "object",
      properties: {
        parentSessionId: { type: "string", description: "父会话 id（仅允许传当前会话，其他会话会被拒绝）" },
      },
    },
  },
};

const interruptAgentDef: ToolDefinition = {
  type: "function",
  function: {
    name: "interrupt_agent",
    description: "中断运行中的子智能体并保留会话（状态变 idle，pending 清空）。中断后可 send_message 续接。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "子智能体 id" },
      },
      required: ["id"],
    },
  },
};

function ok(content: string): ToolResult {
  return { tool_call_id: "", success: true, content };
}

function fail(error: string): ToolResult {
  return { tool_call_id: "", success: false, content: "", error };
}

/** 纵深防御：子智能体（wk- 会话）不得调用任何控制类工具（可见性校验之外的执行层兜底） */
function rejectWorkerCall(name: string, ctx: ToolContext, args: Record<string, unknown>): ToolResult | null {
  if (!ctx.sessionId.startsWith(WORKER_SESSION_PREFIX)) return null;
  auditLogger.log({
    timestamp: Date.now(),
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    action: `tool:${name}`,
    target: JSON.stringify(args).slice(0, 200),
    result: "blocked",
    detail: "深度 1 硬校验：子智能体禁止调用控制类工具",
  });
  return fail("子智能体禁止调用控制类工具（深度限制）");
}

const spawnAgentHandler: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const rejected = rejectWorkerCall("spawn_agent", ctx, args);
  if (rejected) return rejected;

  const agentId = String(args.agentId ?? "");
  const task = String(args.task ?? "");
  const readOnly = args.readOnly !== false;

  if (!agentId || !task) {
    return fail("缺少 agentId 或 task");
  }

  try {
    const id = subagentRunner.spawn(agentId, task, {
      parentSessionId: ctx.sessionId,
      readOnly,
    });
    return ok(`子智能体已启动: ${id}`);
  } catch (err) {
    return fail((err as Error).message);
  }
};

const sendMessageHandler: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const rejected = rejectWorkerCall("send_message", ctx, args);
  if (rejected) return rejected;

  const id = String(args.id ?? "");
  const message = String(args.message ?? "");
  if (!id || !message) return fail("缺少 id 或 message");

  const h = subagentRunner.get(id);
  if (!h) return fail(`子智能体 ${id} 不存在`);
  if (h.parentSessionId !== ctx.sessionId) {
    return fail("无权操作非本会话的子智能体");
  }

  const sent = subagentRunner.send(id, message);
  if (!sent) {
    if (h.status === "failed") return fail(`子智能体 ${id} 已失败，无法续接`);
    return fail("发送失败（pending 已满或状态不允许）");
  }
  return ok(`消息已发送至 ${id}`);
};

const listAgentsHandler: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const rejected = rejectWorkerCall("list_agents", ctx, args);
  if (rejected) return rejected;

  // 归属校验（与 send/interrupt 一致）：只允许查本会话，防止提示注入下横向读取别的会话的任务原文/摘要
  const requested = typeof args.parentSessionId === "string" && args.parentSessionId ? args.parentSessionId : undefined;
  if (requested && requested !== ctx.sessionId) {
    return fail("无权查询其他会话的子智能体");
  }
  const list = subagentRunner.list(ctx.sessionId);
  const summary = list.map((h) => ({
    id: h.id,
    agentId: h.agentId,
    status: h.status,
    task: h.task.slice(0, 100),
    rounds: h.rounds,
    usage: h.usage,
    summary: h.summary.slice(0, 100),
    abortRequested: h.abortRequested,
  }));
  return ok(JSON.stringify(summary, null, 2));
};

const interruptAgentHandler: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const rejected = rejectWorkerCall("interrupt_agent", ctx, args);
  if (rejected) return rejected;

  const id = String(args.id ?? "");
  if (!id) return fail("缺少 id");

  const h = subagentRunner.get(id);
  if (!h) return fail(`子智能体 ${id} 不存在`);
  if (h.parentSessionId !== ctx.sessionId) {
    return fail("无权操作非本会话的子智能体");
  }

  const interrupted = subagentRunner.interrupt(id);
  if (!interrupted) return fail(`中断失败（状态 ${h.status} 不允许）`);
  return ok(`子智能体 ${id} 已中断`);
};

export function registerSubagentTools(): void {
  const tools: Array<{ def: ToolDefinition; handler: ToolHandler }> = [
    { def: spawnAgentDef, handler: spawnAgentHandler },
    { def: sendMessageDef, handler: sendMessageHandler },
    { def: listAgentsDef, handler: listAgentsHandler },
    { def: interruptAgentDef, handler: interruptAgentHandler },
  ];

  for (const { def, handler } of tools) {
    toolRegistry.register(def.function.name, def, handler, { enabled: true });
  }
}
