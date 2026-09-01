/**
 * 审计日志单例
 * 全局共享一个 AuditLog 实例
 */

import { AuditLog } from "../security/audit-log.js";
import { resolve } from "node:path";

let instance: AuditLog | null = null;

export function initAuditLog(dataDir: string): AuditLog {
  if (instance) {
    instance.close();
  }
  instance = new AuditLog(resolve(dataDir, "audit.db"));
  return instance;
}

export const auditLogger = {
  log(entry: Parameters<AuditLog["log"]>[0]): void {
    if (!instance) {
      // 延迟初始化：如果没初始化，写入默认位置
      instance = new AuditLog(resolve(process.cwd(), "data", "audit.db"));
    }
    instance.log(entry);
  },
  queryBySession(sessionId: string) {
    if (!instance) return [];
    return instance.queryBySession(sessionId);
  },
  queryRecent(limit?: number, actionPrefix?: string) {
    if (!instance) return [];
    return instance.queryRecent(limit, actionPrefix);
  },
  countByAction(action: string): number {
    if (!instance) return 0;
    return instance.countByAction(action);
  },
  close(): void {
    if (instance) {
      instance.close();
      instance = null;
    }
  },
};
