/**
 * TerminalRenderer — 终端布局管理器
 *
 * 职责：维护底部固定区域（输入行 + 状态栏），管理内容区滚动。
 *
 * 布局协议：
 *   [内容区 — stdout 正常写，允许滚动]
 *   ────────────────────────────  ← 分隔线
 *   你> _                        ← 输入行（rows-2）
 *   ────────────────────────────
 *   craft · model · 1.2k/8K     ← 状态栏（rows-1，反色背景）
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
  private bottomLines = 2;
  private active = false;

  init(): void {
    this.active = true;
    ansi.enableVT();
    ansi.hideCursor();
    this.redrawBottom();

    // 监听窗口大小变化
    stdout.on("resize", () => {
      if (this.active) this.redrawBottom();
    });
  }

  /**
   * 向内容区写入文本，保持底部区域固定在末尾
   */
  write(text: string): void {
    if (!this.active) {
      console.log(text);
      return;
    }
    // 把光标移到内容区底部（当前内容在最下面一行的上面）
    // 先把底部区域"擦掉"，写新内容，再"贴回去"
    ansi.savePosition();
    // 向上 2 行到内容区分隔位置
    ansi.moveUp(this.bottomLines);
    // 清空从这儿往下的内容
    ansi.clearScreenDown();
    // 写入文本
    stdout.write(text);
    stdout.write("\n");
    // 重绘底部
    this.redrawBottom();
    ansi.restorePosition();
  }

  /**
   * 写入不换行的文本，用于 spinner / 同一行更新
   */
  writeInline(text: string): void {
    if (!this.active) {
      stdout.write(text);
      return;
    }
    ansi.savePosition();
    ansi.moveUp(this.bottomLines);
    ansi.clearLineFromCursor();
    stdout.write(text);
    ansi.restorePosition();
  }

  /**
   * 更新状态栏内容（立即刷新）
   */
  updateStatus(status: StatusLine): void {
    if (!this.active) return;
    ansi.savePosition();

    const { columns } = stdout;
    const right = status.extra ?? "/help /mode /exit";
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
    const padding = columns - chalk.reset(left).length - right.length - 2;
    if (padding > 1) {
      line += " ".repeat(padding);
    }
    line += right;

    line = ansi.reverseVideo(` ${line} `.slice(0, columns));

    ansi.moveTo(stdout.rows, 1);
    ansi.clearLine();
    stdout.write(line);
    ansi.restorePosition();
  }

  /**
   * 在输入行显示提示，等待用户输入
   * 返回用户输入文本
   */
  prompt(): Promise<string> {
    return this.doPrompt("");
  }

  /**
   * 预填文本到输入行并等待用户输入
   */
  promptWithPrefill(prefill: string): Promise<string> {
    return this.doPrompt(prefill);
  }

  /**
   * 渲染错误信息（红色，写入内容区）
   */
  writeError(text: string): void {
    this.write(chalk.red(text));
  }

  /**
   * 渲染成功提示
   */
  writeSuccess(text: string): void {
    this.write(chalk.green(text));
  }

  /**
   * 渲染信息文本（灰色）
   */
  writeInfo(text: string): void {
    this.write(chalk.gray(text));
  }

  destroy(): void {
    this.active = false;
    ansi.showCursor();
    // 额外换行，确保后续 shell 提示正常
    stdout.write("\n");
  }

  // ─── 私有 ───

  private async doPrompt(prefill: string): Promise<string> {
    if (!this.active) {
      return this.fallbackPrompt(prefill);
    }
    return this.ansiPrompt(prefill);
  }

  /**
   * 使用 readline 的 ANSI 输入提示
   */
  private async ansiPrompt(prefill: string): Promise<string> {
    const { default: readline } = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
    });

    return new Promise<string>((resolve) => {
      // 写入输入行提示
      ansi.savePosition();
      ansi.moveTo(stdout.rows - 1, 1);
      ansi.clearLine();
      const promptText = chalk.cyan("  你> ");
      stdout.write(promptText);

      if (prefill) {
        // 预填文本
        stdout.write(chalk.white(prefill));
        // 通过 hack 方式预填到 readline 的输入缓冲区
        // readline 本身没有 prefill API，我们在下一行提示用户确认
        rl.write(prefill);
      }

      rl.on("line", (line) => {
        rl.close();
        resolve(line);
      });

      rl.on("close", () => {
        // 如果没通过 line 回调，是 Ctrl+D
        resolve("");
      });
    });
  }

  /**
   * 非 ANSI 模式降级回退 — 普通 console 输入
   */
  private async fallbackPrompt(prefill: string): Promise<string> {
    const { default: readline } = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
    });

    const msg = prefill ? chalk.cyan(`你> ${chalk.white(prefill + " [Enter 发送]")}\n`) : chalk.cyan("你> ");
    return new Promise<string>((resolve) => {
      rl.question(msg, (answer) => {
        rl.close();
        resolve(answer);
      });
      if (prefill) {
        rl.write(prefill);
      }
    });
  }

  /**
   * 重绘底部区域（输入行 + 状态栏），光标回到输入位置
   */
  private redrawBottom(): void {
    const { rows, columns } = stdout;
    // 确保至少有 3 行空间
    if (rows < 5) return;

    ansi.savePosition();

    // 分隔线 + 输入行
    ansi.moveTo(rows - 1, 1);
    ansi.clearLine();
    stdout.write(chalk.gray("─".repeat(columns)));
    stdout.write("\n");
    stdout.write(chalk.cyan("  你> "));

    // 状态栏
    ansi.moveTo(rows, 1);
    ansi.clearLine();
    stdout.write(ansi.reverseVideo(" ".repeat(columns)));

    ansi.restorePosition();
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }
}

// 全局单例，与现有架构一致
export const renderer = new TerminalRenderer();
