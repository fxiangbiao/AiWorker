/**
 * turn-view.ts — 回合块视图（Sprint 45）
 *
 * 一次用户输入 → agent 输出完成 的结构化视图。thinking / tool / ask / text / note
 * 块按到达序入列；thinking 可折叠（默认折叠：标题流式摘要+字数）、tool 状态原位翻转
 * 且详情可折叠；ask 交互块在块内维护高亮/勾选；定稿（含中断）保留结构供历史回看。
 *
 * 本模块只负责"块状态机 → 成品行（含 ANSI 样式）"，不做宽度 wrap 与滚动
 * （由 components.ts 渲染层负责）。行数预算在块内执行，防巨文本拖垮渲染帧。
 */

import chalk from "chalk";
import type { ToolArtifact, ArtifactKind } from "../types.js";
import { supportsHyperlinks } from "./markdown.js";
import { formatSize } from "../core/preview.js";

/** 展开正文/详情/文本的渲染行预算（超出部分裁剪并标注省略） */
const MAX_CONTENT_ROWS = 400;
/** tool 详情单条内容字符预算（超出截断标注，完整内容按需在事件中） */
const MAX_DETAIL_CHARS = 800;

export interface ThinkingBlock {
  kind: "thinking";
  id: number;
  full: string;
  summary: string;
  charCount: number;
  open: boolean;
  done: boolean;
}

export interface ToolBlock {
  kind: "tool";
  id: number;
  callId: string;
  name: string;
  argsPreview: string;
  argsFull: string;
  status: "running" | "done" | "error";
  durMs: number;
  resultPreview: string;
  resultFull: string;
  detailOpen: boolean;
  artifacts?: ToolArtifact[];
}

export interface AskBlock {
  kind: "ask";
  id: number;
  question: string;
  options: string[];
  multiple: boolean;
  status: "pending" | "answered" | "timeout" | "canceled";
  answer: string | null;
  highlight: number;
  selected: boolean[];
}

export interface TextBlock {
  kind: "text";
  id: number;
  lines: string[];
  lastPartial: string;
}

export interface NoteBlock {
  kind: "note";
  id: number;
  text: string;
}

export type Block = ThinkingBlock | ToolBlock | AskBlock | TextBlock | NoteBlock;

export type FoldKind = "thinking" | "tool";

/** 可折叠块条目（供 [ ] 焦点环 / t / o 快捷键） */
export interface FoldTarget {
  kind: FoldKind;
  id: number;
  /** 标题摘要在目标中的顺序索引（块级，含 note 等非折叠成员跳过） */
  index: number;
}

let nextId = 1;

/** 摘要：取首段（首个换行前）前 max 字，超长补… */
function makeSummary(full: string, max = 80): string {
  const firstLine = full.split("\n", 1)[0] ?? "";
  const line = firstLine.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 内容按预算裁剪：超出只保留尾部 keep 行并前置省略标注 */
function sliceRows(lines: string[], keep: number): string[] {
  if (lines.length <= keep) return lines;
  const head = chalk.gray(`…（已省略前 ${lines.length - keep} 行，折叠/展开查看）`);
  return [head, ...lines.slice(-keep)];
}

export class TurnView {
  running = false;
  interrupted = false;
  meta = "";
  private blocks: Block[] = [];
  private rawLines: string[] = [];
  /** 渲染焦点块 id（[ ] 环移动；null=无焦点） */
  focusId: number | null = null;
  /** thinking 展开正文的行缓存（增量维护，仅展开时存在） */
  private thinkLines = new Map<number, string[]>();
  /** 各 thinking 块已消费进行缓存的文本游标（增量拆分用） */
  private thinkConsumed = new Map<number, number>();

  /** 新 thinking 块默认展开（showThinking=true 语义；缺省折叠摘要） */
  openDefaultThinking = false;

  start(): void {
    this.running = true;
    this.interrupted = false;
    this.meta = "";
    this.blocks = [];
    this.rawLines = [];
    this.focusId = null;
    this.thinkLines.clear();
    this.thinkConsumed.clear();
    this.openDefaultThinking = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 当前（尾部未 done）thinking 块；无则新建（默认折叠） */
  private ensureThinking(): ThinkingBlock {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "thinking" && !last.done) return last;
    this.closeThinking();
    const block: ThinkingBlock = {
      kind: "thinking",
      id: nextId++,
      full: "",
      summary: "",
      charCount: 0,
      open: this.openDefaultThinking,
      done: false,
    };
    this.blocks.push(block);
    return block;
  }

  /** 思考增量：追加 full、刷新摘要/字数；展开时同步增量行缓存 */
  thinkingDelta(text: string): void {
    const block = this.ensureThinking();
    block.full += text;
    block.charCount = block.full.length;
    block.summary = makeSummary(block.full);
    // 展开时维护行缓存（按已消费游标增量拆分，避免全量 split 的 O(n²)）
    const cached = this.thinkLines.get(block.id);
    if (cached) {
      const consumed = this.thinkConsumed.get(block.id) ?? 0;
      const added = block.full.slice(consumed);
      if (added) this.thinkAppendSplit(cached, added);
      this.thinkConsumed.set(block.id, block.full.length);
    }
  }

  /** 供 thinkingDelta 增量拆分：把 last 行与首个片段拼接、余下 push */
  private thinkAppendSplit(lines: string[], added: string): void {
    const parts = added.split("\n");
    if (parts.length > 0 && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${parts[0]}`;
    } else if (parts.length > 0) {
      lines.push(parts[0]);
    }
    for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
  }

  /** 关闭尾部 thinking（thinking→tool/text/note/新 thinking 边界） */
  closeThinking(): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "thinking" && !last.done) {
      last.done = true;
      if (!last.open) {
        this.thinkLines.delete(last.id);
        this.thinkConsumed.delete(last.id);
      }
    }
  }

  /** 新建工具块（关闭尾部 thinking） */
  addTool(callId: string, name: string, argsPreview: string, argsFull: string): void {
    this.closeThinking();
    this.blocks.push({
      kind: "tool",
      id: nextId++,
      callId,
      name,
      argsPreview,
      argsFull,
      status: "running",
      durMs: 0,
      resultPreview: "",
      resultFull: "",
      detailOpen: false,
    });
  }

  /** 工具结果：按 callId 匹配置终态 */
  toolResult(callId: string, ok: boolean, preview: string, full: string, durMs: number, artifacts?: ToolArtifact[]): void {
    const tool = this.findTool(callId);
    if (!tool) return;
    tool.status = ok ? "done" : "error";
    tool.durMs = durMs;
    tool.resultPreview = preview;
    tool.resultFull = full;
    tool.artifacts = artifacts;
  }

  private findTool(callId: string): ToolBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b && b.kind === "tool" && b.callId === callId) return b;
    }
    return null;
  }

  /** ask_user 块（关闭尾部 thinking） */
  addAsk(question: string, options: string[], multiple: boolean): AskBlock {
    this.closeThinking();
    const block: AskBlock = {
      kind: "ask",
      id: nextId++,
      question,
      options,
      multiple,
      status: "pending",
      answer: null,
      highlight: 0,
      selected: options.map(() => false),
    };
    this.blocks.push(block);
    return block;
  }

  askUpdate(patch: { highlight?: number; selected?: boolean[] }): void {
    const ask = this.lastAsk();
    if (!ask || ask.status !== "pending") return;
    if (patch.highlight !== undefined) ask.highlight = patch.highlight;
    if (patch.selected) ask.selected = patch.selected;
  }

  finishAsk(answer: string | null, by: "answered" | "timeout" | "canceled"): void {
    const ask = this.lastAsk();
    if (!ask || ask.status !== "pending") return;
    ask.status = by;
    ask.answer = by === "answered" ? answer : null;
  }

  private lastAsk(): AskBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b && b.kind === "ask") return b;
    }
    return null;
  }

  /** 提交一行回答文本（成品行；首行出现时关闭 thinking） */
  textLine(text: string): void {
    if (this.blocks[this.blocks.length - 1]?.kind !== "text") {
      this.closeThinking();
      this.blocks.push({ kind: "text", id: nextId++, lines: [], lastPartial: "" });
    }
    const textBlock = this.blocks[this.blocks.length - 1] as TextBlock;
    textBlock.lines.push(text);
    // 该行已随换行提交为成品行：清除同内容半行，防 renderRows 用 lastPartial 重复展示（含 flush/textCommit 二次提交）
    textBlock.lastPartial = "";
  }

  /** 流式半行：覆盖 lastPartial（replace 语义） */
  textPartial(text: string): void {
    if (this.blocks[this.blocks.length - 1]?.kind !== "text") {
      this.closeThinking();
      this.blocks.push({ kind: "text", id: nextId++, lines: [], lastPartial: "" });
    }
    (this.blocks[this.blocks.length - 1] as TextBlock).lastPartial = text;
  }

  /** flush：把半行提为正式行 */
  textCommit(): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "text" && last.lastPartial) {
      last.lines.push(last.lastPartial);
      last.lastPartial = "";
    }
  }

  addNote(text: string): void {
    this.closeThinking();
    this.blocks.push({ kind: "note", id: nextId++, text });
  }

  /** 运行期不可归类的外部输出（重定向入口） */
  addRaw(text: string): void {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (const l of lines) this.rawLines.push(l);
  }

  /** thinking 折叠开关 */
  toggleThinking(): void {
    const targets = this.foldTargets();
    for (let i = targets.length - 1; i >= 0; i--) {
      if (targets[i].kind === "thinking") {
        this.toggleById(targets[i].id);
        return;
      }
    }
  }

  /** tool 详情开关（最近） */
  toggleToolDetail(): void {
    const targets = this.foldTargets();
    for (let i = targets.length - 1; i >= 0; i--) {
      if (targets[i].kind === "tool") {
        this.toggleById(targets[i].id);
        return;
      }
    }
  }

  /** 指定 id 折叠/展开（thinking.open 或 tool.detailOpen） */
  toggleById(id: number): void {
    const b = this.findBlock(id);
    if (!b) return;
    if (b.kind === "thinking") {
      b.open = !b.open;
      if (b.open) {
        this.buildThinkLines(id);
      } else {
        this.thinkLines.delete(id);
        this.thinkConsumed.delete(id);
      }
    } else if (b.kind === "tool") {
      b.detailOpen = !b.detailOpen;
    }
  }

  /** 当前回合全部 thinking/tool 收/展 */
  collapseAll(): void {
    for (const b of this.blocks) {
      if (b.kind === "thinking") {
        b.open = false;
        this.thinkLines.delete(b.id);
        this.thinkConsumed.delete(b.id);
      } else if (b.kind === "tool") {
        b.detailOpen = false;
      }
    }
  }

  expandAll(): void {
    for (const b of this.blocks) {
      if (b.kind === "thinking") {
        b.open = true;
        this.buildThinkLines(b.id);
      } else if (b.kind === "tool") {
        b.detailOpen = true;
      }
    }
  }

  /** 可折叠块清单（按序，供 [ ] 环与高亮映射） */
  foldTargets(): FoldTarget[] {
    const out: FoldTarget[] = [];
    for (const b of this.blocks) {
      if (b.kind === "thinking") out.push({ kind: "thinking", id: b.id, index: out.length });
      else if (b.kind === "tool") out.push({ kind: "tool", id: b.id, index: out.length });
    }
    return out;
  }

  /** [ ] 环：相对当前 focusId 取上/下折叠目标（无焦点从最近块开始） */
  moveFocus(dir: -1 | 1): FoldTarget | null {
    const targets = this.foldTargets();
    if (targets.length === 0) {
      this.focusId = null;
      return null;
    }
    let idx = targets.findIndex((t) => t.id === this.focusId);
    if (idx === -1) {
      // 无焦点：从最近块开始（前移找 thinking 优先）
      idx = dir === 1 ? targets.length - 1 : 0;
      if (dir === 1) {
        const thinkIdx = targets.map((t) => t.kind).lastIndexOf("thinking");
        if (thinkIdx !== -1) idx = thinkIdx;
      }
    } else {
      idx = (idx + dir + targets.length) % targets.length;
    }
    const t = targets[idx]!;
    this.focusId = t.id;
    return t;
  }

  /** 定稿（正常或中断）：关 thinking、running 工具置中断态、压 meta */
  finish(metaText: string, interrupted = false): void {
    if (!this.running) return;
    for (const b of this.blocks) {
      if (b.kind === "thinking" && !b.done) {
        b.done = true;
        if (!b.open) {
          this.thinkLines.delete(b.id);
          this.thinkConsumed.delete(b.id);
        }
      } else if (b.kind === "tool" && b.status === "running") {
        b.status = "error";
        b.resultPreview = interrupted ? "已中断" : "未返回结果";
      }
    }
    this.running = false;
    this.interrupted = interrupted;
    this.meta = metaText;
    this.focusId = null;
  }

  /** 渲染成品行（含预算裁剪与样式；不含宽度 wrap——由渲染层负责） */
  renderRows(): string[] {
    const out: string[] = [];
    for (const b of this.blocks) {
      switch (b.kind) {
        case "thinking":
          this.renderThinking(b, out);
          break;
        case "tool":
          this.renderTool(b, out);
          break;
        case "ask":
          this.renderAsk(b, out);
          break;
        case "text": {
          // 区域分界：回答正文与上方思考/工具/提示显式隔开
          if (out.length > 0) out.push(chalk.gray("  " + "─".repeat(48)));
          // 主回答全量输出（不裁剪，防丢阅读内容；行数兜底由渲染层条目上限负责）
          const rows = b.lastPartial ? [...b.lines, b.lastPartial] : b.lines;
          out.push(...rows);
          break;
        }
        case "note":
          out.push(b.text);
          break;
      }
    }
    // rawLines：全部事件块之后、meta 之前（全量；异常量级由渲染层上限兜底）
    if (this.rawLines.length > 0) {
      if (out.length > 0) out.push(chalk.gray("  " + "─".repeat(48)));
      out.push(...this.rawLines);
    }
    if (this.meta) out.push(chalk.gray(this.meta));
    return out;
  }

  private renderThinking(b: ThinkingBlock, out: string[]): void {
    const status = b.done ? chalk.green("✓") : chalk.cyan("▍");
    const marker = b.open ? "▾" : "▸";
    const summary = b.summary ? ` ${chalk.dim(b.summary)}` : "";
    const count = b.done ? chalk.dim(" · 已结束") : ` · 已 ${b.charCount} 字`;
    // 标题统一 dim 灰（仅状态/焦点着色），避免与正文色差产生"区域割裂感"
    let title = `  ${status} ${chalk.dim("思考")}${summary}${chalk.dim(count)} ${chalk.dim(marker)}`;
    if (b.id === this.focusId) title = chalk.inverse(title);
    out.push(title);
    if (!b.open) return;
    const lines = this.thinkLines.get(b.id) ?? this.buildThinkLines(b.id);
    // 正文统一 dim 灰 + │ 纹理前缀（与回答正文区分）；长行 wrap 后颜色由渲染层重放保持
    out.push(...sliceRows(lines.map((l) => chalk.dim(`  │ ${l}`)), MAX_CONTENT_ROWS));
  }

  private buildThinkLines(id: number): string[] {
    const b = this.findBlock(id);
    const lines: string[] = [];
    if (b && b.kind === "thinking") {
      // 首次重建全量；此后 thinkingDelta 按 consumed 游标增量追加
      lines.push(...b.full.split("\n"));
      this.thinkLines.set(id, lines);
      this.thinkConsumed.set(id, b.full.length);
    }
    return lines;
  }

  private renderTool(b: ToolBlock, out: string[]): void {
    const icon = b.status === "running" ? chalk.dim("…") : b.status === "done" ? chalk.green("✓") : chalk.red("✗");
    const dur = b.status === "running" ? "" : chalk.gray(` ⌁ ${fmtDur(b.durMs)}`);
    const preview = b.argsPreview ? chalk.dim(` ${b.argsPreview}`) : "";
    const result = b.status === "running" ? "" : b.resultPreview ? ` ${icon}${chalk.dim(` ${b.resultPreview}`)}` : ` ${icon}`;
    const marker = b.detailOpen ? " ▾" : " ▸";
    let title = `  ${chalk.blue(`🔧 ${b.name}`)}${preview}${dur}${result}${marker}`;
    if (b.id === this.focusId) title = chalk.inverse(title);
    out.push(title);
    // 产物 chips（OSC 8 超链接）：文件 → file:// 打开默认应用，链接 → https 打开浏览器
    if (b.artifacts && b.artifacts.length > 0) {
      for (const art of b.artifacts) {
        if (art.type === "file") {
          const uri = toFileUri(art.path);
          const name = baseNameOf(art.path);
          const link = uri ? osc8(uri, chalk.cyan(name)) : chalk.cyan(name);
          out.push(`  ${chalk.dim(artifactKindIcon(art.kind))} ${link} ${chalk.gray(formatSize(art.size))}`);
        } else if (art.type === "link") {
          const label = art.title || art.site || art.url;
          out.push(`  ${chalk.dim("🔗")} ${osc8(art.url, chalk.cyan(label))}`);
        } else if (art.type === "diff") {
          out.push(`  ${chalk.dim("📝")} ${chalk.dim(`变更 ${baseNameOf(art.path)}`)}`);
        }
      }
    }
    if (!b.detailOpen) return;
    const detail: string[] = [];
    // 与 thinking 正文同 gutter：│ 对齐块标题首列（🔧 起始列），防左右偏移造成区域割裂
    if (b.argsFull) detail.push(chalk.dim(`  │ 参数: ${trunc(b.argsFull)}`));
    if (b.resultFull) detail.push(chalk.dim(`  │ 结果: ${trunc(b.resultFull)}`));
    out.push(...sliceRows(detail, 6));
  }

  private renderAsk(b: AskBlock, out: string[]): void {
    if (b.status !== "pending") {
      const head = b.answer ? `回答: ${trunc(b.answer, 60)}` : b.status === "timeout" ? "超时未答" : "已取消";
      out.push(`  ${chalk.dim("❓")} ${b.question} → ${b.status === "answered" ? chalk.green(head) : chalk.gray(head)}`);
      return;
    }
    out.push(`  ${chalk.cyan("❓")} ${b.question}`);
    b.options.forEach((opt, i) => {
      let line: string;
      if (b.multiple) {
        const mark = b.selected[i] ? "[*]" : "[ ]";
        line = `    ${i === b.highlight ? ">" : " "}${mark} ${i + 1}) ${opt}`;
      } else {
        line = `    ${i === b.highlight ? ">" : " "} ${i + 1}) ${opt}`;
      }
      out.push(i === b.highlight ? chalk.cyan(line) : b.multiple && b.selected[i] ? chalk.green(line) : chalk.dim(line));
    });
    out.push(
      b.options.length > 0
        ? chalk.dim(`   ${b.multiple ? "（可多选：↑/↓ 移动，Tab/空格 勾选，Enter 提交）" : "（↑/↓ 选择，Enter 提交）"}`)
        : chalk.dim("   （输入回答后回车）"),
    );
  }

  private findBlock(id: number): Block | null {
    for (const b of this.blocks) {
      if (b.id === id) return b;
    }
    return null;
  }
}

function fmtDur(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function trunc(s: string, max = MAX_DETAIL_CHARS): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** basename（兼容 Win/Unix 分隔符） */
function baseNameOf(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

/** 文件产物类型图标 */
function artifactKindIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "text":
      return "📄";
    case "image":
      return "🖼️";
    case "video":
      return "🎬";
    case "audio":
      return "🎧";
    case "pdf":
      return "📕";
    case "office":
      return "📊";
    case "binary":
      return "📦";
    default:
      return "📄";
  }
}

/** 绝对路径 → file:// URI（Win: C:\a → file:///C:/a；posix: /a → file:///a） */
function toFileUri(path: string): string {
  try {
    const p = path.replace(/\\/g, "/");
    const abs = p.startsWith("/") ? p : `/${p}`;
    return `file://${encodeURI(abs)}`;
  } catch {
    return "";
  }
}

/** 剥除 C0/C1 控制字符与 DEL（防终端注入；逐字符过滤避免 no-control-regex） */
function stripCtl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) continue;
    out += s[i];
  }
  return out;
}

/** OSC 8 超链接（仅支持的终端；否则回落纯文本；URL/标签先剥控制字符防终端注入） */
function osc8(url: string, label: string): string {
  if (!supportsHyperlinks()) return label;
  return `\x1b]8;;${stripCtl(url)}\x1b\\${stripCtl(label)}\x1b]8;;\x1b\\`;
}
