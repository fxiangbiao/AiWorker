/**
 * 工具注册表 (单例)
 * 参考 HermesAgent 的 ToolRegistry：动态 Schema 重建 + 运行时可用性检查
 */

import type { RegisteredTool, ToolDefinition, ToolContext } from "../types.js";

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  /** 命名作用域注册表：scopeId → 工具表（同名遮蔽全局，对齐 DSH ToolRuntime scoped registry） */
  private scopes = new Map<string, Map<string, RegisteredTool>>();

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
      plugin?: string;
    },
  ): void {
    this.tools.set(name, {
      definition,
      handler,
      enabled: options?.enabled ?? true,
      availabilityCheck: options?.availabilityCheck,
      plugin: options?.plugin,
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

  // ===== 作用域视图（Sprint 27） =====

  /** 获取命名作用域视图（scope 注册 + 全局回退，同名遮蔽全局） */
  getScope(scopeId: string): ToolScopeView {
    return new ToolScopeView(this, scopeId);
  }

  /** scope 内注册（ToolScopeView.register 内部调用） */
  registerInScope(scopeId: string, name: string, tool: RegisteredTool): void {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = new Map();
      this.scopes.set(scopeId, scope);
    }
    scope.set(name, tool);
  }

  /** scope 内注销 */
  unregisterFromScope(scopeId: string, name: string): boolean {
    return this.scopes.get(scopeId)?.delete(name) ?? false;
  }

  /** scope 优先查询，回退全局 */
  getWithScope(scopeId: string, name: string): RegisteredTool | undefined {
    return this.scopes.get(scopeId)?.get(name) ?? this.tools.get(name);
  }

  /** scope 可见集合（scope 同名覆盖全局；无 scope 注册时 = 全局） */
  getAllWithScope(scopeId: string): RegisteredTool[] {
    const scope = this.scopes.get(scopeId);
    if (!scope || scope.size === 0) return this.getAll();
    const merged = new Map(this.tools);
    for (const [name, tool] of scope) merged.set(name, tool);
    return Array.from(merged.values());
  }

  /** scope 内独立注册的工具（不含全局回退；供 /plugins 与调试） */
  listScopeTools(scopeId: string): RegisteredTool[] {
    return Array.from(this.scopes.get(scopeId)?.values() ?? []);
  }

  /** 清空注册表（测试用） */
  clear(): void {
    this.tools.clear();
    this.scopes.clear();
  }
}

/** 命名作用域视图 — 与全局注册表同签名，模型可见性与执行解析共用，保证遮蔽一致 */
export class ToolScopeView {
  constructor(
    private registry: ToolRegistry,
    readonly scopeId: string,
  ) {}

  register(
    name: string,
    definition: ToolDefinition,
    handler: RegisteredTool["handler"],
    options?: {
      enabled?: boolean;
      availabilityCheck?: RegisteredTool["availabilityCheck"];
      plugin?: string;
    },
  ): void {
    this.registry.registerInScope(this.scopeId, name, {
      definition,
      handler,
      enabled: options?.enabled ?? true,
      availabilityCheck: options?.availabilityCheck,
      plugin: options?.plugin,
    });
  }

  unregister(name: string): boolean {
    return this.registry.unregisterFromScope(this.scopeId, name);
  }

  setEnabled(name: string, enabled: boolean): void {
    const tool = this.registry.getWithScope(this.scopeId, name);
    if (tool) tool.enabled = enabled;
  }

  getAll(): RegisteredTool[] {
    return this.registry.getAllWithScope(this.scopeId);
  }

  async getAvailableDefinitions(ctx: ToolContext): Promise<ToolDefinition[]> {
    const available: ToolDefinition[] = [];
    for (const tool of this.getAll()) {
      if (!tool.enabled) continue;
      if (tool.availabilityCheck) {
        const ok = await tool.availabilityCheck(ctx);
        if (!ok) continue;
      }
      available.push(tool.definition);
    }
    return available;
  }

  getHandler(name: string): RegisteredTool["handler"] | undefined {
    return this.registry.getWithScope(this.scopeId, name)?.handler;
  }

  isAvailable(name: string): boolean {
    const tool = this.registry.getWithScope(this.scopeId, name);
    return !!tool && tool.enabled;
  }
}

export const toolRegistry = ToolRegistry.getInstance();
