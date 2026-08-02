/**
 * Hooks 处理器实现
 * 设计依据：Section 3.5 — 11 个 lifecycle handler
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import type { HookHandler } from "../types.js";
import type { Message } from "../types.js";
import { DangerDetector } from "../security/danger-detector.js";
import { PermissionModel } from "../security/permission-model.js";
import { auditLogger } from "../core/audit-logger.js";
import type { SessionStore } from "../memory/session-store.js";
import type { ModelRouter } from "../core/model-router.js";
import { skillEvolution } from "../core/skill-evolution.js";
import type { SkillEvolutionResult } from "../core/skill-evolution.js";

export interface HandlerDependencies {
  dangerDetector?: DangerDetector;
  permissionModel?: PermissionModel;
  sessionStore?: SessionStore;
  modelRouter?: ModelRouter;
  onFileDiff?: (filePath: string, added: number, removed: number, diffText?: string) => void;
}

/**
 * dangerousCommandBlock — 拦截 `rm -rf` 等危险命令
 */
export function createDangerousCommandBlock(deps: HandlerDependencies): HookHandler {
  const detector = deps.dangerDetector ?? new DangerDetector();
  return async (ctx) => {
    const { args } = ctx.data;
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
    if (ctx.event !== "onToolCallPre") return;
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

// ── Phase 3 Handlers ──

/**
 * sensitiveDataFilter — 敏感信息脱敏
 * 在工具调用和用户消息中检测 API Key、私钥等敏感信息并拦截
 * Hook 事件: onToolCallPre, onMessage
 */
export function createSensitiveDataFilter(): HookHandler {
  const patterns: RegExp[] = [
    /sk-[a-zA-Z0-9]{20,}/, // OpenAI / 类 OpenAI API keys
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
    /ghp_[a-zA-Z0-9]{36}/, // GitHub PAT
    /gho_[a-zA-Z0-9]{36}/, // GitHub OAuth
    /xox[bpras]-[a-zA-Z0-9-]+/, // Slack tokens
    /AKIA[0-9A-Z]{16}/, // AWS access key
    /(password|passwd|pwd)\s*[:=]\s*\S+/i,
    /(api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  ];

  return async (ctx) => {
    let input = "";

    if (ctx.event === "onToolCallPre") {
      const toolName = ctx.data.toolName as string;
      if (toolName === "terminal_exec" || toolName === "fs_write") {
        input = typeof ctx.data.args === "string" ? ctx.data.args : JSON.stringify(ctx.data.args ?? {});
      }
    }

    if (ctx.event === "onMessage") {
      input = (ctx.data.instruction as string) ?? "";
    }

    if (!input) return;

    for (const pattern of patterns) {
      if (pattern.test(input)) {
        const match = input.match(pattern)?.[0] ?? "";
        const masked = match.length > 8 ? match.slice(0, 4) + "****" + match.slice(-4) : "****";

        return {
          proceed: false,
          message: `检测到敏感信息 (${masked})，已拦截。请使用环境变量或配置文件管理密钥。`,
        };
      }
    }
  };
}

/**
 * autoLoadProjectMemory — 自动加载项目记忆
 * 会话开始时自动扫描项目关键文件注入上下文
 * Hook 事件: onMessage
 */
export function createAutoLoadProjectMemory(deps: HandlerDependencies): HookHandler {
  const loadedSessions = new Map<string, number>(); // sessionId → loadTime

  return async (ctx) => {
    if (ctx.event === "onTaskComplete") {
      loadedSessions.delete(ctx.sessionId);
      return;
    }

    if (ctx.event !== "onMessage") return;
    if (loadedSessions.has(ctx.sessionId)) return;

    const projectFiles = [
      "README.md",
      "package.json",
      "AGENTS.md",
      "CONTRIBUTING.md",
      ".env.example",
      "tsconfig.json",
      "composer.json",
      "Cargo.toml",
      "pyproject.toml",
      "go.mod",
      "Makefile",
      "Dockerfile",
    ];

    const loaded: string[] = [];
    for (const file of projectFiles) {
      try {
        if (!existsSync(file)) continue;
        const content = readFileSync(file, "utf-8");
        loaded.push(`--- ${file} ---\n${content.slice(0, 2000)}`);
      } catch {
        // skip
      }
    }

    if (loaded.length > 0) {
      const combined = loaded.join("\n\n");

      if (deps.sessionStore) {
        deps.sessionStore.saveEpisodic(ctx.sessionId, combined, "项目文件自动加载", 3.0);
      }

      try {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          action: "auto_load_project_memory",
          target: `已加载 ${loaded.length} 个项目文件`,
          result: "success",
          detail: loaded.map((l) => l.split("\n")[0].replace("--- ", "").replace(" ---", "")).join(", "),
        });
      } catch {
        /* ignore */
      }
    }

    loadedSessions.set(ctx.sessionId, Date.now());

    // TTL 清理: 删除 30 分钟以上的条目
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [sid, time] of loadedSessions) {
      if (time < cutoff) loadedSessions.delete(sid);
    }
  };
}

/**
 * confirmHighRisk — Craft 模式高危操作弹确认
 * 执行高危工具前通过 stdin 交互确认
 * Hook 事件: onToolCallPre
 */
export function createConfirmHighRisk(deps: HandlerDependencies): HookHandler {
  return async (ctx) => {
    if (ctx.event !== "onToolCallPre") return;

    const toolName = ctx.data.toolName as string;
    const permissions = ctx.data.permissions as string;

    if (permissions !== "craft") return;
    if (toolName !== "terminal_exec" && toolName !== "fs_write") return;

    const detector = deps.dangerDetector ?? new DangerDetector();
    const input = typeof ctx.data.args === "string" ? ctx.data.args : JSON.stringify(ctx.data.args ?? {});
    const check = detector.check(input);

    // 仅高危或警告级别需要确认
    if (check.level === "safe") return;

    const confirmed = await interactiveConfirm(
      `${check.isDangerous ? "高危" : "注意"}: ${check.message ?? toolName}。是否继续？`,
    );

    if (!confirmed) {
      return { proceed: false, message: "用户取消操作" };
    }
  };
}

/**
 * captureDiff — 文件变更快照
 * 写文件前保存旧内容，写完成后计算并记录 diff
 * 用于审计和潜在的回滚
 * Hook 事件: onToolCallPre (存快照), onToolCallPost (算 diff)
 */
export function createCaptureDiff(deps: HandlerDependencies): HookHandler {
  // session -> (filePath -> oldContent)
  const snapshots = new Map<string, Map<string, string>>();

  return async (ctx) => {
    if (ctx.event === "onTaskComplete") {
      snapshots.delete(ctx.sessionId);
      // TTL 清理: 超过 30 分钟未使用的快照
      return;
    }

    if (ctx.event === "onToolCallPre") {
      const toolName = ctx.data.toolName as string;
      if (toolName !== "fs_write") return;

      const filePath = extractFilePath(ctx.data.args);
      if (!filePath) return;

      let sessionSnap = snapshots.get(ctx.sessionId);
      if (!sessionSnap) {
        sessionSnap = new Map();
        snapshots.set(ctx.sessionId, sessionSnap);
      }

      try {
        if (existsSync(filePath)) {
          sessionSnap.set(filePath, readFileSync(filePath, "utf-8"));
        }
      } catch {
        // 无法读取旧内容，跳过
      }
    }

    if (ctx.event === "onToolCallPost") {
      const toolName = ctx.data.toolName as string;
      if (toolName !== "fs_write") return;

      const result = ctx.data.result as { success: boolean; content: string } | undefined;
      if (!result?.success) return;

      const filePath = extractFilePath(ctx.data.args);
      if (!filePath) return;

      const sessionSnap = snapshots.get(ctx.sessionId);
      const oldContent = sessionSnap?.get(filePath);
      if (oldContent === undefined) return; // 新文件，无 diff

      // 读取新内容
      let newContent: string;
      try {
        newContent = readFileSync(filePath, "utf-8");
      } catch {
        return;
      }

      const diff = computeSimpleDiff(oldContent, newContent);
      if (!diff) return;

      deps.onFileDiff?.(filePath, diff.added, diff.removed, diff.text);

      try {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          action: `file_diff:${filePath}`,
          target: filePath.slice(0, 200),
          result: "success",
          detail: `+${diff.added} -${diff.removed} 行`,
        });
      } catch {
        /* ignore */
      }

      // 也保存快照到磁盘
      try {
        const snapDir = resolve(process.cwd(), "data", "snapshots", ctx.sessionId);
        mkdirSync(snapDir, { recursive: true });
        const safeName = filePath.replace(/[^a-zA-Z0-9_\-./\\]/g, "_").replace(/[/\\]/g, "_");
        writeFileSync(
          resolve(snapDir, `${safeName}.diff`),
          `${diff.text}\n---\nold: ${oldContent.length} chars\nnew: ${newContent.length} chars`,
          "utf-8",
        );
      } catch {
        // 静默失败
      }
    }
  };
}

// ── Phase 4 Handler ──

/**
 * evaluateSkillCreation — 复杂任务后评估是否沉淀技能
 * 当任务复杂度超过阈值时自动创建 SKILL.md 候选
 * Hook 事件: onTaskComplete
 */
export function createEvaluateSkillCreation(deps: HandlerDependencies): HookHandler {
  const cooldownTrack = new Map<string, number>();

  return async (ctx) => {
    if (ctx.event !== "onTaskComplete") return;

    const iterations = (ctx.data.iterations as number) ?? 0;
    const toolCalls = (ctx.data.toolCallsExecuted as number) ?? 0;
    const truncated = (ctx.data.truncated as boolean) ?? false;

    if (iterations < 3 || toolCalls < 3 || truncated) return;

    const now = Date.now();
    const last = cooldownTrack.get(ctx.agentId);
    if (last && now - last < 20 * 60 * 1000) return;
    cooldownTrack.set(ctx.agentId, now);

    const modelRouter = deps.modelRouter;
    const messages = ctx.data.messages as Message[] | undefined;

    try {
      let result: SkillEvolutionResult | null = null;

      if (modelRouter && messages && messages.length > 0) {
        result = await skillEvolution.evolveV2(ctx.agentId, messages, modelRouter);
      } else {
        // Fallback to template-based generation
        result = skillEvolution.evolve(ctx.agentId, ctx.sessionId, iterations, toolCalls);
      }

      if (result && result.registered) {
        stdout.write(`\n${chalk.green(`✓ 新技能沉淀: ${result.name} (${result.score}★)`)}\n`);
      }

      auditLogger.log({
        timestamp: Date.now(),
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        action: "evaluate_skill_creation",
        target: result?.name ?? "unknown",
        result: "success",
        detail: `score=${result?.score ?? 0}, registered=${result?.registered ?? false}, iterations=${iterations}, toolCalls=${toolCalls}`,
      });
    } catch {
      // 静默失败，不阻塞主流程
    }
  };
}

// ── 监控日志 Handler (M4) ──

/** per-session turn counter */
const turnSeq = new Map<string, number>();

export function createTurnLogger(deps: HandlerDependencies): HookHandler {
  const store = deps.sessionStore;
  if (!store)
    return async () => {
      /* no-op */
    };

  return async (ctx) => {
    if (ctx.event !== "onTaskComplete") return;

    const seq = (turnSeq.get(ctx.sessionId) ?? 0) + 1;
    turnSeq.set(ctx.sessionId, seq);

    const messages = ctx.data.messages as Message[] | undefined;
    const userInput = messages?.find((m) => m.role === "user")?.content.slice(0, 500) ?? "";

    // Count tool successes/failures from messages (assistant tool_calls vs. tool results)
    const toolCallsTotal = (ctx.data.toolCallsExecuted as number) ?? 0;
    let toolCallsSuccess = 0;
    let toolCallsFailed = 0;
    if (messages) {
      for (const m of messages) {
        if (m.role === "tool") {
          const isError = m.content.startsWith("Error:");
          if (isError) toolCallsFailed++;
          else toolCallsSuccess++;
        }
      }
      if (toolCallsSuccess + toolCallsFailed === 0) {
        toolCallsSuccess = toolCallsTotal;
      }
    } else {
      toolCallsSuccess = toolCallsTotal;
    }

    try {
      store.createTurnLog({
        id: randomUUID(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        seq,
        userInput,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        iterations: (ctx.data.iterations as number) ?? 0,
        toolCallsTotal,
        toolCallsSuccess,
        toolCallsFailed,
        tokensPrompt: deps.modelRouter?.getPromptTokens() ?? 0,
        tokensCompletion: deps.modelRouter?.getCompletionTokens() ?? 0,
        finishReason: ctx.data.truncated ? "length" : "stop",
      });
    } catch {
      /* ignore */
    }
  };
}

export function createToolCallLogger(deps: HandlerDependencies): HookHandler {
  const store = deps.sessionStore;
  if (!store)
    return async () => {
      /* no-op */
    };

  let callStart = 0;

  return async (ctx) => {
    if (ctx.event === "onToolCallPre") {
      callStart = Date.now();
      return;
    }

    if (ctx.event !== "onToolCallPost") return;

    const toolName = (ctx.data.toolName as string) ?? "";
    const args = typeof ctx.data.args === "string" ? ctx.data.args : JSON.stringify(ctx.data.args ?? {});
    const result = ctx.data.result as { success: boolean; content: string } | undefined;

    try {
      store.createToolCallLog({
        id: randomUUID(),
        turnId: ctx.sessionId,
        toolName,
        iteration: (ctx.data.iteration as number) ?? 0,
        args: args.slice(0, 2000),
        startedAt: callStart || Date.now(),
        durationMs: callStart ? Date.now() - callStart : 0,
        success: result?.success ?? true,
        resultPreview: (result?.content ?? "").slice(0, 500),
      });
    } catch {
      /* ignore */
    }
  };
}

// ── 工具函数 ──

async function interactiveConfirm(message: string): Promise<boolean> {
  // 临时退出 raw mode 进行交互确认
  const rawMode = typeof stdin.setRawMode === "function";
  if (rawMode) stdin.setRawMode(false);
  stdin.resume();

  return new Promise((resolve) => {
    stdout.write(`\n⚠️  ${message} [y/N] `);

    const handler = (data: Buffer) => {
      const input = data.toString("utf-8").trim().toLowerCase();
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");
      resolve(input === "y" || input === "yes");
    };

    stdin.once("data", handler);

    // 超时安全阀（10 秒后自动拒绝）
    setTimeout(() => {
      stdin.removeListener("data", handler);
      if (rawMode) stdin.setRawMode(true);
      stdout.write("\n");
      resolve(false);
    }, 10000);
  });
}

function extractFilePath(args: unknown): string | null {
  const parsed = typeof args === "string" ? tryParseJson(args) : args;
  if (parsed && typeof parsed === "object" && "path" in parsed) {
    return resolve(String((parsed as Record<string, unknown>).path));
  }
  return null;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function computeSimpleDiff(oldText: string, newText: string): { added: number; removed: number; text: string } | null {
  if (oldText === newText) return null;

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let added = 0;
  let removed = 0;

  // 简单逐行比较
  const maxLen = Math.max(oldLines.length, newLines.length);
  const diffLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      diffLines.push(`+ ${newLines[i]}`);
      added++;
    } else if (i >= newLines.length) {
      diffLines.push(`- ${oldLines[i]}`);
      removed++;
    } else if (oldLines[i] !== newLines[i]) {
      diffLines.push(`- ${oldLines[i]}`);
      diffLines.push(`+ ${newLines[i]}`);
      added++;
      removed++;
    }
  }

  return { added, removed, text: diffLines.join("\n") };
}
