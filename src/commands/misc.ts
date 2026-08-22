/**
 * 杂项命令组 — mcps / help / exit
 */

import chalk from "chalk";
import { mcpManager } from "../mcp/mcp-manager.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { displayWidth, padToWidth } from "./format.js";
import type { CliCommand, CommandContext } from "./types.js";

/** 按展示宽度截断（CJK 安全），超出补省略号 */
function truncateWidth(s: string, max: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return w < displayWidth(s) ? `${out}…` : out;
}

/** 渲染单个命令的详细帮助（/命令 --help 或必选参数命令无参数时） */
export function renderCommandHelp(cmd: CliCommand, ctx: CommandContext): void {
  const aliases = cmd.aliases?.length ? `（别名: ${cmd.aliases.map((a) => `/${a}`).join(", ")}）` : "";
  ctx.writeLine("");
  ctx.writeLine(chalk.bold(`/${cmd.name}${aliases}`));
  ctx.writeLine(chalk.gray(`  用法: /${cmd.usage}`));
  if (cmd.description) ctx.writeLine(`  功能: ${cmd.description}`);
  if (cmd.detail) ctx.writeLine(chalk.gray(`  说明: ${cmd.detail}`));
  ctx.writeLine("");
  ctx.printStatus();
}

/** 命令是否有必选参数（usage 中 `<` 出现在任何 `[` 之前） */
export function hasRequiredArgs(cmd: CliCommand): boolean {
  return /^[^[]*</.test(cmd.usage);
}

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
    usage: "help [命令名]",
    description: "帮助信息（/help <命令> 查看用法）",
    detail: "精简列表；详细参数用 /<命令> --help",
    handler: async (ctx, arg) => {
      // /help <命令> → 命令级详细帮助
      if (arg.trim()) {
        const target = ctx.listCommands().find((c) => {
          const names = [c.name, ...(c.aliases ?? [])];
          return names.includes(arg.trim().replace(/^\//, ""));
        });
        if (target) {
          renderCommandHelp(target, ctx);
        } else {
          ctx.writeLine(chalk.red(`✗ 未知命令: ${arg.trim()}`));
        }
        return "continue";
      }
      // 精简表格：命令（含别名）+ 一句话功能；长内容下沉到 /<命令> --help
      const escapeCell = (s: string): string => s.replace(/\|/g, "/");
      const rows = ctx
        .listCommands()
        .map((c) => {
          const names = [`/${c.name}`, ...(c.aliases ?? []).map((a) => `/${a}`)];
          return [names.join(" "), truncateWidth(escapeCell(c.description || c.detail || "—"), 32)] as const;
        });
      const mdRows = [
        "| 命令 | 功能 |",
        "|---|---|",
        ...rows.map(([a, b]) => `| ${a} | ${b} |`),
      ];
      const rendered = renderMarkdown(mdRows.join("\n"));
      ctx.writeLine("");
      for (const line of rendered) ctx.writeLine(line);
      ctx.writeLine("");
      ctx.writeLine(chalk.dim(`💡 详细用法: /<命令> --help（如 /install --help） | 已加载 ${ctx.skillCount} 个技能，直接输入 /技能名 激活`));
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
