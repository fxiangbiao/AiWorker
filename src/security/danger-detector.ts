/**
 * 危险操作检测器
 * 设计依据：调研报告 6.3 节——高危操作正则拦截
 */

import type { PermissionMode } from "../types.js";

// 默认拦截的高危操作 (Craft 模式下需二次确认)
const DANGEROUS_PATTERNS = [
  // 文件系统
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /rm\s+-rf\s+\$HOME/i,
  /del\s+\/s\s+\/q/i,
  /rmdir\s+\/s/i,
  /Remove-Item.*-Recurse.*-Force/i,
  // 数据库
  /DROP\s+(TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
  /TRUNCATE\s+TABLE/i,
  // Git
  /git\s+push\s+--force/i,
  /git\s+push\s+-f\b/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-fd/i,
  // 系统
  /format\s+[a-z]:/i,
  /shutdown|reboot/i,
  /mkfs/i,
  /dd\s+if=/i,
];

export interface DangerCheckResult {
  isDangerous: boolean;
  matchedPattern?: string;
  level: "safe" | "warning" | "danger";
  message?: string;
}

export class DangerDetector {
  private customPatterns: RegExp[] = [];

  constructor(customPatterns?: string[]) {
    if (customPatterns) {
      this.customPatterns = customPatterns.map((p) => new RegExp(p, "i"));
    }
  }

  /**
   * 检测命令或操作是否危险
   */
  check(input: string): DangerCheckResult {
    const allPatterns = [...DANGEROUS_PATTERNS, ...this.customPatterns];

    for (const pattern of allPatterns) {
      if (pattern.test(input)) {
        return {
          isDangerous: true,
          matchedPattern: pattern.source,
          level: "danger",
          message: `检测到高危操作模式: ${pattern.source}`,
        };
      }
    }

    // 文件写入类操作 — 警告级别
    if (/\.env|\.ssh|\.aws|id_rsa|credentials/i.test(input)) {
      return {
        isDangerous: false,
        level: "warning",
        message: "操作涉及敏感文件，请确认",
      };
    }

    return { isDangerous: false, level: "safe" };
  }

  /**
   * 根据权限模式决定是否需要确认
   * - ask: 不执行工具，无需确认
   * - plan: 需确认
   * - craft: 仅高危需确认
   */
  needsConfirmation(input: string, mode: PermissionMode): boolean {
    if (mode === "plan") return true;
    if (mode === "craft") {
      const result = this.check(input);
      return result.isDangerous || result.level === "warning";
    }
    return false;
  }
}
