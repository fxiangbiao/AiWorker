/**
 * 测试共享工具 — 每个测试文件独立的 data 目录（避免并行 worker 冲突）
 */

import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { initAuditLog, auditLogger } from "../src/core/audit-logger.js";
import { toolRegistry } from "../src/core/tool-registry.js";

const baseDir = resolve(process.cwd(), "data-test");

/** 为当前测试文件创建独立数据目录并返回路径 */
export function makeTestDir(name: string): string {
  const dir = resolve(baseDir, name);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 注册内置工具（幂等）+ 审计日志 */
export function setupEnv(dir: string): void {
  registerBuiltinTools();
  initAuditLog(dir);
}

/** 清理审计日志句柄（配合 afterAll） */
export function teardownEnv(): void {
  try {
    auditLogger.close();
  } catch {
    /* ignore */
  }
}

/** 清空工具注册表（测试隔离用） */
export function clearTools(): void {
  toolRegistry.clear();
}
