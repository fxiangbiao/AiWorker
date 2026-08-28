/**
 * 模板注册表（Sprint 35 v2）
 * 按描述识别产出类型 + 模板/提示词分发
 * v2 生成模式：所有模板提供「生成 agent」系统提示 + 任务消息，
 * 模型经 agent-loop 用 fs_write 工具写文件（与智能体对话写文件无区别，无分块拼接）
 */

import type { AppSpec, AppTemplate } from "../../types.js";
import {
  webappTemplate,
  webappSystemPrompt,
  webappTaskPrompt,
  webappFileTaskPrompt,
} from "./webapp.js";
import { toolTemplate, toolSystemPrompt, toolTaskPrompt, toolFileTaskPrompt } from "./tool.js";
import { docTemplate, docSystemPrompt, docTaskPrompt } from "./doc.js";
import { serviceTemplate, serviceSystemPrompt, serviceTaskPrompt, serviceFileTaskPrompt } from "./service.js";
import { skillTemplate, skillSystemPrompt, skillTaskPrompt, agentTemplate, agentSystemPrompt, agentTaskPrompt } from "./skill-agent.js";

export interface TemplateDef {
  template: AppTemplate;
  /** 生成 agent 系统提示（应用描述/目录约定/能力桥/fs_write 用法/完成条件） */
  buildSystemPrompt: (spec: AppSpec) => string;
  /** 任务消息（发起生成请求） */
  buildTaskPrompt: (spec: AppSpec) => string;
  /** 单文件重生成任务消息（update）；缺省则不支持迭代更新 */
  buildFileTaskPrompt?: (spec: AppSpec, path: string, existingDesc: string) => string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  webapp: {
    template: webappTemplate,
    buildSystemPrompt: webappSystemPrompt,
    buildTaskPrompt: webappTaskPrompt,
    buildFileTaskPrompt: webappFileTaskPrompt,
  },
  tool: {
    template: toolTemplate,
    buildSystemPrompt: toolSystemPrompt,
    buildTaskPrompt: toolTaskPrompt,
    buildFileTaskPrompt: toolFileTaskPrompt,
  },
  doc: { template: docTemplate, buildSystemPrompt: docSystemPrompt, buildTaskPrompt: docTaskPrompt },
  service: {
    template: serviceTemplate,
    buildSystemPrompt: serviceSystemPrompt,
    buildTaskPrompt: serviceTaskPrompt,
    buildFileTaskPrompt: serviceFileTaskPrompt,
  },
  skill: { template: skillTemplate, buildSystemPrompt: skillSystemPrompt, buildTaskPrompt: skillTaskPrompt },
  agent: { template: agentTemplate, buildSystemPrompt: agentSystemPrompt, buildTaskPrompt: agentTaskPrompt },
};

/** 描述关键词 → 产出类型识别（启发式，用户可在向导中改） */
export function detectType(description: string): "webapp" | "tool" | "doc" {
  const d = description.toLowerCase();
  if (/报告|方案|文档|总结|周报|月报|分析文章|调研|计划|说明书|README|说明/.test(d)) return "doc";
  if (/工具|脚本|命令|批处理|转换|批量|自动化脚本|抓取|爬虫/.test(d)) return "tool";
  return "webapp";
}

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES[id];
}

export function listTemplates(): AppTemplate[] {
  return Object.values(TEMPLATES).map((t) => t.template);
}
