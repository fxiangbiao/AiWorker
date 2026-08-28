/**
 * webapp 模板（Sprint 35 v2）
 * 框架/模型职责分离：
 *   框架（宿主）提供：index.html 骨架、全局基础样式（注入 reset）、窗口 chrome、能力桥、透明背景
 *   模型生成：app.js（应用 UI/交互/逻辑/内联样式，创造性内容）+ style.css（可选全局补充）
 * v2 生成：模型经 agent-loop 用 fs_write 工具写文件（无行数限制，长代码多轮工具调用自然解决）
 * manifest 由工厂生成（id/name/permissions 可控，LLM 不碰权限）
 */

import type { AppSpec, AppTemplate } from "../../types.js";

export const webappTemplate: AppTemplate = {
  id: "webapp",
  type: "app",
  name: "Web 应用",
  description: "交互式 Web 应用（iframe 沙箱窗口呈现，内容由模型全权生成）",
  structure: `data/apps/<id>/
  index.html  宿主提供的骨架（head + #app 挂载点 + 引用 app.js/style.css；由工厂生成，模型不生成）
  app.js      模型生成：UI+逻辑+内联样式（DOMContentLoaded 向 #app 写入完整界面并绑定事件）
  style.css   可选：全局补充样式（UI 样式由 app.js 内联）
  app.json    manifest（type: "app"，由工厂生成）`,
  allowedPermissions: ["notify", "llm", "fs:data/apps/{id}", "network"],
  steps: [{ id: "logic", label: "逻辑" }],
};

/** 宿主提供的 index.html 骨架（框架层，不交模型生成）；style.css 为可选，缺失时不引用避免 404 */
export function webappIndexHtml(name: string, hasStyle = true): string {
  const safe = name.replace(/[<>"']/g, "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safe}</title>
  ${hasStyle ? '  <link rel="stylesheet" href="style.css">\n' : ""}</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>`;
}

const BRIDGE_USAGE = `宿主已注入标准能力桥：全局变量 window.__AIWORKER_BRIDGE__ 可直接使用（无需定义/引入）：
  - __AIWORKER_BRIDGE__.storage.get(key)/set(key,value)  — 数据持久化
  - __AIWORKER_BRIDGE__.notify(title, body)               — 系统通知
  - __AIWORKER_BRIDGE__.llm.call({messages})              — 调用 LLM
  - __AIWORKER_BRIDGE__.fs.read(path)/write(path, content) — 沙箱内文件
  - __AIWORKER_BRIDGE__.http.fetch(url, opts)             — 网络请求`;

/** 生成 agent 系统提示（v2：描述应用 + 目录约定 + 桥接用法 + fs_write 用法 + 完成条件） */
export function webappSystemPrompt(spec: AppSpec): string {
  return `你是 AI OS 的 Web 应用生成器。根据用户描述生成一个完整可用的 Web 应用。

# 应用描述
${spec.description}

# 产出文件（全部写入当前工作目录，目录已存在）
- app.js（必需）：应用 UI + 交互 + 逻辑 + 内联样式。功能完整、代码闭合。
- style.css（可选）：全局补充样式（UI 主要样式写在 app.js 内联）。

# 职责边界（框架已提供，你无需生成）
- index.html 骨架（含挂载点 <div id="app"></div> 与 <script src="app.js">）由宿主提供
- app.json manifest 由宿主生成（id/权限可控）
- 窗口 chrome（标题栏/拖拽/缩放/关闭）、透明背景由宿主窗口系统提供

# 能力桥（宿主已注入，直接用）
${BRIDGE_USAGE}

# 写入方式（重要）
- 必须用 fs_write / fs_edit 工具把文件写入工作目录，不要把代码输出到聊天文本里。
- 每次 fs_write 写入一个文件的完整内容；写多个文件就调用多次。
- 局部修改已有文件（改几行/删几行）用 fs_edit：可按行号（先 fs_read 加 lineNumbers:true 看行号，再 startLine/endLine 指定区间，newText 替换或删除），或按文本匹配（oldText 唯一匹配 → newText）。
- 写完后用 fs_list / fs_read 自查文件是否齐全完整。
- 若某次写入不完整（内容超长被截断），请 fs_read 检查后用 fs_write 覆盖写入完整内容。

# 应用要求
1. document.addEventListener("DOMContentLoaded", ...) 中用 document.getElementById("app").innerHTML 写入完整 UI
2. UI 样式用内联 style 属性写在元素上（style="..."）或页面内 <style> 块；不要依赖外部 style.css 的类名
3. 为交互元素绑定 onclick 事件；用 setInterval 实现计时等核心逻辑
4. 背景（重要）：由你在最外层容器/body 上自行决定——需要不透明背景就设置背景色；需要透明（小部件/宠物悬浮）就**不设置背景色**（保持透明）
5. 响应式：UI 最外层容器用内联 style 如 style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center"，完美填满窗口并随窗口缩放自动适配；内部 flex/grid 流动布局；严禁固定像素宽高导致滚动条
6. 视口完整性 + 安全间距（重要）：**所有内容（含动画主体/宠物/气泡消息/弹层）必须完整落在窗口视口内**，不得被裁剪；布局/画布以窗口尺寸为基准（百分比、视口单位或 window.innerWidth/innerHeight 动态计算），监听 resize 自适应；**内容区与窗口边缘预留 ≥12px 安全间距（padding/margin）**；气泡、弹层、提示文本等动态元素用视口边界约束（定位在窗口内、超宽自动换行/收缩、超出视口自动回位），小部件应用尤其要保证主体与气泡整体可见
7. 中文界面；功能完整可用
8. 简洁精炼、不写注释、单文件无外部库；UI 字符串紧凑写
9. 代码必须完整闭合（所有函数/括号/引号/模板字符串闭合），优先保证可运行

# 完成条件
所有文件写完并自查通过后，直接输出完成总结（说明写了哪些文件），不要再调用工具。`;
}

/** 任务消息（v2：发起生成请求） */
export function webappTaskPrompt(spec: AppSpec): string {
  const surfaceHint =
    spec.surface === "widget"
      ? "\n窗口形态：小部件（widget）—— 背景必须透明（不设背景色），界面小巧常驻桌面"
      : spec.surface === "panel"
        ? "\n窗口形态：工作区（panel）—— 占据整个工作区，界面饱满"
        : "";
  return `请生成一个 Web 应用：${spec.description}${surfaceHint}`;
}

/** 单文件重生成任务消息（update：只改指定文件，保留其余） */
export function webappFileTaskPrompt(spec: AppSpec, path: string, existingDesc: string): string {
  return `现有 Web 应用的变更需求：${spec.description}

现有文件概览：
${existingDesc}

请修改应用：
- 先用 fs_read 读取需要修改的文件，了解现有结构（可加 lineNumbers:true 查看行号）
- 局部修改优先用 fs_edit（按行号 startLine/endLine 或文本匹配 oldText → newText，删除片段 newText 留空）；整体重写再用 fs_write 覆盖 "${path}" 完整内容（保持与其他文件的兼容，保留原数据结构）
- 若是 app.js：UI 由你全权创建（innerHTML 写入 #app，内联样式 + 事件绑定）；使用宿主注入的 window.__AIWORKER_BRIDGE__（无需定义桥接代码）；页面背景自行决定（透明或设色）；**必须保证所有内容（含动画主体/宠物/气泡消息）完整落在窗口视口内不被裁剪**：以窗口尺寸为基准自适应（百分比/视口单位/监听 resize），内容区与窗口边缘预留 ≥12px 安全间距，气泡/弹层用视口边界约束（超宽换行/收缩、不超出视口）
- 若是 style.css：仅全局补充样式（UI 样式由 app.js 内联）
- index.html 由宿主提供，无需也不应修改

修改完成后直接输出总结，不要再调用工具。`;
}
