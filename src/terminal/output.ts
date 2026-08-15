/**
 * StreamOutputRenderer — 流式输出渲染器
 *
 * 职责：
 * - 累积 chunk 直到换行，逐行渲染（保证流式实时性且边界完整）
 * - fence 状态机跟踪代码块开合，代码块即时画边框
 * - 工具调用紧凑行渲染（id 关联 + 耗时）
 *
 * TUI 激活时所有输出写入 MessageList（tui.appendMessage），由 Screen 差分渲染；
 * 非 TUI 时直接写 stdout。
 */

import { stdout } from "node:process";
import chalk from "chalk";
import {
  renderLine,
  renderTableBlock,
  isTableLine,
  defaultTableState,
  type TableState,
} from "./markdown.js";
import { highlightLine } from "./highlight.js";
import { tui } from "./tui.js";

interface ToolRow {
  id: string;
  name: string;
  startTime: number;
  argsPreview: string;
}

export class StreamOutputRenderer {
  private buf = "";
  private inFence = false;
  private fenceLang = "";
  private tools = new Map<string, ToolRow>();
  private tableState: TableState = defaultTableState();
  /** 表格块缓冲：流式表格按块对齐（跨行列宽一致）后整块输出 */
  private tableBuf: string[] = [];

  /** 输出一行到消息区（TUI）或 stdout（普通） */
  private emitLineRaw(line: string): void {
    if (tui.isActive()) {
      tui.appendMessage(line);
    } else {
      stdout.write(line + "\n");
    }
  }

  /**
   * 写入流式文本 chunk（onTextDelta 调用）
   */
  writeChunk(text: string): void {
    this.buf += text;
    // 按换行切分渲染
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.emitLine(line);
    }
    // TUI 流式：将残余半行实时追加，保证实时显示
    if (tui.isActive() && this.buf) {
      this.emitPartial(this.buf);
    }
  }

  /** 冲刷剩余缓冲（回答结束时调用） */
  flush(): void {
    if (this.buf) {
      this.emitLine(this.buf);
      this.buf = "";
    }
    // 未闭合代码块补底框
    if (this.inFence) {
      this.emitLineRaw(chalk.gray("─".repeat(44)));
      this.inFence = false;
    }
    // 未闭合表格块（末尾无空行）→ 整块对齐输出
    this.flushTable();
  }

  private emitLine(line: string): void {
    const result = renderLine(line, this.inFence, this.tableState);

    if (result.fenceStart) {
      this.flushTable();
      this.inFence = true;
      this.fenceLang = result.lang ?? "";
      const header = this.fenceLang ? `${chalk.dim(this.fenceLang)} ` : "";
      this.emitLineRaw(`${header}${chalk.gray("─".repeat(40))}`);
      return;
    }
    if (result.fenceEnd) {
      this.flushTable();
      this.inFence = false;
      this.emitLineRaw(chalk.gray("─".repeat(44)));
      return;
    }
    if (this.inFence) {
      this.flushTable();
      this.emitLineRaw(`${chalk.cyan("▍")} ${highlightLine(line, this.fenceLang)}`);
      return;
    }
    // 表格行 → 累积，块结束时统一对齐渲染（跨行列宽一致）
    if (isTableLine(line)) {
      this.tableBuf.push(line);
      this.tableState = { inTable: true, tableFirstRow: false };
      return;
    }
    this.flushTable();

    if (result.tableState) this.tableState = result.tableState;
    if (result.rendered !== null) {
      this.emitLineRaw(result.rendered);
    } else {
      this.emitLineRaw(line);
    }
  }

  /** 表格块结束：按统一列宽对齐后整块输出 */
  private flushTable(): void {
    if (this.tableBuf.length === 0) return;
    for (const l of renderTableBlock(this.tableBuf)) {
      this.emitLineRaw(l);
    }
    this.tableBuf = [];
  }

  /** TUI 模式下实时追加半行（无换行） */
  private emitPartial(text: string): void {
    if (!tui.isActive()) return;
    tui.setPartial(text);
  }

  /** 工具调用开始（onToolCall） */
  toolStart(name: string, args: string, id: string): void {
    let preview = this.sanitizePreview(args, 40);
    let marker = chalk.blue(`🔧 ${name}`);
    let resultPreview = preview; // 结果行的预览（ask_user 不重复展示问题）
    if (name === "ask_user") {
      // ask_user 的 args 是 {question, options?, multiple?}：卡片展示问题本身（截断），而非原始 JSON
      const parsed = tryParseJson(args) as { question?: unknown; options?: unknown; multiple?: unknown } | null;
      const q = typeof parsed?.question === "string" ? parsed.question.trim() : "";
      const optCount = Array.isArray(parsed?.options) ? parsed.options.length : 0;
      const multi = parsed?.multiple === true;
      preview = q ? this.sanitizePreview(q, 56) : "";
      marker = chalk.blue(
        `🔧 ${name}${optCount > 0 ? chalk.dim(`（${optCount} 个选项${multi ? "，可多选" : ""}）`) : ""}`,
      );
      resultPreview = "";
    }
    this.tools.set(id, { id, name, startTime: Date.now(), argsPreview: resultPreview });
    this.emitLineRaw(`  ${marker}${preview ? chalk.dim(` ${preview}`) : ""}`);
  }

  /** 工具调用结束（onToolResult） */
  toolResult(name: string, success: boolean, summary: string, id: string): void {
    const row = this.tools.get(id);
    if (!row) {
      // 无关联 onToolCall（如外部调用）— 单行输出
      const icon = success ? chalk.green("✓") : chalk.red("✗");
      this.emitLineRaw(`  ${icon} ${summary.slice(0, 80)}`);
      return;
    }

    const durMs = Date.now() - row.startTime;
    const durStr = durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`;
    const icon = success ? chalk.green("✓") : chalk.red("✗");
    const summaryStr = summary ? ` ${summary.slice(0, 80)}` : "";
    const line = `${chalk.blue(`🔧 ${row.name}`)}${row.argsPreview ? chalk.dim(` ${row.argsPreview}`) : ""} ${chalk.gray(`⌁ ${durStr}`)} ${icon}${summaryStr}`;

    if (tui.isActive()) {
      // TUI 全帧渲染模式下不支持回退行，直接写新行
      this.emitLineRaw(`  ${line}`);
    } else {
      // 原地更新：回退一行，清行，重写
      stdout.write(`\r\x1b[1A\x1b[2K  ${line}\n`);
    }
    this.tools.delete(id);
  }

  /** 文件 diff 计数行（onFileDiff） */
  fileDiff(filePath: string, added: number, removed: number): void {
    this.emitLineRaw(`  ${chalk.gray("📄")} ${chalk.dim(filePath)} ${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`);
  }

  /** 打印单行普通文本（保留换行语义） */
  writeLine(text: string): void {
    this.emitLineRaw(text);
  }

  /** 工具名带符号（计划 DAG 用） */
  stepStart(stepId: string, expertId: string, desc: string): void {
    this.emitLineRaw(`  ${chalk.cyan("🔵")} ${chalk.cyan(stepId)}: ${chalk.yellow(expertId)} — ${desc} ${chalk.dim("(进行中...)")}`);
  }

  stepEnd(stepId: string, expertId: string, desc: string, success: boolean): void {
    const icon = success ? chalk.green("✅") : chalk.red("❌");
    const status = success ? "" : chalk.gray(" (已跳过)");
    this.emitLineRaw(`  ${icon} ${chalk.cyan(stepId)}: ${chalk.yellow(expertId)} — ${desc}${status}`);
  }

  private sanitizePreview(s: string, max: number): string {
    if (!s) return "";
    let clean = s.replace(/\s+/g, " ").trim();
    if (clean.length > max) clean = clean.slice(0, max) + "…";
    return clean;
  }
}

/** 轻量 JSON 解析（失败返回 null） */
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
