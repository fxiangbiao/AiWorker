/**
 * input.ts — InputCollector 兼容转发
 *
 * 历史遗留：Sprint 14 的 raw-mode 输入收集器已被 term.ts (Terminal) 取代。
 * 保留本模块导出以兼容 smoke-test 与外部调用方，内部转发到 terminal。
 */

import { terminal } from "./term.js";

export class InputCollector {
  startListening(_onFirstKey?: () => void, _onInterrupt?: () => void): void {
    terminal.start(() => {
      // 事件由 Tui 处理；此处仅保持兼容语义
    });
  }

  stopListening(): string[] {
    terminal.stop();
    return [];
  }

  getQueueSize(): number {
    return 0;
  }

  destroy(): void {
    terminal.stop();
  }
}

export const inputCollector = new InputCollector();
