/**
 * 上下文压缩器
 * 设计依据：Claude Code 实证——92% 阈值触发自动压缩
 *
 * Sprint 44：压缩预算窗口与模型物理窗口分离——
 * 本压缩器按 COMPRESS_BUDGET（成本护栏，默认 32768）工作；
 * 模型真实 contextWindow 只用于展示与真实溢出保护，不影响压缩触发时机。
 * 溢出保护（review 补充）：物理窗口小于预算时（如本地 16384 窗口模型），
 * 调用方可传 budget=物理窗口，触发阈值与压缩保留目标随之收紧，避免请求在超窗后仍不压缩。
 */

import type { Message, ModelProvider } from "../types.js";
import { estimateText } from "../core/token-estimate.js";

/** 压缩预算窗口（成本护栏，不随模型 contextWindow 变化；可经构造参数覆盖） */
const COMPRESS_BUDGET = 32768;
const COMPRESS_THRESHOLD = 0.75; // 75% 触发压缩
const KEEP_TARGET_RATIO = 0.35; // 压缩后近期上下文目标占比
const MIN_KEEP_TURNS = 3; // 最少保留轮次（保证基本连贯性）
const MAX_KEEP_TURNS = 8; // 最多保留轮次（防止膨胀）

/** 归一化消息文本（content 兼容 string 与多模态内容数组，review F8：防 .slice 对数组崩溃） */
function textOf(m: Pick<Message, "content">): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
}

/**
 * 按用户轮次拆分对话，返回轮次边界索引列表
 * 每个 user 消息标志一个新轮次的开始，轮次内 assistant+tool 不可分割
 */
function findTurnBoundaries(conversation: Message[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (conversation[i].role === "user") {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/** 估算消息列表 token（遍历文本 + tool_calls 参数字符；共享 estimateText 启发式） */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateText(textOf(msg));
    if (msg.tool_calls) total += estimateText(JSON.stringify(msg.tool_calls));
  }
  return total;
}

export interface CompressResult {
  compressed: boolean;
  originalTokens: number;
  compressedTokens: number;
  summary?: string;
}

export class ContextCompressor {
  private modelProvider?: ModelProvider;
  private threshold: number;
  private budgetWindow: number;

  constructor(modelProvider?: ModelProvider, threshold = COMPRESS_THRESHOLD, budgetWindow = COMPRESS_BUDGET) {
    this.modelProvider = modelProvider;
    this.threshold = threshold;
    this.budgetWindow = budgetWindow;
  }

  /** 有效预算窗口（review F1：物理窗口小于成本预算时收紧，避免本地小窗口模型超窗不压缩） */
  private effectiveBudget(window?: number): number {
    if (typeof window === "number" && Number.isFinite(window) && window > 0 && window < this.budgetWindow) {
      return window;
    }
    return this.budgetWindow;
  }

  /** 计算上下文使用率（0~1，相对预算窗口；window 缺省用成本预算） */
  getUsage(messages: Message[], window?: number): number {
    return estimateMessagesTokens(messages) / this.effectiveBudget(window);
  }

  /** 检查是否需要压缩（window 缺省用成本预算） */
  needsCompression(messages: Message[], window?: number): boolean {
    return this.getUsage(messages, window) > this.threshold;
  }

  /**
   * 压缩上下文
   * 策略：保留系统提示 + 最近 N 条，中间历史用 LLM 摘要替代
   * @param scope 会话归属（可选；带 scope 时压缩摘要请求计入该会话账本；loop 外摘要 fire-and-forget 不传）
   * @param window 物理窗口覆盖（可选；<成本预算时按物理窗口收紧触发阈值与保留目标）
   */
  async compress(messages: Message[], scope?: string, window?: number): Promise<{ messages: Message[]; result: CompressResult }> {
    return this.doCompress(messages, scope, window);
  }

  private async doCompress(messages: Message[], scope?: string, window?: number): Promise<{ messages: Message[]; result: CompressResult }> {
    const budget = this.effectiveBudget(window);
    const originalTokens = estimateMessagesTokens(messages);

    // 分离系统消息和对话历史
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");

    // 按用户轮次划分——每个 user 消息标志新轮次，轮次内不可分割
    const boundaries = findTurnBoundaries(conversation);
    const targetTokens = Math.floor(budget * KEEP_TARGET_RATIO);

    // 从后往前累加完整轮次，直到达到 token 预算
    let keepTurns = 0;
    let keepTokens = 0;
    for (let t = boundaries.length - 1; t >= 0; t--) {
      const turnStart = boundaries[t];
      const turnEnd = t < boundaries.length - 1 ? boundaries[t + 1] : conversation.length;
      const turnMsgs = conversation.slice(turnStart, turnEnd);
      keepTokens += estimateMessagesTokens(turnMsgs);
      keepTurns++;
      if (keepTokens >= targetTokens && keepTurns >= MIN_KEEP_TURNS) break;
      if (keepTurns >= MAX_KEEP_TURNS) break;
    }
    keepTurns = Math.max(MIN_KEEP_TURNS, keepTurns);

    if (boundaries.length <= keepTurns) {
      return {
        messages,
        result: { compressed: false, originalTokens, compressedTokens: originalTokens },
      };
    }

    const splitIdx = boundaries[boundaries.length - keepTurns];
    const toCompress = conversation.slice(0, splitIdx);
    const toKeep = conversation.slice(splitIdx);

    let summary: string;

    if (this.modelProvider) {
      try {
        summary = await this.generateSummary(toCompress, scope);
      } catch {
        summary = this.simpleSummary(toCompress);
      }
    } else {
      summary = this.simpleSummary(toCompress);
    }

    const summaryMessage: Message = {
      role: "system",
      content: `[历史对话摘要]\n${summary}`,
    };

    const compressed = [...systemMessages, summaryMessage, ...toKeep];
    const compressedTokens = estimateMessagesTokens(compressed);

    return {
      messages: compressed,
      result: {
        compressed: true,
        originalTokens,
        compressedTokens,
        summary,
      },
    };
  }

  private async generateSummary(messages: Message[], scope?: string): Promise<string> {
    if (!this.modelProvider) return this.simpleSummary(messages);

    const summaryRequest: Message[] = [
      {
        role: "system",
        content:
          "你是一个对话压缩器。将以下对话历史压缩为简洁的摘要，保留关键决策、工具调用结果和用户意图。不要丢失重要细节。",
      },
      {
        role: "user",
        content: messages.map((m) => `[${m.role}]: ${textOf(m).slice(0, 500)}`).join("\n\n"),
      },
    ];

    const response = await this.modelProvider({
      model: "",
      messages: summaryRequest,
      temperature: 0.3,
      maxTokens: 1024,
      ...(scope ? { scope } : {}),
    });

    return response.text;
  }

  private simpleSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const toolMessages = messages.filter((m) => m.role === "tool");
    return (
      `历史包含 ${userMessages.length} 条用户消息和 ${toolMessages.length} 条工具结果。` +
      `用户最近意图: ${textOf(userMessages[userMessages.length - 1] ?? { content: "" }).slice(0, 200) ?? "N/A"}`
    );
  }
}
