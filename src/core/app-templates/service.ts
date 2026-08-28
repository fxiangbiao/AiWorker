/**
 * service 模板（Sprint 35 v2）
 * Node 常驻后台服务（同 tool 结构 + autostart 可选）
 */

import type { AppSpec, AppTemplate } from "../../types.js";
import { toolSystemPrompt, toolFileTaskPrompt } from "./tool.js";

export const serviceTemplate: AppTemplate = {
  id: "service",
  type: "service",
  name: "后台服务",
  description: "常驻后台服务（心跳监控 + 崩溃自动重启 + autostart）",
  structure: `data/apps/<id>/
  app.json    manifest（type: "service"，autostart: true 可选）
  index.mjs   入口（默认导出 { handleTool(name, args, ctx) } 或 { onStart(ctx) }）`,
  allowedPermissions: ["notify", "llm", "fs:data/apps/{id}", "network"],
  steps: [{ id: "service", label: "服务实现" }],
};

/** 生成 agent 系统提示（v2；复用 tool 提示 + 服务化要求） */
export function serviceSystemPrompt(spec: AppSpec): string {
  const inner = toolSystemPrompt(spec);
  return `${inner}

# 服务化要求（后台常驻服务）
- manifest type 用 "service"；可声明 "autostart": true
- 入口默认导出 handleTool(name, args, ctx)（可被 LLM 调用）或 onStart(ctx)
- 可自行 setInterval 轮询执行周期任务（ctx 提供定时器能力）`;
}

/** 任务消息（v2） */
export function serviceTaskPrompt(spec: AppSpec): string {
  return `请生成一个后台常驻服务：${spec.description}`;
}

/** 单文件重生成任务消息（update） */
export function serviceFileTaskPrompt(spec: AppSpec, path: string, existingDesc: string): string {
  return toolFileTaskPrompt(spec, path, existingDesc);
}
