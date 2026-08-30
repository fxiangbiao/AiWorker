/**
 * Hooks 处理器实现
 * 设计依据：Section 3.5 — 11 个 lifecycle handler
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { resolve, isAbsolute, extname } from "node:path";
import { stdout } from "node:process";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import type { HookHandler, PermissionMode } from "../types.js";
import type { Message } from "../types.js";
import { messageText } from "../types.js";
import { DangerDetector } from "../security/danger-detector.js";
import { PermissionModel } from "../security/permission-model.js";
import { ApprovalService, type ConfirmRequestLike } from "../security/approval-service.js";
import { auditLogger } from "../core/audit-logger.js";
import { requestConfirm } from "./confirm-channel.js";
import type { SessionStore } from "../memory/session-store.js";
import type { ModelRouter } from "../core/model-router.js";
import { skillEvolution } from "../core/skill-evolution.js";
import type { SkillEvolutionResult } from "../core/skill-evolution.js";
import type { TelemetryCoordinator } from "../memory/telemetry.js";

export interface HandlerDependencies {
  dangerDetector?: DangerDetector;
  permissionModel?: PermissionModel;
  /** 审批服务（统一权限决策单点；缺省时由各 handler 按 deps 自建） */
  approval?: ApprovalService;
  sessionStore?: SessionStore;
  modelRouter?: ModelRouter;
  workingDir?: string;
  dataDir?: string;
  telemetry?: TelemetryCoordinator;
  onFileDiff?: (filePath: string, added: number, removed: number, diffText?: string) => void;
  /** 指纹扫描会话级节流间隔（ms），默认 2000；测试可注入 0 关闭 */
  scanThrottleMs?: number;
}

/** 获取审批服务：优先注入实例，否则按 deps 自建（确认走 requestConfirm，保证行为等价） */
function getApproval(deps: HandlerDependencies): ApprovalService {
  return (
    deps.approval ??
    new ApprovalService({
      permissionModel: deps.permissionModel,
      dangerDetector: deps.dangerDetector,
      workingDir: deps.workingDir,
      confirm: (req: ConfirmRequestLike) => requestConfirm(req.message, req.options, req.title),
    })
  );
}

/**
 * dangerousCommandBlock — 拦截 `rm -rf` 等危险命令
 * - ask: 直接拦截（只警告，不放行）
 * - plan/auto: 放行，由 confirmHighRisk 弹确认卡片让用户决定
 * 委托 ApprovalService.checkCommandBlock（审批决策单点）
 */
export function createDangerousCommandBlock(deps: HandlerDependencies): HookHandler {
  const approval = getApproval(deps);
  return async (ctx) => {
    const { args } = ctx.data;
    const input = typeof args === "string" ? args : JSON.stringify(args);
    const mode = (ctx.data.permissions as PermissionMode) || deps.permissionModel?.getMode() || "auto";
    const decision = approval.checkCommandBlock(input, mode);
    if (!decision.proceed) {
      return { proceed: false, message: decision.message };
    }
  };
}

/**
 * permissionCheck — 基于 ApprovalService 检查是否允许工具调用
 */
export function createPermissionCheck(deps: HandlerDependencies): HookHandler {
  const approval = getApproval(deps);
  return async (ctx) => {
    if (ctx.event !== "onToolCallPre") return;

    const mode = (ctx.data.permissions as PermissionMode) || deps.permissionModel?.getMode() || "auto";
    const toolName = ctx.data.toolName as string;
    const decision = approval.checkPermission(toolName, mode);
    if (!decision.proceed) {
      return { proceed: false, message: decision.message };
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
      // 写类工具（fs_write / fs_edit 的 newText 都能向文件写入敏感信息）统一检测
      if (toolName === "terminal_exec" || toolName === "terminal_session" || toolName === "fs_write" || toolName === "fs_edit") {
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
 * redactTelemetry — 遥测导出脱敏（onTelemetryRecord）
 * 只作用于导出副本（SessionTelemetryRecord），权威 session_events 日志永不改写
 */
export function createTelemetryRedact(): HookHandler {
  const mask = (s: string): string =>
    s
      .replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-****")
      .replace(
        /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
        "-----BEGIN PRIVATE KEY-----*****-----END PRIVATE KEY-----",
      )
      .replace(/(api[_-]?key|apikey|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']+/gi, "$1=****");

  const redactDeep = (value: unknown): unknown => {
    if (typeof value === "string") return mask(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactDeep(v);
      }
      return out;
    }
    return value;
  };

  return async (ctx) => {
    if (ctx.event !== "onTelemetryRecord") return;
    const record = ctx.data.record as import("../types.js").SessionTelemetryRecord | undefined;
    if (!record) return;

    const redacted: import("../types.js").SessionTelemetryRecord = {
      ...record,
      attributes: Object.fromEntries(
        Object.entries(record.attributes).map(([k, v]) => [k, typeof v === "string" ? mask(v) : v]),
      ),
      body: redactDeep(record.body),
    };
    return { proceed: true, modifiedData: { record: redacted } };
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
    // 项目文件基准 = 工作目录（--dir），而非进程 cwd（与本批目录合并语义一致）
    const projectBase = deps.workingDir ? resolve(deps.workingDir) : process.cwd();
    for (const file of projectFiles) {
      try {
        const full = resolve(projectBase, file);
        if (!existsSync(full)) continue;
        const content = readFileSync(full, "utf-8");
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
 * confirmHighRisk — Auto 模式高危操作弹确认
 * 执行高危工具前通过确认通道（CLI stdin / HTTP 前端确认卡片）交互确认
 * 委托 ApprovalService.checkConfirmation（决策单点）
 * Hook 事件: onToolCallPre
 */
export function createConfirmHighRisk(deps: HandlerDependencies): HookHandler {
  const approval = getApproval(deps);
  return async (ctx) => {
    if (ctx.event !== "onToolCallPre") return;

    const toolName = ctx.data.toolName as string;
    const permissions = ctx.data.permissions as string;

    const decision = await approval.checkConfirmation(toolName, ctx.data.args, permissions as PermissionMode);
    if (!decision.proceed) {
      return { proceed: false, message: decision.message ?? "用户取消操作" };
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
  // session -> (filePath -> {mtimeMs, size}) 工作目录指纹（覆盖 terminal_exec/MCP 等任意写入）
  const dirSnapshots = new Map<string, Map<string, { mtimeMs: number; size: number }>>();
  // session -> Set<filePath> 已由 fs_write 精确逻辑处理的路径（目录指纹对比时跳过，防重复）
  const fsWritePaths = new Map<string, Set<string>>();
  // session -> 上次实际扫描时间戳（节流：避免一轮内多次写工具调用反复全量扫描）
  const lastScanAt = new Map<string, number>();
  const scanThrottleMs = deps.scanThrottleMs ?? SCAN_THROTTLE_MS;
  const projectBase = deps.workingDir ? resolve(deps.workingDir) : process.cwd();
  const dataBase = deps.dataDir ? resolve(deps.dataDir) : resolve(process.cwd(), "data");

  return async (ctx) => {
    if (ctx.event === "onTaskComplete") {
      snapshots.delete(ctx.sessionId);
      dirSnapshots.delete(ctx.sessionId);
      fsWritePaths.delete(ctx.sessionId);
      lastScanAt.delete(ctx.sessionId);
      // TTL 清理: 超过 30 分钟未使用的快照
      return;
    }

    if (ctx.event === "onToolCallPre") {
      const toolName = ctx.data.toolName as string;
      if (toolName !== "fs_write" && toolName !== "fs_edit") return;

      const filePath = extractFilePath(ctx.data.args, projectBase);
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

      // ── 工作目录指纹监控：仅在"可能写文件的工具"（terminal_exec/MCP/插件等）调用后触发；
      //    只读工具（web_search/fs_read 等）不扫描；fs_write 走下方精确快照逻辑 ──
      if (MAY_WRITE_TOOL.test(toolName) && toolName !== "fs_write" && toolName !== "fs_edit" && projectBase !== process.cwd()) {
        // 会话级节流：间隔内同一会话不重复全量扫描（变化由下次扫描兜底捕获）
        const now = Date.now();
        const last = lastScanAt.get(ctx.sessionId) ?? 0;
        if (now - last >= scanThrottleMs) {
          lastScanAt.set(ctx.sessionId, now);
          const current = scanDirFingerprint(projectBase);
          const prev = dirSnapshots.get(ctx.sessionId);
          if (prev) {
            for (const [absPath, info] of current) {
              const old = prev.get(absPath);
              const existedBefore = old !== undefined;
              const changed = !existedBefore || old.mtimeMs !== info.mtimeMs || old.size !== info.size;
              if (!changed) continue;
              // 已由 fs_write 精确逻辑处理的路径跳过，避免重复记录
              if (fsWritePaths.get(ctx.sessionId)?.has(absPath)) continue;
              const added = existedBefore ? 0 : newFileLineCount(absPath);
              const removed = 0;
              const diffText = existedBefore
                ? `内容已变化（旧内容不可恢复）：${absPath}`
                : `新增文件（${added} 行）：${absPath}`;
              recordDirDiff(ctx, deps, dataBase, absPath, added, removed, diffText, existedBefore);
            }
            // 反向对比：prev 存在但 current 缺失 → 文件被删除
            for (const absPath of prev.keys()) {
              if (current.has(absPath)) continue;
              // 已由 fs_write 精确逻辑处理的路径跳过，避免重复记录
              if (fsWritePaths.get(ctx.sessionId)?.has(absPath)) continue;
              const diffText = `文件已删除：${absPath}`;
              recordDirDiff(ctx, deps, dataBase, absPath, 0, 0, diffText, true, true);
            }
          }
          dirSnapshots.set(ctx.sessionId, current);
        }
      }

      // ── fs_write / fs_edit 精确快照逻辑（行级 diff，含删除行） ──
      if (toolName !== "fs_write" && toolName !== "fs_edit") return;

      const result = ctx.data.result as { success: boolean; content: string } | undefined;
      if (!result?.success) return;

      const filePath = extractFilePath(ctx.data.args, projectBase);
      if (!filePath) return;

      // 仅在成功写入后才标记指纹去重（失败/被拦截的调用不占用，
      // 否则后续 terminal_exec 等对该文件的改动会被误跳过 diff）
      let written = fsWritePaths.get(ctx.sessionId);
      if (!written) {
        written = new Set();
        fsWritePaths.set(ctx.sessionId, written);
      }
      written.add(filePath);

      const sessionSnap = snapshots.get(ctx.sessionId);
      const oldContent = sessionSnap?.get(filePath);

      // 读取新内容
      let newContent: string;
      try {
        newContent = readFileSync(filePath, "utf-8");
      } catch {
        return;
      }

      let added: number;
      let removed: number;
      let diffText: string;

      if (oldContent !== undefined) {
        const diff = computeSimpleDiff(oldContent, newContent);
        if (!diff) return;
        added = diff.added;
        removed = diff.removed;
        diffText = diff.text;
      } else {
        // 新文件：无旧内容，added = 新文件行数
        added = newContent.split("\n").filter((l) => l.length > 0).length;
        removed = 0;
        diffText = newContent
          .split("\n")
          .map((l) => `+ ${l}`)
          .join("\n");
      }
      try {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          action: `file_diff:${filePath}`,
          target: filePath.slice(0, 200),
          result: "success",
          detail: `+${added} -${removed} 行`,
        });
      } catch {
        /* ignore */
      }

      deps.onFileDiff?.(filePath, added, removed, diffText);

      writeDiffSnapshot(dataBase, ctx.sessionId, filePath, diffText, oldContent, newContent);
    }
  };
}

/**
 * recordDirDiff — 输出目录指纹监控发现的变更，写审计 + 磁盘快照 + onFileDiff 回调
 */
function recordDirDiff(
  ctx: import("../types.js").HookContext,
  deps: HandlerDependencies,
  dataBase: string,
  filePath: string,
  added: number,
  removed: number,
  diffText: string,
  /** 变更前文件已存在（无旧内容，行级 diff 不可得，标记 modified 供前端区分） */
  modified: boolean,
  /** 文件被删除（指纹反向对比发现） */
  deleted = false,
): void {
  try {
    auditLogger.log({
      timestamp: Date.now(),
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      action: `file_diff:${filePath}`,
      target: filePath.slice(0, 200),
      result: "success",
      detail: deleted ? "已删除" : `+${added} -${removed} 行`,
    });
  } catch {
    /* ignore */
  }

  deps.onFileDiff?.(filePath, added, removed, diffText);

  // 文件已删除：无新内容可读，仅写元信息快照
  if (deleted) {
    writeDeletedDiffSnapshot(dataBase, ctx.sessionId, filePath, diffText);
    return;
  }

  // 内容不可展示（二进制/大文件）→ 仅元信息快照（不读全文、不 base64）
  if (!isDisplayableText(filePath)) {
    writeBinaryDiffSnapshot(dataBase, ctx.sessionId, filePath, diffText, modified);
    return;
  }

  // 文本文件：读取当前新内容随快照落盘，前端可展示"当前内容"
  let newContent: string | undefined;
  try {
    newContent = readFileSync(filePath, "utf-8");
  } catch {
    /* 读取失败则不带新内容 */
  }
  writeDiffSnapshot(dataBase, ctx.sessionId, filePath, diffText, undefined, newContent, modified);
}

/** 将 diff 快照写入磁盘 */
function writeDiffSnapshot(
  dataBase: string,
  sessionId: string,
  filePath: string,
  diffText: string,
  oldContent: string | undefined,
  newContent: string | undefined,
  modified = false,
): void {
  try {
    const snapDir = resolve(dataBase, "snapshots", sessionId);
    mkdirSync(snapDir, { recursive: true });
    const safeName = filePath.replace(/[^a-zA-Z0-9_\-./\\]/g, "_").replace(/[/\\]/g, "_");
    const meta = `old: ${oldContent?.length ?? 0} chars\nnew: ${newContent?.length ?? 0} chars`;
    // 无行级 diff（指纹监控场景）时附新内容全文（base64 防格式破坏），前端展示"当前内容"
    const newB64 = newContent ? `\nnew_b64: ${Buffer.from(newContent, "utf-8").toString("base64")}` : "";
    const modFlag = modified ? "\nmodified: 1" : "";
    writeFileSync(
      resolve(snapDir, `${safeName}.diff`),
      `# path: ${filePath}\n${diffText}\n---\n${meta}${newB64}${modFlag}`,
      "utf-8",
    );
  } catch {
    // 静默失败
  }
}

/** 二进制/不可展示内容文件：仅写元信息快照（不读全文、不 base64），前端显示"不可预览" */
function writeBinaryDiffSnapshot(dataBase: string, sessionId: string, filePath: string, diffText: string, modified = false): void {
  try {
    const snapDir = resolve(dataBase, "snapshots", sessionId);
    mkdirSync(snapDir, { recursive: true });
    const safeName = filePath.replace(/[^a-zA-Z0-9_\-./\\]/g, "_").replace(/[/\\]/g, "_");
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      /* 文件可能已被删除 */
    }
    const modFlag = modified ? "\nmodified: 1" : "";
    writeFileSync(
      resolve(snapDir, `${safeName}.diff`),
      `# path: ${filePath}\n${diffText}\n---\nbinary: 1\nsize: ${size}${modFlag}`,
      "utf-8",
    );
  } catch {
    // 静默失败
  }
}

/** 文件删除快照：仅元信息（deleted: 1），无内容可读 */
function writeDeletedDiffSnapshot(dataBase: string, sessionId: string, filePath: string, diffText: string): void {
  try {
    const snapDir = resolve(dataBase, "snapshots", sessionId);
    mkdirSync(snapDir, { recursive: true });
    const safeName = filePath.replace(/[^a-zA-Z0-9_\-./\\]/g, "_").replace(/[/\\]/g, "_");
    writeFileSync(
      resolve(snapDir, `${safeName}.diff`),
      `# path: ${filePath}\n${diffText}\n---\ndeleted: 1`,
      "utf-8",
    );
  } catch {
    // 静默失败
  }
}

/** 指纹监控触发白名单：可能写文件的工具（terminal_exec / MCP / 插件工具） */
const MAY_WRITE_TOOL = /^(terminal_exec|terminal_session|mcp_|plugin_)/;

/** 指纹扫描会话级节流间隔（ms）：同一会话两次全量扫描至少间隔此值 */
const SCAN_THROTTLE_MS = 2000;

/** 跳过扫描的目录（机器生成/缓存/依赖，变更无业务价值） */
const SKIP_DIRS = new Set([
  ".godot",
  "node_modules",
  ".git",
  "dist",
  "web",
  ".svelte-kit",
  ".aiworker_history",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".vite",
]);

/** 内容可展示为文本的扩展名白名单（其余按二进制降级处理） */
const TEXT_EXT = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".svelte", ".py",
  ".txt", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".env", ".gitignore", ".sh",
  ".bat", ".ps1", ".tsx", ".jsx", ".svg", ".xml", ".csv", ".log",
]);

/** 判定文件内容是否可展示为文本（扩展名白名单 或 文件头无 NUL 字节） */
function isDisplayableText(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // 未知扩展名：检查文件头 512 字节是否含 NUL（二进制特征）
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, 512, 0);
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return false;
      }
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false; // 读取失败按不可展示处理
  }
}

/**
 * scanDirFingerprint — 递归扫描目录，返回 绝对路径 → {mtimeMs, size}
 * 跳过机器生成的缓存/依赖/产物目录（SKIP_DIRS），仅覆盖输出目录内用户关心的文件
 */
function scanDirFingerprint(root: string): Map<string, { mtimeMs: number; size: number }> {
  const result = new Map<string, { mtimeMs: number; size: number }>();
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          walk(full);
        } else if (e.isFile()) {
          const st = statSync(full);
          result.set(full, { mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
        /* ignore */
      }
    }
  };
  walk(root);
  return result;
}

/** 新增文件行数（非空行） */
function newFileLineCount(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
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
/** per-session turn start time + token baseline（onMessage 记录，onTaskComplete 结算） */
const turnStart = new Map<string, { at: number; prompt: number; completion: number }>();
/** per-session 错误标记：onError 置位，onTaskComplete 结算时避免 token 虚增与 reason 错标 */
const turnError = new Map<string, boolean>();

export function createTurnLogger(deps: HandlerDependencies): HookHandler {
  const store = deps.sessionStore;
  if (!store)
    return async () => {
      /* no-op */
    };

  return async (ctx) => {
    // 任务开始：记录开始时间与 token 基线
    if (ctx.event === "onMessage") {
      turnStart.set(ctx.sessionId, {
        at: Date.now(),
        prompt: deps.modelRouter?.getPromptTokens() ?? 0,
        completion: deps.modelRouter?.getCompletionTokens() ?? 0,
      });
      turnError.delete(ctx.sessionId);
      const turn = (turnSeq.get(ctx.sessionId) ?? 0) + 1;
      try {
        store.appendEvent(ctx.sessionId, "turn/start", { turn }, "hooks");
      } catch {
        /* 事件失败不阻塞主流程 */
      }
      return;
    }
    // 出错时清理未结算的轮次起点，并标记该轮为错误（防 onTaskComplete 虚增 token / 错标 reason）
    if (ctx.event === "onError") {
      turnStart.delete(ctx.sessionId);
      turnError.set(ctx.sessionId, true);
      return;
    }
    if (ctx.event !== "onTaskComplete") return;

    const start = turnStart.get(ctx.sessionId);
    const hadError = turnError.get(ctx.sessionId) ?? false;
    turnError.delete(ctx.sessionId);
    const startedAt = start?.at ?? Date.now();
    const finishedAt = Date.now();
    const tokensPromptNow = deps.modelRouter?.getPromptTokens() ?? 0;
    const tokensCompletionNow = deps.modelRouter?.getCompletionTokens() ?? 0;
    // 当轮 token = 本次完成时刻 − 轮开始时刻基线（避免累计值直接入库）；
    // 错误轮次（onError 已删基线）无法差分，置 0 防把全会话 token 记到本轮
    const tokensPrompt = hadError ? 0 : Math.max(0, tokensPromptNow - (start?.prompt ?? 0));
    const tokensCompletion = hadError ? 0 : Math.max(0, tokensCompletionNow - (start?.completion ?? 0));
    turnStart.delete(ctx.sessionId);

    const seq = (turnSeq.get(ctx.sessionId) ?? 0) + 1;
    turnSeq.set(ctx.sessionId, seq);

    const messages = ctx.data.messages as Message[] | undefined;
    // 取本轮最后一条 user 消息（assembleContext 含历史，find 会取到最早一条）
    const userInput = messages?.filter((m) => m.role === "user").at(-1) ? messageText(messages.filter((m) => m.role === "user").at(-1)!).slice(0, 500) : "";

    // 结束原因：截断 → length；错误轮 → error；否则 stop
    const finishReason: string = ctx.data.truncated ? "length" : hadError ? "error" : "stop";

    // Count tool successes/failures from messages (assistant tool_calls vs. tool results)
    const toolCallsTotal = (ctx.data.toolCallsExecuted as number) ?? 0;
    let toolCallsSuccess = 0;
    let toolCallsFailed = 0;
    if (messages) {
      for (const m of messages) {
        if (m.role === "tool") {
          const isError = messageText(m).startsWith("Error:");
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
        startedAt,
        finishedAt,
        iterations: (ctx.data.iterations as number) ?? 0,
        toolCallsTotal,
        toolCallsSuccess,
        toolCallsFailed,
        tokensPrompt,
        tokensCompletion,
        finishReason,
      });
      store.appendEvent(
        ctx.sessionId,
        "turn/end",
        { turn: seq, reason: finishReason },
        "hooks",
      );
      // 轮次结算后：捕获遥测（从事件流派生，非阻塞；失败不影响主流程）
      if (deps.telemetry) {
        const events = store.getEvents(ctx.sessionId);
        await deps.telemetry.capture(ctx.sessionId, events).catch(() => {});
      }
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

function extractFilePath(args: unknown, baseDir?: string): string | null {
  const parsed = typeof args === "string" ? tryParseJson(args) : args;
  if (parsed && typeof parsed === "object" && "path" in parsed) {
    const raw = String((parsed as Record<string, unknown>).path);
    return isAbsolute(raw) ? resolve(raw) : resolve(baseDir ?? process.cwd(), raw);
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

/** 按行切分：空文本无行；尾部换行符不产生额外空行（与常见 diff 工具一致） */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** LCS 行 diff（精确行数）；大文件退化为简单逐行比较 */
function computeSimpleDiff(oldText: string, newText: string): { added: number; removed: number; text: string } | null {
  if (oldText === newText) return null;

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // LCS 代价保护：n*m 过大（如大文件/日志）时退化为前缀后缀剥离 + 简单比较
  const MAX_CELLS = 4_000_000;
  if (oldLines.length * newLines.length > MAX_CELLS) {
    return simpleDiffFallback(oldLines, newLines);
  }
  return lcsDiff(oldLines, newLines);
}

/** LCS 行 diff：匹配行跳过，只输出变更行，added/removed 精确 */
function lcsDiff(oldLines: string[], newLines: string[]): { added: number; removed: number; text: string } {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * width + j;
      if (oldLines[i] === newLines[j]) dp[idx] = dp[(i + 1) * width + (j + 1)] + 1;
      else dp[idx] = Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const diffLines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i * width + j] === dp[(i + 1) * width + j]) {
      diffLines.push(`- ${oldLines[i]}`);
      i++;
      removed++;
    } else {
      diffLines.push(`+ ${newLines[j]}`);
      j++;
      added++;
    }
  }
  while (i < n) {
    diffLines.push(`- ${oldLines[i]}`);
    i++;
    removed++;
  }
  while (j < m) {
    diffLines.push(`+ ${newLines[j]}`);
    j++;
    added++;
  }
  return { added, removed, text: diffLines.join("\n") };
}

/** 大文件退化：前缀后缀剥离后剩余部分逐行比较 */
function simpleDiffFallback(oldLines: string[], newLines: string[]): { added: number; removed: number; text: string } {
  // 公共前缀
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  // 公共后缀
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const added = newMid.length;
  const removed = oldMid.length;
  const diffLines = [...oldMid.map((l) => `- ${l}`), ...newMid.map((l) => `+ ${l}`)];
  return { added, removed, text: diffLines.join("\n") };
}
