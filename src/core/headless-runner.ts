/**
 * headless 运行器 — 一次性执行（-p），输出 text / json / stream-json，返回稳定退出码
 * 非交互安全语义：确认通道与提问通道均立即失败（fail-closed），绝不挂起等待输入
 */

import { setConfirmProvider } from "../hooks/confirm-channel.js";
import { setAskProvider } from "../tools/ask-channel.js";
import { routeToExpert } from "../agents/router.js";
import type { BaseAgent } from "../agents/base-agent.js";
import type { AgentRunResult, PermissionMode, StreamCallbacks } from "../types.js";

export type HeadlessOutputFormat = "text" | "json" | "stream-json";

const OUTPUT_FORMATS: readonly string[] = ["text", "json", "stream-json"];
const MODES: readonly string[] = ["ask", "plan", "auto"];

/** 工具结果中的"权限拦截"特征（approval-service / hooks 的失败文案） */
const PERMISSION_DENIED_RE = /操作被拦截|规则拒绝|只读，不允许|权限模式\(.+\)不允许|用户取消操作|永不自动批准|受保护路径/;

export interface HeadlessCliInput {
  print?: unknown;
  outputFormat?: unknown;
  session?: unknown;
  agent?: unknown;
  mode?: unknown;
  maxIterations?: unknown;
  yes?: unknown;
}

export interface HeadlessCliResolved {
  prompt: string;
  outputFormat: HeadlessOutputFormat;
  sessionId?: string;
  agentId?: string;
  mode?: PermissionMode;
  maxIterations?: number;
  allowAll: boolean;
}

/** CLI 参数解析与校验（纯函数，便于单测；退出码 2 的错误来源） */
export function resolveHeadlessCli(
  input: HeadlessCliInput,
): { ok: true; value: HeadlessCliResolved } | { ok: false; error: string } {
  if (typeof input.print !== "string" || input.print.trim().length === 0) {
    return { ok: false, error: "缺少提示词：请用 -p/--print \"<prompt>\" 指定要执行的任务" };
  }
  const formatRaw = input.outputFormat === undefined || input.outputFormat === "" ? "text" : input.outputFormat;
  if (typeof formatRaw !== "string" || !OUTPUT_FORMATS.includes(formatRaw)) {
    return { ok: false, error: `未知输出格式「${String(formatRaw)}」：可选 text | json | stream-json` };
  }
  if (input.mode !== undefined && input.mode !== "" && (typeof input.mode !== "string" || !MODES.includes(input.mode))) {
    return { ok: false, error: `未知权限模式「${String(input.mode)}」：可选 ask | plan | auto` };
  }
  let maxIterations: number | undefined;
  if (input.maxIterations !== undefined && input.maxIterations !== "") {
    const n = Number(input.maxIterations);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `迭代上限需为正整数，收到「${String(input.maxIterations)}」` };
    }
    maxIterations = n;
  }
  const value: HeadlessCliResolved = {
    prompt: input.print.trim(),
    outputFormat: formatRaw as HeadlessOutputFormat,
    allowAll: input.yes === true,
  };
  if (typeof input.session === "string" && input.session.trim()) value.sessionId = input.session.trim();
  if (typeof input.agent === "string" && input.agent.trim()) value.agentId = input.agent.trim();
  if (typeof input.mode === "string" && MODES.includes(input.mode)) value.mode = input.mode as PermissionMode;
  if (maxIterations !== undefined) value.maxIterations = maxIterations;
  return { ok: true, value };
}

export interface HeadlessConfig extends HeadlessCliResolved {
  mode: PermissionMode;
  workingDir: string;
}

export interface HeadlessDeps {
  agents: Record<string, BaseAgent>;
  model: string;
  write(text: string): void;
  writeErr(text: string): void;
  signal?: AbortSignal;
}

export interface HeadlessOutcome {
  exitCode: number;
  /** 被 fail-closed 拒绝的确认请求（标题 + 原因） */
  denied: { title: string; message: string }[];
  result?: AgentRunResult;
}

/**
 * 执行一次 headless 运行并返回退出码
 * 0 成功 / 1 运行失败 / 2 参数（无匹配智能体）/ 3 权限拒绝 / 4 达迭代上限 / 130 中断
 */
export async function runHeadless(config: HeadlessConfig, deps: HeadlessDeps): Promise<number> {
  const outcome = await runHeadlessDetailed(config, deps);
  return outcome.exitCode;
}

export async function runHeadlessDetailed(config: HeadlessConfig, deps: HeadlessDeps): Promise<HeadlessOutcome> {
  const format = config.outputFormat;
  const emit = (payload: Record<string, unknown>): void => {
    if (format === "stream-json") deps.write(`${JSON.stringify(payload)}\n`);
  };

  const agentId = config.agentId ?? routeToExpert(config.prompt);
  const agent = deps.agents[agentId];
  if (!agent) {
    const message = config.agentId ? `智能体不存在: ${config.agentId}` : `无可用智能体（路由结果: ${agentId}）`;
    emit({ type: "error", code: "bad_agent", message });
    deps.writeErr(`✗ ${message}\n`);
    return { exitCode: 2, denied: [] };
  }

  agent.setMode(config.mode);
  if (config.maxIterations !== undefined) agent.setMaxIterations(config.maxIterations);

  const denied: { title: string; message: string }[] = [];
  const permissionFailures: string[] = [];
  let textStreamed = false;

  const previousConfirm = setConfirmProvider(async (req) => {
    denied.push({ title: req.title, message: req.message });
    emit({ type: "confirm_denied", title: req.title, message: req.message, reason: "非交互模式无确认通道" });
    deps.writeErr(`⚠ 需要确认但 headless 无确认通道，已按 fail-closed 拒绝：${req.title} — ${req.message}\n`);
    return null;
  });
  const previousAsk = setAskProvider(async (req) => {
    emit({ type: "ask_unavailable", question: req.question });
    deps.writeErr(`⚠ headless 无法回答提问（ask_user）：${req.question}\n`);
    return null;
  });

  emit({
    type: "system",
    sessionId: config.sessionId ?? null,
    model: deps.model,
    mode: config.mode,
    agent: agent.getId(),
    workingDir: config.workingDir,
  });

  const callbacks: StreamCallbacks = {
    onThinkingDelta: (text) => emit({ type: "thinking", delta: text }),
    onTextDelta: (text) => {
      if (format === "text") {
        textStreamed = true;
        deps.write(text);
      } else if (format === "stream-json") {
        emit({ type: "text", delta: text });
      }
    },
    onToolCall: (name, args, id) => {
      emit({ type: "tool_call", id, name, args });
      if (format === "text") deps.writeErr(`[工具] ${name}\n`);
    },
    onToolResult: (name, success, summary, id) => {
      emit({ type: "tool_result", id: id ?? null, name, success, summary });
      if (!success) {
        if (PERMISSION_DENIED_RE.test(summary)) permissionFailures.push(summary);
        if (format === "text") deps.writeErr(`[工具失败] ${name}: ${summary}\n`);
      }
    },
  };

  let result: AgentRunResult | undefined;
  let failure: Error | undefined;
  try {
    result = await agent.runStream(
      {
        instruction: config.prompt,
        mode: config.mode,
        workingDir: config.workingDir,
        sessionId: config.sessionId,
      },
      config.workingDir,
      callbacks,
      deps.signal,
    );
  } catch (err) {
    failure = err as Error;
  } finally {
    setConfirmProvider(previousConfirm);
    setAskProvider(previousAsk);
  }

  if (deps.signal?.aborted) {
    emit({ type: "error", code: "aborted", message: "已中断" });
    deps.writeErr("⏹ 已中断\n");
    return { exitCode: 130, denied, result };
  }

  // agent-loop 把循环内异常折成 text（"Agent 循环异常: …"）；headless 需据此判定失败，
  // 否则脚本会把连接失败/模型错误当成成功结果（result.error 由 agent-loop 显式给出）
  const runError = failure ? failure.message : (result?.error ?? null);
  const blocked = !runError && (denied.length > 0 || permissionFailures.length > 0);
  const truncated = !runError && result?.truncated === true;

  if (format === "text") {
    if (!runError) {
      if (!textStreamed && result?.text) deps.write(result.text);
      deps.write("\n");
    }
  }
  // 失败原因同时给 stderr 一份（json/stream-json 下 stdout 只放结构化载荷，人看日志靠 stderr）
  if (runError) deps.writeErr(`✗ 执行失败: ${runError}\n`);

  const payload = {
    type: "result",
    text: runError ? "" : (result?.text ?? ""),
    error: runError,
    sessionId: result?.sessionId ?? config.sessionId ?? null,
    iterations: result?.iterations ?? 0,
    toolCalls: result?.toolCallsExecuted ?? 0,
    usage: result?.usage ?? null,
    truncated,
    permissionDenied: blocked,
  };
  if (format === "json") {
    deps.write(`${JSON.stringify(payload)}\n`);
  } else if (format === "stream-json") {
    emit(payload);
  }

  const exitCode = runError ? 1 : blocked ? 3 : truncated ? 4 : 0;
  if (exitCode === 3) {
    deps.writeErr(
      `⚠ 本次运行出现权限拒绝（${denied.length} 次确认被拒 / ${permissionFailures.length} 次工具被拦截）；可在 config/permissions.json 写 allow 规则，或用 --yes 显式放行（仍不覆盖 deny 规则与受保护路径）\n`,
    );
  } else if (exitCode === 4) {
    deps.writeErr("⚠ 达到迭代上限，结果可能不完整（可用 --max-iterations 提高上限）\n");
  }

  return { exitCode, denied, result };
}
