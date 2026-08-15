/**
 * LLM 适配器错误分类 — 供应商无关的稳定错误码
 * 设计依据：对比报告借鉴点 #6（对齐 DSH dsh-llm 的 HarnessError/LlmError taxonomy）
 */

export type LlmErrorCode =
  | "quota"
  | "context_window"
  | "invalid_credential"
  | "empty_response"
  | "rate_limit"
  | "timeout"
  | "network"
  | "unknown";

const QUOTA_PATTERNS = [
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
];

const CONTEXT_WINDOW_PATTERNS = [
  /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i,
  /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\b/i,
  /\bcontext[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)\b/i,
  /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i,
];

/** 稳定、机器可路由的错误类（与 message 文案解耦，路由只认 code） */
export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

export function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}

export function isQuotaExceededError(detail: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(detail));
}

export function isContextWindowExceededError(detail: string): boolean {
  return CONTEXT_WINDOW_PATTERNS.some((p) => p.test(detail));
}

/** 从任意异常提取 HTTP 状态码（OpenAI SDK 错误携带 status 属性） */
function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as Record<string, unknown>).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** 非 2xx HTTP 响应 → 稳定错误码（对齐 DSH httpErrorCode 映射） */
export function classifyHttpError(status: number, detail: string): LlmErrorCode {
  if (status === 401 || status === 403) return "invalid_credential";
  if (isQuotaExceededError(detail)) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 400 && isContextWindowExceededError(detail)) return "context_window";
  if (status >= 500) return "network";
  return "unknown";
}

function isTimeoutLike(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const message = readableMessage(err);
  const code = (err as Record<string, unknown>).code;
  return (
    /timeout|timed\s*out|ETIMEDOUT|ECONNABORTED/i.test(message) ||
    (typeof code === "string" && (code === "ETIMEDOUT" || code === "ECONNABORTED"))
  );
}

function isNetworkLike(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const message = readableMessage(err);
  const code = (err as Record<string, unknown>).code;
  return (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|socket hang up|network/i.test(
      message,
    ) ||
    (typeof code === "string" &&
      /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)$/.test(code))
  );
}

/** 提取可读 message（兼容非 Error 对象：SDK 可能抛 plain object） */
function readableMessage(err: unknown): string {
  if (err instanceof Error) return `${err.message} ${err.name}`;
  if (typeof err === "object" && err !== null) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m.length > 0) return m;
    return String(err);
  }
  return String(err);
}

/** 任意异常 → 稳定错误码 */
export function classifyError(err: unknown): LlmErrorCode {
  if (isLlmError(err)) return err.code;
  const status = httpStatus(err);
  const o = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
  const code = o?.code;
  const type = o?.type;
  const detail = [readableMessage(err), typeof code === "string" ? code : "", typeof type === "string" ? type : ""]
    .filter(Boolean)
    .join(" ");
  if (status !== undefined) return classifyHttpError(status, detail);
  if (isQuotaExceededError(detail)) return "quota";
  if (isContextWindowExceededError(detail)) return "context_window";
  if (isTimeoutLike(err)) return "timeout";
  if (isNetworkLike(err)) return "network";
  return "unknown";
}

/** 只有瞬时失败可重试：限流 / 超时 / 网络错误（quota / 凭证 / 上下文超限重试无意义） */
export function isRetryable(code: LlmErrorCode): boolean {
  return code === "rate_limit" || code === "timeout" || code === "network";
}

/** 把任意异常包装为 LlmError（已分类的不再包装） */
export function toLlmError(err: unknown, code: LlmErrorCode = classifyError(err)): LlmError {
  if (isLlmError(err)) return err;
  const message = errorMessage(err);
  const fallback = `LLM request failed (${code})`;
  return new LlmError(code, message.length > 0 && message !== "[object Object]" ? message : fallback, {
    cause: err,
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "object" && err !== null) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return String(err);
}

export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { name?: unknown }).name === "AbortError") return true;
  const message = err instanceof Error ? err.message : "";
  // 单词边界收窄：避免消息中 "abort" 子串（如 "import"）误判为中断
  return /\babort(?:ed|ing)?\b/i.test(message);
}
