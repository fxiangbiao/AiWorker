/**
 * 审批服务 — 权限决策单点（对齐 DSH dsh-user-approval 审批瀑布思想）
 * 将散落在 hooks 里的权限判断（permissionCheck / dangerousCommandBlock / confirmHighRisk）
 * 收敛为可独立测试的决策矩阵；无确认通道时默认拒绝（fail-closed）
 */

import { resolve, isAbsolute } from "node:path";
import type { PermissionMode, PermissionRule, PermissionRuleScope } from "../types.js";
import { PermissionModel } from "./permission-model.js";
import { DangerDetector } from "./danger-detector.js";
import { resolveRealPath } from "./path-policy.js";
import { auditLogger } from "../core/audit-logger.js";
import type { PermissionMemory } from "./permission-memory.js";

export interface ConfirmRequestLike {
  title: string;
  message: string;
  options: { value: string; label: string }[];
}

export type ConfirmFn = (req: ConfirmRequestLike) => Promise<string | null>;

export interface ApprovalDecision {
  proceed: boolean;
  message?: string;
}

export interface ApprovalServiceDeps {
  permissionModel?: PermissionModel;
  dangerDetector?: DangerDetector;
  /** 工作目录（fs_write 目标路径解析基准） */
  workingDir?: string;
  /** 确认通道（CLI stdin / HTTP SSE）。缺省时确认类决策默认拒绝（fail-closed） */
  confirm?: ConfirmFn;
  /** 权限记忆（Sprint 49）：提供"始终允许"选项；缺省则只给 允许/拒绝 */
  permissionMemory?: PermissionMemory;
}

export class ApprovalService {
  private permissionModel?: PermissionModel;
  private dangerDetector: DangerDetector;
  private workingDir?: string;
  private confirmFn?: ConfirmFn;
  private memory?: PermissionMemory;

  constructor(deps: ApprovalServiceDeps = {}) {
    this.permissionModel = deps.permissionModel;
    this.dangerDetector = deps.dangerDetector ?? new DangerDetector();
    this.workingDir = deps.workingDir;
    this.confirmFn = deps.confirm;
    this.memory = deps.permissionMemory;
  }

  /**
   * dangerousCommandBlock 语义 — ask 模式高危命令直接拦截
   */
  checkCommandBlock(input: string, mode: PermissionMode): ApprovalDecision {
    const check = this.dangerDetector.check(input);
    if (!check.isDangerous) return { proceed: true };
    if (mode === "ask") {
      return { proceed: false, message: `高危操作被拦截（ask 模式不允许）：${check.message}` };
    }
    return { proceed: true };
  }

  /**
   * permissionCheck 语义 — 权限模式是否允许该工具
   * 显式 deny 规则优先于模式判断（任何模式都拦截）
   */
  checkPermission(toolName: string, mode: PermissionMode, args?: unknown): ApprovalDecision {
    const model = this.permissionModel;
    if (!model) return { proceed: true };
    // 跨进程一致性：外部（CLI/另一个进程）改过规则文件 → 先重载再判定
    this.memory?.refresh();
    const target = extractTarget(toolName, args, this.workingDir);
    const rule = model.evaluateRules(toolName, realTarget(toolName, target));
    if (rule?.action === "deny") {
      return {
        proceed: false,
        message: `规则拒绝（${rule.rule.tool}${rule.rule.match ? `(${rule.rule.match})` : ""}）：不允许执行 ${toolName}`,
      };
    }
    if (!model.allowsToolFor(mode, toolName)) {
      const reason = model.isReadOnly(mode)
        ? `当前权限模式(${mode})为只读，不允许执行工具 ${toolName}`
        : `当前权限模式(${mode})不允许工具调用`;
      return { proceed: false, message: reason };
    }
    return { proceed: true };
  }

  /**
   * confirmHighRisk 语义 — plan 全确认 / auto 高危（terminal_exec / terminal_session / fs_write）确认
   * Sprint 47 叠加：显式 ask 规则、"永不自动批准"清单、受保护路径强制确认；显式 allow 免确认
   * Sprint 49 修复：① 规则与受保护路径按**真实路径**判定（junction 不能绕过 deny/受保护）；
   *                ② allow 规则**不再短路危险检测**，只有交互确认产生的 `exact` 规则或 `--yes` 全量开关可豁免；
   *                ③ terminal_session 纳入危险检测与受保护路径范围
   * 确认被拒或无确认通道（fail-closed）时返回 proceed: false
   */
  async checkConfirmation(
    toolName: string,
    args: unknown,
    mode: PermissionMode,
    actor?: { agentId?: string; sessionId?: string },
  ): Promise<ApprovalDecision> {
    const projectBase = this.workingDir ? resolve(this.workingDir) : process.cwd();
    const model = this.permissionModel;
    this.memory?.refresh();
    if (actor) this.memory?.setActor(actor);
    const target = extractTarget(toolName, args, projectBase);
    const matchTarget = realTarget(toolName, target);
    const rule = model?.evaluateRules(toolName, matchTarget) ?? null;

    if (rule?.action === "deny") {
      return {
        proceed: false,
        message: `规则拒绝（${rule.rule.tool}${rule.rule.match ? `(${rule.rule.match})` : ""}）：不允许执行 ${toolName}`,
      };
    }

    // plan 模式：所有工具调用都确认（保留"先列计划再执行"语义）
    if (mode === "plan") {
      const detail = toolName === "fs_write" || toolName === "fs_edit" ? (target ? `：${target}` : "") : "";
      const ok = await this.confirm(`${toolName} 调用确认`, `执行工具 ${toolName}${detail}？`);
      return ok.proceed ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    const never = model?.isNeverAutoApprove(toolName) ?? false;
    const protectedHit = PROTECTED_TOOLS.has(toolName) && (model?.isProtectedTarget(matchTarget) ?? false);
    const forcedAsk = rule?.action === "ask";
    const dangerTool = DANGER_TOOLS.has(toolName);
    // 豁免危险检测的两种情形：--yes 全量开关（进程内、不落盘）、交互确认产生的精确规则
    const bypassDanger = (model?.isAutoApproveAll() ?? false) || rule?.rule.exact === true;

    // 显式 allow：仅在 auto 模式免确认（ask/plan 的"先确认"语义由模式本身决定，不依赖钩子顺序）
    // 危险相关工具上，非精确 allow 规则不再短路危险检测（否则一条通配 allow 就能永久关掉高危确认）
    if (mode === "auto" && rule?.action === "allow" && !never && !protectedHit && (!dangerTool || bypassDanger)) {
      return { proceed: true };
    }

    const reason = forcedAsk
      ? `规则要求确认（${rule?.rule.tool}${rule?.rule.match ? `(${rule.rule.match})` : ""}）`
      : never
        ? "该工具被配置为永不自动批准"
        : protectedHit
          ? "命中受保护路径"
          : "";

    // ask 模式：写工具已被 checkPermission 拦截；此处仅在强制类规则命中时确认
    if (mode !== "auto") {
      if (!reason) return { proceed: true };
      const ok = await this.confirm(`${toolName} 操作确认`, `${reason}${target ? `：${target}` : ""}。是否继续？`);
      return ok.proceed ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    // auto 模式：强制类规则（ask / never / 受保护路径）→ 确认（按设计始终要问，不提供"记住"）
    if (reason) {
      const ok = await this.confirm(`${toolName} 操作确认`, `${reason}${target ? `：${target}` : ""}。是否继续？`);
      return ok.proceed ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    if (!dangerTool) return { proceed: true };

    // fs_write 只检测目标路径（正则匹配的是命令文本，不能套用在 content 上）
    const input = toolName === "fs_write" ? extractFilePath(args, projectBase) ?? "" : commandText(args);
    const check = this.dangerDetector.check(input);
    if (check.level === "safe") return { proceed: true };

    // 高危确认可被"始终允许"记住：目标串作为**精确** allow 规则的 match（无 deny/never/受保护路径冲突）
    const ok = await this.confirm(
      `${toolName} 操作确认`,
      `${check.isDangerous ? "高危" : "注意"}: ${check.message ?? toolName}。是否继续？`,
      { tool: toolName, target: rememberTarget(toolName, matchTarget) },
    );
    if (!ok.proceed) return { proceed: false, message: "用户取消操作" };
    return ok.note ? { proceed: true, message: ok.note } : { proceed: true };
  }

  /**
   * 统一确认入口：无确认通道时默认拒绝（fail-closed）
   * - 选项顺序**固定为 允许 / 拒绝 / 始终允许（项目）/ 本会话始终允许**：前两位不变，
   *   避免老用户按习惯输入 2（原本是拒绝）却拿到持久化授权
   * - 只有该次请求确实提供了记忆选项时才追加后两项；客户端回传未提供的值一律按**拒绝**处理
   */
  private async confirm(
    title: string,
    message: string,
    remember?: { tool: string; target?: string },
  ): Promise<{ proceed: boolean; note?: string }> {
    if (!this.confirmFn) return { proceed: false };
    const allowMemory = Boolean(remember && this.memory);
    const options = [
      { value: "allow", label: "允许" },
      { value: "deny", label: "拒绝" },
      ...(allowMemory
        ? [
            { value: "allow_project", label: "始终允许（写入项目配置）" },
            { value: "allow_session", label: "本会话始终允许" },
          ]
        : []),
    ];
    const result = await this.confirmFn({ title, message, options });
    if (result === "allow_project" || result === "allow_session") {
      // 未提供记忆选项却收到该值（伪造/陈旧客户端）→ fail-closed
      if (!allowMemory || !remember) return { proceed: false };
      const scope: PermissionRuleScope = result === "allow_project" ? "project" : "session";
      const rule: PermissionRule = {
        tool: remember.tool,
        action: "allow",
        exact: true,
        ...(remember.target ? { match: remember.target } : {}),
      };
      const added = this.memory!.add(rule, scope);
      if (added.ok && !added.warning) return { proceed: true };
      if (added.ok) return { proceed: true, note: added.warning };
      this.logMemoryFailure(remember.tool, scope, added.reason ?? "未知原因");
      return { proceed: true, note: `本次已放行，但记住规则失败：${added.reason}` };
    }
    return { proceed: result === "allow" };
  }

  /** 记忆失败要留痕：hook 层会丢弃 proceed=true 的 message，审计是唯一可靠通道 */
  private logMemoryFailure(tool: string, scope: string, reason: string): void {
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "system",
      sessionId: "",
      action: "permission:rule-add-failed",
      target: `${scope} ${tool}`,
      result: "error",
      detail: reason.slice(0, 200),
    });
  }
}

/** 可记忆的目标串：fs 类与终端类用精确目标；其余为空（不提供记忆选项） */
function rememberTarget(toolName: string, target: string): string | undefined {
  if (!target) return undefined;
  if (toolName.startsWith("fs_")) return target;
  if (toolName === "terminal_exec" || toolName === "terminal_session") return target;
  return undefined;
}

/**
 * 规则匹配与受保护路径判定用的目标串：fs 类按**真实路径**判定，
 * 否则工作目录内的符号链接/junction 可绕过 deny 规则与受保护路径
 */
function realTarget(toolName: string, target: string): string {
  if (!target || !toolName.startsWith("fs_")) return target;
  return resolveRealPath(target) ?? target;
}

/** 受保护路径检查适用的工具（Sprint 49 起含读取类与终端会话：读 .env / .ssh 同样要问，不能静默放行） */
const PROTECTED_TOOLS = new Set(["fs_write", "fs_edit", "fs_read", "fs_list", "terminal_exec", "terminal_session"]);

/** 需要跑危险检测（danger-detector）的工具 */
const DANGER_TOOLS = new Set(["terminal_exec", "terminal_session", "fs_write"]);

/** 提取命令文本（terminal_exec / terminal_session 的 args） */
function commandText(args: unknown): string {
  const parsed = typeof args === "string" ? tryParseJson(args) : args;
  if (parsed && typeof parsed === "object" && "command" in parsed) {
    return String((parsed as Record<string, unknown>).command ?? "");
  }
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/**
 * 规则匹配用的"目标串"：fs 类 → 解析后的绝对路径；终端类 → 命令文本；其余 → 参数 JSON
 * 供 approval-service 与测试复用
 */
export function extractTarget(toolName: string, args: unknown, baseDir?: string): string {
  if (toolName === "terminal_exec" || toolName === "terminal_session") return commandText(args);
  if (toolName.startsWith("fs_")) return extractFilePath(args, baseDir) ?? "";
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

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
