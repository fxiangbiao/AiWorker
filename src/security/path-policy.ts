/**
 * 路径策略单点（Sprint 49 / P1-7）
 * 一处回答"这个路径能不能读/写"：读根、写根、符号链接真实路径、开关
 * 命令沙箱（terminal_exec）与 fs 四件套共用；受保护路径的"需确认"语义仍在审批层（PermissionModel）
 * 判定为 fail-closed：真实路径无法解析时按越界处理
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export type PathAccessKind = "read" | "write";

/** 路径根配置（SandboxPolicy 结构子集，避免与 sandbox.ts 形成循环依赖） */
export interface PathRootsConfig {
  enabled?: boolean;
  allowReadDirs?: string[];
  allowWriteDirs?: string[];
}

export interface PathPolicy {
  enabled: boolean;
  readRoots: string[];
  writeRoots: string[];
}

export interface PathDecision {
  allowed: boolean;
  /** 解析真实路径后的绝对路径（供审计/展示） */
  resolved: string;
  reason?: string;
}

const MAX_COMPONENTS = 512;
const SEP = sep;
const SEP_RE = /[\\/]+/;

function tryRealpath(path: string): string | null {
  for (const fn of [realpathSync.native, realpathSync]) {
    try {
      const real = fn(path);
      if (real) return real;
    } catch {
      /* 换下一个实现 */
    }
  }
  return null;
}

/**
 * 解析真实路径（Sprint 49 修复：组件级解析，fail-closed）
 * - 从盘根开始**逐组件**解析：每个存在组件都做 realpath（符号链接/junction 被解开），
 *   不存在的组件按词法拼在后面；`..` 在**解析之后**才弹出，与内核逐组件跟随链接的语义一致
 *   （`link\..\x` 中 link 先被解开，再对真实父目录弹一层）
 * - 悬空链接、符号链接环、权限不足、组件数超限 → 返回 null（调用方按拒绝处理），绝不退化成纯词法判定
 */
export function resolveRealPath(target: string): string | null {
  // 绝对路径**不预先折叠** `..`：交给下面的组件循环按"先解开链接、再弹一层"处理（与内核一致）
  const abs = isAbsolute(target) ? target : resolve(target);
  const root = parse(abs).root;
  const parts = abs.slice(root.length).split(SEP_RE).filter((p) => p !== "");
  const rootReal = tryRealpath(root);
  if (rootReal === null) return null;
  let current = rootReal;

  let hops = 0;
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      const parent = dirname(current);
      if (parent !== "") current = parent;
      continue;
    }
    if (++hops > MAX_COMPONENTS) return null;
    const candidate = current.endsWith(SEP) ? `${current}${part}` : `${current}${SEP}${part}`;
    if (existsNoFollow(candidate)) {
      const real = tryRealpath(candidate);
      if (real === null) return null;
      current = real;
    } else {
      current = candidate;
    }
  }
  return current;
}

/** 是否存在（不跟随链接本身：lstat 抛 ENOENT/ENOTDIR 才算不存在，其余错误按"存在但不可解析"处理） */
function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** 目标是否落在根内（含根自身）；`..` 开头的合法文件名（如 `..data`）不算越界 */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${SEP}`) && !isAbsolute(rel));
}

/** 根列表：留空回退 fallback；逐项解析真实路径并去重（无法解析的根直接丢弃，宁严不宽） */
export function resolveRoots(dirs: string[] | undefined, fallback: string): string[] {
  const list = dirs && dirs.length > 0 ? dirs : [fallback];
  const out: string[] = [];
  for (const dir of list) {
    const real = resolveRealPath(dir);
    if (real !== null && !out.includes(real)) out.push(real);
  }
  return out;
}

export function buildPathPolicy(workingDir: string, config: PathRootsConfig = {}): PathPolicy {
  return {
    enabled: config.enabled ?? true,
    readRoots: resolveRoots(config.allowReadDirs, workingDir),
    writeRoots: resolveRoots(config.allowWriteDirs, workingDir),
  };
}

/** Windows 保留设备名：写它们会被当设备处理（内容丢弃），工具却回报"已写入文件"——直接拒绝 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 目标是否为 Windows 保留设备名或 NTFS 备用数据流（ADS）。
 * POSIX 上 `:` 是合法文件名字符，故只在 win32 生效。
 */
function isReservedTarget(resolved: string): string | null {
  if (process.platform !== "win32") return null;
  const name = resolved.split(/[\\/]/).pop() ?? "";
  if (WINDOWS_RESERVED.test(name)) return `目标是 Windows 保留设备名（${name}），不按普通文件处理`;
  // ADS 形如 a.txt:stream；盘符里的冒号在 basename 中不会出现
  if (name.includes(":")) return `目标是 NTFS 备用数据流（${name}），不支持写入`;
  return null;
}

/**
 * 判定读/写是否允许。
 * rawPath 为相对路径时按 baseDir（缺省 process.cwd()）解析；空路径与**无法解析的真实路径**一律拒绝（fail-closed）
 */
export function evaluatePath(
  kind: PathAccessKind,
  rawPath: string,
  policy: PathPolicy,
  baseDir?: string,
): PathDecision {
  const label = kind === "write" ? "写入" : "读取";
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { allowed: false, resolved: "", reason: `${label}路径为空` };
  }
  const abs = isAbsolute(rawPath) ? rawPath : resolve(baseDir ?? process.cwd(), rawPath);
  const resolved = resolveRealPath(abs);
  if (resolved === null) {
    return {
      allowed: false,
      resolved: abs,
      reason: `${label}路径无法解析为真实路径（悬空符号链接/链接环/权限不足），已按拒绝处理: ${abs}`,
    };
  }
  const reserved = isReservedTarget(resolved);
  if (reserved) return { allowed: false, resolved, reason: reserved };
  if (!policy.enabled) return { allowed: true, resolved };
  const roots = kind === "write" ? policy.writeRoots : policy.readRoots;
  if (roots.length > 0 && roots.some((root) => isInsideDir(root, resolved))) {
    return { allowed: true, resolved };
  }
  const hint = kind === "read" ? "；可在 config/sandbox.json 的 allowReadDirs 放宽读取范围" : "";
  const scope = roots.length === 0 ? "未配置任何可用根" : `仅允许${label} ${roots.join("、")} 内`;
  return {
    allowed: false,
    resolved,
    reason: `${label}越界被路径策略拦截: ${resolved}（${scope}${hint}）`,
  };
}

let override: PathPolicy | null = null;

/** 注入策略（测试与装配层用）；传 null 恢复按配置构造 */
export function setPathPolicyOverride(policy: PathPolicy | null): void {
  override = policy;
}

export function getPathPolicyOverride(): PathPolicy | null {
  return override;
}

/** 取生效策略：优先注入值，否则按工作目录与配置构造 */
export function resolvePathPolicy(workingDir: string, config: PathRootsConfig = {}): PathPolicy {
  return override ?? buildPathPolicy(workingDir, config);
}
