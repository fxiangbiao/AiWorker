/**
 * components.ts — TUI 组件（参考 Pi TUI 组件协议）
 *
 * 每个组件实现 render(width): string[]，返回不超过宽度的行数组。
 * 组件内部管理自身状态，不直接写终端。
 */

import { displayWidth, truncateToWidth, charWidth } from "./markdown.js";
import chalk from "chalk";
import type { TurnView } from "./turn-view.js";

export interface Component {
  render(width: number): string[];
  invalidate(): void;
}

/** 行尾追加 SGR 重置，防样式跨行泄漏 */
function safeLine(line: string): string {
  return `${line}\x1b[0m`;
}

/**
 * 从 line[i]（须为 \x1b）起定位完整转义序列的结束下标（不含）。
 * 支持：CSI SGR（\x1b[...m）、OSC 8 超链接（\x1b]8;;...\x1b\）。
 * 未识别或不完整返回 -1（调用方按普通字符处理）。
 */
function escapeEnd(line: string, i: number): number {
  const next = line[i + 1];
  if (next === "[") {
    const m = line.indexOf("m", i + 2);
    return m === -1 ? -1 : m + 1;
  }
  if (next === "]") {
    // OSC：以 ESC \（\x1b 0x5c）结尾
    const end = line.indexOf("\x1b\\", i + 2);
    return end === -1 ? -1 : end + 2;
  }
  return -1;
}

/** CJK 安全截断 */
function fit(line: string, width: number): string {
  return truncateToWidth(line, width);
}

/** 可作"悬挂边界"重放的行首字符（空格 + 纵向制表线 + 左块），折行后保持 gutter 对齐 */
const GUTTER_CHARS = new Set([
  " ",
  "|",
  "│",
  "┃",
  "┆",
  "┇",
  "┊",
  "┋",
  "║",
  "╎",
  "╏",
  "▏",
  "▎",
  "▍",
  "▌",
  "▋",
  "▊",
  "▉",
]);

function isGutterChar(ch: string): boolean {
  return GUTTER_CHARS.has(ch);
}

// ──────────────────────────────────────────────
// MessageList — 消息区（滚动回看；Sprint 45 条目化：静态行 + 回合块视图）
// ──────────────────────────────────────────────

/** 条目类型：静态行（命令/提问/旧消息等）或回合视图（结构化块，可折叠回看） */
type MsgItem = { kind: "line"; text: string } | { kind: "turn"; view: TurnView };

export class MessageList implements Component {
  private items: MsgItem[] = [];
  private scrollOffset = 0; // 0 = 底部跟随
  private lastWasPartial = false; // 最后静态行是否为流式半行（turn 展开行不参与该语义）
  /** 条目上限：超出从头部整条目裁剪（turn 条目整体保留删除，内部行预算由其自身负责） */
  private static readonly ITEM_MAX = 3000;

  /** 全部逻辑行（turn 按其当前展开态产出成品行） */
  private logicalLines(): string[] {
    const out: string[] = [];
    for (const it of this.items) {
      if (it.kind === "line") {
        out.push(it.text);
      } else {
        out.push(...it.view.renderRows());
      }
    }
    return out;
  }

  private trim(): void {
    if (this.items.length > MessageList.ITEM_MAX) {
      this.items.splice(0, this.items.length - MessageList.ITEM_MAX);
    }
  }

  /** 追加完整行。若上一静态行为流式半行且新行非空，替换之（流式提交语义）；空行总是追加 */
  append(line: string): void {
    const last = this.items[this.items.length - 1];
    if (line === "") {
      this.items.push({ kind: "line", text: line });
      this.lastWasPartial = false;
    } else if (this.lastWasPartial && last && last.kind === "line") {
      this.items[this.items.length - 1] = { kind: "line", text: line };
      this.lastWasPartial = false;
    } else {
      this.items.push({ kind: "line", text: line });
      this.lastWasPartial = false;
    }
    this.trim();
    this.scrollOffset = 0; // 新内容自动跟随底部
  }

  /** 回合视图条目（Sprint 45：tui.startTurn 调用；条目内块更新由 TurnView 驱动） */
  appendTurn(view: TurnView): void {
    this.items.push({ kind: "turn", view });
    this.trim();
    this.scrollOffset = 0;
  }

  /** 流式：设置/追加半行（无换行增量），替换上一静态半行或新建 */
  setPartial(text: string): void {
    const last = this.items[this.items.length - 1];
    if (this.lastWasPartial && last && last.kind === "line") {
      this.items[this.items.length - 1] = { kind: "line", text };
    } else {
      this.items.push({ kind: "line", text });
    }
    this.lastWasPartial = true;
    this.trim();
    this.scrollOffset = 0;
  }

  /** 追加内联文本到当前最后静态行（增量）。文本含换行时拆分：首片段拼接，后续各成新行 */
  appendInline(text: string): void {
    if (!text) return;
    const parts = text.split("\n");
    const last = this.items[this.items.length - 1];
    if (parts.length > 0 && last && last.kind === "line") {
      this.items[this.items.length - 1] = { kind: "line", text: `${last.text}${parts[0]}` };
    } else {
      this.items.push({ kind: "line", text: parts[0] });
    }
    for (let i = 1; i < parts.length; i++) {
      this.items.push({ kind: "line", text: parts[i] });
    }
    this.lastWasPartial = true;
    this.trim();
    this.scrollOffset = 0;
  }

  appendLines(lines: string[]): void {
    for (const l of lines) this.append(l);
  }

  /**
   * 替换第 index 个静态行条目（legacy：ask 兜底路径用；turn 存在时不使用——
   * 运行期静态行由 tui 收口重定向进 turn，见 tui.appendToViewport）。越界忽略。
   */
  setLine(index: number, text: string): void {
    let lineIdx = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]!;
      if (it.kind !== "line") continue;
      if (lineIdx === index) {
        this.items[i] = { kind: "line", text };
        return;
      }
      lineIdx++;
    }
  }

  /** legacy 静态行条目总数（ask 兜底 startIdx 用；turn 展开行不计） */
  getTotalLines(): number {
    let n = 0;
    for (const it of this.items) {
      if (it.kind === "line") n++;
    }
    return n;
  }

  /** 全局可折叠块清单（正序=时间序；含全部回合的 thinking/tool，供浏览模式焦点环） */
  foldableBlocks(): Array<{ view: TurnView; kind: "thinking" | "tool"; id: number }> {
    const out: Array<{ view: TurnView; kind: "thinking" | "tool"; id: number }> = [];
    for (const it of this.items) {
      if (it.kind !== "turn") continue;
      for (const t of it.view.foldTargets()) {
        out.push({ view: it.view, kind: t.kind, id: t.id });
      }
    }
    return out;
  }

  /** 最近一个回合视图（浏览/快捷键目标；无则 null） */
  lastTurnView(): TurnView | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.kind === "turn") return it.view;
    }
    return null;
  }

  /** 滚动：delta > 0 向上看历史，< 0 向下；到底部后 offset=0 跟随 */
  scroll(delta: number, _viewport?: number): void {
    const base = this.scrollOffset === 0 ? delta : this.scrollOffset + delta;
    this.scrollOffset = Math.max(0, base);
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** 全部逻辑行 wrap 成视觉行（宽度相关，缓存按 cols） */
  private visualLines(width: number): string[] {
    return this.wrapLines(width, this.logicalLines());
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
    // 提取行首样式组（SGR/OSC），wrap 切分后每段重放，防长行换行后丢色（如 dim 思考行变灰白交替）
    let styles = "";
    let i = 0;
    while (i < line.length && line[i] === "\x1b") {
      const end = escapeEnd(line, i);
      if (end === -1) break;
      styles += line.slice(i, end);
      i = end;
    }
    // 提取行首"悬挂边界"字面量前缀（空格 + 纵向制表线/左块），折行后每段重放，
    // 防长行丢 gutter（thinking/tool 的 │ 竖线中断、回答正文空格缩进丢失）
    let gutter = "";
    let k = i;
    while (k < line.length) {
      const ch = line[k]!;
      if (ch === " " || isGutterChar(ch)) {
        gutter += ch;
        k++;
      } else break;
    }
    const body = line.slice(i);
    if (displayWidth(body) <= width) {
      out.push(line);
      return;
    }
    let content = body.slice(k - i);
    let budget = width - displayWidth(gutter);
    if (budget <= 0) {
      // 极窄终端：gutter 已超宽，退化为整体换行（gutter 不再重放）
      gutter = "";
      content = body;
      budget = width;
    }
    let w = 0;
    let chunk = "";
    let j = 0;
    while (j < content.length) {
      if (content[j] === "\x1b") {
        const end = escapeEnd(content, j);
        if (end !== -1) {
          chunk += content.slice(j, end);
          j = end;
          continue;
        }
      }
      const ch = content[j]!;
      const cw = charWidth(ch);
      if (w + cw > budget && chunk) {
        out.push(`${styles}${gutter}${chunk}`);
        chunk = "";
        w = 0;
      }
      chunk += ch;
      w += cw;
      j += 1;
    }
    if (chunk) out.push(`${styles}${gutter}${chunk}`);
  }

  render(width: number): string[] {
    return this.renderViewport(width, 1000);
  }

  invalidate(): void {
    // 无缓存，无需清理
  }
}

// ──────────────────────────────────────────────
// InputLine — 多行输入编辑器（支持 \n 与视觉换行，Shift+Enter 插入换行）
// ──────────────────────────────────────────────

/** 输入区最大可视行数（超出后滚动显示，光标行始终可见） */
const INPUT_MAX_ROWS = 8;

export class InputLine implements Component {
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private historySave = "";
  private completer: ((line: string) => string[]) | null = null;
  private prefix = "";
  private disabled = false;
  /** 输入区滚动偏移（视觉行），光标跟随 */
  private scrollRows = 0;
  private lastWidth = 80;

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

  /** 插入字符（raw-mode 输入；\n 表示换行） */
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

  /** 光标所在视觉行是否有多行内容（用于 Up/Down 分流：多行编辑 vs 输入历史） */
  isMultiLine(): boolean {
    return this.buffer.includes("\n");
  }

  /**
   * 光标上移一行（同一列对齐）。仅在多行输入时使用。
   */
  moveLineUp(width = this.lastWidth): void {
    const pos = this.wrapPositions(width);
    const idx = this.prefix.length + this.cursor;
    const { row } = pos[idx]!;
    if (row <= 0) return;
    // 本行起点（即目标行终点）
    let rowStart = idx;
    while (rowStart > 0 && pos[rowStart - 1]!.row === row) rowStart--;
    // 目标行起点
    let targetStart = rowStart;
    while (targetStart > 0 && pos[targetStart - 1]!.row === row - 1) targetStart--;
    const col = pos[idx]!.col;
    // 目标行内取 ≤ col 的最右边界
    let target = rowStart;
    for (let i = targetStart; i < rowStart; i++) {
      if (pos[i]!.col > col) break;
      target = i;
    }
    this.cursor = Math.max(0, target - this.prefix.length);
  }

  /**
   * 光标下移一行（同一列对齐）。仅在多行输入时使用。
   */
  moveLineDown(width = this.lastWidth): void {
    const pos = this.wrapPositions(width);
    const idx = this.prefix.length + this.cursor;
    const { row, col } = pos[idx]!;
    // 本行终点（下一行起点）
    let rowEnd = idx;
    while (rowEnd < pos.length - 1 && pos[rowEnd]!.row === row) rowEnd++;
    if (rowEnd >= pos.length - 1) return; // 已在最后一行
    // 下一行终点
    let nextEnd = rowEnd;
    while (nextEnd < pos.length - 1 && pos[nextEnd]!.row === row + 1) nextEnd++;
    let target = rowEnd;
    for (let i = rowEnd; i < nextEnd; i++) {
      if (pos[i]!.col > col) break;
      target = i;
    }
    this.cursor = Math.min(this.buffer.length, target - this.prefix.length);
  }

  /**
   * 历史上翻（不含当前输入）
   */
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
    this.scrollRows = 0;
  }

  /** 文本每个字符边界处的视觉位置（含前缀；wrap 规则与渲染一致） */
  private wrapPositions(width: number): { row: number; col: number }[] {
    const text = `${this.prefix}${this.buffer}`;
    const pos: { row: number; col: number }[] = [{ row: 0, col: 0 }];
    let row = 0;
    let col = 0;
    let rowHas = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\n") {
        row++;
        col = 0;
        rowHas = false;
      } else {
        const cw = charWidth(ch);
        if (col + cw > width && rowHas) {
          row++;
          col = 0;
        }
        col += cw;
        rowHas = true;
      }
      pos.push({ row, col });
    }
    return pos;
  }

  /** 全部视觉行（按 \n 与宽度拆行；换行符本身不进行尾） */
  private layoutRows(width: number): string[] {
    const text = `${this.prefix}${this.buffer}`;
    const rows: string[] = [];
    let row = "";
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\n") {
        rows.push(row);
        row = "";
        w = 0;
        continue;
      }
      const cw = charWidth(ch);
      if (w + cw > width && row) {
        rows.push(row);
        row = "";
        w = 0;
      }
      row += ch;
      w += cw;
    }
    rows.push(row);
    return rows;
  }

  /** 光标所在视觉行（0 基）与行内显示列 */
  cursorPosition(width = this.lastWidth): { row: number; col: number } {
    const pos = this.wrapPositions(width);
    const idx = this.prefix.length + this.cursor;
    return pos[idx] ?? { row: 0, col: displayWidth(this.prefix) };
  }

  /** 光标在输入区可视窗口内的行号（0 基） */
  cursorRowInWindow(): number {
    return Math.max(0, this.cursorPosition().row - this.scrollRows);
  }

  /** 光标所在显示列（考虑前缀宽度） */
  cursorCol(): number {
    return this.cursorPosition().col;
  }

  /** 当前输入区占用的可视行数（渲染用） */
  getTotalRows(): number {
    return this.layoutRows(this.lastWidth).length;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    if (this.disabled) {
      return [fit(`${this.prefix}${chalk.dim("思考中...")}`, width)];
    }
    const rows = this.layoutRows(width);
    const { row } = this.cursorPosition(width);
    // 光标跟随：确保光标行在可视窗口内；缓冲缩减后回退
    const maxScroll = Math.max(0, rows.length - INPUT_MAX_ROWS);
    this.scrollRows = Math.max(0, Math.min(this.scrollRows, maxScroll));
    if (row < this.scrollRows) this.scrollRows = row;
    if (row > this.scrollRows + INPUT_MAX_ROWS - 1) this.scrollRows = row - INPUT_MAX_ROWS + 1;
    const visible = rows.slice(this.scrollRows, this.scrollRows + INPUT_MAX_ROWS);
    return visible.map((l) => safeLine(l));
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
