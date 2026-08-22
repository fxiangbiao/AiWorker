/**
 * 策略化命令沙箱（对齐 DSH 沙箱思想，个人项目务实路径）
 * 纵深：cwd 越界约束（fail-closed）+ 配置化命令黑名单 + 敏感环境变量清理
 * 说明：不做 OS 级进程沙箱（bwrap/restricted-token）——Node 无原生 API、
 *       自研风险高、本项目信任模型为本人执行；叠加 danger-detector /
 *       路径校验 / 超时 / 输出截断构成多层防御。
 */

import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface SandboxPolicy {
  enabled: boolean;
  allowDirs: string[];
  denyCommands: string[];
  stripSecretEnv: boolean;
}

const DEFAULT_POLICY: SandboxPolicy = {
  enabled: true,
  allowDirs: [],
  denyCommands: [],
  stripSecretEnv: true,
};

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

export function loadSandboxPolicy(configPath?: string): SandboxPolicy {
  try {
    const path = configPath ?? resolve(import.meta.dirname, "../../config/sandbox.json");
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<SandboxPolicy>;
    return {
      enabled: parsed.enabled ?? DEFAULT_POLICY.enabled,
      allowDirs: Array.isArray(parsed.allowDirs) ? parsed.allowDirs.map((d) => resolve(d)) : [],
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

function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function checkCommand(
  command: string,
  cwd: string,
  workingDir: string,
  policy: SandboxPolicy,
): SandboxCheckResult {
  if (!policy.enabled) return { allowed: true };
  const base = resolve(cwd);
  const roots = policy.allowDirs.length > 0 ? policy.allowDirs : [resolve(workingDir)];
  if (!roots.some((root) => isInsideDir(root, base))) {
    return {
      allowed: false,
      reason: `工作目录越界被沙箱拦截: ${base}（仅允许 ${roots.join("、")} 内）`,
    };
  }
  return checkDeniedCommand(command, policy);
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
