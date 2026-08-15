/**
 * Markdown 终端渲染器 — 纯函数，无副作用
 * 负责把 Markdown 行渲染为带 ANSI 颜色的终端文本
 * 流式渲染通过 StreamOutputRenderer 的 fence 状态机调用 renderLine
 */

import chalk from "chalk";
import { highlightLine } from "./highlight.js";

/** 剥除 ANSI 颜色码 + OSC 8 超链接序列（不可见，不影响宽度） */
function stripAnsiSequences(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d+(;\d+)*m/g, "")
    // OSC 8 超链接：\x1b]8;;url\x1b\ 和关闭 \x1b]8;;\x1b\
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
}

/** emoji 呈现字符（✅⭐🔥 等，终端占 2 列） */
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;

/** 判断字符是否为宽字符（CJK 全角，占 2 列）。制表线 ─│ 等 Ambiguous 按 1 列。 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  // 零宽字符：ZWJ / 变体选择符（emoji 序列内部，不占列）
  if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f) return 0;
  // emoji 呈现字符（✅⭐🔥 等）占 2 列（✗✓★ 等文本呈现仍 1 列）
  if (EMOJI_PRESENTATION_RE.test(ch)) return 2;
  // 常见 CJK 全角范围（东亚宽字符）
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals, 部首, 假名, 谚文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x2fffd) // CJK 扩展 B
  ) {
    return 2;
  }
  return 1;
}

/** 计算展示宽度（CJK 全角占 2 列，制表线等按 1 列） */
export function displayWidth(s: string): number {
  const clean = stripAnsiSequences(s);
  let w = 0;
  for (const ch of clean) {
    w += charWidth(ch);
  }
  return w;
}

/** 按展示宽度右填充（CJK 安全） */
export function padToWidth(s: string, targetWidth: number): string {
  const w = displayWidth(s);
  if (w >= targetWidth) return s;
  return s + " ".repeat(targetWidth - w);
}

/** 截断到展示宽度（CJK 安全） */
export function truncateToWidth(s: string, maxWidth: number): string {
  const clean = stripAnsiSequences(s);
  if (displayWidth(clean) <= maxWidth) return s;
  let out = "";
  let w = 0;
  for (const ch of clean) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** 终端是否支持 OSC 8 超链接 */
let hyperlinkSupported: boolean | null = null;
function supportsHyperlinks(): boolean {
  if (hyperlinkSupported !== null) return hyperlinkSupported;
  const env = process.env.TERM_PROGRAM ?? "";
  const term = process.env.TERM ?? "";
  hyperlinkSupported =
    /(iTerm|vscode|windows terminal|wezterm|kitty|ghostty|alacritty|hyper|tmux)/i.test(env) ||
    /(kitty|wezterm|ghostty|alacritty)/i.test(term);
  return hyperlinkSupported;
}

/** 清洗 URL：仅允许 http/https/mailto，剥控制字符，空格编码 */
function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^(https?|mailto):/i.test(trimmed)) return null;
  // eslint-disable-next-line no-control-regex
  const clean = trimmed.replace(/[\x00-\x1f\x7f]/g, "").replace(/ /g, "%20");
  return clean;
}

/** 行内样式：链接 [text](url)、粗体 **x**、行内代码 `x` */
export function renderInline(text: string): string {
  let out = text;
  // 链接 [text](url) → OSC 8 超链接（Ctrl+Click 跳转）
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return chalk.blue.underline(label);
    if (!supportsHyperlinks()) return chalk.blue.underline(label);
    return `\x1b]8;;${safeUrl}\x1b\\${chalk.blue.underline(label)}\x1b]8;;\x1b\\`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, m) => chalk.bold(m));
  out = out.replace(/`([^`]+)`/g, (_, m) => chalk.bgBlack.dim(m));
  return out;
}

/** 渲染标题行 `# ` 返回带样式的整行，非标题返回 null */
function renderHeading(line: string): string | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return null;
  const level = m[1].length;
  const title = renderInline(m[2]);
  if (level === 1) return chalk.bold.underline.cyan(title);
  if (level === 2) return chalk.bold.cyan(title);
  if (level === 3) return chalk.cyan(title);
  return chalk.white(title);
}

/** 判断是否为表格行（以 `|` 或 `│` 开头） */
export function isTableLine(line: string): boolean {
  return /^\s*[|│]/.test(line);
}

/**
 * 表格轻量美化 — 不跨行对齐，仅着色分隔符 + 表头加粗
 * 兼容 `|` 和 `│` 分隔符。isHeader 为 true 时加粗首行。
 */
function renderTableRow(line: string, isHeader: boolean): string {
  const cellSep = line.match(/\|/g)?.length ? "|" : "│";
  const raw = line.split(cellSep).map((c) => c.trim());
  // 仅去首尾空字符串（由行首尾 `|` 产生），保留中间空单元格
  const cells = raw;
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  // 纯分隔线行（如 |---|）→ 灰色美化，列数自适应
  const isSeparator = cells.length >= 2 && cells.every((c) => c === "" || /^[-:]+$/.test(c));
  if (isSeparator) {
    const seg = "─".repeat(12);
    const n = cells.length;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(seg);
    return chalk.gray(parts.join(chalk.gray("┼")));
  }
  const styled = cells.map((c) => {
    const body = renderInline(c);
    return isHeader ? chalk.bold(body) : body;
  });
  return `${chalk.gray("│")} ${styled.join(` ${chalk.gray("│")} `)} ${chalk.gray("│")}`;
}

/** 渲染列表行 `- ` / `1. `，返回带样式行 */
function renderList(line: string): string | null {
  const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (ul) return `${ul[1]}${chalk.gray("•")} ${renderInline(ul[2])}`;
  const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ol) return `${ol[1]}${chalk.gray(`${ol[2]}.`)} ${renderInline(ol[3])}`;
  return null;
}

/** 渲染引用行 `> ` */
function renderQuote(line: string): string | null {
  const m = line.match(/^>\s?(.*)$/);
  if (!m) return null;
  return `${chalk.gray("│")} ${chalk.dim(renderInline(m[1]))}`;
}

/** 渲染分割线 `---` */
function renderHr(line: string): string | null {
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return chalk.gray("─".repeat(48));
  return null;
}

export interface TableState {
  inTable: boolean;
  tableFirstRow: boolean;
}

export const defaultTableState = (): TableState => ({ inTable: false, tableFirstRow: true });

export interface LineRenderResult {
  rendered: string | null;
  fenceStart?: boolean;
  fenceEnd?: boolean;
  lang?: string;
  tableState?: TableState;
}

/**
 * 渲染单行 Markdown。inFence 表示当前是否在代码块内。
 * tableState 传入当前表格状态，返回更新后的状态。
 * 返回 null 表示调用方按普通文本原样输出（如代码块内容行）。
 */
export function renderLine(line: string, inFence: boolean, tableState?: TableState): LineRenderResult {
  const fence = line.match(/^```\s*(\w*)\s*$/);
  if (fence) {
    if (!inFence) {
      const lang = fence[1] || "";
      return { rendered: null, fenceStart: true, lang };
    }
    return { rendered: null, fenceEnd: true };
  }

  if (inFence) return { rendered: null };

  const ts = tableState ?? defaultTableState();

  // 空行 — 重置表格状态
  if (!line.trim()) {
    return { rendered: "", tableState: ts.inTable ? defaultTableState() : ts };
  }

  // 标题
  const heading = renderHeading(line);
  if (heading) return { rendered: heading, tableState: ts.inTable ? defaultTableState() : ts };

  // 分割线
  const hr = renderHr(line);
  if (hr) return { rendered: hr, tableState: ts.inTable ? defaultTableState() : ts };

  // 引用
  const quote = renderQuote(line);
  if (quote) return { rendered: quote, tableState: ts.inTable ? defaultTableState() : ts };

  // 列表
  const list = renderList(line);
  if (list) return { rendered: list, tableState: ts.inTable ? defaultTableState() : ts };

  // 表格轻量美化（分隔符着色 + 分隔线，不跨行对齐）
  if (isTableLine(line)) {
    const isHeader = !ts.inTable && ts.tableFirstRow;
    return {
      rendered: renderTableRow(line, isHeader),
      tableState: { inTable: true, tableFirstRow: false },
    };
  }

  // 非表格行 → 重置表格状态
  return { rendered: renderInline(line), tableState: ts.inTable ? defaultTableState() : ts };
}

/**
 * 渲染整块 Markdown（非流式，用于完整回答 result.text）
 * 代码块用左侧色条（▍）风格，宽度自适应，无固定边框。
 * 表格块跨行对齐列宽（超宽由上层按终端宽度换行）。
 */
export function renderMarkdown(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let tableState = defaultTableState();
  let tableBuf: string[] = [];

  const flushTable = () => {
    if (tableBuf.length > 0) {
      out.push(...renderTableBlock(tableBuf));
      tableBuf = [];
    }
  };

  for (const line of lines) {
    const result = renderLine(line, inFence, tableState);

    if (result.fenceStart) {
      flushTable();
      inFence = true;
      fenceLang = result.lang ?? "";
      const header = fenceLang ? `${chalk.dim(fenceLang)} ` : "";
      out.push(`${header}${chalk.gray("─".repeat(40))}`);
      continue;
    }
    if (result.fenceEnd) {
      inFence = false;
      out.push(chalk.gray("─".repeat(44)));
      continue;
    }
    if (inFence) {
      out.push(`${chalk.cyan("▍")} ${highlightLine(line, fenceLang)}`);
      continue;
    }

    // 表格块：累积连续表格行，块结束时对齐渲染
    if (isTableLine(line)) {
      tableBuf.push(line);
      tableState = { inTable: true, tableFirstRow: false };
      continue;
    }
    flushTable();

    if (result.tableState) tableState = result.tableState;
    if (result.rendered !== null) {
      out.push(result.rendered);
    } else {
      out.push(line);
    }
  }

  flushTable();

  // 未闭合代码块：补底框
  if (inFence) {
    out.push(chalk.gray("─".repeat(44)));
  }

  return out;
}

/**
 * 表格块跨行对齐：两遍扫描。
 * 第一遍解析所有行得到列数、每列最大宽度、对齐方向；
 * 第二遍按统一列宽渲染。供整块渲染（renderMarkdown）与流式渲染（StreamOutputRenderer）共用。
 */
export function renderTableBlock(lines: string[]): string[] {
  // 分隔符行（|--|）用于判定对齐方向
  const alignRow = lines.find((l) => {
    const cellSep = l.includes("|") ? "|" : "│";
    const cells = l.split(cellSep).map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
    return cells.length >= 2 && cells.every((c) => c === "" || /^:?-+:?$/.test(c));
  });

  let alignments: ("left" | "center" | "right")[] = [];
  if (alignRow) {
    const cellSep = alignRow.includes("|") ? "|" : "│";
    const cells = splitCells(alignRow, cellSep);
    alignments = cells.map((c) => {
      if (c.startsWith(":") && c.endsWith(":")) return "center";
      if (c.endsWith(":")) return "right";
      return "left";
    });
  }

  // 解析所有行（跳过分隔线行）
  const dataRows: { cells: string[]; sep: string }[] = [];
  let maxCols = 0;
  for (const line of lines) {
    const cellSep = line.includes("|") ? "|" : "│";
    const cells = splitCells(line, cellSep);
    const isSep = cells.length >= 2 && cells.every((c) => c === "" || /^:?-+:?$/.test(c));
    if (isSep) continue;
    dataRows.push({ cells, sep: cellSep });
    maxCols = Math.max(maxCols, cells.length);
  }

  if (dataRows.length === 0) return lines.map((l) => chalk.gray(l));

  // 每列最大显示宽度
  const colWidths = new Array<number>(maxCols).fill(0);
  for (const { cells } of dataRows) {
    cells.forEach((c, i) => {
      colWidths[i] = Math.max(colWidths[i] ?? 0, displayWidth(c));
    });
  }

  // 对齐每行（首行为表头，加粗）。不做截断：超宽行由 MessageList 换行处理，
  // 保证所有行 │ 列位置严格一致。
  const rendered = dataRows.map(({ cells, sep }, rowIdx) => {
    const padded = cells.map((c, i) => {
      const w = colWidths[i] ?? 0;
      let body = renderInline(c);
      if (rowIdx === 0) body = chalk.bold(body);
      const align = alignments[i] ?? "left";
      if (align === "right") return padLeft(body, w);
      if (align === "center") return padCenter(body, w);
      return padToWidth(body, w);
    });
    void sep;
    return `${chalk.gray("│")} ${padded.join(` ${chalk.gray("│")} `)} ${chalk.gray("│")}`;
  });

  // 表头分隔线：与数据行完全相同的结构（│ 单元格 │），单元格用 ─ 铺满列宽
  const hasAlignRow =
    alignRow && lines.some((l) => /^:?-+:?$/.test(l.trim().replace(/\|/g, "")));
  if (dataRows.length > 0 && hasAlignRow) {
    const sepCells = colWidths.map((w) => {
      // ─ 占 1 列，w 个恰好铺满 w 列宽
      return chalk.gray("─".repeat(w));
    });
    const sepRow = `${chalk.gray("│")} ${sepCells.join(` ${chalk.gray("│")} `)} ${chalk.gray("│")}`;
    rendered.splice(1, 0, sepRow);
  }
  return rendered;
}

/** 拆分表格行为单元格（去首尾空） */
function splitCells(line: string, cellSep: string): string[] {
  const raw = line.split(cellSep).map((c) => c.trim());
  if (raw[0] === "") raw.shift();
  if (raw[raw.length - 1] === "") raw.pop();
  return raw;
}

/** 左填充到显示宽度 */
function padLeft(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

/** 居中填充到显示宽度 */
function padCenter(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  const left = Math.floor((width - w) / 2);
  const right = width - w - left;
  return " ".repeat(left) + s + " ".repeat(right);
}
