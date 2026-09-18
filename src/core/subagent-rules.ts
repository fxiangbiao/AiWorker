/**
 * 子智能体规则常量（Sprint 52）— 无依赖模块，供 agent-loop / subagent-tools / subagent-runner 共用
 * 独立成模块的原因：避免 subagent-runner ↔ subagent-tools 的循环导入
 */

/** 控制类工具：仅主智能体可显式启用；子智能体工具面一律剔除（深度 1） */
export const RESTRICTED_TOOLS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_message",
  "list_agents",
  "interrupt_agent",
]);

export function isRestrictedTool(name: string): boolean {
  return RESTRICTED_TOOLS.has(name);
}

/** 只读闭集（Sprint 52 §2.3-7）：readOnly 子智能体仅可见这四个工具，无 MCP/插件豁免 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["fs_read", "fs_list", "web_search", "web_fetch"]);