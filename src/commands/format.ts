/**
 * CLI 命令显示工具 — 从 index.ts 迁出（命令模块共用）
 */

/** 终端显示宽度（CJK + fullwidth 计 2 列） */
export function displayWidth(s: string): number {
  let w = 0;
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\x1b\[\d+(;\d+)*m/g, "");
  for (const ch of clean) {
    w += (ch.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
  }
  return w;
}

export function padToWidth(s: string, targetWidth: number): string {
  const w = displayWidth(s);
  if (w >= targetWidth) return s;
  return s + " ".repeat(targetWidth - w);
}

/** 毫秒 → 人类可读（<1s 显示 ms，否则 s） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** token 数 → 千分位缩写（≥1000 显示 k，≥1e6 显示 m） */
export function fmtK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
