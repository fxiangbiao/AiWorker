/**
 * TerminalRenderer — 终端输出 + 状态栏
 *
 * 简化设计：不抢光标、不管理布局。状态栏为普通输出行，输入由 readline 全权处理。
 */

import { enableVT } from "./ansi.js";
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
    const maxWidth = Math.max(40, columns - 4); // leave margin

    const pct = status.tokensMax > 0
      ? Math.round((status.tokensUsed / status.tokensMax) * 100) : 0;

    const tokenStr = status.tokensMax > 0
      ? `${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)} tokens`
      : "";
    const queueStr = status.queueSize > 0 ? `排队: ${status.queueSize}` : "";

    const rawParts: string[] = [
      status.mode.toUpperCase(),
      status.model || "",
      tokenStr,
      queueStr,
    ].filter(Boolean);

    const parts = [
      chalk.bold.cyan(status.mode.toUpperCase()),
      status.model ? chalk.bold.white(status.model) : "",
      tokenStr ? (pct > 80 ? chalk.bold.yellow(tokenStr) : chalk.bold.white(tokenStr)) : "",
      queueStr ? chalk.yellow(queueStr) : "",
    ].filter(Boolean);

    // build left side, truncate if too long
    const sep = chalk.gray(" │ ");
    let leftText = "";
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) leftText += sep;
      leftText += parts[i];
    }

    const right = chalk.gray(status.extra ?? " /help /status /exit");

    // strip ANSI for length calc
    const stripAnsi = (s: string) => s.replace(/\x1b\[\d+(;\d+)*m/g, "");
    const leftLen = stripAnsi(leftText).length;
    const rightLen = stripAnsi(right).length;

    // if too wide, truncate middle parts
    if (leftLen + rightLen + 4 > maxWidth) {
      // keep mode + right help, drop middle
      leftText = chalk.bold.cyan(status.mode.toUpperCase());
      if (queueStr) leftText += sep + chalk.yellow(queueStr);
      if (tokenStr) leftText += sep + (pct > 80 ? chalk.bold.yellow(tokenStr) : chalk.bold.white(tokenStr));
    }

    const finalLeftLen = stripAnsi(leftText).length;
    const pad = Math.max(2, maxWidth - finalLeftLen - rightLen);

    stdout.write(`${chalk.gray("─")} ${leftText}${" ".repeat(pad)}${right} ${chalk.gray("─")}\n`);
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
