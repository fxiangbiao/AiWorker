/**
 * Hooks 系统 — 全生命周期扩展点
 * 设计依据：调研报告 3.5 节——五生命周期点
 *
 * onMessage      → 用户消息进入时
 * onToolCallPre  → 工具执行前（可拦截）
 * onToolCallPost → 工具执行后
 * onTaskComplete → 任务完成时
 * onError        → 发生错误时
 */

import type { HookEvent, HookHandler, HookContext, HookResult } from "../types.js";

interface RegisteredHook {
  id: string;
  event: HookEvent;
  handler: HookHandler;
  priority: number; // 数字越小越先执行
}

class HookManager {
  private hooks: RegisteredHook[] = [];

  private static instance: HookManager;

  static getInstance(): HookManager {
    if (!HookManager.instance) {
      HookManager.instance = new HookManager();
    }
    return HookManager.instance;
  }

  /** 注册 Hook */
  on(event: HookEvent, handler: HookHandler, options?: { id?: string; priority?: number }): string {
    const id = options?.id ?? `${event}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.hooks.push({
      id,
      event,
      handler,
      priority: options?.priority ?? 100,
    });
    // 按优先级排序
    this.hooks.sort((a, b) => a.priority - b.priority);
    return id;
  }

  /** 注销 Hook */
  off(id: string): boolean {
    const idx = this.hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  /** 检查指定 ID 的 Hook 是否已注册 */
  has(id: string): boolean {
    return this.hooks.some((h) => h.id === id);
  }

  /**
   * 触发事件
   * 依次执行所有 hook，任一返回 proceed=false 则中止并返回拦截
   */
  async trigger(event: HookEvent, ctx: Omit<HookContext, "event">): Promise<HookResult> {
    const hooks = this.hooks.filter((h) => h.event === event);
    let currentData = { ...ctx.data };

    for (const hook of hooks) {
      const result = await hook.handler({
        ...ctx,
        event,
        data: currentData,
      });

      if (result) {
        if (!result.proceed) {
          return { proceed: false, modifiedData: currentData, message: result.message };
        }
        if (result.modifiedData) {
          currentData = { ...currentData, ...result.modifiedData };
        }
      }
    }

    return { proceed: true, modifiedData: currentData };
  }

  /** 获取已注册的 hook 列表 */
  list(): RegisteredHook[] {
    return [...this.hooks];
  }

  clear(): void {
    this.hooks = [];
  }
}

export const hookManager = HookManager.getInstance();
