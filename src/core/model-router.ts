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
  StreamChunk,
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
  private currentProfile = "";

  constructor(configPath?: string) {
    const path = configPath ?? resolve(__dirname, "../../config/models.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelsConfig;
    parsed.default.apiKey = this.resolveEnv(parsed.default.apiKey);
    // 解析 profile 中的 ${ENV} 引用
    for (const key of Object.keys(parsed.profiles)) {
      const p = parsed.profiles[key];
      if (p.apiKey) p.apiKey = this.resolveEnv(p.apiKey);
      if (p.baseURL) p.baseURL = this.resolveEnv(p.baseURL);
    }
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

  getCurrentModel(): string {
    return this.currentProfile || this.config.default.model;
  }

  async *completeStream(
    preference: string,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
  ): AsyncGenerator<StreamChunk> {
    const profile = this.getProfile(preference);
    this.currentProfile = profile.model;
    const client = this.getClient(profile);

    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: profile.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options?.temperature ?? profile.temperature,
      max_tokens: options?.maxTokens ?? profile.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools as unknown as OpenAI.Chat.ChatCompletionTool[];
    }

    const stream = await client.chat.completions.create(requestParams, {
      signal: options?.signal,
    });

    const tcAcc: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: string = "stop";

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const choiceFinish = chunk.choices?.[0]?.finish_reason;

        if (choiceFinish) {
          finishReason = choiceFinish;
        }

        // reasoning_content (DeepSeek R1 等推理模型)
        const reasoning = (delta as Record<string, unknown>)?.reasoning_content as string | undefined;
        if (reasoning) {
          yield { type: "thinking", content: reasoning };
        }

        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index;
            if (!tcAcc.has(idx)) {
              tcAcc.set(idx, { id: tcDelta.id ?? "", name: "", args: "" });
            }
            const acc = tcAcc.get(idx)!;
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) {
              acc.name = tcDelta.function.name;
              yield { type: "tool_call_start", toolCallId: acc.id, toolName: acc.name };
            }
            if (tcDelta.function?.arguments) {
              acc.args += tcDelta.function.arguments;
              yield { type: "tool_call_delta", toolCallId: acc.id, content: tcDelta.function.arguments };
            }
          }
        }

        if (delta?.content) {
          yield { type: "text", content: delta.content };
        }

        if (chunk.usage) {
          this.totalTokensUsed += chunk.usage.total_tokens;
        }
      }

      const resolvedToolCalls: ToolCall[] = [];
      for (const [, acc] of tcAcc) {
        if (acc.id && acc.name) {
          resolvedToolCalls.push({
            id: acc.id,
            type: "function",
            function: { name: acc.name, arguments: acc.args },
          });
        }
      }

      yield {
        type: "done",
        finishReason: finishReason as StreamChunk["finishReason"],
        content: resolvedToolCalls.length > 0 ? JSON.stringify(resolvedToolCalls) : undefined,
      };
    } catch (err) {
      const isAbort = (err as Error).name === "AbortError" || (err as Error).message?.includes("abort");
      if (isAbort) {
        yield { type: "error", error: "aborted" };
      } else {
        yield { type: "error", error: (err as Error).message };
      }
    }
  }
}
