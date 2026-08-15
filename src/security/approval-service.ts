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
   */
  checkPermission(toolName: string, mode: PermissionMode): ApprovalDecision {
    const model = this.permissionModel;
    if (!model) return { proceed: true };
    if (!model.allowsToolFor(mode, toolName)) {
      const reason = model.isReadOnly(mode)
        ? `当前权限模式(${mode})为只读，不允许执行工具 ${toolName}`
        : `当前权限模式(${mode})不允许工具调用`;
      return { proceed: false, message: reason };
    }
    return { proceed: true };
  }

  /**
   * confirmHighRisk 语义 — plan 全确认 / auto 仅高危（terminal_exec / fs_write）确认
   * 确认被拒或无确认通道（fail-closed）时返回 proceed: false
   */
  async checkConfirmation(toolName: string, args: unknown, mode: PermissionMode): Promise<ApprovalDecision> {
    const projectBase = this.workingDir ? resolve(this.workingDir) : process.cwd();

    if (mode === "plan") {
      let detail = "";
      if (toolName === "fs_write") {
        const p = extractFilePath(args, projectBase);
        if (p) detail = `：${p}`;
      }
      const ok = await this.confirm(`${toolName} 调用确认`, `执行工具 ${toolName}${detail}？`);
      return ok ? { proceed: true } : { proceed: false, message: "用户取消操作" };
    }

    if (mode !== "auto") return { proceed: true };
    if (toolName !== "terminal_exec" && toolName !== "fs_write") return { proceed: true };

    // fs_write 只检测目标路径（正则匹配的是命令文本，不能套用在 content 上）
    const input =
      toolName === "fs_write"
        ? extractFilePath(args, projectBase) ?? ""
        : typeof args === "string"
          ? args
          : JSON.stringify(args ?? {});
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
