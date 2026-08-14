/**
 * 适配器注册表 — 单例，按 id 解析 LlmAdapter
 * 设计依据：对比报告借鉴点 #6；单例约定与 ToolRegistry 一致
 */

import type { LlmAdapter } from "./llm-adapter.js";
import { openaiCompatibleAdapter } from "./openai-compatible.js";

const FALLBACK_ID = "openai-compatible";

class AdapterRegistry {
  private static instance: AdapterRegistry;
  private adapters = new Map<string, LlmAdapter>();

  static getInstance(): AdapterRegistry {
    if (!AdapterRegistry.instance) {
      AdapterRegistry.instance = new AdapterRegistry();
      AdapterRegistry.instance.register(openaiCompatibleAdapter);
    }
    return AdapterRegistry.instance;
  }

  register(adapter: LlmAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  /** 未知 id 降级 openai-compatible（与 modelPreference 白名单降级 default 的既有约定一致） */
  resolve(id: string | undefined): LlmAdapter {
    if (id && this.adapters.has(id)) return this.adapters.get(id)!;
    return this.adapters.get(FALLBACK_ID) ?? openaiCompatibleAdapter;
  }
}

export const adapterRegistry = AdapterRegistry.getInstance();
