/**
 * 工具注册表 (单例)
 * 参考 HermesAgent 的 ToolRegistry：动态 Schema 重建 + 运行时可用性检查
 */

import type { RegisteredTool, ToolDefinition, ToolContext } from "../types.js";

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  private static instance: ToolRegistry;

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  /** 注册工具 */
  register(
    name: string,
    definition: ToolDefinition,
    handler: RegisteredTool["handler"],
    options?: {
      enabled?: boolean;
      availabilityCheck?: RegisteredTool["availabilityCheck"];
    },
  ): void {
    this.tools.set(name, {
      definition,
      handler,
      enabled: options?.enabled ?? true,
      availabilityCheck: options?.availabilityCheck,
    });
  }

  /** 注销工具 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 启用/禁用工具 */
  setEnabled(name: string, enabled: boolean): void {
    const tool = this.tools.get(name);
    if (tool) tool.enabled = enabled;
  }

  /** 获取所有已注册工具 */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取当前上下文中可用的工具定义列表
   * 运行时过滤：enabled + availabilityCheck
   */
  async getAvailableDefinitions(ctx: ToolContext): Promise<ToolDefinition[]> {
    const available: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.enabled) continue;
      if (tool.availabilityCheck) {
        const ok = await tool.availabilityCheck(ctx);
        if (!ok) continue;
      }
      available.push(tool.definition);
    }
    return available;
  }

  /** 获取工具处理器 */
  getHandler(name: string): RegisteredTool["handler"] | undefined {
    return this.tools.get(name)?.handler;
  }

  /** 检查工具是否存在且可用 */
  isAvailable(name: string): boolean {
    const tool = this.tools.get(name);
    return !!tool && tool.enabled;
  }

  /** 清空注册表（测试用） */
  clear(): void {
    this.tools.clear();
  }
}

export const toolRegistry = ToolRegistry.getInstance();
