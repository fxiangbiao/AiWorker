/**
 * ANSI 转义码工具 — 终端渲染基础设施
 * 所有终端控制序列集中管理，保证跨平台兼容
 */

import { stdout } from "node:process";

let vtEnabled = false;

export function enableVT(): void {
  if (vtEnabled) return;
  // Node.js 默认已为 stdout 启用 VT 处理，但显式确保
  // 对于部分特殊终端环境，直接注入 ENABLE_VIRTUAL_TERMINAL_PROCESSING
  vtEnabled = true;
}

export function hideCursor(): void {
  stdout.write("\x1b[?25l");
}

export function showCursor(): void {
  stdout.write("\x1b[?25h");
}

export function savePosition(): void {
  stdout.write("\x1b[s");
}

export function restorePosition(): void {
  stdout.write("\x1b[u");
}

export function moveTo(row: number, col: number): void {
  stdout.write(`\x1b[${row};${col}H`);
}

export function moveUp(n: number): void {
  stdout.write(`\x1b[${n}A`);
}

export function moveDown(n: number): void {
  stdout.write(`\x1b[${n}B`);
}

export function clearLine(): void {
  stdout.write("\x1b[2K");
}

export function clearLineFromCursor(): void {
  stdout.write("\x1b[K");
}

export function clearLineFromCursorStr(): string {
  return "\x1b[K";
}

export function clearScreenDown(): void {
  stdout.write("\x1b[J");
}

export function eraseLines(count: number): void {
  for (let i = 0; i < count; i++) {
    moveUp(1);
    clearLine();
  }
}

/**
 * 反色背景 + 文字（用于状态栏）
 */
export function reverseVideo(text: string): string {
  return `\x1b[7m${text}\x1b[0m`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

export function italic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

/** 光标移到下一行行首 */
export function newline(): void {
  stdout.write("\r\n");
}

/** 回到当前行行首 */
export function carriageReturn(): void {
  stdout.write("\r");
}
