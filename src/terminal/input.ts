/**
 * InputCollector — 输入收集器
 * Agent 运行期间用 raw 模式捕获 stdin，不冲突 readline。
 */

import { stdin } from "node:process";

export class InputCollector {
  private listening = false;
  private buf = "";
  private queue: string[] = [];
  private handler: ((data: Buffer) => void) | null = null;

  startListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.queue = [];
    this.buf = "";

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    this.handler = (data: Buffer) => {
      const s = data.toString("utf-8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          const line = this.buf.trim();
          this.buf = "";
          if (line) this.queue.push(line);
        } else if (ch === "\x7f" || ch === "\b") {
          if (this.buf.length > 0) this.buf = this.buf.slice(0, -1);
        } else if (ch === "\x03") {
          // Ctrl+C — 忽略
        } else if (ch >= " ") {
          this.buf += ch;
        }
      }
    };

    stdin.on("data", this.handler);
  }

  stopListening(): string[] {
    if (!this.listening) return [];
    this.listening = false;

    if (this.handler) {
      stdin.removeListener("data", this.handler);
      this.handler = null;
    }

    if (this.buf.trim()) {
      this.queue.push(this.buf.trim());
      this.buf = "";
    }

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    stdin.pause();

    const q = [...this.queue];
    this.queue = [];
    return q;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  destroy(): void {
    if (this.listening) this.stopListening();
  }
}

export const inputCollector = new InputCollector();
