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
  /** DeepSeek 思考模式：true=开启（temperature 无效），false=关闭（temperature 生效），缺省=供应商默认 */
  thinking?: boolean;
}

interface ModelsConfig {
  default: ModelProfile;
  profiles: Record<string, Partial<ModelProfile>>;
  routing: {
    strategy: string;
    fallback: string;
  };
  pricing?: Record<string, { prompt: number; completion: number }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ModelRouter {
  private config: ModelsConfig;
  private clients = new Map<string, OpenAI>();
  private totalTokensUsed = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private currentProfile = "";
  /** 运行时覆盖（/config 命令设置，持久化到文件） */
  private runtimeProfileKey = "";
  private runtimeModel = "";
  private runtimeTemperature: number | null = null;
  private runtimeMaxTokens: number | null = null;

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
    let profile: ModelProfile;
    // 运行时 profile 覆盖：优先于配置文件的 default（含 provider/baseURL/apiKey）
    if (this.runtimeProfileKey) {
      const rp = this.config.profiles[this.runtimeProfileKey];
      profile = rp ? this.mergeProfile(this.config.default, rp) : this.config.default;
      // 若请求的是默认路由，直接使用运行时 profile；否则仍可叠加偏好 profile
      if (preference && preference !== "default") {
        const p = this.config.profiles[preference];
        profile = p ? this.mergeProfile(profile, p) : profile;
      }
    } else if (!preference || preference === "default") {
      profile = this.config.default;
    } else {
      const p = this.config.profiles[preference];
      profile = p ? this.mergeProfile(this.config.default, p) : this.config.default;
    }
    // 应用运行时覆盖
    if (this.runtimeModel) profile = { ...profile, model: this.runtimeModel };
    if (this.runtimeTemperature !== null) profile = { ...profile, temperature: this.runtimeTemperature };
    if (this.runtimeMaxTokens !== null) profile = { ...profile, maxTokens: this.runtimeMaxTokens };
    return profile;
  }

  /**
   * 合并 profile。thinking 是供应商专属参数（DeepSeek），
   * 仅在子 profile 显式声明时生效，不随 default 继承（避免 lite 等本地模型误传）。
   */
  private mergeProfile(base: ModelProfile, override: Partial<ModelProfile>): ModelProfile {
    const merged = { ...base, ...override };
    if (!("thinking" in override)) {
      delete merged.thinking;
    }
    return merged;
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

    // DeepSeek 思考模式需经 extra_body 传递（OpenAI SDK 兼容）
    const extraBody: Record<string, unknown> = {};
    if (profile.thinking !== undefined) {
      extraBody.thinking = { type: profile.thinking ? "enabled" : "disabled" };
    }

    const response = await client.chat.completions.create(requestParams, {
      signal: options.signal,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
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
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;

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
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
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

  getPromptTokens(): number {
    return this.totalPromptTokens;
  }

  getCompletionTokens(): number {
    return this.totalCompletionTokens;
  }

  getCost(): number {
    const provider = this.config.default.provider;
    const price = this.config.pricing?.[provider];
    if (!price) return 0;
    return (
      (this.totalPromptTokens / 1_000_000) * price.prompt + (this.totalCompletionTokens / 1_000_000) * price.completion
    );
  }

  resetTokenUsage(): void {
    this.totalTokensUsed = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
  }

  getCurrentModel(): string {
    if (this.runtimeProfileKey) {
      const rp = this.config.profiles[this.runtimeProfileKey];
      return this.runtimeModel || rp?.model || this.config.default.model;
    }
    return this.runtimeModel || this.currentProfile || this.config.default.model;
  }

  // ── 运行时配置（/config 命令支持）──

  /** 可用的默认模型选项：default + profiles */
  getAvailableModels(): Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number }> {
    const out: Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number }> = [];
    out.push({ key: "default", model: this.config.default.model, provider: this.config.default.provider, baseURL: this.config.default.baseURL, temperature: this.config.default.temperature, maxTokens: this.config.default.maxTokens });
    for (const [key, p] of Object.entries(this.config.profiles)) {
      out.push({ key, model: p.model ?? this.config.default.model, provider: p.provider ?? this.config.default.provider, baseURL: p.baseURL ?? this.config.default.baseURL, temperature: p.temperature ?? this.config.default.temperature, maxTokens: p.maxTokens ?? this.config.default.maxTokens });
    }
    return out;
  }

  /** 查看运行时覆盖状态 */
  getRuntimeConfig(): { profileKey: string; model: string; temperature: number | null; maxTokens: number | null } {
    return {
      profileKey: this.runtimeProfileKey,
      model: this.runtimeModel,
      temperature: this.runtimeTemperature,
      maxTokens: this.runtimeMaxTokens,
    };
  }

  /** 设置运行时默认 profile（空字符串恢复配置文件默认） */
  setDefaultModel(profileKey: string): void {
    this.runtimeProfileKey = profileKey.trim().toLowerCase();
  }

  /** 设置运行时默认温度（null 恢复配置文件） */
  setTemperature(t: number | null): void {
    this.runtimeTemperature = t;
  }

  /** 设置运行时 maxTokens（null 恢复配置文件） */
  setMaxTokens(n: number | null): void {
    this.runtimeMaxTokens = n;
  }

  /** 导出全部覆盖，供持久化 */
  getOverrides(): { profile?: string; temperature?: number; maxTokens?: number } {
    const out: { profile?: string; temperature?: number; maxTokens?: number } = {};
    if (this.runtimeProfileKey) out.profile = this.runtimeProfileKey;
    if (this.runtimeTemperature !== null) out.temperature = this.runtimeTemperature;
    if (this.runtimeMaxTokens !== null) out.maxTokens = this.runtimeMaxTokens;
    return out;
  }

  /** 从持久化文件恢复覆盖 */
  applyOverrides(overrides: { profile?: string; model?: string; temperature?: number; maxTokens?: number }): void {
    if (overrides.profile) this.runtimeProfileKey = overrides.profile;
    if (overrides.model) this.runtimeModel = overrides.model;
    if (typeof overrides.temperature === "number") this.runtimeTemperature = overrides.temperature;
    if (typeof overrides.maxTokens === "number") this.runtimeMaxTokens = overrides.maxTokens;
  }

  async *completeStream(
    preference: string,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
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

    // DeepSeek 思考模式需经 extra_body 传递（OpenAI SDK 兼容）
    const extraBody: Record<string, unknown> = {};
    if (profile.thinking !== undefined) {
      extraBody.thinking = { type: profile.thinking ? "enabled" : "disabled" };
    }

    const stream = await client.chat.completions.create(requestParams, {
      signal: options?.signal,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
    });

    const tcAcc: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: string = "stop";
    let streamPromptTokens = 0;
    let streamCompletionTokens = 0;

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

        // Capture usage from the last chunk (stream_options.include_usage ensures
        // it appears; only the last value is correct — accumulating per-chunk
        // would vastly overcount if the provider reports cumulative values).
        if (chunk.usage) {
          streamPromptTokens = chunk.usage.prompt_tokens;
          streamCompletionTokens = chunk.usage.completion_tokens;
        }
      }

      // Accumulate stream usage once (per-request, not per-chunk)
      this.totalPromptTokens += streamPromptTokens;
      this.totalCompletionTokens += streamCompletionTokens;
      this.totalTokensUsed += streamPromptTokens + streamCompletionTokens;

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
