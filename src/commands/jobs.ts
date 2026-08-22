/**
 * 后台任务与定时调度命令组 — bg / jobs / schedule
 */

import chalk from "chalk";
import { jobRunner } from "../core/job-runner.js";
import { scheduler, nextFireAt } from "../core/scheduler.js";
import { parseNaturalSchedule, type NaturalSchedule } from "../core/nl-schedule.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

/** 是否为合法 cron 表达式（5 字段或 6 字段） */
function looksLikeCron(s: string): boolean {
  return /^[\d*/,\- ]+$/.test(s) && s.trim().split(/\s+/).length >= 5;
}

/** LLM 兜底：把任意自然语言调度需求解析为 cron + prompt */
async function parseWithLLM(
  modelRouter: { complete: (opts: { messages: { role: string; content: string }[] }) => Promise<{ text: string }> },
  text: string,
): Promise<NaturalSchedule | null> {
  try {
    const system = `你是 cron 表达式解析器。把用户的自然语言定时任务解析为 JSON，只输出 JSON：
{"cron": "5字段cron（分 时 日 月 周）", "prompt": "任务描述（去掉时间表达）"}
示例：每天上午9点生成日报 → {"cron":"0 9 * * *","prompt":"生成日报"}
每30分钟检查服务 → {"cron":"*/30 * * * *","prompt":"检查服务"}
每周一18点提醒健身 → {"cron":"0 18 * * 1","prompt":"提醒健身"}`;
    const res = await modelRouter.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });
    const m = /{[^{}]*}/.exec(res.text);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { cron?: unknown; prompt?: unknown };
    if (typeof parsed.cron !== "string" || typeof parsed.prompt !== "string") return null;
    const cron = parsed.cron.trim();
    const prompt = parsed.prompt.trim();
    if (!cron || !prompt || nextFireAt(cron) === null) return null;
    return { cron, prompt };
  } catch {
    return null;
  }
}

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
    usage: "schedule [add \"<cron>\" \"<任务>\" [agentId] | add \"自然语言\"] [remove <id>]",
    description: "查看/管理定时任务",
    detail: "支持自然语言（如\"每天早上8点生成早报\"）；cron 5 字段；持久化 config/schedule.json",
    handler: async (ctx, _arg, line) => {
      const parts = line.split(/\s+/).slice(1);
      const sub = parts[0] ?? "";
      if (sub === "add") {
        const rest = line.replace(/^\/schedule\s+add\s+/, "").trim();
        if (!rest) {
          ctx.writeLine(chalk.gray('用法: /schedule add "<cron>" "<任务>" [agentId]  或  /schedule add "每天早上8点生成早报"'));
          return "continue";
        }
        let nl: string;
        let agentId = "default";
        // 旧格式："cron" "任务" [agentId]
        const legacy = rest.match(/^"([^"]+)"\s+"([^"]+)"(?:\s+(\S+))?$/);
        if (legacy && looksLikeCron(legacy[1]!)) {
          const ok = scheduler.addJob({
            id: `sched-${Date.now().toString(36)}`,
            cron: legacy[1]!,
            prompt: legacy[2]!,
            agentId: legacy[3] ?? "default",
          });
          ctx.writeLine(
            ok ? chalk.green(`✓ 定时任务已添加: ${legacy[1]} → ${legacy[2]!.slice(0, 40)}`) : chalk.red(`✗ cron 表达式无效: ${legacy[1]}`),
          );
          return "continue";
        }
        if (legacy) {
          nl = `${legacy[1]} ${legacy[2]}`;
          agentId = legacy[3] ?? "default";
        } else {
          nl = rest.replace(/^"|"$/g, "").trim();
        }
        // 自然语言：规则解析 → LLM 兜底
        let parsed = parseNaturalSchedule(nl);
        if (!parsed) {
          ctx.writeLine(chalk.gray("规则解析失败，尝试模型解析…"));
          parsed = await parseWithLLM(ctx.modelRouter as never, nl);
        }
        if (!parsed) {
          ctx.writeLine(chalk.red(`✗ 无法解析调度需求: ${nl}`));
          ctx.writeLine(chalk.gray('  请直接填写 cron，如 /schedule add "0 8 * * *" "任务"'));
          return "continue";
        }
        const ok = scheduler.addJob({ id: `sched-${Date.now().toString(36)}`, cron: parsed.cron, prompt: parsed.prompt, agentId });
        ctx.writeLine(
          ok
            ? chalk.green(`✓ 定时任务已添加: ${parsed.cron} → ${parsed.prompt.slice(0, 40)}`)
            : chalk.red(`✗ cron 表达式无效: ${parsed.cron}`),
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
