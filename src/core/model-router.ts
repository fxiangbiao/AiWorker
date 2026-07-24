/**
 * 模型路由器
 * 统一 OpenAI 兼容格式，支持多 provider 路由
 * 设计依据：调研报告——OpenAI 标准消息格式保证多模型切换零摩擦
 */

import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelCompleteOptions,
  ModelResponse,
  ModelProvider,
  Message,
  ToolCall,
  ToolDefinition,
} from "../types.js";

interface ModelProfile {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

interface ModelsConfig {
  default: ModelProfile;
  profiles: Record<string, Partial<ModelProfile>>;
  routing: {
    strategy: string;
    fallback: string;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ModelRouter {
  private config: ModelsConfig;
  private clients = new Map<string, OpenAI>();
  private totalTokensUsed = 0;

  constructor(configPath?: string) {
    const path = configPath ?? resolve(__dirname, "../../config/models.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelsConfig;
    // 展开 apiKey 环境变量
    parsed.default.apiKey = this.resolveEnv(parsed.default.apiKey);
    this.config = parsed;
  }

  private resolveEnv(value: string): string {
    if (value.startsWith("${") && value.endsWith("}")) {
      const envName = value.slice(2, -1);
      return process.env[envName] ?? "";
    }
    return value;
  }

  private getProfile(preference?: string): ModelProfile {
    if (!preference || preference === "default") {
      return this.config.default;
    }
    const profile = this.config.profiles[preference];
    if (!profile) return this.config.default;
    return { ...this.config.default, ...profile };
  }

  private getClient(profile: ModelProfile): OpenAI {
    const key = `${profile.provider}:${profile.baseURL}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAI({
        apiKey: profile.apiKey,
        baseURL: profile.baseURL,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * 调用模型完成
   * 统一使用 OpenAI chat.completions 接口
   */
  async complete(options: ModelCompleteOptions): Promise<ModelResponse> {
    const profile = this.getProfile(undefined);
    const model = options.model || profile.model;
    const client = this.getClient(profile);

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature ?? profile.temperature,
      max_tokens: options.maxTokens ?? profile.maxTokens,
    };

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools as unknown as OpenAI.Chat.ChatCompletionTool[];
    }

    const response = await client.chat.completions.create(requestParams, {
      signal: options.signal,
    });

    const choice = response.choices[0];
    const message = choice.message;

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    this.totalTokensUsed += usage.totalTokens;

    return {
      text: message.content ?? "",
      toolCalls,
      hasToolCalls: toolCalls.length > 0,
      usage,
      finishReason: (choice.finish_reason as ModelResponse["finishReason"]) ?? "stop",
    };
  }

  /** 按偏好调用 */
  async completeWithProfile(
    preference: string,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
  ): Promise<ModelResponse> {
    const profile = this.getProfile(preference);
    return this.complete({
      model: profile.model,
      messages,
      tools,
      temperature: options?.temperature ?? profile.temperature,
      maxTokens: options?.maxTokens ?? profile.maxTokens,
      signal: options?.signal,
    });
  }

  getTokenUsage(): number {
    return this.totalTokensUsed;
  }

  resetTokenUsage(): void {
    this.totalTokensUsed = 0;
  }
}
