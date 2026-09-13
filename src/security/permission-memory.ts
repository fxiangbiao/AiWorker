/**
 * 权限记忆（Sprint 49 / P1-4）
 * 规则来源分层：项目（config/permissions.json 的 rules，跨进程）/ 会话（内存，进程结束即失效）
 * 落盘为**原子替换**：读全量 → 改 rules → 写临时文件 → rename；解析失败或校验不通过一律拒绝，不半写
 * 变更进审计：permission:rule-added / permission:rule-removed / permission:rules-reset
 * 本模块不会主动加规则：无确认通道时由审批层 fail-closed，不存在"默认记住"的路径
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { PermissionRule, PermissionRuleChange, PermissionRuleScope, SourcedPermissionRule } from "../types.js";
import { PermissionModel } from "./permission-model.js";
import { readJsonObject, writeJsonAtomic } from "./json-file.js";
import { auditLogger } from "../core/audit-logger.js";

export interface PermissionMemoryDeps {
  model: PermissionModel;
  /** 项目级规则文件（缺省按工作目录解析，见 resolvePermissionConfigPath） */
  configPath?: string;
  /** 工作目录（--dir）；用于把"项目级"规则落到被操作的项目而不是启动目录 */
  workingDir?: string;
  /** 审计写入（缺省写全局 auditLogger；测试可注入） */
  log?: (event: { action: string; detail: string }) => void;
}

/** 配置文件里可识别的权限键：用于判断"这个 permissions.json 是不是我们的配置" */
const CONFIG_KEYS = ["default_mode", "modes", "allowed_dirs", "denied_patterns", "rules", "never_auto_approve", "protected_paths"];

/**
 * 生效的权限配置文件（Sprint 49 第二轮：跟随 `--dir`）
 * 优先 `<workingDir>/config/permissions.json`，其次 `<cwd>/config/permissions.json`（兼容既有用法）；
 * 都存在则以前者为准；都不存在时返回前者（首次写入即创建）。
 * 目录下的同名文件若不含任何已知权限键（可能是别的工具的 permissions.json），视为不存在并告警。
 */
export function resolvePermissionConfigPath(workingDir: string, cwd: string = process.cwd()): string {
  const candidates = [resolve(workingDir, "config", "permissions.json"), resolve(cwd, "config", "permissions.json")];
  const unique = candidates.filter((p, i) => candidates.indexOf(p) === i);
  for (const path of unique) {
    const shape = inspectConfig(path);
    if (shape === "ok") return path;
    if (shape === "foreign") {
      console.warn(`[permissions] 忽略 ${path}：不含任何权限配置键（default_mode/modes/rules/protected_paths 等），按不存在处理`);
    }
  }
  return unique[0]!;
}

function inspectConfig(path: string): "ok" | "foreign" | "absent" | "broken" {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return "absent";
  }
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) return "broken";
    return CONFIG_KEYS.some((k) => k in data) ? "ok" : "foreign";
  } catch {
    return "broken";
  }
}

interface ParsedConfig {
  data: Record<string, unknown>;
  hadBom: boolean;
  /** 原文件主导行尾与尾换行习惯（写回时保持一致，减少无谓 diff） */
  eol: string;
  trailing: boolean;
  /** 原文件权限位（不存在时写 null，用默认 umask） */
  mode: number | null;
  mtimeMs: number;
  size: number;
  /** 文件里 rules 的原始条目（含无法识别的条目，写回时原样保留，不静默丢弃用户内容） */
  rawRules: unknown[];
}

/** 从原始条目取规则（形状不合法返回 null） */
function ruleFromUnknown(item: unknown): PermissionRule | null {
  const r = item as Partial<PermissionRule> | null;
  const action = r?.action;
  if (typeof r?.tool !== "string" || r.tool.length === 0) return null;
  if (action !== "deny" && action !== "ask" && action !== "allow") return null;
  return {
    tool: r.tool,
    action,
    ...(typeof r.match === "string" ? { match: r.match } : {}),
    ...(r.exact === true ? { exact: true } : {}),
  };
}

function isSameRule(item: unknown, target: PermissionRule): boolean {
  const r = ruleFromUnknown(item);
  if (!r) return false;
  return (
    r.tool === target.tool &&
    r.action === target.action &&
    (r.match ?? undefined) === (target.match ?? undefined) &&
    (r.exact ?? false) === (target.exact ?? false)
  );
}

/** 规则归一化：只保留已知字段（含 exact） */
function normalize(rule: PermissionRule): PermissionRule {
  return {
    tool: rule.tool,
    action: rule.action,
    ...(rule.match !== undefined ? { match: rule.match } : {}),
    ...(rule.exact ? { exact: true } : {}),
  };
}

export class PermissionMemory {
  private model: PermissionModel;
  /** 生效读取路径（项目配置存在则项目，否则启动目录） */
  private configPath: string;
  /** 启动时的回落读取路径（通常 = 启动目录配置） */
  private readFallback: string;
  /** 项目规则写入路径：始终跟随 `--dir`，绝不静默改写启动目录/安装目录的配置 */
  private writePath: string;
  private log: (event: { action: string; detail: string }) => void;
  /** 上次同步的文件指纹：mtime+size 变化才重载（外部/跨进程改动） */
  private stamp: { mtimeMs: number; size: number } | null = null;
  /** 审计归属：由调用方（confirm 弹窗 / CLI）设置，默认记为用户操作 */
  private actor: { agentId: string; sessionId: string } = { agentId: "user", sessionId: "" };

  constructor(deps: PermissionMemoryDeps) {
    this.model = deps.model;
    this.readFallback = deps.configPath ?? resolvePermissionConfigPath(deps.workingDir ?? process.cwd());
    // 显式给了 configPath 又没给 workingDir（测试/嵌入式用法）：读写同一文件
    this.writePath = deps.workingDir ? resolve(deps.workingDir, "config", "permissions.json") : this.readFallback;
    this.configPath = existsSync(this.writePath) ? this.writePath : this.readFallback;
    this.log =
      deps.log ??
      ((event) => {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: this.actor.agentId,
          sessionId: this.actor.sessionId,
          action: event.action,
          target: event.detail.slice(0, 200),
          result: "success",
        });
      });
    this.syncStamp();
  }

  /** 设置审计归属（谁触发了这次变更） */
  setActor(actor: { agentId?: string; sessionId?: string }): void {
    this.actor = { agentId: actor.agentId ?? "user", sessionId: actor.sessionId ?? "" };
  }

  getActor(): { agentId: string; sessionId: string } {
    return { ...this.actor };
  }

  private syncStamp(): void {
    try {
      const st = statSync(this.configPath);
      this.stamp = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      this.stamp = null;
    }
  }

  /**
   * 按 mtime/size 变化重载项目级规则（跨进程一致性：CLI 写的 deny 能对运行中的 server 生效）
   * 项目配置文件出现后自动切换读取来源；文件缺失/损坏时**保留当前规则并告警**（不静默丢掉 deny，也不静默清空）
   */
  refresh(): boolean {
    const effective = existsSync(this.writePath) ? this.writePath : this.readFallback;
    if (effective !== this.configPath) {
      this.configPath = effective; // 首次创建项目配置后，读取来源切到项目文件
      this.stamp = null;
    }
    const parsed = this.readConfig();
    if (!parsed.ok) {
      if (this.stamp !== null) {
        this.stamp = null;
        console.warn(`[permissions] 配置不可读，保留当前生效规则（${parsed.reason}）`);
      }
      return false;
    }
    if (this.stamp && parsed.mtimeMs === this.stamp.mtimeMs && parsed.size === this.stamp.size) return false;
    const rules = parsed.rawRules.map(ruleFromUnknown).filter((r): r is PermissionRule => r !== null);
    const count = this.model.setRulesForSource(rules, "project");
    this.stamp = { mtimeMs: parsed.mtimeMs, size: parsed.size };
    this.log({ action: "permission:rules-reloaded", detail: `project ${count} 条` });
    return true;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  list(): SourcedPermissionRule[] {
    this.refresh();
    return this.model.listRules();
  }

  /** 新增规则：session 只进内存；project 先落盘再进内存（落盘失败则整体失败）；同形规则不重复写入 */
  add(rule: PermissionRule, scope: PermissionRuleScope = "session"): PermissionRuleChange {
    this.refresh();
    const valid = this.model.validateRule(rule);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    const normalized = normalize(rule);
    if (this.model.hasRule(normalized, scope)) {
      return { ok: true, rule: { ...normalized, source: scope }, warning: "同形规则已存在，未重复写入" };
    }

    if (scope === "project") {
      const written = this.writeProject((rules) => [...rules, normalized]);
      if (!written.ok) return { ok: false, reason: written.reason };
    }
    this.model.addRule(normalized, scope);
    this.log({
      action: "permission:rule-added",
      detail: `${scope} ${normalized.action} ${normalized.tool}${normalized.match ? `(${normalized.match})` : ""}`,
    });
    return { ok: true, rule: { ...normalized, source: scope } };
  }

  /**
   * 撤销规则：**内存先撤、再落盘**——落盘失败（文件损坏/缺失）时规则在进程内立即失效，
   * 只以 warning 告知"重启后会重新生效"，不会出现"报失败但规则仍然生效"的死角
   */
  revoke(rule: PermissionRule, scope?: PermissionRuleScope): PermissionRuleChange {
    this.refresh();
    const hit = this.model
      .listRules()
      .find(
        (r) =>
          r.tool === rule.tool &&
          r.action === rule.action &&
          (r.match ?? undefined) === (rule.match ?? undefined) &&
          (scope === undefined || r.source === scope),
      );
    if (!hit) return { ok: false, reason: "未找到匹配规则" };

    const removed = this.model.removeRule(hit, hit.source);
    let warning: string | undefined;
    if (hit.source === "project") {
      const written = this.writeProject((rules) => rules.filter((r) => !isSameRule(r, hit)));
      if (!written.ok) {
        warning = `配置文件未更新（${written.reason}）：本进程已撤销 ${removed} 条，重启后会重新生效`;
      }
    }
    this.log({
      action: "permission:rule-removed",
      detail: `${hit.source} ${hit.action} ${hit.tool}${hit.match ? `(${hit.match})` : ""}${warning ? "（仅内存）" : ""}`,
    });
    return warning ? { ok: true, rule: hit, warning } : { ok: true, rule: hit };
  }

  /** 清空项目级规则：内存先清（立即失效），再尝试写回空数组；落盘失败只告警 */
  resetProject(): PermissionRuleChange {
    this.refresh();
    const removed = this.model.removeRulesBySource("project");
    const written = this.writeProject(() => []);
    const warning = written.ok ? undefined : `配置文件未更新（${written.reason}）：本进程已清空 ${removed} 条，重启后会重新生效`;
    this.log({ action: "permission:rules-reset", detail: `project 清除 ${removed} 条${written.ok ? "" : "（仅内存）"}` });
    return warning ? { ok: true, warning } : { ok: true };
  }

  /** 清空会话级规则（仅内存） */
  clearSession(): number {
    const removed = this.model.removeRulesBySource("session");
    if (removed > 0) this.log({ action: "permission:rules-reset", detail: `session 清除 ${removed} 条` });
    return removed;
  }

  /** 读配置里的字符串数组键（`present: false` = 文件里没有该键，此时生效值来自内置基线） */
  readStringList(key: "protected_paths" | "never_auto_approve"): { present: boolean; values: string[] } {
    this.refresh();
    const parsed = this.readConfig();
    if (!parsed.ok) return { present: false, values: [] };
    const raw = parsed.data[key];
    if (!Array.isArray(raw)) return { present: false, values: [] };
    return { present: true, values: raw.filter((v): v is string => typeof v === "string") };
  }

  /**
   * 写「安全清单」键（受保护路径 / 永不自动批准 / 命令黑名单）：整表替换 → 落盘 → **同步更新运行中的模型**
   *
   * 两个刻意的安全设计：
   * - **落盘失败即整体失败**（与 add 不同，这里不回退内存）：清单是"保护范围"的声明，
   *   内存与磁盘不一致时用户看到的与生效的不一样，比直接报错更危险。
   * - **移除内置基线项需显式 acknowledge**：文件里的 `protected_paths` 会**整体替换**内置基线
   *   （bootstrap 用 `?? DEFAULT_PROTECTED_PATHS`），所以"少传一条"就等于静默丢掉一层保护。
   *   服务端强制要求调用方确认（而不是只靠前端弹窗），避免任何脚本/第三方客户端误删。
   */
  setSafetyList(
    key: "protected_paths" | "never_auto_approve",
    values: unknown,
    opts: { defaults?: readonly string[]; acknowledge?: boolean } = {},
  ): { ok: boolean; reason?: string; warning?: string; removedDefaults?: string[] } {
    this.refresh();
    if (!Array.isArray(values)) return { ok: false, reason: `${key} 必须是字符串数组` };
    const cleaned: string[] = [];
    for (const item of values) {
      if (typeof item !== "string") return { ok: false, reason: `${key} 的每一项都必须是字符串` };
      const v = item.trim();
      if (!v) return { ok: false, reason: `${key} 不允许空字符串条目` };
      if (/[\r\n]/.test(v)) return { ok: false, reason: `${key} 的条目不允许多行内容` };
      if (!cleaned.some((c) => c.toLowerCase() === v.toLowerCase())) cleaned.push(v);
    }
    const defaults = opts.defaults ?? [];
    const removedDefaults = defaults.filter((d) => !cleaned.some((c) => c.toLowerCase() === d.toLowerCase()));
    if (removedDefaults.length > 0 && opts.acknowledge !== true) {
      return {
        ok: false,
        reason: `本次提交会移除内置基线项（${removedDefaults.join("、")}），需确认后再提交`,
        removedDefaults,
      };
    }

    const written = this.writeConfigData((data) => ({ ...data, [key]: cleaned }));
    if (!written.ok) return { ok: false, reason: written.reason };
    if (key === "protected_paths") this.model.setProtectedPaths(cleaned);
    else this.model.setNeverAutoApprove(cleaned);
    this.log({
      action: key === "protected_paths" ? "permission:protected-paths-set" : "permission:never-auto-approve-set",
      detail: `${cleaned.length} 条${removedDefaults.length > 0 ? `（移除内置基线 ${removedDefaults.join("、")}）` : ""}`,
    });
    return removedDefaults.length > 0
      ? { ok: true, warning: `已移除内置基线项：${removedDefaults.join("、")}（重启后同样生效，因为已经写进配置文件）` }
      : { ok: true };
  }

  /**
   * 读全量 → 变换 rules → 原子写回（保留其他字段、BOM、行尾风格、权限与无法识别的条目）
   * 目标始终是**项目配置**（跟随 `--dir`）：首次写入时以启动目录配置为模板创建，
   * 因此不会静默改写安装目录/启动目录的配置，也不会因为新建文件而丢掉受保护路径等基础策略
   */
  private writeProject(mutate: (rules: unknown[]) => unknown[]): { ok: boolean; reason?: string } {
    return this.writeConfigData((data, rawRules) => ({ ...data, rules: mutate(rawRules) }));
  }

  /**
   * 通用的"读全量 → 改一处 → 原子写回"。rules 与安全清单（受保护路径 / 永不自动批准）共用同一套
   * 模板创建、损坏拒绝与风格保留逻辑，避免同一个文件出现两套写法。
   */
  private writeConfigData(
    mutate: (data: Record<string, unknown>, rawRules: unknown[]) => Record<string, unknown>,
  ): { ok: boolean; reason?: string } {
    const target = this.writePath;
    const creating = !existsSync(target);
    if (!creating && inspectConfig(target) === "foreign") {
      return {
        ok: false,
        reason: `${target} 已存在但不含任何权限配置键（可能是别的工具的配置），拒绝覆盖`,
      };
    }
    const source = creating && this.readFallback !== target ? this.readFallback : target;
    const parsed = this.readConfigAt(source);
    if (!parsed.ok && !creating) return { ok: false, reason: parsed.reason };
    // 首次创建时若模板/回落配置存在但不可读（损坏），同样拒绝：不在一份读不懂的基础策略之上新建授权文件
    if (creating && !parsed.ok && existsSync(source)) return { ok: false, reason: parsed.reason };
    const template = parsed.ok ? parsed.data : {};
    const data = mutate(template, parsed.ok ? parsed.rawRules : []);
    const written = writeJsonAtomic(target, data, {
      hadBom: parsed.ok && parsed.hadBom,
      eol: parsed.ok ? parsed.eol : "\n",
      trailing: parsed.ok ? parsed.trailing : true,
      mode: parsed.ok ? parsed.mode : null,
    });
    if (!written.ok) return { ok: false, reason: `写入权限配置失败: ${written.reason}` };
    this.configPath = target;
    this.syncStamp();
    return { ok: true };
  }

  private readConfig(): ({ ok: true } & ParsedConfig) | { ok: false; reason: string } {
    return this.readConfigAt(this.configPath);
  }

  private readConfigAt(path: string): ({ ok: true } & ParsedConfig) | { ok: false; reason: string } {
    const res = readJsonObject(path);
    if (!res.ok) return { ok: false, reason: `权限配置文件${res.reason}` };
    const rawRules = res.data.rules;
    if (rawRules !== undefined && !Array.isArray(rawRules)) {
      console.warn(`[permissions] ${path} 的 rules 不是数组，写入时将替换为数组`);
    }
    return {
      ok: true,
      data: res.data,
      hadBom: res.hadBom,
      eol: res.eol,
      trailing: res.trailing,
      mode: res.mode,
      mtimeMs: res.mtimeMs,
      size: res.size,
      rawRules: Array.isArray(rawRules) ? rawRules : [],
    };
  }
}
