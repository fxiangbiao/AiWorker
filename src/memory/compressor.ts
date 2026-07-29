/**
 * 上下文压缩器
 * 设计依据：Claude Code 实证——92% 阈值触发自动压缩
 */

import type { Message, ModelProvider } from "../types.js";

const CONTEXT_WINDOW = 128000; // 默认上下文窗口大小
const COMPRESS_THRESHOLD = 0.92; // 92% 触发压缩

function calcKeepRecent(totalCount: number): number {
  return Math.max(4, Math.min(20, Math.ceil(totalCount * 0.2)));
}

// 粗略 token 估算 (英文 ~4 字符/token，中文 ~2 字符/token)
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length;
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
  }
  return Math.ceil(chars / 3.5); // 混合估算
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

  constructor(modelProvider?: ModelProvider, threshold = COMPRESS_THRESHOLD) {
    this.modelProvider = modelProvider;
    this.threshold = threshold;
  }

  /** 计算上下文使用率 (0~1) */
  getUsage(messages: Message[]): number {
    const tokens = estimateTokens(messages);
    return tokens / CONTEXT_WINDOW;
  }

  /** 检查是否需要压缩 */
  needsCompression(messages: Message[]): boolean {
    return this.getUsage(messages) > this.threshold;
  }

  /**
   * 压缩上下文
   * 策略：保留系统提示 + 最近 N 条，中间历史用 LLM 摘要替代
   */
  async compress(messages: Message[]): Promise<{ messages: Message[]; result: CompressResult }> {
    const originalTokens = estimateTokens(messages);
    const keepCount = calcKeepRecent(messages.length);

    if (messages.length <= keepCount + 1) {
      return {
        messages,
        result: { compressed: false, originalTokens, compressedTokens: originalTokens },
      };
    }

    // 分离系统消息和对话历史
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");

    // 保留最近的对话
    const toCompress = conversation.slice(0, conversation.length - keepCount);
    const toKeep = conversation.slice(conversation.length - keepCount);

    let summary = "";

    if (this.modelProvider) {
      // 用 LLM 生成摘要
      summary = await this.generateSummary(toCompress);
    } else {
      // 无模型时用简单截断摘要
      summary = this.simpleSummary(toCompress);
    }

    const summaryMessage: Message = {
      role: "system",
      content: `[历史对话摘要]\n${summary}`,
    };

    const compressed = [...systemMessages, summaryMessage, ...toKeep];
    const compressedTokens = estimateTokens(compressed);

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

  private async generateSummary(messages: Message[]): Promise<string> {
    if (!this.modelProvider) return this.simpleSummary(messages);

    const summaryRequest: Message[] = [
      {
        role: "system",
        content:
          "你是一个对话压缩器。将以下对话历史压缩为简洁的摘要，保留关键决策、工具调用结果和用户意图。不要丢失重要细节。",
      },
      {
        role: "user",
        content: messages
          .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
          .join("\n\n"),
      },
    ];

    const response = await this.modelProvider({
      model: "",
      messages: summaryRequest,
      temperature: 0.3,
      maxTokens: 1024,
    });

    return response.text;
  }

  private simpleSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const toolMessages = messages.filter((m) => m.role === "tool");
    return `历史包含 ${userMessages.length} 条用户消息和 ${toolMessages.length} 条工具结果。` +
      `用户最近意图: ${userMessages[userMessages.length - 1]?.content.slice(0, 200) ?? "N/A"}`;
  }
}
