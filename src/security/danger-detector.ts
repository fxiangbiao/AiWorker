/**
 * 危险操作检测器
 * 设计依据：调研报告 6.3 节——高危操作正则拦截
 */

import type { PermissionMode } from "../types.js";

// 默认拦截的高危操作 (Auto 模式下需二次确认)
const DANGEROUS_PATTERNS = [
  // 文件系统（rm 目标任意：相对路径/引号/盘符均覆盖，大小写不敏感）
  /rm\s+-rf\s+\S+/i, // rm -rf <任意目标>（含相对路径/引号/盘符）
  /rm\s+-r\s+[^\s"']+/i, // 递归删除单个目标（保留）
  /rm\s+-r[f]?\s+["'][^&|;]+["']/i, // rm -r/-rf 引号内目标（含空格路径）
  /rm\s+(?!-)(?:"[^"]+"|\S+)/i, // 删除单个文件 rm <file>（含引号路径，不可逆）
  /del\s+(\/s\s*)?(\/q\s*)?[^\s&|;]+/i, // del <file> 任意 /s /q 顺序（Windows，不可逆）
  /(?:rd|rmdir)\s+\/s\b/i, // rd / rmdir /s（递归删除目录，Windows 别名覆盖）
  /Remove-Item.*-Recurse.*-Force/i,
  /Remove-Item\s+/i, // Remove-Item 任意删除（PowerShell）
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
   * - auto: 仅高危需确认
   */
  needsConfirmation(input: string, mode: PermissionMode): boolean {
    if (mode === "plan") return true;
    if (mode === "auto") {
      const result = this.check(input);
      return result.isDangerous || result.level === "warning";
    }
    return false;
  }
}
