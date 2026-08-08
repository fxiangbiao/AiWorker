/**
 * 权限模型 — Ask / Plan / Auto 三模式
 * 设计依据：调研报告——WorkBuddy 的三模式权限设计
 */

import type { PermissionMode, PermissionConfig } from "../types.js";

export class PermissionModel {
  private config: PermissionConfig;
  private currentMode: PermissionMode;

  constructor(config: PermissionConfig) {
    this.config = config;
    this.currentMode = config.defaultMode;
  }

  getMode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  /** 当前模式是否允许工具调用 */
  allowsToolCalls(): boolean {
    return this.config.modes[this.currentMode].allow_tool_calls;
  }

  /** 指定模式是否允许工具调用（请求级权限判断用） */
  allowsToolCallsFor(mode: PermissionMode): boolean {
    return this.config.modes[mode]?.allow_tool_calls ?? false;
  }

  /** 指定模式是否为只读（仅允许只读工具） */
  isReadOnly(mode: PermissionMode): boolean {
    return this.config.modes[mode]?.readOnly ?? false;
  }

  /** 只读工具白名单（ask 模式可执行） */
  static READONLY_TOOLS: string[] = ["fs_read", "fs_list", "web_search", "web_fetch", "math_eval", "uuid_gen", "json_format", "timestamp_convert"];

  /** 指定模式是否允许调用指定工具 */
  allowsToolFor(mode: PermissionMode, toolName: string): boolean {
    if (this.isReadOnly(mode)) {
      return PermissionModel.READONLY_TOOLS.includes(toolName);
    }
    return this.allowsToolCallsFor(mode);
  }

  /** 是否需要用户确认 */
  requiresConfirmation(): boolean {
    return this.config.modes[this.currentMode].require_confirmation ?? false;
  }

  /** 高危操作是否需要确认 */
  highRiskNeedsConfirm(): boolean {
    return this.config.modes[this.currentMode].high_risk_confirm ?? false;
  }

  /** 检查目录是否在允许范围内 */
  isDirAllowed(dir: string): boolean {
    if (this.config.allowedDirs.length === 0) return true; // 未配置则全允许
    return this.config.allowedDirs.some((allowed) => dir.startsWith(allowed));
  }

  getDescription(mode?: PermissionMode): string {
    const m = mode ?? this.currentMode;
    return this.config.modes[m].description;
  }

  /** 切换到 Plan 模式时生成计划确认提示 */
  static formatPlanConfirmation(plan: string): string {
    return [
      "┌─ 执行计划 ─────────────────────────────┐",
      "│                                        │",
      plan
        .split("\n")
        .map((line) => `│  ${line}`)
        .join("\n"),
      "│                                        │",
      "└─ 输入 y 确认执行，n 取消 ──────────────┘",
    ].join("\n");
  }
}
