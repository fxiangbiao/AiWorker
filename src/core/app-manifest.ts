/**
 * 应用清单校验（Sprint 34）
 * data/apps/<id>/app.json 的 schema 校验：
 * - 硬约束：terminal 权限被禁用；权限白名单；工具声明合法
 * - fs 权限仅允许沙箱内（data/apps/<id>/）
 */

import { resolve, relative, isAbsolute } from "node:path";
import type { AppManifest, AppPermission, AppToolDecl, AppType } from "../types.js";

export class AppManifestError extends Error {}

const APP_TYPES: AppType[] = ["tool", "skill", "agent", "service", "app"];
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 权限合法性：network/notify/llm 或 fs: 沙箱内路径 */
export function isValidPermission(p: unknown, appId?: string): p is AppPermission {
  if (typeof p !== "string") return false;
  if (p === "network" || p === "notify" || p === "llm") return true;
  if (p === "terminal") return false;
  if (p.startsWith("fs:")) {
    const target = p.slice(3);
    if (!appId) return false;
    const root = resolve("data", "apps", appId);
    const abs = resolve(root, target);
    const rel = relative(root, abs);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }
  return false;
}

function validateToolDecl(t: unknown): AppToolDecl {
  if (!isPlainObject(t)) throw new AppManifestError("工具声明必须是对象");
  const name = t.name;
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    throw new AppManifestError(`工具名非法: ${String(name)}（^[a-z][a-z0-9_]{1,63}$）`);
  }
  const description = t.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new AppManifestError(`工具 ${name} 缺少 description`);
  }
  const parameters = t.parameters;
  if (!isPlainObject(parameters) || parameters.type !== "object") {
    throw new AppManifestError(`工具 ${name} parameters 必须是 {type:"object",...}`);
  }
  return { name, description: description.trim(), parameters: parameters as unknown as AppToolDecl["parameters"] };
}

/** 校验 manifest；非法抛 AppManifestError */
export function validateAppManifest(raw: unknown): AppManifest {
  if (!isPlainObject(raw)) throw new AppManifestError("manifest 必须是 JSON 对象");
  const m = raw as Record<string, unknown>;

  const id = m.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new AppManifestError(`id 非法: ${String(id)}（kebab-case，小写字母开头，≤64 字符）`);
  }

  const type = m.type;
  if (typeof type !== "string" || !APP_TYPES.includes(type as AppType)) {
    throw new AppManifestError(`type 非法: ${String(type)}（${APP_TYPES.join("/")}）`);
  }

  const name = m.name;
  if (typeof name !== "string" || name.trim().length === 0) throw new AppManifestError("缺少 name");

  const version = m.version;
  if (typeof version !== "string" || version.trim().length === 0) throw new AppManifestError("缺少 version");

  const description = m.description;
  if (typeof description !== "string" || description.trim().length === 0) throw new AppManifestError("缺少 description");

  const entry = m.entry;
  if (typeof entry !== "string" || entry.trim().length === 0) throw new AppManifestError("缺少 entry");
  if (entry.includes("..") || entry.startsWith("/") || /^[a-zA-Z]:/.test(entry)) {
    throw new AppManifestError(`entry 非法（必须为沙箱内相对路径）: ${entry}`);
  }

  // 权限白名单（terminal 拒绝）
  const rawPerms = m.permissions === undefined ? [] : m.permissions;
  if (!Array.isArray(rawPerms)) throw new AppManifestError("permissions 必须是数组");
  const permissions: AppPermission[] = [];
  for (const p of rawPerms) {
    if (p === "terminal") throw new AppManifestError("权限 terminal 被禁用（MVP 无 shell 执行权限）");
    if (!isValidPermission(p, id as string)) {
      throw new AppManifestError(`权限非法: ${String(p)}（network/notify/llm 或 fs:沙箱内路径）`);
    }
    permissions.push(p as AppPermission);
  }

  // 工具声明
  const rawTools = m.tools === undefined ? [] : m.tools;
  if (!Array.isArray(rawTools)) throw new AppManifestError("tools 必须是数组");
  const tools: AppToolDecl[] = [];
  for (const t of rawTools) tools.push(validateToolDecl(t));

  // lifecycle（可选，仅校验函数名形式）
  const rawLifecycle = m.lifecycle;
  if (rawLifecycle !== undefined && !isPlainObject(rawLifecycle)) throw new AppManifestError("lifecycle 必须是对象");
  const lifecycle = rawLifecycle as Record<string, unknown> | undefined;
  for (const key of ["onStart", "onStop", "onDestroy"] as const) {
    const v = lifecycle?.[key];
    if (v !== undefined && typeof v !== "string") throw new AppManifestError(`lifecycle.${key} 必须是字符串`);
  }

  const originSessionId = m.originSessionId;
  if (originSessionId !== undefined && typeof originSessionId !== "string") {
    throw new AppManifestError("originSessionId 必须是字符串");
  }

  const autostart = m.autostart === undefined ? false : m.autostart;
  if (typeof autostart !== "boolean") throw new AppManifestError("autostart 必须是布尔值");

  // ui（webapp 窗口形态：panel/float/widget）
  let ui: { surface?: string } | undefined;
  if (m.ui !== undefined) {
    if (typeof m.ui !== "object" || m.ui === null || Array.isArray(m.ui)) throw new AppManifestError("ui 必须是对象");
    const s = (m.ui as Record<string, unknown>).surface;
    if (s !== undefined && s !== "panel" && s !== "float" && s !== "widget") {
      throw new AppManifestError(`ui.surface 非法: ${String(s)}（panel/float/widget）`);
    }
    ui = s === undefined ? {} : { surface: s as string };
  }

  return {
    id: id as string,
    type: type as AppType,
    name: name.trim(),
    version: version.trim(),
    description: description.trim(),
    entry: entry.trim(),
    permissions,
    tools,
    lifecycle: lifecycle as AppManifest["lifecycle"],
    originSessionId: originSessionId as string | undefined,
    autostart,
    ui: ui as AppManifest["ui"],
  };
}
