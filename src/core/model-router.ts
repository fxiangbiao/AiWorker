/**
 * 模型路由器（门面）
 * 统一 OpenAI 兼容格式，支持多 provider 路由
 * 设计依据：调研报告——OpenAI 标准消息格式保证多模型切换零摩擦
 *
 * 改造（对比报告借鉴点 #6）：供应商专属逻辑下沉到 src/core/llm/ 适配器层，
 * 本类只负责 profile 解析、适配器路由与 token/成本计量；公开 API 保持不变。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelCompleteOptions,
  ModelResponse,
  Message,
  ToolDefinition,
  StreamChunk,
} from "../types.js";
import type { LlmConnection } from "./llm/llm-adapter.js";
import { adapterRegistry } from "./llm/adapter-registry.js";

interface ModelProfile {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** DeepSeek 思考模式：true=开启（temperature 无效），false=关闭（temperature 生效），缺省=供应商默认 */
  thinking?: boolean;
  /** 供应商适配器 id（缺省 openai-compatible），见 src/core/llm/ */
  adapter?: string;
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
  private totalTokensUsed = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private currentProfile = "";
  /** 最近一次请求的 usage（assistant/message 事件携带，供轨迹/遥测消费） */
  private lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
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

  /** profile → 适配器连接参数 */
  private toConnection(profile: ModelProfile): LlmConnection {
    const conn: LlmConnection = {
      provider: profile.provider,
      model: profile.model,
      baseURL: profile.baseURL,
      apiKey: profile.apiKey,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
    };
    if (profile.thinking !== undefined) conn.thinking = profile.thinking;
    return conn;
  }

  async complete(options: ModelCompleteOptions): Promise<ModelResponse> {
    const profile = this.getProfile(undefined);
    return this.dispatch(profile, options);
  }

  async completeWithProfile(
    preference: string,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): Promise<ModelResponse> {
    const profile = this.getProfile(preference);
    // 用 preference profile 的完整连接（provider/baseURL/apiKey 等）执行，
    // 避免 lite 等异源 profile 的 model 错发到 default 的连接
    return this.dispatch(profile, {
      model: profile.model,
      messages,
      tools,
      temperature: options?.temperature ?? profile.temperature,
      maxTokens: options?.maxTokens ?? profile.maxTokens,
      signal: options?.signal,
    });
  }

  /** 共享执行：适配器路由 + 计量 */
  private async dispatch(profile: ModelProfile, options: ModelCompleteOptions): Promise<ModelResponse> {
    const adapter = adapterRegistry.resolve(profile.adapter);
    const conn = this.toConnection(profile);
    // 按调用覆盖思考模式（生成器等场景传 thinking:false 省 token）
    if (options.thinking !== undefined) conn.thinking = options.thinking;

    const response = await adapter.complete(conn, {
      model: options.model || profile.model,
      messages: options.messages,
      tools: options.tools,
      temperature: options.temperature ?? profile.temperature,
      maxTokens: options.maxTokens ?? profile.maxTokens,
      signal: options.signal,
    });

    this.lastUsage = response.usage;
    this.totalTokensUsed += response.usage.totalTokens;
    this.totalPromptTokens += response.usage.promptTokens;
    this.totalCompletionTokens += response.usage.completionTokens;

    return response;
  }

  /** 最近一次请求的 usage（供 appendMessage 写入 assistant/message 事件） */
  getLastUsage(): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    return this.lastUsage ?? undefined;
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

  /** 状态栏展示：当前生效模型 + profile 上下文（/config model 切换 profile 后可感知） */
  getDisplayModel(): string {
    const model = this.getCurrentModel();
    if (this.runtimeProfileKey && this.runtimeProfileKey !== "default") {
      return `${model} (${this.runtimeProfileKey})`;
    }
    return model;
  }

  // ── 运行时配置（/config 命令支持）──

  /** 可用的默认模型选项：default + profiles */
  getAvailableModels(): Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number; adapter?: string }> {
    const out: Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number; adapter?: string }> = [];
    out.push({ key: "default", model: this.config.default.model, provider: this.config.default.provider, baseURL: this.config.default.baseURL, temperature: this.config.default.temperature, maxTokens: this.config.default.maxTokens, adapter: this.config.default.adapter });
    for (const [key, p] of Object.entries(this.config.profiles)) {
      out.push({ key, model: p.model ?? this.config.default.model, provider: p.provider ?? this.config.default.provider, baseURL: p.baseURL ?? this.config.default.baseURL, temperature: p.temperature ?? this.config.default.temperature, maxTokens: p.maxTokens ?? this.config.default.maxTokens, adapter: p.adapter ?? this.config.default.adapter });
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

  /** 动态添加模型 profile（立即生效；持久化由调用方写回 config/models.json） */
  addProfile(
    key: string,
    profile: { model: string; baseURL: string; provider?: string; apiKey?: string; temperature?: number; maxTokens?: number; adapter?: string },
  ): boolean {
    const k = key.trim().toLowerCase();
    if (!k || k === "default" || this.config.profiles[k]) return false;
    const model = profile.model?.trim();
    const baseURL = profile.baseURL?.trim();
    if (!model || !baseURL) return false;
    this.config.profiles[k] = {
      provider: profile.provider?.trim() || this.config.default.provider,
      model,
      baseURL,
      apiKey: profile.apiKey?.trim() || this.config.default.apiKey,
      temperature: profile.temperature ?? this.config.default.temperature,
      maxTokens: profile.maxTokens ?? this.config.default.maxTokens,
      adapter: profile.adapter ?? this.config.default.adapter,
    };
    return true;
  }

  /** 获取动态添加/现有 profile 的原始结构（供持久化写回） */
  getProfileRaw(key: string): Record<string, unknown> | null {
    const k = key.trim().toLowerCase();
    const p = this.config.profiles[k];
    if (!p) return null;
    return {
      provider: p.provider,
      model: p.model,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      adapter: p.adapter,
    };
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
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void },
  ): AsyncGenerator<StreamChunk> {
    const profile = this.getProfile(preference);
    this.currentProfile = profile.model;
    const adapter = adapterRegistry.resolve(profile.adapter);

    const stream = adapter.completeStream(this.toConnection(profile), {
      model: profile.model,
      messages,
      tools,
      temperature: options?.temperature ?? profile.temperature,
      maxTokens: options?.maxTokens ?? profile.maxTokens,
      signal: options?.signal,
      onUsage: (usage) => {
        // 流式 usage 只在流结束时一次性回调（防多 chunk 计数膨胀）
        this.lastUsage = usage;
        this.totalPromptTokens += usage.promptTokens;
        this.totalCompletionTokens += usage.completionTokens;
        this.totalTokensUsed += usage.totalTokens;
        // 透传调用方回调（agent-loop 用其收集"本轮主请求"usage，避开压缩请求污染单槽）
        options?.onUsage?.(usage);
      },
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
