/**
 * components.ts — TUI 组件（参考 Pi TUI 组件协议）
 *
 * 每个组件实现 render(width): string[]，返回不超过宽度的行数组。
 * 组件内部管理自身状态，不直接写终端。
 */

import { displayWidth, truncateToWidth, charWidth } from "./markdown.js";
import chalk from "chalk";

export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

/** 行尾追加 SGR 重置，防样式跨行泄漏 */
function safeLine(line: string): string {
  return `${line}\x1b[0m`;
}

/** CJK 安全截断 */
function fit(line: string, width: number): string {
  return truncateToWidth(line, width);
}

// ──────────────────────────────────────────────
// MessageList — 消息区（滚动回看）
// ──────────────────────────────────────────────

export class MessageList implements Component {
  private lines: string[] = [];
  private scrollOffset = 0; // 0 = 底部跟随
  private partial = false; // 最后一行是否为流式半行

  /** 追加完整行。若上一行为流式半行且新行非空，替换之（流式提交语义）；空行总是追加 */
  append(line: string): void {
    if (line === "") {
      // 空行：保留当前 partial（若存在），总是追加
      this.lines.push(line);
      this.partial = false;
    } else if (this.partial && this.lines.length > 0) {
      this.lines[this.lines.length - 1] = line;
      this.partial = false;
    } else {
      this.lines.push(line);
      this.partial = false;
    }
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
    this.scrollOffset = 0; // 新内容自动跟随底部
  }

  /** TUI 流式：设置/追加半行（无换行增量），替换上一半行或新建 */
  setPartial(text: string): void {
    if (this.partial && this.lines.length > 0) {
      this.lines[this.lines.length - 1] = text;
    } else {
      this.lines.push(text);
    }
    this.partial = true;
    this.scrollOffset = 0;
  }

  /** 追加内联文本到当前最后一行（增量）。文本含换行时拆分：首片段拼接，后续各成新行 */
  appendInline(text: string): void {
    if (!text) return;
    const parts = text.split("\n");
    if (this.lines.length === 0) {
      this.lines.push(parts[0]!);
    } else {
      this.lines[this.lines.length - 1] = `${this.lines[this.lines.length - 1]!}${parts[0]!}`;
    }
    for (let i = 1; i < parts.length; i++) {
      this.lines.push(parts[i]!);
    }
    this.partial = true;
    this.scrollOffset = 0;
  }

  appendLines(lines: string[]): void {
    for (const l of lines) this.append(l);
  }

  /**
   * 滚动：delta > 0 向上看历史，< 0 向下；到底部后 offset=0 跟随。
   * offset 语义：从视觉行末尾回退 N 行。viewport 用于滚动步长估算。
   */
  scroll(delta: number, _viewport?: number): void {
    const base = this.scrollOffset === 0 ? delta : this.scrollOffset + delta;
    this.scrollOffset = Math.max(0, base);
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  getTotalLines(): number {
    return this.lines.length;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** 全部逻辑行 wrap 成视觉行（宽度相关，缓存按 cols） */
  private visualLines(width: number): string[] {
    return this.wrapLines(width, this.lines);
  }

  /** Tui 传入消息区高度，返回应显示的行（不足补空行，不溢出） */
  renderViewport(width: number, height: number): string[] {
    const visual = this.visualLines(width);
    const maxOffset = Math.max(0, visual.length - height);
    const offset = Math.min(this.scrollOffset, maxOffset);
    const end = visual.length - offset;
    const start = Math.max(0, end - height);
    const tail = visual.slice(start, end);
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      out.push(i < tail.length ? fit(safeLine(tail[i]!), width) : "");
    }
    return out;
  }

  /** 将若干行按 width 拆成视觉行（CJK 安全，保留 ANSI）。内嵌换行先拆分防布局破坏 */
  private wrapLines(width: number, lines: string[]): string[] {
    const out: string[] = [];
    for (const raw of lines) {
      for (const line of raw.split("\n")) {
        this.wrapSingle(line, width, out);
      }
    }
    return out;
  }

  private wrapSingle(line: string, width: number, out: string[]): void {
    if (displayWidth(line) <= width) {
      out.push(line);
      return;
    }
    // 逐字符拆分，维护原始索引（含 ANSI）
    let i = 0;
    let w = 0;
    let chunk = "";
    while (i < line.length) {
      if (line[i] === "\x1b" && line[i + 1] === "[") {
        const end = line.indexOf("m", i);
        if (end === -1) {
          chunk += line.slice(i);
          break;
        }
        chunk += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      const ch = line[i]!;
      const cw = charWidth(ch);
      if (w + cw > width && chunk) {
        out.push(chunk);
        chunk = "";
        w = 0;
      }
      chunk += ch;
      w += cw;
      i += 1;
    }
    if (chunk) out.push(chunk);
  }

  render(width: number): string[] {
    return this.renderViewport(width, 1000);
  }

  invalidate(): void {
    // 无缓存，无需清理
  }
}

// ──────────────────────────────────────────────
// InputLine — 单行输入编辑器
// ──────────────────────────────────────────────

export class InputLine implements Component {
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private historySave = "";
  private completer: ((line: string) => string[]) | null = null;
  private prefix = "";
  private disabled = false;

  setCompleter(fn: ((line: string) => string[]) | null): void {
    this.completer = fn;
  }

  setHistory(hist: string[]): void {
    this.history = hist;
  }

  setPrefix(p: string): void {
    this.prefix = p;
  }

  getPrefix(): string {
    return this.prefix;
  }

  setDisabled(d: boolean): void {
    this.disabled = d;
  }

  getValue(): string {
    return this.buffer;
  }

  /** 插入字符（raw-mode 输入） */
  type(char: string): void {
    if (this.disabled) return;
    this.buffer = this.buffer.slice(0, this.cursor) + char + this.buffer.slice(this.cursor);
    this.cursor += char.length;
    this.historyIdx = -1;
  }

  moveLeft(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveRight(): void {
    this.cursor = Math.min(this.buffer.length, this.cursor + 1);
  }

  moveHome(): void {
    this.cursor = 0;
  }

  moveEnd(): void {
    this.cursor = this.buffer.length;
  }

  backspace(): void {
    if (this.cursor <= 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
  }

  deleteChar(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
  }

  /** 历史上翻（不含当前输入） */
  historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx === -1) {
      this.historySave = this.buffer;
      this.historyIdx = this.history.length - 1;
    } else {
      this.historyIdx = Math.max(0, this.historyIdx - 1);
    }
    this.buffer = this.history[this.historyIdx] ?? "";
    this.cursor = this.buffer.length;
  }

  historyDown(): void {
    if (this.historyIdx === -1) return;
    this.historyIdx++;
    if (this.historyIdx >= this.history.length) {
      this.historyIdx = -1;
      this.buffer = this.historySave;
    } else {
      this.buffer = this.history[this.historyIdx] ?? "";
    }
    this.cursor = this.buffer.length;
  }

  /**
   * Tab 补全：单个候选直接替换；多个候选找公共前缀。
   * 返回补全后的完整候选列表（供 Tui 展示），无候选返回空数组。
   */
  complete(): string[] {
    if (!this.completer) return [];
    const hits = this.completer(this.buffer);
    if (hits.length === 0) return [];
    if (hits.length === 1) {
      this.buffer = hits[0]!;
      this.cursor = this.buffer.length;
      return [hits[0]!];
    }
    // 多个候选：找公共前缀
    let prefix = hits[0]!;
    for (let i = 1; i < hits.length; i++) {
      let j = 0;
      while (j < prefix.length && j < hits[i]!.length && prefix[j] === hits[i]![j]) j++;
      prefix = prefix.slice(0, j);
    }
    if (prefix.length > this.buffer.length) {
      this.buffer = prefix;
      this.cursor = this.buffer.length;
    }
    return hits;
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.historyIdx = -1;
    this.historySave = "";
  }

  /** 光标所在显示列（考虑前缀宽度） */
  cursorCol(): number {
    return displayWidth(this.prefix) + displayWidth(this.buffer.slice(0, this.cursor));
  }

  render(width: number): string[] {
    if (this.disabled) {
      return [fit(`${this.prefix}${chalk.dim("思考中...")}`, width)];
    }
    const text = `${this.prefix}${this.buffer}`;
    return [fit(safeLine(text), width)];
  }

  invalidate(): void {
    // 无缓存
  }
}

// ──────────────────────────────────────────────
// StatusBar — 底部状态栏
// ──────────────────────────────────────────────

export interface StatusData {
  mode: string;
  model: string;
  tokensUsed: number;
  windowPct?: number;
  queueSize: number;
  status?: string;
  toolName?: string;
  iteration?: number;
  maxIter?: number;
}

export class StatusBar implements Component {
  private data: StatusData = { mode: "auto", model: "", tokensUsed: 0, queueSize: 0 };

  setData(data: StatusData): void {
    this.data = { ...this.data, ...data };
  }

  /** 清除瞬时状态（思考中/工具名等），保留模式/模型/token */
  clearTransient(): void {
    this.data.status = undefined;
    this.data.toolName = undefined;
    this.data.iteration = undefined;
  }

  getData(): StatusData {
    return this.data;
  }

  render(width: number): string[] {
    const d = this.data;
    const tokenStr = d.tokensUsed > 0 ? `token ${this.fmt(d.tokensUsed)}` : "";
    const iterStr =
      d.iteration != null ? `iter ${d.iteration}${d.maxIter ? `/${d.maxIter}` : ""}` : "";
    const queueStr = d.queueSize > 0 ? `排队:${d.queueSize}` : "";
    const toolStr = d.toolName ? `🛠 ${d.toolName}` : "";
    const statusStr = d.status ? chalk.yellow(d.status) : "";

    const modeLabels: Record<string, string> = { ask: "询问", plan: "规划", auto: "自动" };
    const modeLabel = modeLabels[d.mode] ?? d.mode;
    const barStr = d.windowPct != null ? this.renderWindowBar(d.windowPct) : "";

    const sep = chalk.gray(" │ ");
    const right = chalk.gray("/help /thinking /exit");
    const rightLen = displayWidth(right);
    // 行结构：─ + ␣ + 内容 + pad + right + ␣ + ─
    // ─(2) 与 │(2) 都是全角，需按 displayWidth 精确计算
    const leftDeco = displayWidth("─ ");
    const rightDeco = displayWidth(" ─");
    // 内容区可用宽度 = 总宽 - 左侧装饰 - 右侧 help - 右侧装饰
    const contentBudget = width - leftDeco - rightLen - rightDeco;

    // 优先级从高到低：mode > model > status > bar > token > iter > tool > queue
    const priority: ((() => string) | null)[] = [
      () => chalk.bold.cyan(`[${d.mode.toUpperCase()}] ${modeLabel}`),
      d.model ? () => chalk.white(d.model) : null,
      statusStr ? () => statusStr : null,
      barStr ? () => barStr : null,
      tokenStr ? () => chalk.white(tokenStr) : null,
      iterStr ? () => chalk.white(iterStr) : null,
      toolStr ? () => chalk.blue(toolStr) : null,
      queueStr ? () => chalk.yellow(queueStr) : null,
    ];

    // 从低位逐步丢弃，直到内容放得下（含右侧 help）
    const kept: string[] = [];
    let len = 0;
    for (const item of priority) {
      if (!item) continue;
      const s = item();
      const w = displayWidth(s);
      if (len + (kept.length ? displayWidth(sep) : 0) + w > contentBudget) break;
      if (kept.length) len += displayWidth(sep);
      kept.push(s);
      len += w;
    }

    const line = kept.join(sep);
    const pad = Math.max(1, contentBudget - len);
    const result = `${chalk.gray("─")} ${line}${" ".repeat(pad)}${right} ${chalk.gray("─")}`;
    // 保险截断（理论上不会触发）
    return [truncateToWidth(result, width)];
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

  invalidate(): void {
    // 无缓存
  }
}
