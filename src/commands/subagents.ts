/**
 * 子智能体命令组 — subagents（列表 / send / stop / close）
 */

import chalk from "chalk";
import { subagentRunner } from "../core/subagent-runner.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

function statusText(status: string): string {
  switch (status) {
    case "running":
      return chalk.cyan(padToWidth("running", 12));
    case "idle":
      return chalk.green(padToWidth("idle", 12));
    case "failed":
      return chalk.red(padToWidth("failed", 12));
    default:
      return chalk.yellow(padToWidth("queued", 12));
  }
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const subagentsCommands: CliCommand[] = [
  {
    name: "subagents",
    aliases: ["sa", "agents-bg"],
    usage: "subagents [send <id> <消息> | stop <id> | close <id>]",
    description: "子智能体：列表 / 追问 / 中断 / 关闭",
    detail: "send 运行中入队（≤5）空闲起新一轮；stop 中断当前轮并保留会话（可续接）；close 彻底关闭释放槽位；/bg 提交的后台任务同在此列",
    handler: async (ctx, arg) => {
      if (!subagentRunner.isInitialized()) {
        ctx.writeLine(chalk.red("子智能体服务未初始化"));
        return "continue";
      }
      const parts = arg.trim().split(/\s+/);
      const sub = parts[0] ?? "";

      if (sub === "send") {
        const id = parts[1];
        const message = parts.slice(2).join(" ").trim();
        if (!id || !message) {
          ctx.writeLine(chalk.gray("用法: /subagents send <id> <消息>"));
          return "continue";
        }
        const h = subagentRunner.get(id);
        if (!h) {
          ctx.writeLine(chalk.red(`✗ 子智能体不存在: ${id}`));
          return "continue";
        }
        const ok = subagentRunner.send(id, message);
        ctx.writeLine(
          ok
            ? chalk.green(`✓ 已发送至 ${id}（${h.status === "running" ? "运行中，入队待本轮结束" : "起新一轮"}）`)
            : chalk.red(`✗ 发送失败 ${id}（已失败或 pending 已满 5 条）`),
        );
        return "continue";
      }

      if (sub === "stop") {
        const id = parts[1];
        if (!id) {
          ctx.writeLine(chalk.gray("用法: /subagents stop <id>"));
          return "continue";
        }
        const ok = subagentRunner.interrupt(id);
        ctx.writeLine(ok ? chalk.yellow(`✓ 已中断 ${id}（会话保留，可 send 续接）`) : chalk.red(`✗ 中断失败 ${id}（不存在）`));
        return "continue";
      }

      if (sub === "close") {
        const id = parts[1];
        if (!id) {
          ctx.writeLine(chalk.gray("用法: /subagents close <id>"));
          return "continue";
        }
        const ok = subagentRunner.close(id);
        ctx.writeLine(ok ? chalk.yellow(`✓ 已关闭 ${id}（槽位已释放，不可续接）`) : chalk.red(`✗ 关闭失败 ${id}（不存在）`));
        return "continue";
      }

      const list = subagentRunner.list();
      if (list.length === 0) {
        ctx.writeLine(chalk.gray("暂无子智能体（/bg <任务> 提交，或对话中让主智能体调 spawn_agent）"));
        return "continue";
      }
      for (const h of list) {
        const content = (h.summary || h.lastError || h.task).slice(0, 50);
        const tok = `${fmtTok(h.usage.prompt)}/${fmtTok(h.usage.completion)}`;
        const parent = h.parentSessionId ? chalk.dim(` 父 ${h.parentSessionId.slice(0, 10)}`) : "";
        ctx.writeLine(
          `  ${statusText(h.status)} ${chalk.gray(h.id)} ${chalk.dim(h.agentId)}${h.readOnly ? chalk.dim(" 只读") : ""}` +
            ` ${h.rounds} 轮 tok ${tok}${h.pending.length > 0 ? chalk.yellow(` 待处理 ${h.pending.length}`) : ""}${parent} ${content}`,
        );
      }
      ctx.writeLine(chalk.gray("  /subagents send <id> <消息> | stop <id> | close <id>"));
      ctx.printStatus();
      return "continue";
    },
  },
];
