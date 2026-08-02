/**
 * TerminalRenderer — 终端输出 + 状态栏
 *
 * 设计原则：
 * - 状态栏仅在"空闲"和"思考"阶段出现在当前行，用 \r 原地刷新
 * - 流式文本输出期间不显示状态栏（避免滚动混乱）
 * - 工具调用/结果以独立行展示，完成后可打印状态
 */

import { enableVT } from "./ansi.js";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StatusLine {
  mode: string;
  model: string;
  /** 累计消耗 token（会话级） */
  tokensUsed: number;
  /** 当前上下文窗口占用百分比 (0-100)，可选；传了才显示 */
  windowPct?: number;
  queueSize: number;
  extra?: string;
  toolName?: string;
  iteration?: number;
  maxIter?: number;
}

export class TerminalRenderer {
  private active = false;

  init(): void {
    this.active = true;
    enableVT();
  }

  /**
   * 内联刷新状态栏 — 仅用于光标在同一行时（思考/spinner 阶段）
   * 使用 \r 回到行首 + 清行 + 重写
   */
  updateLiveStatus(status: StatusLine): void {
    if (!this.active) return;
    const text = this.buildStatusText(status);
    stdout.write(`\r\x1b[2K${text}`);
  }

  /**
   * 结束内联状态栏 — 换行离开状态行，之后可正常输出内容
   */
  endLiveStatus(): void {
    if (!this.active) return;
    stdout.write(`\r\x1b[2K`);
  }

  /**
   * 打印单行状态（带换行）
   */
  printStatus(status: StatusLine): void {
    if (!this.active) return;
    stdout.write(this.buildStatusText(status) + "\n");
  }

  // ── 普通内容输出 ──

  write(text: string): void {
    stdout.write(text);
  }

  writeLine(text: string): void {
    stdout.write(text + "\n");
  }

  writeError(text: string): void {
    stdout.write(chalk.red(text) + "\n");
  }

  writeSuccess(text: string): void {
    stdout.write(chalk.green(text) + "\n");
  }

  writeInfo(text: string): void {
    stdout.write(chalk.gray(text) + "\n");
  }

  // ── 输入 / 生命周期 ──

  /** 最近一次 prompt 的 readline 实例（供 history 追加） */
  private lastRl: import("node:readline").Interface | null = null;

  private historyFile = "";
  private historyLines: string[] = [];
  private completer: ((line: string) => [string[], string]) | null = null;

  /** 设置历史持久化文件 + 补全器 */
  configureInput(historyFile: string, completer?: (line: string) => [string[], string]): void {
    this.historyFile = historyFile;
    this.completer = completer ?? null;
    this.historyLines = this.loadHistory();
  }

  /** 记录一条命令到历史（由主循环调用） */
  recordHistory(line: string): void {
    if (!this.historyFile || !line.trim()) return;
    this.historyLines.push(line.trim());
    // 去重相邻
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
    if (stdin.isPaused()) stdin.resume();
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }

    // On Windows, the previous readline's close() cleanup is async (multiple
    // event-loop ticks). Without this delay, the next createInterface inherits
    // stale listeners and freezes stdin. 50ms is the minimum observed to work
    // reliably after raw-mode cycles with inputCollector.
    await new Promise<void>((r) => setTimeout(r, 50));

    const rl = createInterface({
      input: process.stdin,
      output: stdout,
      terminal: true,
      prompt: "",
      completer: this.completer ?? undefined,
      historySize: 200,
    });
    // 注入持久化历史（readline 内部 _history 数组）
    const internal = rl as unknown as { history: string[] };
    if (Array.isArray(internal.history)) {
      internal.history.length = 0;
      for (const h of this.historyLines) {
        internal.history.push(h);
      }
    }
    this.lastRl = rl;
    return new Promise<string>((resolve) => {
      rl.question(chalk.cyan("你> "), (answer) => {
        rl.close();
        this.lastRl = null;
        resolve(answer);
      });
    });
  }

  async promptWithText(prefill: string): Promise<string> {
    if (!this.active) return prefill;
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
    stdout.write("\n");
  }

  // ── 内部 ──

  private buildStatusText(status: StatusLine): string {
    // 累计消耗 token（会话级），无窗口分母；窗口占用用真实 windowPct 单独显示
    const tokenStr = status.tokensUsed > 0 ? `token ${this.fmt(status.tokensUsed)}` : "";
    const pctStr = status.windowPct != null ? `${status.windowPct}%` : "";
    const iterStr =
      status.iteration != null ? `iter ${status.iteration}${status.maxIter ? `/${status.maxIter}` : ""}` : "";
    const queueStr = status.queueSize > 0 ? `排队:${status.queueSize}` : "";
    const toolStr = status.toolName ? `🛠 ${status.toolName}` : "";

    const modeLabels: Record<string, string> = { ask: "询问", plan: "规划", craft: "执行" };
    const modeLabel = modeLabels[status.mode] ?? status.mode;

    const parts = [
      chalk.bold.cyan(`[${status.mode.toUpperCase()}] ${modeLabel}`),
      status.model ? chalk.white(status.model) : "",
      tokenStr ? chalk.white(tokenStr) : "",
      pctStr
        ? status.windowPct! > 80
          ? chalk.bold.yellow(`窗口 ${pctStr}`)
          : chalk.white(`窗口 ${pctStr}`)
        : "",
      iterStr ? chalk.white(iterStr) : "",
      toolStr ? chalk.blue(toolStr) : "",
      queueStr ? chalk.yellow(queueStr) : "",
    ].filter(Boolean);

    const sep = chalk.gray(" │ ");
    let line = parts.join(sep);

    const right = chalk.gray(status.extra ?? "/help /thinking /exit");
    const { columns } = stdout;
    const maxWidth = Math.max(40, columns - 4);

    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[\d+(;\d+)*m/g, "");
    const leftLen = stripAnsi(line).length;
    const rightLen = stripAnsi(right).length;

    if (leftLen + rightLen + 4 > maxWidth) {
      const compact = [
        chalk.bold.cyan(`[${status.mode.toUpperCase()}]`),
        status.model ? chalk.white(status.model) : "",
        tokenStr ? chalk.white(tokenStr) : "",
        pctStr ? (status.windowPct! > 80 ? chalk.bold.yellow(`窗口 ${pctStr}`) : chalk.white(`窗口 ${pctStr}`)) : "",
        toolStr ? chalk.blue(toolStr) : "",
        queueStr ? chalk.yellow(queueStr) : "",
      ]
        .filter(Boolean)
        .join(sep);
      line = compact;
    }

    const finalLeftLen = stripAnsi(line).length;
    const pad = Math.max(2, maxWidth - finalLeftLen - rightLen);

    return `${chalk.gray("─")} ${line}${" ".repeat(pad)}${right} ${chalk.gray("─")}`;
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
