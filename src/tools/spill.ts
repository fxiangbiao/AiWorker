/**
 * 超长工具结果落盘（spill）
 * 对齐 DSH dsh-spill：结果超阈值时写入 <dataDir>/spills/，上下文只留定位符 + 预览
 * 事件溯源天然 replay-safe：事件日志只存定位符文本，完整内容在磁盘文件
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export const SPILL_THRESHOLD = 8000; // 超过该字符数触发落盘
export const SPILL_PREVIEW_CHARS = 1500; // 定位符内保留的预览长度

/** 兜底截断：无数据目录时原地截断，避免上下文被撑爆 */
function truncateInline(content: string): string {
  return (
    content.slice(0, SPILL_PREVIEW_CHARS) + `\n…[内容过长已截断，共 ${content.length} 字符]`
  );
}

/**
 * 超阈值内容 → 落盘并返回定位符文本；未超阈值原样返回；无 dataDir 时原地截断
 */
export function spillOrTruncate(
  dataDir: string | undefined,
  sessionId: string,
  content: string,
  ext = "txt",
): string {
  if (content.length <= SPILL_THRESHOLD) return content;

  if (dataDir) {
    const spillsDir = resolve(dataDir, "spills");
    mkdirSync(spillsDir, { recursive: true });
    const name = `${sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = resolve(spillsDir, name);
    writeFileSync(filePath, content, "utf-8");
    const tokens = Math.ceil(content.length / 3.5);
    const preview = content.slice(0, SPILL_PREVIEW_CHARS);
    const relPath = relative(dataDir, filePath).replace(/\\/g, "/");
    return (
      `[结果已落盘: ${relPath}（${content.length} 字符 / ~${tokens} tokens）。` +
      `如需完整内容，请用 fs_read 读取该文件。]\n\n${preview}${content.length > SPILL_PREVIEW_CHARS ? "…" : ""}`
    );
  }

  return truncateInline(content);
}
