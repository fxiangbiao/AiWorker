/**
 * InputCollector — 输入收集器
 *
 * 不创建独立 readline 实例（避免与 renderer.prompt() 争抢 stdin）。
 * 使用 raw stdin data 事件捕获内容。
 */

import { stdin } from "node:process";

export class InputCollector {
  private listening = false;
  private queue: string[] = [];
  private buffer = "";
  private onData: ((chunk: string) => void) | null = null;

  startListening(_onInput: (text: string) => void): void {
    if (this.listening) return;
    this.listening = true;
    this.queue = [];
    this.buffer = "";

    stdin.setEncoding("utf8");
    stdin.resume();

    this.onData = (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const ln of lines) {
        const t = ln.replace(/\r/g, "").trim();
        if (t) this.queue.push(t);
      }
    };

    stdin.on("data", this.onData);
  }

  stopListening(): string[] {
    this.listening = false;
    if (this.onData) {
      stdin.removeListener("data", this.onData);
      this.onData = null;
    }
    // 刷新残留 buffer
    if (this.buffer.trim()) {
      this.queue.push(this.buffer.trim());
      this.buffer = "";
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
    this.stopListening();
  }
}

export const inputCollector = new InputCollector();
