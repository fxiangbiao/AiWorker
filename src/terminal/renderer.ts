/**
 * TerminalRenderer — 终端输出 + 状态栏
 *
 * 简化设计：不抢光标、不管理布局。状态栏为普通输出行，输入由 readline 全权处理。
 */

import { enableVT, savePosition, restorePosition, moveTo, clearLine, clearLineFromCursor } from "./ansi.js";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

export interface StatusLine {
  mode: string;
  model: string;
  tokensUsed: number;
  tokensMax: number;
  queueSize: number;
  extra?: string;
  toolName?: string;
  iteration?: number;
  maxIter?: number;
}

export class TerminalRenderer {
  private active = false;
  private statusDirty = false;
  private currentStatus: StatusLine | null = null;

  init(): void {
    this.active = true;
    enableVT();
  }

  /**
   * 更新常驻状态栏 — 在当前行刷新，不影响上方内容
   * 配合流式输出使用：文本行在上面滚动，状态栏保持在最后一行
   */
  updateLiveStatus(status: StatusLine): void {
    if (!this.active) return;
    this.currentStatus = status;
    this.statusDirty = true;

    const text = this.buildStatusText(status);
    // CR + 清行 + 写状态（不换行，保持光标在状态行内）
    stdout.write(`\r${clearLineFromCursor()}${text}`);
  }

  /**
   * 输出内容行 — 自动把状态栏推到内容下方
   */
  writeContentLine(text: string): void {
    if (!this.active) { stdout.write(text + "\n"); return; }
    // 清除当前状态行 → 写内容 → 换行 → 恢复状态
    stdout.write(`\r${clearLineFromCursor()}${text}\n`);
    if (this.currentStatus && this.statusDirty) {
      stdout.write(this.buildStatusText(this.currentStatus));
    }
  }

  /**
   * 流式写入文本（不换行，不破坏状态栏）
   * 直接输出，状态栏在之后的 updateLiveStatus 刷新时恢复
   */
  writeStreamText(text: string): void {
    if (!this.active) { stdout.write(text); return; }
    stdout.write(text);
  }

  /**
   * 清除状态栏（换行离开状态行）
   */
  clearStatusLine(): void {
    if (!this.currentStatus) return;
    stdout.write(`\r${clearLineFromCursor()}\n`);
    this.currentStatus = null;
    this.statusDirty = false;
  }

  private buildStatusText(status: StatusLine): string {
    const pct = status.tokensMax > 0
      ? Math.round((status.tokensUsed / status.tokensMax) * 100) : 0;

    const tokenStr = status.tokensMax > 0
      ? `${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)}`
      : "";
    const pctStr = status.tokensMax > 0
      ? `${pct}%`
      : "";
    const iterStr = status.iteration != null
      ? `iter ${status.iteration}${status.maxIter ? `/${status.maxIter}` : ""}`
      : "";
    const queueStr = status.queueSize > 0 ? `排队:${status.queueSize}` : "";
    const toolStr = status.toolName ? `🛠 ${status.toolName}` : "";

    const modeLabels: Record<string, string> = {
      ask: "询问", plan: "规划", craft: "执行",
    };
    const modeLabel = modeLabels[status.mode] ?? status.mode;

    const parts = [
      chalk.bold.cyan(`[${status.mode.toUpperCase()}] ${modeLabel}`),
      status.model ? chalk.white(status.model) : "",
      tokenStr ? (pct > 80 ? chalk.bold.yellow(`${tokenStr} ${pctStr}`) : chalk.white(`${tokenStr} ${pctStr}`)) : "",
      iterStr ? chalk.white(iterStr) : "",
      toolStr ? chalk.blue(toolStr) : "",
      queueStr ? chalk.yellow(queueStr) : "",
    ].filter(Boolean);

    const sep = chalk.gray(" │ ");
    let line = "";
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) line += sep;
      line += parts[i];
    }

    const right = chalk.gray(status.extra ?? "/help /thinking /exit");
    const { columns } = stdout;
    const maxWidth = Math.max(40, columns - 4);

    const stripAnsi = (s: string) => s.replace(/\x1b\[\d+(;\d+)*m/g, "");
    const leftLen = stripAnsi(line).length;
    const rightLen = stripAnsi(right).length;

    if (leftLen + rightLen + 4 > maxWidth) {
      const compact = [
        chalk.bold.cyan(`[${status.mode.toUpperCase()}]`),
        status.model ? chalk.white(status.model) : "",
        tokenStr ? (pct > 80 ? chalk.bold.yellow(`${tokenStr}`) : chalk.white(tokenStr)) : "",
        toolStr ? chalk.blue(toolStr) : "",
        queueStr ? chalk.yellow(queueStr) : "",
      ].filter(Boolean).join(sep);
      line = compact;
    }

    const finalLeftLen = stripAnsi(line).length;
    const pad = Math.max(2, maxWidth - finalLeftLen - rightLen);

    return `${chalk.gray("─")} ${line}${" ".repeat(pad)}${right} ${chalk.gray("─")}`;
  }

  /**
   * 打印状态栏 — 普通输出行 (一次性，不使用常驻模式)
   */
  printStatus(status: StatusLine): void {
    if (!this.active) return;
    this.currentStatus = null;
    stdout.write(this.buildStatusText(status) + "\n");
  }

  async prompt(): Promise<string> {
    if (!this.active) return this.fallbackPrompt();

    if (stdin.isPaused()) stdin.resume();

    const rl = createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
      prompt: "",
    });

    return new Promise<string>((resolve) => {
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  /**
   * 预填文本显示提示
   */
  async promptWithText(prefill: string): Promise<string> {
    if (!this.active) return prefill;

    return new Promise<string>((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: stdout,
        terminal: true,
      });
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        resolve(answer || prefill);
      });
      rl.write(prefill);
    });
  }

  /** 写入一行内容 */
  writeLine(text: string): void {
    stdout.write(text + "\n");
  }

  /** 流式写入（不换行） */
  writeRaw(text: string): void {
    stdout.write(text);
  }

  /** 写入带颜色的错误 */
  writeError(text: string): void {
    stdout.write(chalk.red(text) + "\n");
  }

  /** 写入成功信息 */
  writeSuccess(text: string): void {
    stdout.write(chalk.green(text) + "\n");
  }

  /** 写入灰色信息 */
  writeInfo(text: string): void {
    stdout.write(chalk.gray(text) + "\n");
  }

  destroy(): void {
    this.active = false;
    stdout.write("\n");
  }

  private fmt(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private async fallbackPrompt(): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
    });
    return new Promise<string>((resolve) => {
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

export const renderer = new TerminalRenderer();
