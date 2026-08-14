# Sprint 23 — LLM Provider Seam 改造设计

> 来源：`docs/comparison-report.md` 可借鉴点 #6「模型接入硬编码 OpenAI 格式」
> 借鉴对象：DeepSeek Harness `dsh-llm` seam（`LlmAdapter` 抽象 + `LlmRuntime` 运行时 + `LlmError` 错误分类 + `BlockAssembler` 流式组装）

## 1. 目标摘要

消除 `src/core/model-router.ts` 对 `openai` SDK 的硬编码依赖：把"OpenAI 兼容请求/响应"降级为**一种可替换的 provider 适配器**，抽象出与供应商无关的 LLM seam。改造后新增模型供应商（Anthropic、Ollama、Gemini、本地推理服务等）只需写一个 adapter 文件 + 注册一行，**8 个现有调用方（agent-loop / team-coordinator / skill-evolution / router / hooks / server / base-agent / index）零改动**。

## 2. 现状分析

`model-router.ts`（409 行）中所有供应商专属逻辑集中在这几处：

| 位置 | 硬编码点 | 问题 |
|------|---------|------|
| L114-125 `getClient` | `new OpenAI({ apiKey, baseURL })` | 强制 OpenAI SDK 构造 |
| L132-152 `complete` | `client.chat.completions.create` + `extra_body` | 请求格式锁死 OpenAI 兼容 |
| L144-147 / L317-320 | DeepSeek `thinking` 经 `extra_body` 透传 | 供应商专属参数直接写在路由层 |
| L342 `completeStream` | `delta.reasoning_content` 手解析 | 推理内容解析与 OpenAI 流格式耦合 |
| L157-184 | `response.choices[0].message` → `ModelResponse` | 响应规范化为 OpenAI 形态 |

好消息：`ModelCompleteOptions` / `ModelResponse` / `StreamChunk`（`src/types.ts`）已是中立格式；所有下游只通过 `completeWithProfile` / `completeStream` 访问，**门面方法签名可保持不变**。

## 3. 目标架构

```
                    ┌─────────────────────────────────────────────┐
                    │  ModelRouter（门面，保持公开 API 不变）        │
                    │  解析 profile → 计量 → 路由 → 降级兜底          │
                    └───────────────┬─────────────────────────────┘
                                    │ createAdapter(profile)
                    ┌───────────────▼─────────────────────────────┐
                    │  adapter-registry.ts（单例注册表 + 工厂）      │
                    │  id → LlmAdapter；未知 id 降级 openai-compatible│
                    └───┬───────────────┬───────────────┬─────────┘
        ┌───────────────▼───┐   ┌───────▼────────┐   ┌───▼──────────────────┐
        │ OpenAICompatible   │   │ AnthropicAdapter│   │ OllamaAdapter（未来） │
        │  Adapter（现有逻辑  │   │  （未来扩展）    │   │   非 OpenAI 兼容      │
        │  整体迁入，行为不变）│   │                │   │                      │
        └───────┬───────────┘   └────────────────┘   └──────────────────────┘
                │ 内部：client 缓存（按 baseURL+apiKey）· 流式组装 · 错误分类 · 网络层重试
                ▼
        LlmError（quota / context_window / invalid_credential / empty_response /
                  rate_limit / timeout / network / unknown）
```

设计要点（对齐 DSH `dsh-llm`）：

1. **LlmAdapter 是唯一供应商接触面**：`complete` / `completeStream` 接收已解析的 `LlmConnection`（连接参数），返回中立 `ModelResponse` / `StreamChunk`。
2. **计量留在门面**：adapter 只返回 usage，token/成本累计仍在 `ModelRouter` 统一做（与现状一致，避免多 adapter 计量漂移）。
3. **错误分类下沉**：adapter 内部把 HTTP/网络错误映射为 `LlmError`（带 code），路由层据此决定是否重试、是否提示用户，参考 DSH `HarnessError`/`LlmError` taxonomy 与 `isQuotaExceededError` 等判定函数。
4. **网络层重试 vs hook 重试分层**：adapter 只做 retryable（rate_limit/timeout/network/5xx）指数退避；hooks 中既有业务级"重试退避/模型降级"handler 保留，职责不重叠。

## 4. 接口设计

### 4.1 连接参数与适配器契约（新建 `src/core/llm/llm-adapter.ts`）

```ts
import type { ModelCompleteOptions, ModelResponse, StreamChunk } from "../../types.js";

export interface LlmConnection {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** DeepSeek 思考模式：供应商专属参数，由 profile 携带，adapter 自行消费 */
  thinking?: boolean;
}

export interface LlmAdapter {
  readonly id: string;                                  // "openai-compatible" | "anthropic" | ...
  complete(conn: LlmConnection, options: ModelCompleteOptions): Promise<ModelResponse>;
  completeStream(conn: LlmConnection, options: ModelCompleteOptions): AsyncGenerator<StreamChunk>;
}
```

> `ModelCompleteOptions` 中的 `model` 为空时回退 `conn.model`；`signal` / `tools` / `temperature` / `maxTokens` 均透传。

### 4.2 错误分类（新建 `src/core/llm/llm-error.ts`）

```ts
export type LlmErrorCode =
  | "quota" | "context_window" | "invalid_credential" | "empty_response"
  | "rate_limit" | "timeout" | "network" | "unknown";

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly cause?: unknown,
  ) { super(message); this.name = "LlmError"; }
}

/** 把任意异常映射为分类错误（文案启发式 + 状态码映射，参考 DSH LlmError taxonomy） */
export function classifyError(err: unknown): LlmErrorCode;
export function isLlmError(err: unknown): err is LlmError;
/** rate_limit / timeout / network / 5xx → true；quota / credential / context / empty → false */
export function isRetryable(code: LlmErrorCode): boolean;
export function isQuotaExceededError(err: unknown): boolean;
export function isContextWindowExceededError(err: unknown): boolean;
```

### 4.3 适配器注册表（新建 `src/core/llm/adapter-registry.ts`）

```ts
import { openaiCompatibleAdapter } from "./openai-compatible.js";

class AdapterRegistry {
  private static instance: AdapterRegistry;
  private adapters = new Map<string, LlmAdapter>();
  static getInstance(): AdapterRegistry { /* 单例，与 ToolRegistry 等既有约定一致 */ }
  register(adapter: LlmAdapter): void;
  /** 未知 id 降级 openai-compatible（与 modelPreference 白名单降级 default 的既有约定一致） */
  resolve(id: string | undefined): LlmAdapter;
}

export const adapterRegistry = AdapterRegistry.getInstance();
adapterRegistry.register(openaiCompatibleAdapter);
```

### 4.4 OpenAI 兼容适配器（新建 `src/core/llm/openai-compatible.ts`）

从 `model-router.ts` **原样迁移**以下逻辑，行为不变：

- `new OpenAI({ apiKey, baseURL })` + 按 `baseURL:apiKey` 缓存 client
- `complete`：`chat.completions.create`（含 `extra_body.thinking` 透传）→ 规范化 `ModelResponse`
- `completeStream`：`reasoning_content` → `thinking` chunk、tool_calls 增量累积、usage 只在流末尾一次性累计（防多 chunk 计数膨胀）
- 新增：请求异常包 `try { ... } catch (err) { throw classifyAsLlmError(err) }`；retryable 错误指数退避 `min(1000*2^n, 8000)` 最多 3 次（quota/credential/context/empty 直接抛）

### 4.5 ModelRouter 改为门面（修改 `src/core/model-router.ts`）

- 删除 L114-125 `getClient`、L132-152 / L303-325 的 OpenAI SDK 直调
- `complete`：`getProfile → adapterRegistry.resolve(profile.adapter) → adapter.complete(conn, options)`，usage 累计逻辑保留在门面
- `completeStream`：同样改走 adapter；`currentProfile` 记录与 token 累计不变
- 公开方法签名（`completeWithProfile` / `completeStream` / `getCost` / 运行时覆盖等）**全部保持不变**

### 4.6 配置（修改 `config/models.json`，可选字段，向后兼容）

```jsonc
{
  "default": {
    "provider": "deepseek", "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com", "apiKey": "${DEEPSEEK_API_KEY}",
    "temperature": 0.7, "maxTokens": 4096,
    "adapter": "openai-compatible", "thinking": false
  },
  "profiles": {
    "coding": { "thinking": true },
    "lite":   { "provider": "ollama", "baseURL": "http://localhost:8000/v1" },
    "anthropic": { "provider": "anthropic", "baseURL": "https://api.anthropic.com/v1",
                   "apiKey": "${ANTHROPIC_API_KEY}", "adapter": "anthropic" }
  }
}
```

- `adapter` 缺省 = `"openai-compatible"`，**旧配置文件零迁移**，与 `thinking` 的继承规则一致（仅在子 profile 显式声明时生效）
- `ModelProfile` 增加 `adapter?: string`；`getAvailableModels` 透出该字段供 `/config` 展示

## 5. 文件变更清单

**新建**：
- `src/core/llm/llm-adapter.ts` — `LlmConnection` / `LlmAdapter` 接口
- `src/core/llm/llm-error.ts` — `LlmError` + `classifyError` / `isRetryable` / `isQuotaExceededError` / `isContextWindowExceededError`
- `src/core/llm/adapter-registry.ts` — 单例注册表 + `resolve(id)` 降级
- `src/core/llm/openai-compatible.ts` — OpenAI 兼容适配器（从 model-router 迁移 + 错误分类 + 网络层重试）
- `test/llm-adapter.test.ts` — adapter 单测（见 §7）

**修改**：
- `src/core/model-router.ts` — 删 OpenAI SDK 直调，改为门面（公开 API 不变）；`ModelProfile` 增 `adapter` 字段
- `config/models.json` — default/profile 增可选 `adapter` 字段（文档化，不强制）
- `src/types.ts` — 如需要导出 `LlmConnection` 等类型（仅 `import type` 引用，不破坏现有导出）

## 6. 依赖关系图

```
adapter-registry ──→ openai-compatible（唯一依赖 openai SDK 的模块）
      ↑
model-router（门面）──→ llm-adapter 契约
      │                └─→ llm-error（分类/重试判定）
      ├─→ agent-loop / team-coordinator / skill-evolution / router（零改动）
      └─→ hooks / server / base-agent / index（仅 import type，零改动）
```

## 7. 验证标准

**单元测试（新增 `test/llm-adapter.test.ts`，mock OpenAI 请求层，不触真实 LLM）**：
- `complete`：正确规范化 text / toolCalls / usage / finishReason
- `thinking`：`extra_body.thinking = {type:"enabled"}` 透传（profile.thinking=true 时）
- `completeStream`：`reasoning_content` → `thinking` chunk；tool_calls 增量累积顺序正确；usage 只累计一次
- 错误分类：quota 文案 / 401 / 超时分别映射为 `quota` / `invalid_credential` / `timeout`；`isRetryable` 判定正确
- registry：未知 adapter id 降级 `openai-compatible`；`adapter` 缺省走默认
- 门面回归：`completeWithProfile` / `completeStream` 行为与改造前一致（复用既有 mock 夹具）

**整体回归**：
- 现有测试全绿（当前 184 个，server.test.ts 已 mock coordinator/agent，不受影响）
- `npx tsc --noEmit` + `npx eslint src/` + `npm run web:build` 通过
- 真机冒烟（DEEPSEEK_API_KEY）：`/chat` 流式 + `/plan` 协作各跑一轮，thinking 与工具调用正常

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 行为回归（thinking / reasoning_content / usage 计数） | adapter 内**原样迁移**现有逻辑 + 新增单测覆盖上述三点 + 真机冒烟 |
| 双层重试（hook 重试退避 + adapter 网络重试） | 明确分层：adapter 只做网络层 retryable 快速重试（≤3 次、指数退避），hook 保留业务级重试/模型降级；文档写明职责边界 |
| 旧配置无 `adapter` 字段 | 缺省 `"openai-compatible"`，零迁移；`thinking` 继承规则保持不变 |
| 新 provider 参数不同（Anthropic 的 max_tokens 语义等） | `LlmConnection` 预留可选扩展字段；适配器内部自行处理供应商差异，契约不膨胀 |
| 单例注册表时序（adapter 未注册即被引用） | adapter 注册发生在 `src/index.ts` 启动早期（与 ToolRegistry 注册并列）；`resolve` 对未注册 id 降级兜底 |

## 9. 执行记录

| 日期 | 任务 | 说明 |
|------|------|------|
| 2026-08 | 实现 | 新建 `src/core/llm/llm-adapter.ts`（LlmConnection/LlmAdapter 契约）、`llm-error.ts`（LlmError + classifyError/classifyHttpError/isRetryable，参考 DSH error.ts 文案启发式）、`adapter-registry.ts`（单例，未知 id 降级 openai-compatible）、`openai-compatible.ts`（从 model-router 迁移 complete/completeStream：thinking extra_body 透传、reasoning_content 流式、usage 单次回调、retryable 指数退避 ≤3 次、abort 语义不变） |
| 2026-08 | 门面化 | `model-router.ts` 删除 OpenAI SDK 直调与 client 缓存，改为 profile 解析 → adapterRegistry.resolve → adapter 调用；token/成本计量留在门面（流式 usage 经 onUsage 回调单次累计）；公开 API 与运行时覆盖全部保留 |
| 2026-08 | 配置 | `config/models.json` default 增加 `adapter: "openai-compatible"`（缺省兼容旧配置）；`src/types.ts` StreamChunk 增加可选 `errorCode`（向后兼容） |
| 2026-08 | 测试 | 新增 `test/llm-adapter.test.ts` 14 例（vi.mock openai）：complete 规范化/thinking 透传/429 重试/quota 不重试/重试耗尽、流式组装+usage 单次回调、创建失败 errorCode、abort 语义、错误分类单元、注册表降级、ModelRouter 门面计量；fake timers 加速重试用例 |
| 2026-08 | 验证 | tsc + eslint 全绿；全量测试 198 passed（184 原有 + 14 新增）；npm run build 成功 |
