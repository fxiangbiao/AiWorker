/**
 * tool 模板（Sprint 35 v2）
 * Node ESM 子进程应用：默认导出 { handleTool(name, args, ctx) }，仅内置模块 + ctx 能力桥
 * v2 生成：模型经 agent-loop 用 fs_write 工具写 app.json + index.mjs
 */

import type { AppSpec, AppTemplate } from "../../types.js";

export const toolTemplate: AppTemplate = {
  id: "tool",
  type: "tool",
  name: "工具",
  description: "Node 工具应用（子进程运行，LLM 可调用其注册的工具）",
  structure: `data/apps/<id>/
  app.json    manifest（type: "tool"，tools: [{name, description, parameters}]）
  index.mjs   入口（默认导出 { handleTool(name, args, ctx) }）`,
  allowedPermissions: ["notify", "llm", "fs:data/apps/{id}", "network"],
  steps: [{ id: "tool", label: "工具实现" }],
};

/** 生成 agent 系统提示（v2） */
export function toolSystemPrompt(spec: AppSpec): string {
  return `你是 AI OS 的工具应用生成器。根据用户描述生成一个 Node 工具应用。

# 应用描述
${spec.description}

# 产出文件（全部写入当前工作目录，目录已存在）
- app.json：manifest，格式：
  {"id":"<kebab-case>","type":"${spec.type ?? "tool"}","name":"<中文名>","version":"1.0.0","description":"<一句话>","entry":"index.mjs","permissions":[],"tools":[{"name":"<snake_case>","description":"<工具说明>","parameters":{"type":"object","properties":{...}}}]}
  注意：id 最终会被宿主覆盖为生成 id；permissions 只能从 ["notify","llm","fs:data/apps/<id>","network"] 中选（storage 自动可用，无需声明）
- index.mjs：ESM 模块，默认导出 { async handleTool(name, args, ctx) }
  - 按 name 分发处理 tools 中声明的每个工具，返回 { success: true, content: "..." } 或 { success: false, content: "", error: "..." }

# ctx 能力桥（异步）
ctx.storage.get(key)/set(key,value)、ctx.notify(title,body)、ctx.llm.call({messages})、ctx.fs.read(path)/write(path,content)、ctx.http.fetch(url,opts)

# 约束
- 禁止 require/import 任何第三方包（仅 Node 内置模块）；禁止 child_process、net、直接 fs 访问（文件操作走 ctx.fs）
- 工具参数声明 JSON Schema（parameters.type 必须是 "object"）
- 代码简洁精炼、完整闭合、优先保证可运行

# 写入方式（重要）
- 必须用 fs_write / fs_edit 工具把文件写入工作目录，不要把代码输出到聊天文本里。
- 每次 fs_write 写入一个文件的完整内容；写多个文件就调用多次。
- 局部修改已有文件（改几行/删几行）用 fs_edit：可按行号（先 fs_read 加 lineNumbers:true 看行号，再 startLine/endLine 指定区间），或按文本匹配（oldText 唯一匹配 → newText）。
- 写完后用 fs_list / fs_read 自查文件是否齐全完整；不完整就 fs_write 覆盖重写。

# 完成条件
所有文件写完并自查通过后，直接输出完成总结，不要再调用工具。`;
}

/** 任务消息（v2） */
export function toolTaskPrompt(spec: AppSpec): string {
  return `请生成一个工具应用：${spec.description}`;
}

/** 单文件重生成任务消息（update） */
export function toolFileTaskPrompt(spec: AppSpec, path: string, existingDesc: string): string {
  return `现有工具应用的变更需求：${spec.description}

现有文件概览：
${existingDesc}

请修改应用：
- 先用 fs_read 读取需要修改的文件，了解现有结构
- 再用 fs_write 覆盖写入修改后的 "${path}" 完整内容：
  - 若为 app.json：保持既有 tools 结构，新增/修改工具声明
  - 若为 index.mjs：与 app.json 的 tools 一一对应实现，保持既有工具行为不变（保留数据兼容）

修改完成后直接输出总结，不要再调用工具。`;
}
