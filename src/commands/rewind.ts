/**
 * 回滚命令 — /rewind [轮次] [--code|--chat|--all] [--dry-run] [--force]
 * 只有拿到用户显式选择（交互三选或范围参数）才执行；无提问通道时 fail-closed 中止
 */

import chalk from "chalk";
import { displayWidth, padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";
import type { RewindPlan, RewindScope } from "../types.js";

const SCOPE_LABEL: Record<RewindScope, string> = {
  all: "代码+对话",
  chat: "仅对话",
  code: "仅代码",
};

function clip(text: string, width: number): string {
  let out = text;
  while (displayWidth(out) > width) out = out.slice(0, -1);
  return out;
}

function renderPlan(ctx: { write: (t: string) => void }, plan: RewindPlan, dryRun: boolean): void {
  ctx.write(`\n${chalk.bold("── 回滚预览 ──")} 回到第 ${plan.toTurn} 轮之前（范围：${SCOPE_LABEL[plan.scope]}）\n`);
  ctx.write(chalk.dim(`将撤销回合: ${plan.turns.join(", ")}\n`));
  const restore = plan.files.filter((f) => f.action === "restore");
  const del = plan.files.filter((f) => f.action === "delete");
  const conflict = plan.files.filter((f) => f.action === "conflict");
  const skip = plan.files.filter((f) => f.action === "skip");
  for (const f of restore) ctx.write(`│ ${chalk.cyan("还原")} ${f.path}\n`);
  for (const f of del) ctx.write(`│ ${chalk.cyan("删除")} ${f.path}${chalk.dim("（回合前不存在）")}\n`);
  for (const f of conflict) ctx.write(`│ ${chalk.yellow("冲突")} ${f.path}${chalk.dim(`（${f.reason ?? "外部改动"}）`)}\n`);
  for (const f of skip) ctx.write(`│ ${chalk.gray("跳过")} ${f.path}${chalk.dim(`（${f.reason ?? "不可恢复"}）`)}\n`);
  if (plan.scope !== "code") {
    ctx.write(`│ ${chalk.cyan("对话")} 删除 ${plan.messageCount} 条消息（可在轨迹中回看）\n`);
  }
  ctx.write(
    chalk.dim(
      `共 ${restore.length} 还原 / ${del.length} 删除 / ${conflict.length} 冲突 / ${skip.length} 跳过${dryRun ? "（--dry-run 仅预览，未做任何改动）" : ""}\n`,
    ),
  );
}

function renderResult(ctx: { writeLine: (t: string) => void }, result: { restored: string[]; deleted: string[]; skipped: { path: string; reason: string }[]; conflicts: string[]; messagesDeleted: number; toTurn: number; scope: RewindScope }): void {
  ctx.writeLine(
    chalk.green(
      `✓ 已回滚到第 ${result.toTurn} 轮之前（${SCOPE_LABEL[result.scope]}）：还原 ${result.restored.length} 文件` +
        `${result.deleted.length > 0 ? ` · 删除 ${result.deleted.length} 新建文件` : ""}` +
        `${result.messagesDeleted > 0 ? ` · 移除 ${result.messagesDeleted} 条消息` : ""}`,
    ),
  );
  if (result.conflicts.length > 0) {
    ctx.writeLine(
      chalk.yellow(`⚠ ${result.conflicts.length} 个文件有外部改动被跳过（--force 可强制覆盖）：`),
    );
    for (const p of result.conflicts) ctx.writeLine(chalk.gray(`  ${p}`));
  }
  if (result.skipped.length > 0) {
    ctx.writeLine(chalk.gray(`  跳过 ${result.skipped.length} 项（terminal_exec 变更不可回滚 / 二进制 / 超限）：`));
    for (const s of result.skipped.slice(0, 10)) ctx.writeLine(chalk.gray(`  ${s.path} — ${s.reason}`));
  }
}

export const rewindCommands: CliCommand[] = [
  {
    name: "rewind",
    aliases: ["rollback"],
    usage: "rewind [轮次] [--code|--chat|--all] [--dry-run] [--force]",
    description: "回滚到指定轮次之前",
    detail: "无参数列出检查点；带轮次交互三选（代码+对话/仅对话/仅代码）；--dry-run 只预览；冲突需 --force",
    handler: async (ctx, arg) => {
      const service = ctx.rewindService;
      if (!service) {
        ctx.writeLine(chalk.red("✗ 检查点服务不可用（未注入 rewindService）"));
        ctx.printStatus();
        return "continue";
      }
      const sessionId = ctx.currentSessionId();
      if (!sessionId) {
        ctx.writeLine(chalk.gray("暂无当前会话（先进行一轮对话，检查点在每轮开始时创建）"));
        ctx.printStatus();
        return "continue";
      }

      const tokens = arg.trim().split(/\s+/).filter(Boolean);
      const flags = new Set(tokens.filter((t) => t.startsWith("--")));
      const turnArg = tokens.find((t) => !t.startsWith("--"));
      const dryRun = flags.has("--dry-run");
      const force = flags.has("--force");
      const scopeFlag: RewindScope | undefined = flags.has("--code")
        ? "code"
        : flags.has("--chat")
          ? "chat"
          : flags.has("--all")
            ? "all"
            : undefined;

      if (turnArg === undefined) {
        const turns = service.list(sessionId);
        if (turns.length === 0) {
          ctx.writeLine(chalk.gray("本会话暂无检查点（检查点在每轮对话开始时创建，默认保留最近 20 轮）"));
          ctx.printStatus();
          return "continue";
        }
        ctx.write("\n┌──────┬────────────┬────────────────────────┬────────┬──────────┐\n");
        ctx.write(
          `│ ${padToWidth("轮次", 4)} │ ${padToWidth("时间", 10)} │ ${padToWidth("输入摘要", 22)} │ ${padToWidth("文件", 6)} │ ${padToWidth("可恢复", 8)} │\n`,
        );
        ctx.write("├──────┼────────────┼────────────────────────┼────────┼──────────┤\n");
        for (const t of turns) {
          const restorable = t.files.filter((f) => f.restorable).length;
          const time = new Date(t.createdAt).toLocaleTimeString();
          ctx.write(
            `│ ${String(t.turn).padEnd(4)} │ ${time.padEnd(10)} │ ${padToWidth(clip(t.userInput ?? "(无)", 22), 22)} │ ${String(t.files.length).padEnd(6)} │ ${`${restorable}/${t.files.length}`.padEnd(8)} │\n`,
          );
        }
        ctx.write("└──────┴────────────┴────────────────────────┴────────┴──────────┘\n");
        ctx.write(chalk.gray(`/rewind <轮次> 回滚（交互选择范围）· /rewind <轮次> --code --dry-run 预览\n`));
        ctx.printStatus();
        return "continue";
      }

      const toTurn = parseInt(turnArg, 10);
      if (Number.isNaN(toTurn) || toTurn < 1) {
        ctx.writeLine(chalk.red(`✗ 轮次需为正整数，收到「${turnArg}」`));
        ctx.printStatus();
        return "continue";
      }

      let scope: RewindScope = scopeFlag ?? "all";
      if (scopeFlag === undefined) {
        const plan = service.preview(sessionId, toTurn, "all");
        if (plan.blockers.length > 0) {
          ctx.writeLine(chalk.red(`✗ ${plan.blockers[0]}`));
          ctx.printStatus();
          return "continue";
        }
        renderPlan(ctx, plan, dryRun);
        if (dryRun) {
          ctx.printStatus();
          return "continue";
        }
        const answer = await ctx.ask("回滚范围：1) 代码+对话  2) 仅对话  3) 仅代码（回车取消）");
        const picked = (answer ?? "").trim();
        if (picked === "1") scope = "all";
        else if (picked === "2") scope = "chat";
        else if (picked === "3") scope = "code";
        else {
          ctx.writeLine(chalk.gray("已取消（未做任何改动）"));
          ctx.printStatus();
          return "continue";
        }
      }

      const plan = service.preview(sessionId, toTurn, scope);
      if (plan.blockers.length > 0) {
        ctx.writeLine(chalk.red(`✗ ${plan.blockers[0]}`));
        ctx.printStatus();
        return "continue";
      }
      if (scopeFlag !== undefined) renderPlan(ctx, plan, dryRun);
      if (dryRun) {
        ctx.printStatus();
        return "continue";
      }

      const result = service.apply(sessionId, toTurn, scope, { force });
      if (!result.ok) {
        ctx.writeLine(chalk.red(`✗ 回滚失败: ${result.error ?? "未知原因"}`));
        ctx.printStatus();
        return "continue";
      }
      renderResult(ctx, result);
      if (result.messagesDeleted > 0) {
        ctx.writeLine(chalk.gray("  当前会话上下文已按事件回放截断；被回滚的历史仍可在 /trace 中查看"));
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
