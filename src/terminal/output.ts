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
import type { TurnView } from "./turn-view.js";
import type { ToolArtifact } from "../types.js";

/** 工具调用计时（回合注入后仍由本渲染器记录耗时，供 turn 块展示） */
const toolStarts = new Map<string, number>();

export class StreamOutputRenderer {
  private buf = "";
  private inFence = false;
  private fenceLang = "";
  private tableState: TableState = defaultTableState();
  /** 表格块缓冲：流式表格按块对齐（跨行列宽一致）后整块输出 */
  private tableBuf: string[] = [];
  /** 当前回合句柄（Sprint 45：注入后文本/工具落回合块；null=静态/旧路径） */
  private turn: TurnView | null = null;

  /** 注入/释放回合句柄（index 回合开始调用；注入时重置 fence/table/buf，防跨回合残留） */
  setTurn(view: TurnView | null): void {
    this.turn = view;
    this.buf = "";
    this.inFence = false;
    this.fenceLang = "";
    this.tableState = defaultTableState();
    this.tableBuf = [];
  }

  /** 回合块变化后请求渲染（注入路径无 tui.appendMessage 隐式触发） */
  private turnChanged(): void {
    if (tui.isActive()) tui.requestRender();
  }

  /** 输出一行：注入回合 → text 块；否则消息区（TUI）或 stdout（普通） */
  private emitLineRaw(line: string): void {
    if (this.turn) {
      this.turn.textLine(line);
      this.turnChanged();
      return;
    }
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
    // 流式：将残余半行实时追加，保证实时显示（回合注入 → 块半行；TUI → setPartial）
    if (this.buf) {
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

  /** TUI 模式下实时追加半行（无换行）；回合注入 → text 块半行（lastPartial） */
  private emitPartial(text: string): void {
    if (this.turn) {
      this.turn.textPartial(text);
      this.turnChanged();
      return;
    }
    if (!tui.isActive()) return;
    tui.setPartial(text);
  }

  /** 工具调用开始（onToolCall） */
  toolStart(name: string, args: string, id: string): void {
    toolStarts.set(id, Date.now());
    const preview = this.sanitizePreview(args, 40);
    if (this.turn) {
      if (name === "ask_user") {
        // 回合注入：ask_user 走 TUI ask 块（含选项交互），不重复打印问题行
        const q = parseAsk(args);
        if (q.question) this.turn.addAsk(q.question, q.options, q.multiple);
      } else {
        this.turn.addTool(id, name, preview, args);
      }
      // 首个可折叠块出现时提示折叠键（每回合一次）
      tui.maybeHintFoldKeys();
      this.turnChanged();
      return;
    }
    if (name === "ask_user") {
      const q = parseAsk(args);
      const qPreview = q.question ? this.sanitizePreview(q.question, 56) : "";
      const suffix = q.options.length > 0 ? chalk.dim(`（${q.options.length} 个选项${q.multiple ? "，可多选" : ""}）`) : "";
      this.emitLineRaw(`  ${chalk.blue(`🔧 ${name}${suffix}`)}${qPreview ? chalk.dim(` ${qPreview}`) : ""}`);
      return;
    }
    this.emitLineRaw(`  ${chalk.blue(`🔧 ${name}`)}${preview ? chalk.dim(` ${preview}`) : ""}`);
  }

  /** 工具调用结束（onToolResult） */
  toolResult(name: string, success: boolean, summary: string, id: string, artifacts?: ToolArtifact[]): void {
    const durMs = toolStarts.has(id) ? Date.now() - toolStarts.get(id)! : 0;
    toolStarts.delete(id);
    const summaryPreview = this.sanitizePreview(summary, 80);
    if (this.turn) {
      // ask_user 不在回合工具块中（已由 addAsk 块展示），无需置终态
      if (name !== "ask_user") {
        this.turn.toolResult(id, success, summaryPreview, summary, durMs, artifacts);
      }
      this.turnChanged();
      return;
    }
    const icon = success ? chalk.green("✓") : chalk.red("✗");
    const line = `  ${chalk.blue(`🔧 ${name}`)} ${chalk.gray(`⌁ ${fmtDurMs(durMs)}`)} ${icon}${summaryPreview ? ` ${summaryPreview}` : ""}`;
    if (tui.isActive()) {
      // TUI 全帧渲染模式下不支持回退行，直接写新行
      this.emitLineRaw(line);
    } else {
      // 原地更新：回退一行，清行，重写
      stdout.write(`\r\x1b[1A\x1b[2K${line}\n`);
    }
  }

  /** 文件 diff 计数行（onFileDiff）——仅 TUI 激活时输出；server 模式控制台静默（Web /diffs 查看） */
  fileDiff(filePath: string, added: number, removed: number): void {
    if (!tui.isActive() && !this.turn) return;
    const line = `  ${chalk.gray("📄")} ${chalk.dim(filePath)} ${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`;
    if (this.turn) {
      this.turn.addNote(line);
      this.turnChanged();
    } else {
      this.emitLineRaw(line);
    }
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

/** 解析 ask_user args（{question, options?, multiple?}） */
function parseAsk(args: string): { question: string; options: string[]; multiple: boolean } {
  const p = tryParseJson(args) as { question?: unknown; options?: unknown; multiple?: unknown } | null;
  return {
    question: typeof p?.question === "string" ? p.question.trim() : "",
    options: Array.isArray(p?.options) ? p.options.map(String) : [],
    multiple: p?.multiple === true,
  };
}

function fmtDurMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
