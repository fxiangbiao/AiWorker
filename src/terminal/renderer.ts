/**
 * TerminalRenderer — 终端布局管理器
 *
 * 底部 2 行固定区域：
 *   rows-2 → 输入行 "你> _"
 *   rows-1 → 状态栏（反色背景）
 *
 * 内容区正常 stdout，允许滚动。
 */

import * as ansi from "./ansi.js";
import chalk from "chalk";
import { stdout } from "node:process";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";

export interface StatusLine {
  mode: string;
  model: string;
  tokensUsed: number;
  tokensMax: number;
  queueSize: number;
  extra?: string;
}

const STATUSBAR_ROW = -1; // relative to bottom
const INPUT_ROW = -2;

export class TerminalRenderer {
  private active = false;
  private rl: Interface | null = null;

  init(): void {
    this.active = true;
    ansi.enableVT();
  }

  /**
   * 渲染状态栏 — 写入最后一行
   */
  printStatus(status: StatusLine): void {
    if (!this.active) return;
    const { columns } = stdout;

    const pct = status.tokensMax > 0 ? Math.round((status.tokensUsed / status.tokensMax) * 100) : 0;

    const line = [
      chalk.bold.cyan(status.mode.toUpperCase()),
      status.model ? chalk.white(status.model) : "",
      status.tokensMax > 0
        ? (pct > 80 ? chalk.yellow : chalk.white)(`${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)} tokens`)
        : "",
      status.queueSize > 0 ? chalk.yellow(`排队: ${status.queueSize}`) : "",
    ]
      .filter(Boolean)
      .join(chalk.gray("  │  "));

    const help = chalk.gray(status.extra ?? " /help /status /exit");

    const raw = `${status.mode.toUpperCase()}  │  ${status.model}  │  ${this.fmt(status.tokensUsed)}/${this.fmt(status.tokensMax)} tokens`;
    const pad = columns - raw.length - " /help /status /exit".length - 6;

    ansi.moveTo(stdout.rows + STATUSBAR_ROW, 1);
    ansi.clearLine();
    stdout.write(`  ${line}${" ".repeat(Math.max(1, pad))}${help}  `);
  }

  /**
   * 显示输入提示并读取一行
   */
  async prompt(): Promise<string> {
    if (!this.active) {
      return this.fallbackPrompt();
    }

    const rows = stdout.rows;

    // 确保底部布局存在
    ansi.moveTo(rows + INPUT_ROW, 1);
    ansi.clearLine();
    stdout.write(chalk.cyan("你> "));

    const rl = createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
    });
    this.rl = rl;

    return new Promise<string>((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        this.rl = null;
        resolve(answer);
      });

      rl.on("SIGINT", () => {
        // 在 close 回调处理
      });
    });
  }

  /**
   * 预填文本显示提示
   */
  async promptWithText(prefill: string): Promise<string> {
    if (!this.active) return prefill;

    const rows = stdout.rows;
    ansi.moveTo(rows + INPUT_ROW, 1);
    ansi.clearLine();

    // 写 "你>" + 预填文本
    stdout.write(chalk.cyan("你> "));
    stdout.write(chalk.yellow(prefill));
    stdout.write(chalk.gray("  [Enter 发送 / 输入覆盖]"));

    const rl = createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
    });
    this.rl = rl;

    return new Promise<string>((resolve) => {
      rl.write(prefill);

      rl.question("", (answer) => {
        rl.close();
        this.rl = null;
        resolve(answer || prefill);
      });
    });
  }

  /**
   * 写入内容到内容区（底部 2 行之上）
   */
  writeLine(text: string): void {
    if (!this.active) {
      stdout.write(text + "\n");
      return;
    }
    // 光标移到内容区底部（status 行的上面）
    const rows = stdout.rows;
    ansi.moveTo(rows - 2, 1);
    ansi.clearLine();
    stdout.write(text + "\n");
    // 重绘底部 2 行
    ansi.moveTo(rows - 1, 1);
    ansi.clearLine();
    stdout.write(chalk.cyan("你> "));
  }

  /**
   * 流式写入（不换行），用于 onTextDelta
   */
  writeRaw(text: string): void {
    if (!this.active) {
      stdout.write(text);
      return;
    }
    stdout.write(text);
  }

  /**
   * 写入内容并保持底部 2 行在末尾
   */
  writeAbove(text: string): void {
    if (!this.active) {
      stdout.write(text + "\n");
      return;
    }
    const rows = stdout.rows;
    // 在底部 2 行上方的正确位置写内容
    // 把当前行"挤"上去
    ansi.moveTo(rows - 2, 1);
    // 向上插入一行（用 scroll up + move 模拟）
    // 简化：直接在底部 2 行上面追加一行
    stdout.write("\x1bM"); // scroll reverse (insert line)
    ansi.moveTo(rows - 2, 1);
    ansi.clearLine();
    stdout.write(text);

    // 确保状态栏在底部 — 有时 scroll 会改变位置
    ansi.moveTo(rows, 1);
    ansi.clearLine();
  }

  /** 写入错误 */
  writeError(text: string): void {
    this.writeAbove(chalk.red(text));
  }

  /** 写入成功 */
  writeSuccess(text: string): void {
    this.writeAbove(chalk.green(text));
  }

  /** 写入灰字 */
  writeInfo(text: string): void {
    this.writeAbove(chalk.gray(text));
  }

  /**
   * 确保底部 2 行布局正确（在大量 console.log 输出后调用）
   */
  ensureLayout(): void {
    if (!this.active) return;
    const rows = stdout.rows;
    // 在底部绘制分隔线
    ansi.moveTo(rows - 2, 1);
    ansi.clearLine();
    // 不强制写 "你> " — prompt() 会处理
    ansi.moveTo(rows - 1, 1);
    ansi.clearLine();
  }

  destroy(): void {
    this.active = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // 在 exit 时多一个换行，让 shell 提示正常
    stdout.write("\n\n");
  }

  private fmt(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private async fallbackPrompt(): Promise<string> {
    const { default: inquirer } = await import("inquirer");
    const { input } = await inquirer.prompt([
      { type: "input", name: "input", message: chalk.cyan("你>"), prefix: "" },
    ]);
    return input;
  }
}

export const renderer = new TerminalRenderer();
