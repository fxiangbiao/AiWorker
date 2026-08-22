/**
 * Screen — 终端帧缓冲 + 差分渲染引擎
 *
 * 职责：
 * - 持有 rows×cols 虚拟屏幕
 * - render(lines[]) 与上一帧逐行对比，只写变化行
 * - 每行末尾追加 SGR 重置，防止样式跨行泄漏
 * - CJK 字符按显示宽度 2 列计算
 *
 * 输出经内部 out 写入（默认 process.stdout.write 真实引用），
 * 避免与外部 stdout 捕获冲突。
 */

import { stdout } from "node:process";
import { displayWidth, truncateToWidth } from "./markdown.js";

/** 行尾追加 SGR reset，防样式泄漏；未闭合 OSC 8 先补 ST 关闭（防吞掉后续 ANSI 定位命令） */
function resetLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const openCount = (line.match(/\x1b\]8;/g) ?? []).length;
  // eslint-disable-next-line no-control-regex
  const closeCount = (line.match(/\x1b\\/g) ?? []).length;
  const tail = openCount > closeCount ? "\x1b\\" : "";
  return `${line}${tail}\x1b[0m`;
}

export class Screen {
  private rows = 0;
  private cols = 0;
  private prev: string[] = [];
  private out: (s: string) => void;

  constructor(out?: (s: string) => void) {
    // 默认捕获真实 write（后续可能被 Tui 替换 process.stdout.write）
    this.out = out ?? ((s) => stdout.write(s));
  }

  /** 由 Tui 注入真实 write（规避外部捕获） */
  setOut(out: (s: string) => void): void {
    this.out = out;
  }

  init(): void {
    this.rows = stdout.rows || 24;
    this.cols = stdout.columns || 80;
    this.prev = [];
    this.out(`\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l`);
  }

  /** 终端尺寸变化时清空上一帧，强制全量重绘 */
  resize(): void {
    this.rows = stdout.rows || 24;
    this.cols = stdout.columns || 80;
    this.prev = [];
  }

  getRows(): number {
    return this.rows;
  }

  getCols(): number {
    return this.cols;
  }

  /** 校验单行不超过列宽（CJK 安全），超出截断 */
  private fit(line: string): string {
    return truncateToWidth(line, this.cols);
  }

  /**
   * 渲染整帧。lines 长度 ≤ rows；不足部分补空行。
   * 差分对比 prev，只写变化行。
   */
  render(lines: string[]): void {
    const frame: string[] = [];
    const height = this.rows;
    for (let i = 0; i < height; i++) {
      const src = i < lines.length ? lines[i] : "";
      frame.push(resetLine(this.fit(src)));
    }

    const old = this.prev;
    this.prev = frame;

    if (old.length === 0) {
      // 首帧 / resize 后（prev 被清空）：清屏后全量输出。
      // 必须清屏：终端变窄/变矮时旧帧行尾与底部内容会残留，与新内容重叠。
      this.out(`\x1b[2J\x1b[H`);
      for (let i = 0; i < height; i++) {
        this.out(`\x1b[${i + 1};1H\x1b[2K${frame[i]}`);
      }
      return;
    }

    // 差分：找变化区间
    let first = -1;
    let last = -1;
    const maxLen = Math.max(old.length, height);
    for (let i = 0; i < maxLen; i++) {
      if (old[i] !== frame[i]) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) return;

    for (let i = first; i <= last; i++) {
      const row = frame[i] ?? "";
      this.out(`\x1b[${i + 1};1H\x1b[2K${row}`);
    }
  }

  /** 光标定位到某行（1 基），供输入组件放置硬件光标 */
  positionCursor(row: number, col: number): void {
    const r = Math.max(1, Math.min(this.rows, row));
    const c = Math.max(1, Math.min(this.cols, col));
    this.out(`\x1b[${r};${c}H`);
  }

  showCursor(): void {
    this.out(`\x1b[?25h`);
  }

  hideCursor(): void {
    this.out(`\x1b[?25l`);
  }

  /** 退出交替屏幕，恢复主缓冲 */
  destroy(): void {
    this.out(`\x1b[?25h\x1b[?1049l`);
  }

  /** 计算字符串显示宽度（CJK 2 列，忽略 ANSI） */
  widthOf(s: string): number {
    return displayWidth(s);
  }
}
