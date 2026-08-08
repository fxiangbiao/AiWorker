/**
 * renderer.ts — TerminalRenderer（Tui 薄封装）
 *
 * 保留对外兼容 API（printStatus/updateLiveStatus/write/prompt 等），
 * 内部委托给 Tui 组件：消息写入 MessageList，状态写入 StatusBar。
 * 提供非 TUI 环境的降级：直接写 stdout + readline。
 */

import chalk from "chalk";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tui } from "./tui.js";
import { enableVT } from "./ansi.js";
import type { StatusData } from "./components.js";

export interface StatusLine extends StatusData {
  /** 右侧提示文本（可选） */
  extra?: string;
}

export class TerminalRenderer {
  private active = false;
  private fallbackMode = false; // 非 TUI 环境（无法进 raw mode 等）
  private lastRl: import("node:readline").Interface | null = null;
  private historyFile = "";
  private historyLines: string[] = [];
  private completer: ((line: string) => [string[], string]) | null = null;

  init(): void {
    this.active = true;
    enableVT();
    try {
      tui.init();
    } catch {
      this.fallbackMode = true;
    }
  }

  /** 状态栏更新 — 委托 Tui StatusBar */
  updateLiveStatus(status: StatusLine): void {
    if (!this.active) return;
    if (tui.isActive()) {
      tui.setStatus(status);
    } else if (this.fallbackMode) {
      stdout.write(this.buildStatusText(status) + "\r");
    }
  }

  endLiveStatus(): void {
    if (!this.active) return;
    if (this.fallbackMode) {
      stdout.write("\r\x1b[2K");
    }
  }

  /** 打印单行状态 — TUI 激活时更新状态栏，否则打印新行 */
  printStatus(status: StatusLine): void {
    if (!this.active) return;
    if (tui.isActive()) {
      tui.setStatus(status);
    } else {
      stdout.write(this.buildStatusText(status) + "\n");
    }
  }

  /** 返回状态栏文本（供 Tui 初始化等） */
  formatStatus(status: StatusLine): string {
    return this.buildStatusText(status);
  }

  // ── 内容输出 ──

  write(text: string): void {
    if (!this.active) return;
    if (tui.isActive()) {
      // 内联追加（思考流式等增量），避免拆行
      tui.appendInline(text);
    } else {
      stdout.write(text);
    }
  }

  writeLine(text: string): void {
    if (!this.active) return;
    if (tui.isActive()) {
      tui.appendMessage(text);
    } else {
      stdout.write(text + "\n");
    }
  }

  writeError(text: string): void {
    this.writeLine(chalk.red(text));
  }

  writeSuccess(text: string): void {
    this.writeLine(chalk.green(text));
  }

  writeInfo(text: string): void {
    this.writeLine(chalk.gray(text));
  }

  // ── 输入 ──

  configureInput(historyFile: string, completer?: (line: string) => [string[], string]): void {
    this.historyFile = historyFile;
    this.completer = completer ?? null;
    this.historyLines = this.loadHistory();
    if (tui.isActive()) {
      tui.input.setHistory(this.historyLines);
      tui.input.setCompleter((line) => {
        const res = this.completer?.(line);
        return res ? res[0] : [];
      });
    }
  }

  recordHistory(line: string): void {
    if (!this.historyFile || !line.trim()) return;
    this.historyLines.push(line.trim());
    if (this.historyLines.length > 1 && this.historyLines[this.historyLines.length - 2] === line.trim()) {
      this.historyLines.pop();
    }
    this.historyLines = this.historyLines.slice(-500);
    this.saveHistory();
  }

  private loadHistory(): string[] {
    try {
      const raw = readFileSync(this.historyFile, "utf-8");
      return raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(-500);
    } catch {
      return [];
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true });
      writeFileSync(this.historyFile, this.historyLines.join("\n") + "\n", "utf-8");
    } catch {
      // ignore
    }
  }

  async prompt(): Promise<string> {
    if (!this.active) return this.fallbackPrompt();
    if (tui.isActive()) {
      return tui.prompt();
    }
    if (stdin.isPaused()) stdin.resume();
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    return this.fallbackPrompt();
  }

  async promptWithText(prefill: string): Promise<string> {
    if (!this.active) return prefill;
    if (tui.isActive()) {
      const p = tui.prompt();
      for (const ch of prefill) tui.input.type(ch);
      tui.requestRender();
      return p;
    }
    return new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: stdout, terminal: true });
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        resolve(answer || prefill);
      });
      rl.write(prefill);
    });
  }

  destroy(): void {
    this.active = false;
    if (tui.isActive()) {
      tui.destroy();
    } else {
      stdout.write("\n");
    }
  }

  // ── 内部 ──

  private buildStatusText(status: StatusLine): string {
    const tokenStr = status.tokensUsed > 0 ? `token ${this.fmt(status.tokensUsed)}` : "";
    const iterStr =
      status.iteration != null ? `iter ${status.iteration}${status.maxIter ? `/${status.maxIter}` : ""}` : "";
    const queueStr = status.queueSize > 0 ? `排队:${status.queueSize}` : "";
    const toolStr = status.toolName ? `🛠 ${status.toolName}` : "";
    const statusStr = status.status ? chalk.yellow(status.status) : "";

    const modeLabels: Record<string, string> = { ask: "询问", plan: "规划", auto: "自动" };
    const modeLabel = modeLabels[status.mode] ?? status.mode;
    const barStr = status.windowPct != null ? this.renderWindowBar(status.windowPct) : "";

    const parts = [
      chalk.bold.cyan(`[${status.mode.toUpperCase()}] ${modeLabel}`),
      status.model ? chalk.white(status.model) : "",
      tokenStr ? chalk.white(tokenStr) : "",
      barStr ? barStr : "",
      iterStr ? chalk.white(iterStr) : "",
      toolStr ? chalk.blue(toolStr) : "",
      queueStr ? chalk.yellow(queueStr) : "",
      statusStr ? statusStr : "",
    ].filter(Boolean);

    const sep = chalk.gray(" │ ");
    const line = parts.join(sep);
    const right = chalk.gray(status.extra ?? "/help /thinking /exit");
    const { columns } = stdout;
    const maxWidth = Math.max(40, columns - 4);

    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[\d+(;\d+)*m/g, "");
    const leftLen = stripAnsi(line).length;
    const rightLen = stripAnsi(right).length;
    const finalLeftLen = leftLen;
    const pad = Math.max(2, maxWidth - finalLeftLen - rightLen);

    return `${chalk.gray("─")} ${line}${" ".repeat(pad)}${right} ${chalk.gray("─")}`;
  }

  private renderWindowBar(pct: number): string {
    const total = 10;
    const filled = Math.round((Math.min(pct, 100) / 100) * total);
    const empty = total - filled;
    const fill = "█".repeat(filled);
    const rest = "░".repeat(empty);
    const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
    return color(`[${fill}${rest}] ${pct}%`);
  }

  private fmt(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private async fallbackPrompt(): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: stdout, terminal: true });
    return new Promise<string>((resolve) => {
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

export const renderer = new TerminalRenderer();
