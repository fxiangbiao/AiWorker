/**
 * Markdown 终端渲染器 — 纯函数，无副作用
 * 负责把 Markdown 行渲染为带 ANSI 颜色的终端文本
 * 流式渲染通过 StreamOutputRenderer 的 fence 状态机调用 renderLine
 */

import chalk from "chalk";

/** 计算展示宽度（CJK 占 2 列） */
export function displayWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\x1b\[\d+(;\d+)*m/g, "");
  let w = 0;
  for (const ch of clean) {
    w += (ch.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
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
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\x1b\[\d+(;\d+)*m/g, "");
  if (displayWidth(clean) <= maxWidth) return clean;
  let out = "";
  let w = 0;
  for (const ch of clean) {
    const cw = (ch.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** 行内样式：粗体 **x**、斜体 *x*、行内代码 `x` */
export function renderInline(text: string): string {
  let out = text;
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
  if (level === 1) return chalk.bold.cyan(title);
  if (level === 2) return chalk.bold.cyan(title);
  if (level === 3) return chalk.cyan(title);
  return chalk.white(title);
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

export interface LineRenderResult {
  rendered: string | null;
  /** 该行是代码块开头行 */
  fenceStart?: boolean;
  /** 该行是代码块结束行 */
  fenceEnd?: boolean;
  /** 代码块语言标签 */
  lang?: string;
}

/**
 * 渲染单行 Markdown。inFence 表示当前是否在代码块内。
 * 返回 null 表示调用方按普通文本原样输出（如代码块内容行）。
 */
export function renderLine(line: string, inFence: boolean): LineRenderResult {
  // 代码块围栏检测（无论是否在代码块内都先检查）
  const fence = line.match(/^```\s*(\w*)\s*$/);
  if (fence) {
    if (!inFence) {
      const lang = fence[1] || "code";
      return { rendered: null, fenceStart: true, lang };
    }
    return { rendered: null, fenceEnd: true };
  }

  if (inFence) return { rendered: null };

  // 空行
  if (!line.trim()) return { rendered: "" };

  // 标题
  const heading = renderHeading(line);
  if (heading) return { rendered: heading };

  // 分割线
  const hr = renderHr(line);
  if (hr) return { rendered: hr };

  // 引用
  const quote = renderQuote(line);
  if (quote) return { rendered: quote };

  // 列表
  const list = renderList(line);
  if (list) return { rendered: list };

  // 表格原样输出（不做边框/对齐渲染，保持 Markdown 原始格式）
  return { rendered: renderInline(line) };
}

/**
 * 渲染整块 Markdown（非流式，用于完整回答 result.text）
 * 代码块用左侧色条（▍）风格，宽度自适应，无固定边框
 */
export function renderMarkdown(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const result = renderLine(line, inFence);
    if (result.fenceStart) {
      inFence = true;
      out.push(`${chalk.dim(result.lang ?? "code")} ${chalk.gray("─".repeat(40))}`);
      continue;
    }
    if (result.fenceEnd) {
      inFence = false;
      out.push(chalk.gray("─".repeat(44)));
      continue;
    }
    if (inFence) {
      out.push(`${chalk.cyan("▍")} ${chalk.white(line)}`);
      continue;
    }
    if (result.rendered !== null) {
      out.push(result.rendered);
    } else {
      out.push(line);
    }
  }

  // 未闭合代码块：补底框
  if (inFence) {
    out.push(chalk.gray("─".repeat(44)));
  }

  return out;
}
