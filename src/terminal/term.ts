/**
 * Terminal — raw-mode 输入 + 键解析
 *
 * 职责：
 * - 进入/退出 raw mode（配合 InputCollector 兼容语义）
 * - 键序列解析：方向键（CSI-u 与经典 CSI）、Home/End/退格/Delete/Enter/Tab/Ctrl+C、粘贴
 * - 键序列 10ms 超时判定（防 \x1b[A 与 Esc 歧义）
 * - resize 事件回调
 *
 * 键事件模型：每个可打印字符 / 控制键解析为 KeyEvent，交由 handler 处理。
 */

import { stdin } from "node:process";

export type KeyEvent =
  | { type: "char"; char: string }
  | { type: "enter" }
  | { type: "altEnter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "ctrlC" }
  | { type: "ctrlD" }
  | { type: "wheelup" }
  | { type: "wheeldown" }
  | { type: "paste"; text: string }
  | { type: "unknown"; raw: string };

/** 解析字节流，输出键事件数组 */
export function parseKeys(input: string, pending = ""): { events: KeyEvent[]; rest: string } {
  const events: KeyEvent[] = [];
  let rest = "";
  const s = pending + input;

  let i = 0;
  const len = s.length;
  while (i < len) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);

    if (ch === "\r" || ch === "\n") {
      events.push({ type: "enter" });
      i++;
      continue;
    }
    if (ch === "\t") {
      events.push({ type: "tab" });
      i++;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      events.push({ type: "backspace" });
      i++;
      continue;
    }
    if (ch === "\x03") {
      events.push({ type: "ctrlC" });
      i++;
      continue;
    }
    if (ch === "\x04") {
      events.push({ type: "ctrlD" });
      i++;
      continue;
    }
    if (ch === "\x1b") {
      // 转义序列
      const seq = s.slice(i);
      if (seq.length === 1) {
        // 孤立 Esc，可能后续字节未到 — 保留待续
        rest = seq;
        i++;
        continue;
      }
      if (seq[1] === "[") {
        // SGR 鼠标滚轮事件：CSI < 64/65 ; row ; col M（64=上滚, 65=下滚）
        // eslint-disable-next-line no-control-regex
        const wheel = /^\x1b\[<(\d+);\d+;\d+([Mm])/.exec(seq);
        if (wheel) {
          const btn = Number(wheel[1]);
          if (btn === 64) events.push({ type: "wheelup" });
          else if (btn === 65) events.push({ type: "wheeldown" });
          i += wheel[0].length;
          continue;
        }
        const parsed = parseCsi(seq);
        if (parsed) {
          events.push(...parsed.events);
          i += parsed.consumed;
          continue;
        }
        // 不完整 CSI（缺终结符）
        rest = seq;
        i++;
        continue;
      }
      if (seq[1] === "O") {
        // SS3：经典 Home/End/方向键
        const map: Record<string, KeyEvent> = {
          A: { type: "up" },
          B: { type: "down" },
          C: { type: "right" },
          D: { type: "left" },
          H: { type: "home" },
          F: { type: "end" },
        };
        const k = map[seq[2] ?? ""];
        if (k) {
          events.push(k);
          i += 3;
          continue;
        }
        rest = seq;
        i++;
        continue;
      }
      // Alt+Enter（ESC + \r/\n）：插入换行
      if (seq[1] === "\r" || seq[1] === "\n") {
        events.push({ type: "altEnter" });
        i += 2;
        continue;
      }
      // 其他 Esc 组合（如 Alt+字符）
      events.push({ type: "escape" });
      i++;
      continue;
    }
    if (code >= 32) {
      events.push({ type: "char", char: ch });
      i++;
      continue;
    }
    // 其他控制字符
    events.push({ type: "unknown", raw: ch });
    i++;
  }

  return { events, rest };
}

function parseCsi(seq: string): { events: KeyEvent[]; consumed: number } | null {
  // eslint-disable-next-line no-control-regex
  const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(seq);
  if (!m) return null;
  const params = m[1] ?? "";
  const final = m[2]!;
  const consumed = m[0].length;

  // 方向键经典 CSI: [A [B [C [D
  if (final === "A" || final === "B" || final === "C" || final === "D") {
    const key = final === "A" ? "up" : final === "B" ? "down" : final === "C" ? "right" : "left";
    // CSI-u 修饰：;1;5A 等带修饰符
    const modMatch = /^1;(\d+)$/.exec(params);
    if (modMatch) {
      const mod = Number(modMatch[1]);
      // 5=Ctrl, 6=Ctrl+Shift, 1=Shift, 3=Alt
      void mod;
      return { events: [{ type: key }], consumed };
    }
    return { events: [{ type: key }], consumed };
  }

  if (final === "H") return { events: [{ type: "home" }], consumed };
  if (final === "F") return { events: [{ type: "end" }], consumed };
  if (final === "Z") return { events: [{ type: "tab" }], consumed }; // Shift+Tab

  // CSI-u 修饰键：13=Enter；;2=Shift, ;3=Alt, ;5=Ctrl（如 Shift+Enter=\x1b[13;2u）
  if (final === "u") {
    if (/^13;([235])$/.test(params)) return { events: [{ type: "altEnter" }], consumed };
    return { events: [{ type: "unknown", raw: seq.slice(0, consumed) }], consumed };
  }

  if (final === "~") {
    if (params === "3") return { events: [{ type: "delete" }], consumed };
    if (params === "5") return { events: [{ type: "pageup" }], consumed };
    if (params === "6") return { events: [{ type: "pagedown" }], consumed };
    if (params === "1" || params === "7") return { events: [{ type: "home" }], consumed };
    if (params === "4" || params === "8") return { events: [{ type: "end" }], consumed };
    return { events: [{ type: "unknown", raw: seq.slice(0, consumed) }], consumed };
  }

  return null;
}

/** 将 KeyEvent 转为可读字符串（调试用） */
export function keyLabel(ev: KeyEvent): string {
  if (ev.type === "char") return `char(${ev.char})`;
  return ev.type;
}
export class Terminal {
  private listening = false;
  private handler: ((data: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private keyHandler: ((ev: KeyEvent) => void) | null = null;
  private pasteBuf = "";
  private inPaste = false;
  private out: (s: string) => void = (s) => process.stdout.write(s);
  /** 不完整转义序列暂存（\x1b 被拆到多个 chunk 时重组，防方向键变成 [A 字符） */
  private pending = "";

  /** 启动 raw mode 输入监听 + 鼠标协议 */
  start(keyHandler: (ev: KeyEvent) => void, onResize?: () => void, out?: (s: string) => void): void {
    this.keyHandler = keyHandler;
    this.onResize = onResize ?? null;
    if (out) this.out = out;
    if (this.listening) return;
    this.listening = true;
    this.pending = "";

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    // 注意：不启用 SGR 鼠标协议（\x1b[?1000h），否则会拦截鼠标拖动导致无法选择复制。
    // 滚轮在无鼠标协议时由终端映射为方向键，通过 up/down 分流处理。

    this.handler = (data: Buffer) => {
      const s = data.toString("utf-8");
      if (this.inPaste) {
        // bracketed paste 结束标记
        const endIdx = s.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          this.pasteBuf += s.slice(0, endIdx);
          this.inPaste = false;
          this.keyHandler?.({ type: "paste", text: this.pasteBuf });
          this.pasteBuf = "";
          const after = s.slice(endIdx + 6);
          if (after) this.dispatch(after);
        } else {
          this.pasteBuf += s;
        }
        return;
      }
      // 检查粘贴开始
      const startIdx = s.indexOf("\x1b[200~");
      if (startIdx !== -1) {
        const before = s.slice(0, startIdx);
        if (before) this.dispatch(before);
        this.inPaste = true;
        this.pasteBuf = s.slice(startIdx + 6);
        return;
      }
      this.dispatch(s);
    };
    stdin.on("data", this.handler);

    if (this.onResize) {
      process.stdout.on("resize", this.onResize);
    }
  }

  private dispatch(s: string): void {
    const { events, rest } = parseKeys(s, this.pending);
    this.pending = rest;
    for (const ev of events) {
      this.keyHandler?.(ev);
    }
  }

  /** 停止 raw mode，恢复 cooked */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.pending = "";
    if (this.handler) {
      stdin.removeListener("data", this.handler);
      this.handler = null;
    }
    if (this.onResize) {
      process.stdout.removeListener("resize", this.onResize);
      this.onResize = null;
    }
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
  }

  destroy(): void {
    this.stop();
  }
}

export const terminal = new Terminal();
