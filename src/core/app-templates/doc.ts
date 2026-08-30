/**
 * doc 模板（Sprint 35 v2）
 * 文档型产出：report.md（+ 可选 data.json 图表数据）→ 落 data/docs/<sessionId>/
 * v2 生成：模型经 agent-loop 用 fs_write 工具写文件
 */

import type { AppSpec, AppTemplate } from "../../types.js";

export const docTemplate: AppTemplate = {
  id: "doc",
  type: "skill",
  name: "文档",
  description: "结构化文档产出（Markdown + 可选图表数据，文档工作台渲染）",
  structure: `report.md         Markdown 报告（# 标题 / ## 章节 / 列表 / 表格）
data.json         可选图表数据（{"chart":{"type":"bar|line","labels":[...],"values":[...]}}）`,
  allowedPermissions: [],
  steps: [{ id: "doc", label: "文档撰写" }],
};

/** 生成 agent 系统提示（v2） */
export function docSystemPrompt(spec: AppSpec): string {
  return `你是 AI OS 的文档生成器。根据用户描述撰写一份结构化文档。

# 文档要求
${spec.description}

# 产出文件（全部写入当前工作目录，目录已存在）
- report.md（必需）：
  - 第一行是 "# 标题"（≤30 字符）
  - 用 ## 二级标题分章节（3-8 章），每章 2-6 个要点
  - 适当使用表格/列表
- data.json（可选）：若内容含可量化的对比/趋势，提供 {"chart":{"type":"bar|line","labels":["..."],"values":[数字]}}；否则写 {}（空 JSON 对象）

# 语言
与用户描述一致（默认中文）

# 写入方式（重要）
- 必须用 fs_write 工具把文件写入工作目录，不要把文档内容输出到聊天文本里。
- 每次 fs_write 写入一个文件的完整内容；写多个文件就调用多次。
- 写完后用 fs_list / fs_read 自查文件是否齐全完整。

# 完成条件
所有文件写完并自查通过后，直接输出完成总结，不要再调用工具。`;
}

/** 任务消息（v2） */
export function docTaskPrompt(spec: AppSpec): string {
  return `请撰写一份文档：${spec.description}`;
}
