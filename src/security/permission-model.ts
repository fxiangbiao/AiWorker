/**
 * 权限模型 — Ask / Plan / Auto 三模式
 * 设计依据：调研报告——WorkBuddy 的三模式权限设计
 */

import type { PermissionMode, PermissionConfig, PermissionRule, PermissionRuleAction } from "../types.js";

const RULE_ACTIONS: readonly string[] = ["deny", "ask", "allow"];

/** 规则形状校验：action 拼写错误若被静默忽略，等于 deny 规则失效（fail-open） */
function isUsableRule(r: unknown): r is PermissionRule {
  if (!r || typeof r !== "object") return false;
  const rule = r as Partial<PermissionRule>;
  if (typeof rule.tool !== "string" || rule.tool.length === 0) return false;
  if (typeof rule.action !== "string" || !RULE_ACTIONS.includes(rule.action)) return false;
  return rule.match === undefined || typeof rule.match === "string";
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

export class PermissionModel {
  private config: PermissionConfig;
  private currentMode: PermissionMode;
  private rules: PermissionRule[];
  private neverAuto: string[];
  private protectedPaths: string[];

  constructor(config: PermissionConfig) {
    this.config = config;
    this.currentMode = config.defaultMode;
    const rawRules: unknown[] = Array.isArray(config.rules) ? config.rules : [];
    this.rules = rawRules.filter(isUsableRule);
    if (this.rules.length !== rawRules.length) {
      console.warn(
        `[permissions] 忽略 ${rawRules.length - this.rules.length} 条无效规则：需 tool 为非空字符串、action ∈ deny|ask|allow、match 为字符串或缺省`,
      );
    }
    this.neverAuto = toStringList(config.neverAutoApprove);
    this.protectedPaths = toStringList(config.protectedPaths).map((p) => p.replace(/\\/g, "/").toLowerCase());
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

  /** 只读工具白名单（ask 模式可执行；ask_user 仅提问，无副作用） */
  static READONLY_TOOLS: string[] = ["fs_read", "fs_list", "web_search", "web_fetch", "ask_user", "math_eval", "uuid_gen", "json_format", "timestamp_convert"];

  /** 内置 MCP 服务器前缀——其工具全部无副作用（计算/转换类），ask 模式放行 */
  static BUILTIN_MCP_PREFIX = "mcp_builtin_";

  /** 指定模式是否允许调用指定工具 */
  allowsToolFor(mode: PermissionMode, toolName: string): boolean {
    if (this.isReadOnly(mode)) {
      if (PermissionModel.READONLY_TOOLS.includes(toolName)) return true;
      // 内置 MCP 工具只读无副作用，ask 模式放行；外部 MCP 工具仍拦截
      return toolName.startsWith(PermissionModel.BUILTIN_MCP_PREFIX);
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

  // ===== 规则引擎（Sprint 47：Tool(specifier) 级 deny → ask → allow） =====

  /** glob 匹配（`*` 匹配任意长度，大小写不敏感；工具名与目标串共用） */
  static globMatch(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    if (!pattern) return false;
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${esc}$`, "i").test(value);
  }

  /** 规则求值：命中多条时按 deny > ask > allow 取最高优先级；无命中返回 null */
  evaluateRules(toolName: string, target: string): { action: PermissionRuleAction; rule: PermissionRule } | null {
    const hits = this.rules.filter(
      (r) => PermissionModel.globMatch(r.tool, toolName) && (r.match === undefined || PermissionModel.globMatch(r.match, target)),
    );
    for (const action of ["deny", "ask", "allow"] as PermissionRuleAction[]) {
      const rule = hits.find((r) => r.action === action);
      if (rule) return { action, rule };
    }
    return null;
  }

  /** 是否属于"永不自动批准"工具（任何模式都需确认） */
  isNeverAutoApprove(toolName: string): boolean {
    return this.neverAuto.some((p) => PermissionModel.globMatch(p, toolName));
  }

  /**
   * 目标串是否命中受保护路径。按**路径段**匹配（`p` 或 `p.` 前缀），避免 `.git` 误伤
   * `.gitignore` / `.github/**`；目标串为命令文本时，先按空白/标点拆出候选片段再切段匹配。
   * 含分隔符的规则（如 `.git/config`）退化为子串匹配，保持兼容。
   */
  isProtectedTarget(target: string): boolean {
    if (!target) return false;
    const norm = target.replace(/\\/g, "/").toLowerCase();
    const segments = new Set<string>();
    for (const token of [norm, ...norm.split(/[\s"',;|&()<>]+/)]) {
      for (const seg of token.split(/[/=:]+/)) {
        if (seg) segments.add(seg);
      }
    }
    return this.protectedPaths.some((p) => {
      if (!p) return false;
      if (p.includes("/")) return norm.includes(p);
      for (const seg of segments) {
        if (seg === p || seg.startsWith(`${p}.`)) return true;
      }
      return false;
    });
  }

  /** 供展示/调试：规则摘要 */
  describeRules(): string[] {
    return this.rules.map((r) => `${r.action.toUpperCase()} ${r.tool}${r.match ? `(${r.match})` : ""}`);
  }

  getProtectedPaths(): string[] {
    return [...this.protectedPaths];
  }

  getNeverAutoApprove(): string[] {
    return [...this.neverAuto];
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
