/**
 * 杂项命令组 — mcps / help / exit
 */

import chalk from "chalk";
import { mcpManager } from "../mcp/mcp-manager.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

export const miscCommands: CliCommand[] = [
  {
    name: "mcps",
    usage: "mcps",
    description: "查看 MCP 服务器",
    detail: "列出已加载的 MCP 服务、连接状态与工具",
    handler: async (ctx) => {
      const statuses = mcpManager.getStatuses();
      const servers = Object.values(statuses);
      if (servers.length === 0) {
        ctx.writeLine(chalk.gray("未加载任何 MCP 服务器（检查 config/mcp.json）"));
      } else {
        ctx.writeLine("");
        for (const s of servers) {
          const icon = s.connected ? chalk.green("✓") : s.state === "connecting" || s.state === "reconnecting" ? chalk.yellow("⏳") : chalk.red("✗");
          const stateLabel = s.connected ? "已连接" : s.state === "connecting" ? "连接中" : s.state === "reconnecting" ? "重连中" : s.state === "dead" ? "已失效" : "未连接";
          ctx.writeLine(`  ${icon} ${chalk.white(padToWidth(s.name, 16))}${chalk.dim(s.transport)} ${chalk.dim("·")} ${stateLabel} ${chalk.dim(`· ${s.toolCount} 工具`)}${s.error ? chalk.red(` · ${s.error}`) : ""}`);
          for (const t of s.tools ?? []) {
            const toolName = t.name.replace(`mcp_${s.name}_`, "");
            ctx.writeLine(`      ${chalk.dim("└")} ${chalk.cyan(padToWidth(toolName, 24))}${t.description ? chalk.dim(t.description) : ""}`);
          }
        }
        ctx.writeLine("");
        ctx.writeLine(chalk.dim(`💡 共 ${servers.length} 个 MCP 服务器，可在系统弹窗 MCP Tab 查看详情`));
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "help",
    usage: "help",
    description: "帮助信息",
    detail: "显示此表",
    handler: async (ctx) => {
      // /help 表格从注册表自动生成（新增命令无需手工维护）
      // 防御：单元格内半角 | 会被表格解析当作列分隔符，统一替换为 /
      const escapeCell = (s: string): string => s.replace(/\|/g, "/");
      const rows: [string, string, string][] = ctx
        .listCommands()
        .map((c) => [escapeCell(`/${c.usage}`), escapeCell(c.description), escapeCell(c.detail)]);
      const mdRows = [
        "| 命令 | 功能 | 说明 |",
        "|---|---|---|",
        ...rows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
      ];
      const rendered = renderMarkdown(mdRows.join("\n"));
      ctx.writeLine("");
      for (const line of rendered) ctx.writeLine(line);
      ctx.writeLine("");
      ctx.writeLine(chalk.dim(`💡 已加载 ${ctx.skillCount} 个技能，可直接输入 /技能名 激活（如 /code-review）`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "exit",
    aliases: ["quit"],
    usage: "exit",
    description: "退出",
    detail: "",
    handler: async (ctx) => {
      ctx.writeLine(chalk.gray("\n再见！"));
      return "exit";
    },
  },
];
