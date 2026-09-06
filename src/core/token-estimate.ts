/**
 * Token 估算共享工具（Sprint 44）
 * 粗糙启发式（无 tokenizer），仅用于展示/上下文分层统计/压缩预算判断；
 * 真实 token 一律以 provider 返回的 usage 为准。
 *
 * 规则：CJK 字符 ≈1 token/字；其余字符 ≈1 token/4 字符（混合文本经验值）。
 */

/** CJK 统一表意文字（含扩展 A）、兼容汉字、假名、谚文 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

/** 估算单段文本 token 数 */
export function estimateText(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(other / 4);
}

/** 估算单条消息 token 数（含 tool_calls 参数字符） */
export function estimateMessageTokens(content: unknown, toolCalls?: unknown): number {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const body = estimateText(text);
  const calls = toolCalls ? estimateText(JSON.stringify(toolCalls)) : 0;
  return body + calls;
}
