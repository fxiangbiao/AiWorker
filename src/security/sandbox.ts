/**
 * 策略化命令沙箱（对齐 DSH 沙箱思想，个人项目务实路径）
 * 纵深：cwd 越界约束（fail-closed）+ 命令写入目标可写根约束（Sprint 47）+
 *       配置化命令黑名单 + 敏感环境变量清理
 * Sprint 49：根的解析与包含判定统一走 path-policy（与 fs 四件套同源，符号链接一并解析）
 * 说明：不做 OS 级进程沙箱（bwrap/restricted-token）——Node 无原生 API、
 *       自研风险高、本项目信任模型为本人执行；叠加 danger-detector /
 *       路径校验 / 超时 / 输出截断构成多层防御。写入目标判定为启发式，
 *       覆盖重定向与常见写入类命令，不覆盖脚本内部动态拼接的路径。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { evaluatePath, isInsideDir, resolveRealPath, resolveRoots } from "./path-policy.js";

export interface SandboxPolicy {
  enabled: boolean;
  allowDirs: string[];
  /** 允许写入的目录（留空回退到工作目录）；Sprint 47 可写根约束 */
  allowWriteDirs: string[];
  /** 允许读取的目录（留空回退到工作目录）；Sprint 49 读根约束，fs 四件套共用 */
  allowReadDirs: string[];
  denyCommands: string[];
  stripSecretEnv: boolean;
}

const DEFAULT_POLICY: SandboxPolicy = {
  enabled: true,
  allowDirs: [],
  allowWriteDirs: [],
  allowReadDirs: [],
  denyCommands: [],
  stripSecretEnv: true,
};

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 配置文件路径注入（测试用）：不注入时按 workingDir → cwd → 包目录 的顺序解析
 */
let configPathOverride: string | null = null;

export function setSandboxConfigPath(path: string | null): void {
  configPathOverride = path;
}

const SANDBOX_KEYS = ["enabled", "allowDirs", "allowWriteDirs", "allowReadDirs", "denyCommands", "stripSecretEnv"];

/** 是不是一份沙箱配置（别的工具可能也有 config/sandbox.json） */
function looksLikeSandboxConfig(path: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return Boolean(data) && typeof data === "object" && !Array.isArray(data) && SANDBOX_KEYS.some((k) => k in data);
  } catch {
    return false;
  }
}

/**
 * 生效的沙箱配置文件（Sprint 49 第二轮：与权限配置同样跟随 `--dir`）
 * 优先 `<workingDir>/config/sandbox.json`，其次 `<cwd>/config/sandbox.json`，最后回落到包内 config/sandbox.json
 */
export function resolveSandboxConfigPath(workingDir: string, cwd: string = process.cwd()): string {
  if (configPathOverride) return configPathOverride;
  const candidates = [resolve(workingDir, "config", "sandbox.json"), resolve(cwd, "config", "sandbox.json")];
  for (const path of candidates.filter((p, i) => candidates.indexOf(p) === i)) {
    if (existsSync(path) && looksLikeSandboxConfig(path)) return path;
  }
  return resolve(import.meta.dirname, "../../config/sandbox.json");
}

export function loadSandboxPolicy(configPath?: string): SandboxPolicy {
  try {
    const path = configPath ?? configPathOverride ?? resolveSandboxConfigPath(process.cwd());
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<SandboxPolicy>;
    return {
      enabled: parsed.enabled ?? DEFAULT_POLICY.enabled,
      allowDirs: Array.isArray(parsed.allowDirs) ? parsed.allowDirs.map((d) => resolve(d)) : [],
      allowWriteDirs: Array.isArray(parsed.allowWriteDirs) ? parsed.allowWriteDirs.map((d) => resolve(d)) : [],
      allowReadDirs: Array.isArray(parsed.allowReadDirs) ? parsed.allowReadDirs.map((d) => resolve(d)) : [],
      denyCommands: Array.isArray(parsed.denyCommands) ? parsed.denyCommands : [],
      stripSecretEnv: parsed.stripSecretEnv ?? DEFAULT_POLICY.stripSecretEnv,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

export function checkCommand(
  command: string,
  cwd: string,
  workingDir: string,
  policy: SandboxPolicy,
): SandboxCheckResult {
  if (!policy.enabled) return { allowed: true };
  const base = resolveRealPath(cwd);
  if (base === null) {
    return { allowed: false, reason: `工作目录无法解析为真实路径（悬空链接/链接环/权限不足），已按拒绝处理: ${resolve(cwd)}` };
  }
  const roots = resolveRoots(policy.allowDirs, workingDir);
  if (!roots.some((root) => isInsideDir(root, base))) {
    return {
      allowed: false,
      reason: `工作目录越界被沙箱拦截: ${base}（仅允许 ${roots.join("、")} 内）`,
    };
  }
  const deny = checkDeniedCommand(command, policy);
  if (!deny.allowed) return deny;
  // 写入目标可写根约束（Sprint 47 引入，Sprint 49 起与 fs 工具共用同一套根解析）
  return checkWriteTargets(command, base, resolveRoots(policy.allowWriteDirs, workingDir));
}

/** 重定向/写入命令中无需检查的伪目标 */
const IGNORED_WRITE_TARGETS = new Set(["nul", "/dev/null", "&1", "&2", "&0", "$null", "con"]);

/**
 * 写入类命令（cmd / PowerShell 常见项 + 常用别名）。
 * 别名（rm/ri/ni/sc/ac/cp/mv）与完整名同等对待——LLM 输出的 PowerShell 别名占多数。
 * 仅在命令位置匹配，引号视为边界以覆盖解释器包裹。
 */
const WRITE_CMD_PATTERN =
  /(?:^|[;&|("'])\s*(?:set-content|sc|add-content|ac|out-file|new-item|ni|remove-item|rm|ri|clear-content|copy-item|copy|cp|move-item|move|mv|rename-item|ren|tee-object|tee|touch|del|erase|rmdir|rd|mkdir|md|mklink)\b([^;&|]*)/gi;

/** 以"输出路径"为语义的外部程序（含 `git clone` / `npm install --prefix` 这类子命令形式） */
const WRITE_PROGRAM_PATTERN =
  /(?:^|[;&|("'])\s*(?:robocopy|xcopy|curl|wget|iwr|invoke-webrequest|expand-archive|compress-archive|start-bitstransfer|tar|7z|git\s+clone|npm\s+(?:install|ci|i|link|pack))\b([^;&|]*)/gi;

/** 命令是否通过解释器包裹（此时引号内文本需要参与扫描） */
const INTERPRETER_INVOCATION = /(?:^|[;&|(])\s*(?:powershell|pwsh|cmd|bash|sh|zsh)\b/i;

/** 伪目标/开关：`-Path` `--force` `-rf` 与 cmd 的 `/F /S`（Windows 上 `/F` 会被 isAbsolute 误判为绝对路径） */
function isSwitch(t: string): boolean {
  return /^-[A-Za-z-]+$/.test(t) || /^\/[A-Za-z-]+$/.test(t);
}

/** URL / 协议相对引用：不参与路径解析（否则 `//host/x` 会被当成 UNC 绝对路径） */
function isUrlLike(t: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("//");
}

/**
 * 是否"像路径"的目标 token。
 * 只取明确带路径特征的 token，避免把 `-Encoding utf8` 的值、`-ItemType Directory` 的值、
 * `rm -rf` 之类的开关误当写入目标。
 */
function looksLikePath(t: string): boolean {
  if (!t || isSwitch(t) || isUrlLike(t)) return false;
  if (/^--?[A-Za-z][\w-]*=/.test(t)) return true; // --output=… / -Path=… 等带值开关
  if (isAbsolute(t)) return true;
  if (t === ".." || t === ".") return t === "..";
  if (/^\.\.?[\\/]/.test(t)) return true;
  if (/[\\/]/.test(t)) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(t);
}

/** 取片段中所有"像路径"的 token（写入类命令的源与目标都要校验，不能只看第一个） */
function pathTokens(rest: string): string[] {
  const tokens = rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.replace(/^["']|["']$/g, "").trim();
    if (looksLikePath(t)) out.push(t);
  }
  return out;
}

/** 把引号内文本替换为等长空白（长度不变，便于用同一索引回取原文中的真实参数） */
function maskQuoted(command: string): string {
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch !== '"' && ch !== "'") {
      out += ch;
      continue;
    }
    const end = command.indexOf(ch, i + 1);
    if (end === -1) {
      out += ch;
      continue;
    }
    out += ch + " ".repeat(end - i - 1) + ch;
    i = end;
  }
  return out;
}

/** 在掩码文本上定位写入类片段，但用原文取参数（引号包裹的真实路径不能被掩掉） */
function collectCommandTargets(command: string, masked: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  for (const pattern of [WRITE_CMD_PATTERN, WRITE_PROGRAM_PATTERN]) {
    pattern.lastIndex = 0;
    while ((m = pattern.exec(masked))) {
      const seg = m[1] ?? "";
      const start = m.index + m[0].length - seg.length;
      out.push(...pathTokens(command.slice(start, start + seg.length)));
    }
  }
  return out;
}

/**
 * 收集重定向目标。非包裹命令做引号感知扫描（`echo "a > b"` 不是重定向）；
 * 解释器包裹时按引号不敏感扫描（`cmd /c "echo x > out"` 的引号是外壳语法，需参与判定）。
 */
function redirectTargets(command: string, quoteAware: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quoteAware && (ch === '"' || ch === "'")) {
      const quote = ch;
      i++;
      while (i < command.length && command[i] !== quote) i++;
      continue;
    }
    if (ch !== ">") continue;
    const prev = command[i - 1] ?? "";
    if (/[0-9&]/.test(prev)) continue; // 2>&1 / >&2 之类文件描述符重定向
    let j = i + 1;
    if (command[j] === ">") j++;
    while (command[j] === " " || command[j] === "\t") j++;
    const quote = command[j];
    let target = "";
    if (quote === '"' || quote === "'") {
      const end = command.indexOf(quote, j + 1);
      if (end !== -1) {
        target = command.slice(j + 1, end);
        i = end;
      }
    } else {
      const m = /^[^\s;&|)"]+/.exec(command.slice(j));
      if (m) {
        target = m[0];
        i = j + m[0].length - 1;
      }
    }
    if (target) out.push(target);
  }
  return out;
}

/**
 * 写入目标越界检查（启发式，fail-closed）：
 * - 重定向 `>` / `>>` 的目标
 * - 写入类命令/程序（含别名）片段内**所有**像路径的 token（源与目标都查）
 * - 含变量/通配（$ %）而无法静态解析的目标直接拒绝，提示改用 fs_write
 * 不覆盖：解释器脚本体内的写入（`python -c`、`node -e`）、未列举的第三方程序、
 *         管道下游程序的写入、`cd` 之后的相对路径归属、命令位置之外的写入（如 `cmd /c del x`）。
 */
export function checkWriteTargets(command: string, cwd: string, writeRoots: string[]): SandboxCheckResult {
  const base = resolve(cwd);
  const wrapped = INTERPRETER_INVOCATION.test(command);
  const targets: string[] = redirectTargets(command, !wrapped);
  targets.push(...collectCommandTargets(command, wrapped ? command : maskQuoted(command)));

  for (const raw of targets) {
    const t = raw.trim();
    if (!t || IGNORED_WRITE_TARGETS.has(t.toLowerCase())) continue;
    if (/[$%~]/.test(t)) {
      return {
        allowed: false,
        reason: `写入目标无法静态解析（含变量/通配/主目录）: ${t}。请使用明确路径，或改用 fs_write 工具`,
      };
    }
    // 相对路径**按原样拼接**（不折叠 `..`）：shell/内核拿到的是命令原文，
    // 只有按组件次序解析（先解开链接、再弹 `..`）才与真实写入位置一致
    const abs = isAbsolute(t) ? t : `${base}${sep}${t}`;
    const decision = evaluatePath("write", abs, { enabled: true, readRoots: [], writeRoots });
    if (!decision.allowed) return { allowed: false, reason: decision.reason };
  }
  return { allowed: true };
}

export function checkDeniedCommand(command: string, policy: SandboxPolicy): SandboxCheckResult {
  if (!policy.enabled) return { allowed: true };
  const lower = command.toLowerCase();
  for (const deny of policy.denyCommands) {
    if (lower.includes(deny.toLowerCase())) {
      return { allowed: false, reason: `命令被沙箱策略拦截: ${deny}` };
    }
  }
  return { allowed: true };
}

/**
 * 应用能力强制层（Sprint 34，先于权限层检查）
 * storage 自动允许（沙箱 data/ 内）；其余能力须静态声明命中，未命中由调用方走 ask 通道
 */
export function checkAppCapability(appId: string, capability: string, declared: string[]): SandboxCheckResult {
  if (capability === "storage") return { allowed: true };
  const perm = capability === "http" ? "network" : capability === "fs" ? "fs:data" : capability;
  const hit = declared.some((p) => (perm === "fs:data" ? p.startsWith("fs:") : p === perm));
  return hit
    ? { allowed: true }
    : { allowed: false, reason: `应用 ${appId} 未声明权限: ${perm}` };
}
