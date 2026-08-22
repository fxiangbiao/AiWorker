/**
 * 后台任务与定时调度命令组 — bg / jobs / schedule
 */

import chalk from "chalk";
import { jobRunner } from "../core/job-runner.js";
import { scheduler } from "../core/scheduler.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

export const jobsCommands: CliCommand[] = [
  {
    name: "bg",
    aliases: ["background"],
    usage: "bg <任务>",
    description: "提交后台任务（不阻塞交互）",
    detail: "立即返回任务 ID；完成写入独立会话 + WS 推送；/jobs 查看",
    handler: async (ctx, arg) => {
      const prompt = arg.trim();
      if (!prompt) {
        ctx.writeLine(chalk.gray("用法: /bg <任务描述>"));
        return "continue";
      }
      if (!jobRunner.isInitialized()) {
        ctx.writeLine(chalk.red("后台任务服务未初始化"));
        return "continue";
      }
      const agent = ctx.currentAgent();
      const id = jobRunner.submit(agent.getId(), prompt);
      ctx.writeLine(chalk.green(`✓ 后台任务已提交: ${id}（专家: ${agent.getName()}）`));
      ctx.writeLine(chalk.gray(`  查看状态: /jobs | 完成结果写入独立会话`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "jobs",
    usage: "jobs [cancel <id>]",
    description: "查看/取消后台任务",
    detail: "cancel 仅可取消排队中任务",
    handler: async (ctx, arg) => {
      const parts = arg.trim().split(/\s+/);
      if (parts[0] === "cancel" && parts[1]) {
        const ok = jobRunner.cancel(parts[1]!);
        ctx.writeLine(
          ok ? chalk.yellow(`✓ 已取消 ${parts[1]}`) : chalk.red(`✗ 无法取消 ${parts[1]}（仅排队中可取消）`),
        );
        return "continue";
      }
      const jobs = jobRunner.list();
      if (jobs.length === 0) {
        ctx.writeLine(chalk.gray("暂无后台任务（用 /bg <任务> 提交）"));
        return "continue";
      }
      for (const j of jobs) {
        const status =
          j.status === "done" ? chalk.green(padToWidth("done", 8))
          : j.status === "failed" ? chalk.red(padToWidth("failed", 8))
          : j.status === "running" ? chalk.cyan(padToWidth("running", 8))
          : chalk.yellow(padToWidth("queued", 8));
        const content = (j.summary || j.error || j.prompt).slice(0, 60);
        const dur = j.finishedAt && j.startedAt ? ` ${chalk.dim(`${((j.finishedAt - j.startedAt) / 1000).toFixed(1)}s`)}` : "";
        ctx.writeLine(`  ${status} ${chalk.gray(j.id)} ${chalk.dim(j.agentId)}${dur} ${content}`);
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "schedule",
    usage: "schedule [add \"<cron>\" \"<任务>\" [agentId]] [remove <id>]",
    description: "查看/管理定时任务",
    detail: "cron 5 字段（分 时 日 月 周）；持久化 config/schedule.json",
    handler: async (ctx, _arg, line) => {
      const parts = line.split(/\s+/).slice(1);
      const sub = parts[0] ?? "";
      if (sub === "add") {
        const m = line.match(/^\/schedule\s+add\s+"([^"]+)"\s+"([^"]+)"(?:\s+(\S+))?$/);
        if (!m) {
          ctx.writeLine(chalk.gray('用法: /schedule add "<cron>" "<任务描述>" [agentId]'));
          return "continue";
        }
        const cron = m[1]!;
        const prompt = m[2]!;
        const agentId = m[3] ?? "default";
        const ok = scheduler.addJob({ id: `sched-${Date.now().toString(36)}`, cron, prompt, agentId });
        ctx.writeLine(
          ok ? chalk.green(`✓ 定时任务已添加: ${cron} → ${prompt.slice(0, 40)}`) : chalk.red(`✗ cron 表达式无效: ${cron}`),
        );
        return "continue";
      }
      if (sub === "remove") {
        const id = parts[1];
        if (!id) {
          ctx.writeLine(chalk.gray("用法: /schedule remove <id>"));
          return "continue";
        }
        const ok = scheduler.removeJob(id);
        ctx.writeLine(ok ? chalk.yellow(`✓ 已移除 ${id}`) : chalk.red(`✗ 未找到 ${id}`));
        return "continue";
      }
      const jobs = scheduler.getJobs();
      if (jobs.length === 0) {
        ctx.writeLine(chalk.gray("暂无定时任务（/schedule add 添加或编辑 config/schedule.json）"));
        return "continue";
      }
      for (const j of jobs) {
        ctx.writeLine(`  ${chalk.gray(j.id)} ${chalk.cyan(j.cron)} ${chalk.dim(j.agentId)} ${j.prompt.slice(0, 60)}`);
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
