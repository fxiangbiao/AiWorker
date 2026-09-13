/**
 * 权限规则命令 — /permissions [list|allow|ask|deny|revoke|reset|clear-session]
 * 项目级规则写入 config/permissions.json（原子替换）；会话级只留内存
 * 拒绝写入的情形（never_auto_approve / 受保护路径 / 非法格式）原样回显原因
 */

import chalk from "chalk";
import { displayWidth, padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";
import type { PermissionRule, PermissionRuleAction } from "../types.js";

const ACTION_COLOR: Record<PermissionRuleAction, (t: string) => string> = {
  deny: chalk.red,
  ask: chalk.yellow,
  allow: chalk.green,
};

/** 解析 `Tool` 或 `Tool(specifier)`（specifier 内含括号时取最后一对） */
function parseRuleSpec(spec: string): { tool: string; match?: string } | null {
  const text = spec.trim();
  if (!text) return null;
  const open = text.indexOf("(");
  if (open < 0) return { tool: text };
  if (!text.endsWith(")")) return null;
  const tool = text.slice(0, open).trim();
  const match = text.slice(open + 1, -1).trim();
  if (!tool) return null;
  return { tool, ...(match ? { match } : {}) };
}

function clip(text: string, width: number): string {
  let out = text;
  while (displayWidth(out) > width) out = out.slice(0, -1);
  return out;
}

export const permissionCommands: CliCommand[] = [
  {
    name: "permissions",
    aliases: ["perms"],
    usage: "permissions [allow|ask|deny <Tool>[(<glob>)] | revoke <序号> [--project|--session] | reset | clear-session]",
    description: "查看与维护权限规则（含来源）",
    detail: "无参数列出规则；allow/ask/deny 写项目级规则；revoke 按序号撤销（--project/--session 限定来源）；reset 清空项目级；clear-session 清空会话级",
    handler: async (ctx, arg) => {
      const memory = ctx.permissionMemory;
      if (!memory) {
        ctx.writeLine(chalk.red("✗ 权限记忆不可用（未注入 permissionMemory）"));
        ctx.printStatus();
        return "continue";
      }

      const render = (): void => {
        const rules = memory.list();
        ctx.write(chalk.dim(`\n项目配置: ${memory.getConfigPath()}\n`));
        if (rules.length === 0) {
          ctx.writeLine(chalk.gray("暂无规则（全部按权限模式与工具白名单判定）"));
          ctx.writeLine(
            chalk.gray("例：/permissions allow terminal_exec(npm install)  或  /permissions deny fs_write(*.env)"),
          );
          return;
        }
        ctx.write("┌────┬───────┬────────────────────┬──────────────────────────┬────────┐\n");
        ctx.write(
          `│ ${padToWidth("序号", 2)} │ ${padToWidth("动作", 5)} │ ${padToWidth("工具", 18)} │ ${padToWidth("目标", 24)} │ ${padToWidth("来源", 6)} │\n`,
        );
        ctx.write("├────┼───────┼────────────────────┼──────────────────────────┼────────┤\n");
        rules.forEach((r, i) => {
          const color = ACTION_COLOR[r.action];
          ctx.write(
            `│ ${String(i + 1).padEnd(2)} │ ${color(padToWidth(r.action.toUpperCase(), 5))} │ ${padToWidth(clip(r.tool, 18), 18)} │ ${padToWidth(clip(r.match ?? "*", 24), 24)} │ ${padToWidth(r.source === "project" ? "项目" : "会话", 6)} │\n`,
          );
        });
        ctx.write("└────┴───────┴────────────────────┴──────────────────────────┴────────┘\n");
        ctx.write(chalk.dim("优先级：deny > ask > allow；deny 与受保护路径不可被 allow 覆盖（会话级重启即失效）\n"));
      };

      const tokens = arg.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "list").toLowerCase();

      if (sub === "list" || sub === "") {
        render();
        ctx.printStatus();
        return "continue";
      }

      if (sub === "allow" || sub === "ask" || sub === "deny") {
        const spec = tokens.slice(1).join(" ");
        if (!spec) {
          ctx.writeLine(chalk.red(`✗ 用法：/permissions ${sub} <Tool>[(<glob>)]`));
          ctx.printStatus();
          return "continue";
        }
        const parsed = parseRuleSpec(spec);
        if (!parsed) {
          ctx.writeLine(chalk.red(`✗ 规则格式非法：「${spec}」，应为 Tool 或 Tool(specifier)`));
          ctx.printStatus();
          return "continue";
        }
        const rule: PermissionRule = { tool: parsed.tool, action: sub, ...(parsed.match ? { match: parsed.match } : {}) };
        const result = memory.add(rule, "project");
        if (!result.ok) {
          ctx.writeLine(chalk.red(`✗ ${result.reason}`));
          ctx.writeLine(chalk.gray("  （deny/ask 规则不受限；allow 不得覆盖永不自动批准清单与受保护路径）"));
          ctx.printStatus();
          return "continue";
        }
        ctx.writeLine(
          chalk.green(
            `✓ 已写入项目级规则：${sub.toUpperCase()} ${parsed.tool}${parsed.match ? `(${parsed.match})` : ""}`,
          ),
        );
        if (result.warning) ctx.writeLine(chalk.yellow(`⚠ ${result.warning}`));
        render();
        ctx.printStatus();
        return "continue";
      }

      if (sub === "revoke") {
        const rules = memory.list();
        const sourceFlag = tokens.includes("--project") ? "project" : tokens.includes("--session") ? "session" : undefined;
        const index = parseInt(tokens[1] ?? "", 10);
        if (Number.isNaN(index) || index < 1 || index > rules.length) {
          ctx.writeLine(chalk.red(`✗ 序号需在 1-${rules.length} 之间（先用 /permissions 查看）`));
          ctx.printStatus();
          return "continue";
        }
        const target = rules[index - 1]!;
        if (sourceFlag && target.source !== sourceFlag) {
          ctx.writeLine(
            chalk.red(`✗ 序号 ${index} 是${target.source === "project" ? "项目级" : "会话级"}规则，与 --${sourceFlag} 不符（同形规则可用 --project/--session 指定来源）`),
          );
          ctx.printStatus();
          return "continue";
        }
        const result = memory.revoke(target, sourceFlag ?? target.source);
        if (!result.ok) {
          ctx.writeLine(chalk.red(`✗ 撤销失败：${result.reason}`));
          ctx.printStatus();
          return "continue";
        }
        ctx.writeLine(
          chalk.green(
            `✓ 已撤销（${target.source === "project" ? "项目级" : "会话级"}）：${target.action.toUpperCase()} ${target.tool}${target.match ? `(${target.match})` : ""}`,
          ),
        );
        if (result.warning) ctx.writeLine(chalk.yellow(`⚠ ${result.warning}`));
        render();
        ctx.printStatus();
        return "continue";
      }

      if (sub === "reset") {
        const result = memory.resetProject();
        if (!result.ok) {
          ctx.writeLine(chalk.red(`✗ 重置失败：${result.reason}`));
          ctx.printStatus();
          return "continue";
        }
        ctx.writeLine(chalk.green("✓ 已清空项目级规则"));
        if (result.warning) ctx.writeLine(chalk.yellow(`⚠ ${result.warning}`));
        render();
        ctx.printStatus();
        return "continue";
      }

      if (sub === "clear-session") {
        const removed = memory.clearSession();
        ctx.writeLine(chalk.green(`✓ 已清空会话级规则（${removed} 条）`));
        render();
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.red(`✗ 未知子命令「${sub}」`));
      ctx.writeLine(chalk.gray("用法：/permissions [allow|ask|deny <Tool>[(<glob>)] | revoke <序号> | reset | clear-session]"));
      ctx.printStatus();
      return "continue";
    },
  },
];
