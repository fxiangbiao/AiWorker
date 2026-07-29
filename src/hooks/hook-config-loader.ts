/**
 * Hook 配置加载器
 * 从 config/hooks.json 加载声明式配置并注册到 hookManager
 */

import { readFileSync } from "node:fs";
import { hookManager } from "./hook-manager.js";
import type { HookEvent } from "../types.js";
import {
  createDangerousCommandBlock,
  createPermissionCheck,
  createAuditLog,
  createUpdateMemory,
  createRetryWithBackoff,
  createFallbackModel,
  createSensitiveDataFilter,
  createAutoLoadProjectMemory,
  createConfirmHighRisk,
  createCaptureDiff,
  createEvaluateSkillCreation,
  type HandlerDependencies,
} from "./handlers.js";

interface HookEntry {
  handler: string;
  tools?: string[];
  options?: Record<string, unknown>;
}

interface HooksConfig {
  onMessage?: HookEntry[];
  onToolCallPre?: HookEntry[];
  onToolCallPost?: HookEntry[];
  onTaskComplete?: HookEntry[];
  onError?: HookEntry[];
}

const handlerFactories: Record<string, (deps: HandlerDependencies) => import("../types.js").HookHandler | null> = {
  dangerousCommandBlock: (deps) => createDangerousCommandBlock(deps),
  permissionCheck: (deps) => createPermissionCheck(deps),
  auditLog: (deps) => createAuditLog(deps),
  updateMemory: (deps) => createUpdateMemory(deps),
  retryWithBackoff: (deps) => createRetryWithBackoff(deps),
  fallbackModel: (deps) => createFallbackModel(deps),
  sensitiveDataFilter: () => createSensitiveDataFilter(),
  autoLoadProjectMemory: (deps) => createAutoLoadProjectMemory(deps),
  confirmHighRisk: (deps) => createConfirmHighRisk(deps),
  captureDiff: (deps) => createCaptureDiff(deps),
  evaluateSkillCreation: (deps) => createEvaluateSkillCreation(deps),
};

export function loadHooksFromConfig(configPath: string, deps: HandlerDependencies): number {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return 0;
  }

  const config = JSON.parse(raw) as HooksConfig;
  let registered = 0;

  const eventEntries: [HookEvent, HookEntry[] | undefined][] = [
    ["onMessage", config.onMessage],
    ["onToolCallPre", config.onToolCallPre],
    ["onToolCallPost", config.onToolCallPost],
    ["onTaskComplete", config.onTaskComplete],
    ["onError", config.onError],
  ];

  for (const [event, entries] of eventEntries) {
    if (!entries) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const factory = handlerFactories[entry.handler];
      if (!factory) continue;

      const handler = factory(deps);
      if (!handler) continue;

      hookManager.on(event, handler, {
        id: `${event}:${entry.handler}`,
        priority: i,
      });
      registered++;
    }
  }

  return registered;
}
