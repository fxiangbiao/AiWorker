/**
 * 应用沙箱 — 目录隔离 + 路径防护（Sprint 34）
 * data/apps/<id>/ 为应用唯一可写区域；entry/能力路径统一防穿越
 */

import { resolve, relative, isAbsolute } from "node:path";

/** 应用沙箱根目录 */
export function appSandboxDir(dataDir: string, appId: string): string {
  return resolve(dataDir, "apps", appId);
}

/** 相对路径合法性：非空、无 ..、非绝对路径、非盘符 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.includes("..")) return false;
  if (isAbsolute(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  return true;
}

/** target 是否在 root 内（root 本身不算，防应用读写沙箱根元数据） */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 沙箱内绝对路径（非法抛错） */
export function safeResolve(root: string, relPath: string): string {
  if (!isSafeRelativePath(relPath)) {
    throw new Error(`路径非法（必须为沙箱内相对路径）: ${relPath}`);
  }
  const abs = resolve(root, relPath);
  if (!isInsideDir(root, abs)) {
    throw new Error(`路径越界: ${relPath}`);
  }
  return abs;
}
