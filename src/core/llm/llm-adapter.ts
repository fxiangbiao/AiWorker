/**
 * LLM 能力缝（seam）— 供应商无关的适配器契约
 * 设计依据：对比报告借鉴点 #6（对齐 DSH dsh-llm 的 LlmAdapter/LlmRuntime 设计）
 */

import type { ModelCompleteOptions, ModelResponse, StreamChunk } from "../../types.js";

/** 一次请求的已解析连接参数（由 ModelRouter 门面从 profile 解析后传入） */
export interface LlmConnection {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** DeepSeek 思考模式：供应商专属参数，由 adapter 自行消费 */
  thinking?: boolean;
}

export interface LlmStreamOptions extends ModelCompleteOptions {
  /** 流式 usage 回调：adapter 在流结束时回调一次，由门面统一累计（防多 chunk 计数膨胀） */
  onUsage?: (usage: NonNullable<ModelResponse["usage"]>) => void;
}

/** 模型供应商适配器：唯一接触供应商 wire 格式的模块 */
export interface LlmAdapter {
  /** 注册 id（config/models.json 中 profile.adapter 引用，缺省 openai-compatible） */
  readonly id: string;
  complete(conn: LlmConnection, options: ModelCompleteOptions): Promise<ModelResponse>;
  completeStream(conn: LlmConnection, options: LlmStreamOptions): AsyncGenerator<StreamChunk>;
}
