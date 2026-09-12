/**
 * 测试共享工具 — 每个测试文件独立的 data 目录（避免并行 worker 冲突）
 */

import { join, resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { initAuditLog, auditLogger } from "../src/core/audit-logger.js";
import { toolRegistry } from "../src/core/tool-registry.js";

const baseDir = resolve(process.cwd(), "data-test");

/** CI/受限机器模拟：`AIW_NO_LINKS=1` 所有链接失败；`AIW_NO_FILE_LINKS=1` 仅文件符号链接失败（Windows 无开发者模式的真实情形） */
const FORCE_NO_LINKS = process.env.AIW_NO_LINKS === "1";
const FORCE_NO_FILE_LINKS = FORCE_NO_LINKS || process.env.AIW_NO_FILE_LINKS === "1";

/** 目录链接：Windows 用 junction（创建它不需要管理员或开发者模式），其余平台普通目录符号链接 */
export function makeDirLink(linkPath: string, target: string): boolean {
  if (FORCE_NO_LINKS) return false;
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/** 文件符号链接：Windows 上需要开发者模式或管理员权限（无权限时 EPERM） */
export function makeFileLink(linkPath: string, target: string): boolean {
  if (FORCE_NO_FILE_LINKS) return false;
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

/** 悬空链接（目标不存在）：Windows 走 junction 以免依赖开发者模式，其余平台走文件符号链接 */
export function makeDanglingLink(linkPath: string, missingTarget: string): boolean {
  return process.platform === "win32" ? makeDirLink(linkPath, missingTarget) : makeFileLink(linkPath, missingTarget);
}

function probeLink(kind: "dir" | "file"): boolean {
  const dir = resolve(tmpdir(), `aiworker-link-probe-${kind}-${process.pid}-${Date.now()}`);
  const target = join(dir, "target");
  try {
    mkdirSync(kind === "dir" ? target : dir, { recursive: true });
    if (kind === "file") writeFileSync(target, "x", "utf-8");
    const ok = (kind === "dir" ? makeDirLink : makeFileLink)(join(dir, "link"), target);
    rmSync(dir, { recursive: true, force: true });
    return ok;
  } catch {
    return false;
  }
}

/** 目录链接能力：不具备时相关用例显式 skip（vitest 报 skipped，不静默通过） */
export const DIR_LINK_SUPPORTED = probeLink("dir");

/** 文件符号链接能力：Windows 无开发者模式/管理员权限时为 false */
export const FILE_LINK_SUPPORTED = probeLink("file");

/** 悬空链接能力：按平台对应的创建方式探测 */
export const DANGLING_LINK_SUPPORTED = process.platform === "win32" ? DIR_LINK_SUPPORTED : FILE_LINK_SUPPORTED;

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
