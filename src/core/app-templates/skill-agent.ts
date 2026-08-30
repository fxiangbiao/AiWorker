/**
 * skill / agent 模板（Sprint 35 v2）
 * skill: SKILL.md（frontmatter + body）→ 沙箱 + reloadSkill 注册
 * agent: 人设包（agent.yaml）→ 元数据管理（运行时路由注册留后续）
 * v2 生成：模型经 agent-loop 用 fs_write 工具写文件
 */

import type { AppSpec, AppTemplate } from "../../types.js";

export const skillTemplate: AppTemplate = {
  id: "skill",
  type: "skill",
  name: "技能",
  description: "SKILL.md 技能包（触发词 + 专家 + 操作指南）",
  structure: `data/apps/<id>/
  app.json  manifest（type: "skill"）
  SKILL.md  YAML frontmatter（name/description/triggers/expert）+ body`,
  allowedPermissions: [],
  steps: [{ id: "skill", label: "技能撰写" }],
};

/** 生成 agent 系统提示（v2） */
export function skillSystemPrompt(spec: AppSpec): string {
  return `你是 AI OS 的技能生成器。根据用户描述生成一个 SKILL.md 技能。

# 技能要求
${spec.description}

# 产出文件（全部写入当前工作目录，目录已存在）
- SKILL.md：
  ---
  name: <技能名>
  description: <一句话>
  triggers: [<正则触发词>]
  expert: <适用专家: coding|research|data-analysis|product-ops|financial|game-dev|general>
  ---
  <操作指南 body：步骤化、可执行>
- app.json：{"id":"<kebab-case>","type":"skill","name":"<名称>","version":"1.0.0","description":"<一句话>","entry":"SKILL.md","permissions":[]}
  注意：id 最终会被宿主覆盖为生成 id

# 写入方式（重要）
- 必须用 fs_write 工具把文件写入工作目录，不要把内容输出到聊天文本里。
- 每次 fs_write 写入一个文件的完整内容；写完后用 fs_list / fs_read 自查。

# 完成条件
所有文件写完并自查通过后，直接输出完成总结，不要再调用工具。`;
}

/** 任务消息（v2） */
export function skillTaskPrompt(spec: AppSpec): string {
  return `请生成一个技能：${spec.description}`;
}

export const agentTemplate: AppTemplate = {
  id: "agent",
  type: "agent",
  name: "智能体人设",
  description: "人设助手包（agent.yaml：prompt/工具/技能引用）——MVP 仅生成与元数据管理",
  structure: `data/apps/<id>/
  app.json   manifest（type: "agent"）
  agent.yaml 人设（name/displayName/systemPrompt/tools）`,
  allowedPermissions: [],
  steps: [{ id: "agent", label: "人设撰写" }],
};

/** 生成 agent 系统提示（v2） */
export function agentSystemPrompt(spec: AppSpec): string {
  return `你是 AI OS 的智能体生成器。根据用户描述生成一个智能体人设包。

# 人设要求
${spec.description}

# 产出文件（全部写入当前工作目录，目录已存在）
- agent.yaml：{"name":"<英文id>","displayName":"<中文名>","systemPrompt":"<角色+能力+边界>","tools":[]}
- app.json：{"id":"<kebab-case>","type":"agent","name":"<名称>","version":"1.0.0","description":"<一句话>","entry":"agent.yaml","permissions":[]}
  注意：id 最终会被宿主覆盖为生成 id

# 写入方式（重要）
- 必须用 fs_write 工具把文件写入工作目录，不要把内容输出到聊天文本里。
- 每次 fs_write 写入一个文件的完整内容；写完后用 fs_list / fs_read 自查。

# 完成条件
所有文件写完并自查通过后，直接输出完成总结，不要再调用工具。`;
}

/** 任务消息（v2） */
export function agentTaskPrompt(spec: AppSpec): string {
  return `请生成一个智能体人设：${spec.description}`;
}
