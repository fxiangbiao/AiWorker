/**
 * 会话导出 — 消息序列渲染为 Markdown（TUI /export 与 HTTP /sessions/:id/export 共用）
 */

import { messageText, type Message } from "../types.js";

/** 将会话消息渲染为 Markdown 导出内容 */
export function renderSessionMarkdown(
  title: string,
  sessionId: string,
  messages: Array<Message & { seq: number; createdAt: number }>,
): string {
  const lines: string[] = [`# ${title}`, "", `> 会话 ID: ${sessionId}`, ""];
  for (const m of messages) {
    const time = new Date(m.createdAt).toLocaleString("zh-CN", { hour12: false });
    const text = messageText(m);
    if (m.role === "user") {
      lines.push(`## 🧑 用户 · ${time}`, "", text.trim(), "");
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        lines.push(`## 🤖 助手 · ${time}`, "");
        for (const tc of m.tool_calls) {
          lines.push(`- \`${tc.function.name}\` \`\`\`json\n${tc.function.arguments}\n\`\`\``);
        }
        lines.push("");
      }
      if (text.trim()) {
        if (!m.tool_calls || m.tool_calls.length === 0) lines.push(`## 🤖 助手 · ${time}`, "");
        lines.push(text.trim(), "");
      }
    } else if (m.role === "tool") {
      lines.push(`> 🔧 工具结果${m.name ? ` (${m.name})` : ""}: ${messageText(m).slice(0, 200)}`, "");
    }
  }
  return lines.join("\n");
}
