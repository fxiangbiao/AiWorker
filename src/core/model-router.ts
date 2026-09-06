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
  /** 视觉能力（Sprint 36）：true=支持图片输入（多模态消息），缺省 false */
  vision?: boolean;
  /** 上下文窗口（token；Sprint 44）：profile 级覆盖，缺省走顶层 contextWindow 表 → 内置兜底 */
  contextWindow?: number;
}

interface ModelsConfig {
  default: ModelProfile;
  profiles: Record<string, Partial<ModelProfile>>;
  routing: {
    strategy: string;
    fallback: string;
  };
  /** provider/model 级上下文窗口表（Sprint 44）：键 "provider" 或 "provider.model"，见 getContextWindow */
  contextWindow?: Record<string, number>;
}

/** 常用模型上下文窗口兜底表（Sprint 44；deepseek V4 官方 1M、Gemma 4 官方 256K 已核实） */
const BUILTIN_CONTEXT_WINDOWS: Record<string, number> = {
  deepseek: 1048576,
  openai: 128000,
  anthropic: 200000,
  google: 262144,
};
/** 未配置任何窗口时的最终兜底（与历史 compressor 预算一致，避免行为突变） */
export const CONTEXT_WINDOW_FALLBACK = 32768;

/** 非有限/负数 token 计数归 0（Sprint 44 review：OpenAI 兼容端点 usage 字段缺失/异常时不污染全局与账本） */
function sanitize(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ModelRouter {
  private config: ModelsConfig;
  private totalTokensUsed = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private currentProfile = "";
  /** 会话级 token 账本（Sprint 44）：scope=sessionId 的请求差分结算"本轮"；仅 token 无费用 */
  private sessionScopes = new Map<string, { prompt: number; completion: number }>();
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
    // contextWindow 校验：非法值（非正整数）回退兜底（不修改原配置，查询时兜底）
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
    // 应用运行时覆盖（显式切换模型名时丢弃 profile 声明窗口，回退顶层表按新模型查询）
    if (this.runtimeModel) profile = { ...profile, model: this.runtimeModel, contextWindow: undefined };
    if (this.runtimeTemperature !== null) profile = { ...profile, temperature: this.runtimeTemperature };
    if (this.runtimeMaxTokens !== null) profile = { ...profile, maxTokens: this.runtimeMaxTokens };
    return profile;
  }

  /**
   * 合并 profile。thinking 是供应商专属参数（DeepSeek），
   * 仅在子 profile 显式声明时生效，不随 default 继承（避免 lite 等本地模型误传）。
   * contextWindow 同理：未显式声明的子 profile 不继承 default 窗口，回退顶层表按自身 provider.model 查询。
   */
  private mergeProfile(base: ModelProfile, override: Partial<ModelProfile>): ModelProfile {
    const merged = { ...base, ...override };
    if (!("thinking" in override)) {
      delete merged.thinking;
    }
    if (!("contextWindow" in override)) {
      delete merged.contextWindow;
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
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; scope?: string },
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
      scope: options?.scope,
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

    this.accumulate(options.scope, response.usage);

    return response;
  }

  /** 计量收口：全局累计 + scope（会话账本）累计；非法 usage（非有限/负数）按 0 处理，防一个异常 provider 污染全部计数 */
  private accumulate(scope: string | undefined, usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    const p = sanitize(usage.promptTokens);
    const c = sanitize(usage.completionTokens);
    const t = sanitize(usage.totalTokens);
    this.totalTokensUsed += t;
    this.totalPromptTokens += p;
    this.totalCompletionTokens += c;
    if (scope) {
      const bucket = this.sessionScopes.get(scope) ?? { prompt: 0, completion: 0 };
      bucket.prompt += p;
      bucket.completion += c;
      this.sessionScopes.set(scope, bucket);
    }
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

  /** 会话账本当前累计（scope=sessionId；供 hooks 轮次差分/本轮展示；重启后清空，持久口径走事件/TurnLog） */
  getSessionTokens(scope: string): { prompt: number; completion: number } {
    return this.sessionScopes.get(scope) ?? { prompt: 0, completion: 0 };
  }

  /** 删除会话账本（Web DELETE /sessions/:id 调用，防 Map 无界增长） */
  deleteScope(sessionId: string): void {
    this.sessionScopes.delete(sessionId);
  }

  resetTokenUsage(): void {
    this.totalTokensUsed = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.sessionScopes.clear();
  }

  /**
   * 解析指定偏好（缺省 default）的上下文窗口（token；Sprint 44）
   * 优先级：profile.contextWindow > 顶层 contextWindow["provider.model"] > contextWindow["provider"] > 内置表 > 兜底
   */
  getContextWindow(preference?: string): number {
    const profile = this.getProfile(preference);
    const own = profile.contextWindow;
    if (typeof own === "number" && Number.isInteger(own) && own > 0) return own;
    return this.lookupContextWindow(profile);
  }

  /** 顶层表/内置表查询：provider.model 精确键 > provider 默认键 > 内置表；
   *  精确键未命中时做大小写不敏感兜底（review：profile.model 大小写与配置键漂移仍命中，防窗口静默虚高） */
  private lookupContextWindow(profile: ModelProfile): number {
    const provider = (profile.provider || "").trim().toLowerCase();
    const table = this.config.contextWindow;
    const modelKey = `${provider}.${profile.model}`;
    const exact = table?.[modelKey] ?? table?.[provider];
    if (typeof exact === "number" && Number.isInteger(exact) && exact > 0) return exact;
    if (table) {
      const lowerKey = `${provider}.${(profile.model || "").trim().toLowerCase()}`;
      const lowerProv = provider.toLowerCase();
      for (const k of Object.keys(table)) {
        if (k.toLowerCase() === lowerKey || k.toLowerCase() === lowerProv) {
          const v = table[k];
          if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
        }
      }
    }
    return BUILTIN_CONTEXT_WINDOWS[provider] ?? CONTEXT_WINDOW_FALLBACK;
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

  /** 指定模型偏好是否支持视觉（多模态图片输入；Sprint 36） */
  supportsVision(preference?: string): boolean {
    const profile = this.getProfile(preference);
    return profile.vision === true;
  }

  // ── 运行时配置（/config 命令支持）──

  /**
   * 可用模型列表（default + profiles 静态视图，不含运行时 profile 覆盖——
   * 否则 /config model 切换 runtime 后 default 行会显示被覆盖的模型/窗口，误导选择）
   */
  getAvailableModels(): Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number; adapter?: string; contextWindow: number }> {
    const out: Array<{ key: string; model: string; provider: string; baseURL: string; temperature: number; maxTokens: number; adapter?: string; contextWindow: number }> = [];
    const push = (key: string, profile: ModelProfile) => {
      const own = profile.contextWindow;
      const window = typeof own === "number" && Number.isInteger(own) && own > 0 ? own : this.lookupContextWindow(profile);
      out.push({ key, model: profile.model, provider: profile.provider, baseURL: profile.baseURL, temperature: profile.temperature, maxTokens: profile.maxTokens, adapter: profile.adapter, contextWindow: window });
    };
    push("default", this.config.default);
    for (const [key, p] of Object.entries(this.config.profiles)) {
      push(key, this.mergeProfile(this.config.default, p));
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

  /** 动态添加模型 profile（立即生效；持久化由调用方写回 config/models.json；contextWindow 缺省走回退链） */
  addProfile(
    key: string,
    profile: { model: string; baseURL: string; provider?: string; apiKey?: string; temperature?: number; maxTokens?: number; adapter?: string; contextWindow?: number },
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
      ...(Number.isInteger(profile.contextWindow) && profile.contextWindow! > 0 ? { contextWindow: profile.contextWindow } : {}),
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
      ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
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
    options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; scope?: string; onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void },
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
        this.accumulate(options?.scope, usage);
        // 透传调用方回调（agent-loop 用其收集"本轮主请求"usage，避开压缩请求污染单槽）
        options?.onUsage?.(usage);
      },
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
