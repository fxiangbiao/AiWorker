/**
 * InputCollector — 替代 inquirer 的输入收集器
 *
 * 功能：
 *   1. 标准行输入（替代 inquirer prompt）
 *   2. 非阻塞输入捕获（Agent 运行期间监听，加入排队队列）
 *   3. 预填输入（队列消息回显）
 */

import { createInterface, Interface } from "node:readline";
import { stdin, stdout } from "node:process";

export class InputCollector {
  private rl: Interface | null = null;
  private listening = false;
  private queue: string[] = [];
  private lineHandler: ((line: string) => void) | null = null;

  /**
   * 标准输入 — 阻塞式，等待用户输入一行
   */
  async prompt(): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    return new Promise<string>((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  /**
   * 预填文本并等待输入
   */
  async promptWithPrefill(prefill: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    return new Promise<string>((resolve) => {
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.write(prefill);
    });
  }

  /**
   * 开始非阻塞监听（Agent 运行期间使用）
   * 用户输入的行会通过 onInput 回调加入队列
   */
  startListening(onInput: (text: string) => void): void {
    if (this.listening) return;
    this.listening = true;
    this.queue = [];
    this.lineHandler = onInput;

    // 使用原始 stdin 捕获输入
    // 通过 readline.emitKeypressEvents 加 data 事件监听
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    this.rl = rl;

    rl.on("line", (line) => {
      if (this.listening && line.trim()) {
        this.queue.push(line.trim());
        this.lineHandler?.(line.trim());
      }
    });
  }

  /**
   * 停止监听，返回排队队列
   */
  stopListening(): string[] {
    this.listening = false;
    if (this.rl) {
      // 暂停 line 事件但不关闭，后续用户可以继续输入
      this.rl.removeAllListeners("line");
      this.rl.pause();
    }
    const queue = [...this.queue];
    this.queue = [];
    this.lineHandler = null;
    return queue;
  }

  /**
   * 获取当前排队消息数
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  destroy(): void {
    this.stopListening();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

export const inputCollector = new InputCollector();
