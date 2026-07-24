/**
 * TerminalRenderer — 终端输出 + 状态栏
 *
 * 不管理终端布局，不碰光标。与 inquirer 和平共存。
 * 状态栏作为普通输出行显示，输入由 inquirer 全权处理。
 */

import * as ansi from "./ansi.js";
import chalk from "chalk";
import { stdout } from "node:process";

export interface StatusLine {
  mode: string;
  model: string;
  tokensUsed: number;
  tokensMax: number;
  queueSize: number;
  extra?: string;
}

export class TerminalRenderer {
  private active = false;

  init(): void {
    this.active = true;
    ansi.enableVT();
  }

  /**
   * 打印状态栏 — 作为普通输出行，不抢光标
   */
  printStatus(status: StatusLine): void {
    const { columns } = stdout;
    const right = status.extra ?? "/help /status /exit";
    const leftParts: string[] = [];
    leftParts.push(chalk.cyan(status.mode));
    if (status.model) leftParts.push(chalk.white(status.model));
    if (status.tokensMax > 0) {
      const pct = Math.round((status.tokensUsed / status.tokensMax) * 100);
      const tknColor = pct > 80 ? chalk.yellow : chalk.white;
      leftParts.push(tknColor(`${this.formatTokens(status.tokensUsed)}/${this.formatTokens(status.tokensMax)}`));
    }
    if (status.queueSize > 0) {
      leftParts.push(chalk.yellow(`排队: ${status.queueSize}`));
    }
    const left = leftParts.join(" · ");

    let line = left;
    const rawLen = left.replace(/\x1b\[\d+(;\d+)*m/g, "").length;
    const padding = columns - rawLen - right.length - 4;
    if (padding > 1) line += " ".repeat(padding);
    line += right;

    stdout.write(ansi.reverseVideo(`  ${line}  `.slice(0, columns)));
    stdout.write("\n");
  }

  /** 重新打印状态栏（用于刷新） */
  updateStatus(status: StatusLine): void {
    this.printStatus(status);
  }

  /**
   * 写入内容（不含换行），用于流式输出
   */
  writeRaw(text: string): void {
    stdout.write(text);
  }

  /**
   * 写入行内文本可覆盖（用于 spinner）
   */
  writeInline(text: string): void {
    stdout.write(`\r${text}${ansi.clearLineFromCursorStr()}`);
  }

  /** 写入错误 */
  writeError(text: string): void {
    stdout.write(chalk.red(text) + "\n");
  }

  /** 写入成功 */
  writeSuccess(text: string): void {
    stdout.write(chalk.green(text) + "\n");
  }

  /** 写入灰字 */
  writeInfo(text: string): void {
    stdout.write(chalk.gray(text) + "\n");
  }

  /** 写入带换行 */
  writeLine(text: string): void {
    stdout.write(text + "\n");
  }

  destroy(): void {
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }
}

export const renderer = new TerminalRenderer();
