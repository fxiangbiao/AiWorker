/**
 * 审批服务 — 权限决策单点（对齐 DSH dsh-user-approval 审批瀑布思想）
 * 将散落在 hooks 里的权限判断（permissionCheck / dangerousCommandBlock / confirmHighRisk）
 * 收敛为可独立测试的决策矩阵；无确认通道时默认拒绝（fail-closed）
 */

import { resolve, isAbsolute } from "node:path";
import type { PermissionMode } from "../types.js";
import { PermissionModel } from "./permission-model.js";
import { DangerDetector } from "./danger-detector.js";

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
}

export class ApprovalService {
  private permissionModel?: PermissionModel;
  private dangerDetector: DangerDetector;
  private workingDir?: string;
  private confirmFn?: ConfirmFn;

  constructor(deps: ApprovalServiceDeps = {}) {
    this.permissionModel = deps.permissionModel;
    this.dangerDetector = deps.dangerDetector ?? new DangerDetector();
    this.workingDir = deps.workingDir;
    this.confirmFn = deps.confirm;
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
    const target = extractTarget(toolName, args, this.workingDir);
    const rule = model.evaluateRules(toolName, target);
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
   * confirmHighRisk 语义 — plan 全确认 / auto 高危（terminal_exec / fs_write）确认
   * Sprint 47 叠加：显式 ask 规则、"永不自动批准"清单、受保护路径强制确认；显式 allow 免确认
   * 确认被拒或无确认通道（fail-closed）时返回 proceed: false
   */
  async checkConfirmation(toolName: string, args: unknown, mode: PermissionMode): Promise<ApprovalDecision> {
    const projectBase = this.workingDir ? resolve(this.workingDir) : process.cwd();
    const model = this.permissionModel;
    const target = extractTarget(toolName, args, projectBase);
    const rule = model?.evaluateRules(toolName, target) ?? null;

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
      return ok ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    const never = model?.isNeverAutoApprove(toolName) ?? false;
    const protectedHit = WRITE_TOOLS.has(toolName) && (model?.isProtectedTarget(target) ?? false);
    const forcedAsk = rule?.action === "ask";

    // 显式 allow：仅在 auto 模式免确认（ask/plan 的"先确认"语义由模式本身决定，
    // 不依赖 permissionCheck 钩子的执行顺序）；never 与受保护路径不可被 allow 覆盖
    if (mode === "auto" && rule?.action === "allow" && !never && !protectedHit) return { proceed: true };

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
      return ok ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    // auto 模式：强制类规则（ask / never / 受保护路径）→ 确认
    if (reason) {
      const ok = await this.confirm(`${toolName} 操作确认`, `${reason}${target ? `：${target}` : ""}。是否继续？`);
      return ok ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    if (toolName !== "terminal_exec" && toolName !== "fs_write") return { proceed: true };

    // fs_write 只检测目标路径（正则匹配的是命令文本，不能套用在 content 上）
    const input =
      toolName === "fs_write"
        ? extractFilePath(args, projectBase) ?? ""
        : commandText(args);
    const check = this.dangerDetector.check(input);
    if (check.level === "safe") return { proceed: true };

    const ok = await this.confirm(
      `${toolName} 操作确认`,
      `${check.isDangerous ? "高危" : "注意"}: ${check.message ?? toolName}。是否继续？`,
    );
    return ok ? { proceed: true } : { proceed: false, message: "用户取消操作" };
  }

  /** 统一确认入口：无确认通道时默认拒绝（fail-closed） */
  private async confirm(title: string, message: string): Promise<boolean> {
    if (!this.confirmFn) return false;
    const result = await this.confirmFn({
      title,
      message,
      options: [
        { value: "allow", label: "允许" },
        { value: "deny", label: "拒绝" },
      ],
    });
    return result === "allow";
  }
}

/** 受保护路径检查适用的写入类工具（读取类不强制确认） */
const WRITE_TOOLS = new Set(["fs_write", "fs_edit", "terminal_exec"]);

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
