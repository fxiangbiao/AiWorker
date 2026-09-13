/**
 * 权限模型 — Ask / Plan / Auto 三模式
 * 设计依据：调研报告——WorkBuddy 的三模式权限设计
 */

import type {
  PermissionMode,
  PermissionConfig,
  PermissionRule,
  PermissionRuleAction,
  PermissionRuleSource,
  SourcedPermissionRule,
} from "../types.js";

const RULE_ACTIONS: readonly string[] = ["deny", "ask", "allow"];

/**
 * 内置受保护路径默认值：配置文件缺失/损坏时用它兜底。
 * 绝不因为"读不到配置"就把保护清单清空——那是静默 fail-open（Sprint 49 第二轮修复）。
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  ".git",
  ".ssh",
  ".aws",
  ".kube",
  ".claude",
  ".npmrc",
  ".env",
  ".envrc",
  "id_rsa",
];

/** 规则形状校验：action 拼写错误若被静默忽略，等于 deny 规则失效（fail-open） */
function isUsableRule(r: unknown): r is PermissionRule {
  if (!r || typeof r !== "object") return false;
  const rule = r as Partial<PermissionRule>;
  if (typeof rule.tool !== "string" || rule.tool.length === 0) return false;
  if (typeof rule.action !== "string" || !RULE_ACTIONS.includes(rule.action)) return false;
  if (rule.match !== undefined && typeof rule.match !== "string") return false;
  return rule.exact === undefined || typeof rule.exact === "boolean";
}

/** 规则归一化：只保留已知字段（含 exact） */
function normalizeRule(rule: PermissionRule): PermissionRule {
  return {
    tool: rule.tool,
    action: rule.action,
    ...(rule.match !== undefined ? { match: rule.match } : {}),
    ...(rule.exact ? { exact: true } : {}),
  };
}

/** 两条规则是否同形（工具/动作/目标/精确标记） */
function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.tool === b.tool && a.action === b.action && (a.match ?? undefined) === (b.match ?? undefined) && (a.exact ?? false) === (b.exact ?? false);
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

export class PermissionModel {
  private config: PermissionConfig;
  private currentMode: PermissionMode;
  private rules: SourcedPermissionRule[];
  private neverAuto: string[];
  private protectedPaths: string[];
  /** 全量免确认开关（仅 headless --yes 在进程内打开；不落盘、不可从 HTTP/配置文件开启） */
  private autoApproveAll = false;

  constructor(config: PermissionConfig) {
    this.config = config;
    this.currentMode = config.defaultMode;
    const rawRules: unknown[] = Array.isArray(config.rules) ? config.rules : [];
    const valid = rawRules.filter(isUsableRule);
    // 配置文件里的规则来源为项目级；会话级规则由 addRule(rule, "session") 追加
    this.rules = valid.map((r) => ({ ...normalizeRule(r), source: "project" as PermissionRuleSource }));
    if (valid.length !== rawRules.length) {
      console.warn(
        `[permissions] 忽略 ${rawRules.length - valid.length} 条无效规则：需 tool 为非空字符串、action ∈ deny|ask|allow、match 为字符串或缺省`,
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

  /** 全量免确认（headless --yes）：仍不覆盖 deny / never_auto_approve / 受保护路径 */
  setAutoApproveAll(value: boolean): void {
    this.autoApproveAll = value;
  }

  isAutoApproveAll(): boolean {
    return this.autoApproveAll;
  }

  /** 当前模式是否允许工具调用 */
  allowsToolCalls(): boolean {
    return this.config.modes[this.currentMode].allow_tool_calls;
  }

  /**
   * 追加一条生效规则（仍无法覆盖 deny / never_auto_approve / 受保护路径）
   * 顺序固定为**会话级在前、项目级在后**：新增与文件重载走同一顺序，`/permissions` 列表与规则表一致
   * 默认来源为会话级（进程结束即失效）；项目级规则由 PermissionMemory 落盘后以 "project" 追加
   */
  addRule(rule: PermissionRule, source: PermissionRuleSource = "session"): boolean {
    if (!isUsableRule(rule)) return false;
    const entry: SourcedPermissionRule = { ...normalizeRule(rule), source };
    if (source === "session") this.rules.unshift(entry);
    else this.rules.push(entry);
    return true;
  }

  /** 是否已存在完全相同的规则（工具/动作/目标/精确标记 + 同来源）；新增前用它去重 */
  hasRule(rule: PermissionRule, source?: PermissionRuleSource): boolean {
    return this.rules.some((r) => sameRule(r, rule) && (source === undefined || r.source === source));
  }

  /** 生效规则清单（含来源），供 /permissions 与 Web 面板展示 */
  listRules(): SourcedPermissionRule[] {
    return this.rules.map((r) => ({ ...normalizeRule(r), source: r.source }));
  }

  /**
   * 删除**所有**匹配（工具/动作/目标/精确标记 + 来源限定）的规则，返回清除条数。
   * 与配置文件侧的"按同形过滤"对称，避免盘上删净、内存还留一条。
   */
  removeRule(rule: PermissionRule, source?: PermissionRuleSource): number {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => !(sameRule(r, rule) && (source === undefined || r.source === source)));
    return before - this.rules.length;
  }

  /** 清空指定来源的规则，返回清除条数 */
  removeRulesBySource(source: PermissionRuleSource): number {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.source !== source);
    return before - this.rules.length;
  }

  /**
   * 用给定集合**整体替换**某一来源的规则（外部改动后重载用）
   * 会话级仍排在前面（与新增顺序一致），项目级按给定顺序追加
   */
  setRulesForSource(rules: PermissionRule[], source: PermissionRuleSource): number {
    const session = this.rules.filter((r) => r.source !== source);
    const next = rules.filter(isUsableRule).map((r) => ({ ...normalizeRule(r), source }));
    this.rules = source === "session" ? [...next, ...session] : [...session, ...next];
    return next.length;
  }

  /**
   * 写入前校验：格式非法、或 allow 规则会架空保护（never_auto_approve / 受保护路径）时拒绝
   * deny 与 ask 规则不受限制（它们只会收紧权限）
   */
  validateRule(rule: PermissionRule): { ok: boolean; reason?: string } {
    if (!isUsableRule(rule)) {
      return { ok: false, reason: "规则格式非法：需 tool 非空、action ∈ deny|ask|allow、match 为字符串或缺省" };
    }
    if (rule.action !== "allow") return { ok: true };
    if (this.isNeverAutoApprove(rule.tool)) {
      return { ok: false, reason: `工具 ${rule.tool} 在 never_auto_approve 清单中，不允许写成 allow 规则` };
    }
    if (rule.match && this.matchTouchesProtected(rule.match)) {
      return { ok: false, reason: `规则目标触及受保护路径：${rule.match}` };
    }
    if (rule.tool === "*" && !rule.match) {
      return { ok: false, reason: "通配工具（tool: \"*\"）必须写明 match 目标：无目标的全局 allow 等于对所有工具放行" };
    }
    return { ok: true };
  }

  /**
   * allow 规则的目标串是否触及受保护路径（含通配写法，如 `*id_rsa`、`.ssh/*`、`*.env`）
   * 按**路径段**判定（与运行口 isProtectedTarget 同源），只在段首/段尾的 `*` 被剥掉后比较，
   * 因此 `.gitignore`、`.github/*`、`mylogs/.sshfoo` 不会被 `.git` / `.ssh` 误伤
   */
  private matchTouchesProtected(match: string): boolean {
    if (this.isProtectedTarget(match)) return true;
    const segments = match.replace(/\\/g, "/").toLowerCase().split(/[/=:\s]+/);
    return segments.some((raw) => {
      const seg = raw.replace(/^\*+|\*+$/g, "");
      if (!seg) return false;
      return this.protectedPaths.some((p) => p !== "" && (seg === p || seg.startsWith(`${p}.`)));
    });
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

  /**
   * 规则求值：命中多条时按 deny > ask > allow 取最高优先级；无命中返回 null
   * `exact: true` 的规则按**字面全等**（大小写不敏感）比较，不展开通配——交互确认产生的
   * "始终允许"必须是精确目标，否则命令文本里的 `*` 会把授权范围悄悄放大
   */
  evaluateRules(toolName: string, target: string): { action: PermissionRuleAction; rule: PermissionRule } | null {
    const hits = this.rules.filter((r) => {
      if (!PermissionModel.globMatch(r.tool, toolName)) return false;
      if (r.match === undefined) return true;
      return r.exact ? r.match.toLowerCase() === target.toLowerCase() : PermissionModel.globMatch(r.match, target);
    });
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

  /** 供展示/调试：规则摘要（含来源标注便于排查生效顺序） */
  describeRules(): string[] {
    return this.rules.map(
      (r) => `${r.action.toUpperCase()} ${r.tool}${r.match ? `(${r.match})` : ""}${r.source === "session" ? " [会话]" : ""}`,
    );
  }

  getProtectedPaths(): string[] {
    return [...this.protectedPaths];
  }

  getNeverAutoApprove(): string[] {
    return [...this.neverAuto];
  }

  /**
   * 热更新受保护路径 / 永不自动批准清单（Sprint 50 / IA 重构）
   *
   * 存在的理由：这两个清单原本只在构造时从配置读入，Web 上改完文件若不重启就是"看起来改了、其实没生效"。
   * 归一化规则与构造函数逐字一致（受保护路径：反斜杠转正斜杠 + 小写），避免"同一份配置因入口不同而判定不同"。
   * 只做替换，不做校验：合法性由写入方（PermissionMemory.setSafetyList）负责。
   */
  setProtectedPaths(paths: string[]): void {
    this.protectedPaths = toStringList(paths).map((p) => p.replace(/\\/g, "/").toLowerCase());
  }

  setNeverAutoApprove(list: string[]): void {
    this.neverAuto = toStringList(list);
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
