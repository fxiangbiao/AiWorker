/**
 * TerminalRenderer — 终端输出 + 状态栏
 *
 * 简化设计：不抢光标、不管理布局。状态栏为普通输出行，输入由 readline 全权处理。
 */

import { enableVT } from "./ansi.js";
import chalk from "chalk";
import { createInterface } from "node:readline";
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
    enableVT();
  }

  /**
   * 打印状态栏 — 普通输出行
   */
  printStatus(status: StatusLine): void {
    if (!this.active) return;
    const { columns } = stdout;

    const pct = status.tokensMax > 0
      ? Math.round((status.tokensUsed / status.tokensMax) * 100) : 0;

    const parts = [
      chalk.bold.cyan(status.mode.toUpperCase()),
      status.model ? chalk.bold.white(status.model) : "",
      status.tokensMax > 0
        ? (pct > 80 ? chalk.bold.yellow : chalk.bold.white)(
            `${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)} tokens`
          )
        : "",
      status.queueSize > 0 ? chalk.yellow(`排队: ${status.queueSize}`) : "",
    ].filter(Boolean).join(chalk.gray("  │  "));

    const right = chalk.gray(status.extra ?? "/help /status /exit");

    // 计算无 ANSI 长度来 padding
    const rawParts = [
      status.mode.toUpperCase(),
      status.model || "",
      status.tokensMax > 0 ? `${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)} tokens` : "",
      status.queueSize > 0 ? `排队: ${status.queueSize}` : "",
    ].filter(Boolean);
    const rawLen = rawParts.join("  │  ").length;
    const pad = Math.max(1, columns - rawLen - " /help /status /exit ".length);

    stdout.write(`${chalk.gray("─")}  ${parts}${" ".repeat(pad)}${right}  ${chalk.gray("─")}\n`);
  }

  /**
   * 显示输入提示并读取一行
   */
  async prompt(): Promise<string> {
    if (!this.active) return this.fallbackPrompt();

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
