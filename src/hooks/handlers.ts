/**
 * Hooks 处理器实现
 * 设计依据：Section 3.5 — 11 个 lifecycle handler
 */

import type { HookHandler } from "../types.js";
import { DangerDetector } from "../security/danger-detector.js";
import { PermissionModel } from "../security/permission-model.js";
import { auditLogger } from "../core/audit-logger.js";
import type { SessionStore } from "../memory/session-store.js";
import type { ModelRouter } from "../core/model-router.js";

export interface HandlerDependencies {
  dangerDetector?: DangerDetector;
  permissionModel?: PermissionModel;
  sessionStore?: SessionStore;
  modelRouter?: ModelRouter;
}

/**
 * dangerousCommandBlock — 拦截 `rm -rf` 等危险命令
 */
export function createDangerousCommandBlock(deps: HandlerDependencies): HookHandler {
  const detector = deps.dangerDetector ?? new DangerDetector();
  return async (ctx) => {
    const { toolName, args } = ctx.data;
    const input = typeof args === "string" ? args : JSON.stringify(args);
    const check = detector.check(input);
    if (check.isDangerous) {
      return { proceed: false, message: check.message };
    }
  };
}

/**
 * permissionCheck — 基于 PermissionModel 检查是否允许工具调用
 */
export function createPermissionCheck(deps: HandlerDependencies): HookHandler {
  return async (ctx) => {
    if (!deps.permissionModel) return;
    if (!deps.permissionModel.allowsToolCalls()) {
      return { proceed: false, message: "当前权限模式不允许工具调用" };
    }
  };
}

/**
 * auditLog — 记录工具调用到审计日志
 */
export function createAuditLog(_deps: HandlerDependencies): HookHandler {
  return async (ctx) => {
    const { toolName, args, result } = ctx.data;
    auditLogger.log({
      timestamp: Date.now(),
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      action: String(toolName ?? "unknown"),
      target: JSON.stringify(args ?? {}).slice(0, 200),
      result: result ? "success" : "error",
      detail: "",
    });
  };
}

/**
 * updateMemory — 任务完成后持久化会话摘要
 */
export function createUpdateMemory(deps: HandlerDependencies): HookHandler {
  return async (_ctx) => {
    if (!deps.sessionStore) return;
    // 记忆更新在 base-agent.ts 的 summarizeSession() 中处理
    // 此 hook 作为预留扩展点
  };
}

/**
 * retryWithBackoff — 指数退避重试策略
 */
export function createRetryWithBackoff(_deps: HandlerDependencies): HookHandler {
  return async (ctx) => {
    const error = ctx.data.error as Error | undefined;
    if (!error) return;
    // 无需操作：底层错误通过 onError hook 标记
    // 重试逻辑在 agent-loop 层处理，此处为意图标记
    ctx.data._shouldRetry = true;
  };
}

/**
 * fallbackModel — 失败时切换到备用模型
 */
export function createFallbackModel(deps: HandlerDependencies): HookHandler {
  return async (ctx) => {
    if (!deps.modelRouter) return;
    // 标记降级意图，由 agent-loop 或调用方处理
    ctx.data._fallbackTriggered = true;
  };
}

// ── Stub handlers (未来 Sprint 实现) ──

/**
 * sensitiveDataFilter — 敏感信息脱敏 (stub)
 */
export function createSensitiveDataFilter(): HookHandler {
  return async () => { /* Phase 3 */ };
}

/**
 * autoLoadProjectMemory — 自动加载项目记忆 (stub)
 */
export function createAutoLoadProjectMemory(): HookHandler {
  return async () => { /* Phase 3 */ };
}

/**
 * confirmHighRisk — Craft 模式高危操作弹确认 (stub)
 */
export function createConfirmHighRisk(): HookHandler {
  return async () => { /* Phase 3 */ };
}

/**
 * captureDiff — 文件变更快照 (stub)
 */
export function createCaptureDiff(): HookHandler {
  return async () => { /* Phase 3 */ };
}

/**
 * evaluateSkillCreation — 复杂任务后评估是否沉淀技能 (stub)
 */
export function createEvaluateSkillCreation(): HookHandler {
  return async () => { /* Phase 4 */ };
}
