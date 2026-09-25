/**
 * 后台任务与定时调度命令组 — bg / jobs / schedule
 * 执行统一走 subagentRunner（/jobs、POST /jobs、scheduler 经 job-runner 兼容层）
 */

import chalk from "chalk";
import { jobRunner } from "../core/job-runner.js";
import { subagentRunner } from "../core/subagent-runner.js";
import { scheduler, nextFireAt } from "../core/scheduler.js";
import { parseNaturalSchedule, reconcileCron, stripScheduleWords, type NaturalSchedule } from "../core/nl-schedule.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

/** 是否为合法 cron 表达式（5 字段或 6 字段） */
function looksLikeCron(s: string): boolean {
  return /^[\d*/,\- ]+$/.test(s) && s.trim().split(/\s+/).length >= 5;
}

/**
 * LLM 兜底：把规则解析不了的自然语言解析为 cron + prompt
 * 返回前必经 reconcileCron：模型丢掉原句里的星期/日期/时刻时按原句**自动修复**，并把修复说明带回给用户
 */
async function parseWithLLM(
  modelRouter: { complete: (opts: { messages: { role: string; content: string }[] }) => Promise<{ text: string }> },
  text: string,
): Promise<(NaturalSchedule & { notes: string[] }) | null> {
  try {
    const system = `你是 cron 表达式解析器。把用户的自然语言定时任务解析为 JSON，只输出 JSON：
{"cron": "5字段cron（分 时 日 月 周）", "prompt": "任务描述（去掉时间表达）"}
示例：每天上午9点生成日报 → {"cron":"0 9 * * *","prompt":"生成日报"}
每30分钟检查服务 → {"cron":"*/30 * * * *","prompt":"检查服务"}
每周一18点提醒健身 → {"cron":"0 18 * * 1","prompt":"提醒健身"}
每个周六提醒我运动 → {"cron":"0 10 * * 6","prompt":"提醒我运动"}
硬性要求：原句里出现的每一次时间限定（星期、日期、时刻、间隔）都必须在 cron 里体现，不得丢弃；原句没给时刻时可以自选一个合理时刻。`;
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
    const rawCron = parsed.cron.trim();
    const rawPrompt = parsed.prompt.trim();
    if (!rawCron || !rawPrompt || nextFireAt(rawCron) === null) return null;

    const repaired = reconcileCron(text, rawCron);
    const stripped = stripScheduleWords(text);
    const prompt = stripped.matched && stripped.prompt ? stripped.prompt : rawPrompt;
    // 修补结果必须复验：修出无效 cron（如反序星期）时回退模型原值，绝不入库半成品
    if (nextFireAt(repaired.cron) === null) {
      return { cron: rawCron, prompt, notes: [`按原句修正得到无效 cron（${repaired.cron}），已保留模型结果`] };
    }
    return { cron: repaired.cron, prompt, notes: repaired.notes };
  } catch {
    return null;
  }
}

export const jobsCommands: CliCommand[] = [
  {
    name: "bg",
    aliases: ["background"],
    usage: "bg [--readonly] <任务>",
    description: "提交后台子智能体（不阻塞交互，可续接/可中断）",
    detail: "绑定当前会话为父会话；缺省完整工具面，--readonly 收窄为只读闭集；/subagents 追问/中断/关闭",
    handler: async (ctx, arg) => {
      const raw = arg.trim();
      const readOnly = /^--readonly\b/.test(raw);
      const prompt = raw.replace(/^--readonly\s*/, "").trim();
      if (!prompt) {
        ctx.writeLine(chalk.gray("用法: /bg [--readonly] <任务描述>"));
        return "continue";
      }
      if (!subagentRunner.isInitialized()) {
        ctx.writeLine(chalk.red("后台任务服务未初始化"));
        return "continue";
      }
      const agent = ctx.currentAgent();
      let id: string;
      try {
        id = subagentRunner.spawn(agent.getId(), prompt, {
          parentSessionId: ctx.currentSessionId(),
          readOnly,
        });
      } catch (err) {
        ctx.writeLine(chalk.red(`✗ 提交失败: ${(err as Error).message}`));
        return "continue";
      }
      ctx.writeLine(chalk.green(`✓ 后台子智能体已提交: ${id}（专家: ${agent.getName()}${readOnly ? "，只读" : ""}）`));
      ctx.writeLine(chalk.gray(`  查看: /subagents（可追问/中断）| /jobs（兼容视图）`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "jobs",
    usage: "jobs [cancel <id>]",
    description: "查看/取消后台任务（兼容视图，等同子智能体）",
    detail: "cancel 即中断当前轮并保留会话；完整操作见 /subagents",
    handler: async (ctx, arg) => {
      const parts = arg.trim().split(/\s+/);
      if (parts[0] === "cancel" && parts[1]) {
        const id = parts[1]!;
        const before = jobRunner.get(id);
        const ok = jobRunner.cancel(id);
        if (ok) {
          ctx.writeLine(chalk.yellow(`✓ 已中断 ${id}（会话保留，可 /subagents send 续接）`));
        } else if (!before) {
          ctx.writeLine(chalk.red(`✗ 未找到 ${id}`));
        } else if (before.status === "done" || before.status === "failed") {
          ctx.writeLine(chalk.gray(`· ${id} 已结束（${before.interrupted ? "曾被中断" : before.status}），无需中断`));
        } else {
          ctx.writeLine(chalk.red(`✗ 无法中断 ${id}`));
        }
        return "continue";
      }
      const jobs = jobRunner.list();
      if (jobs.length === 0) {
        ctx.writeLine(chalk.gray("暂无后台任务（用 /bg <任务> 提交）"));
        return "continue";
      }
      for (const j of jobs) {
        const status =
          j.status === "done" && j.interrupted ? chalk.yellow(padToWidth("interrupted", 11))
          : j.status === "done" ? chalk.green(padToWidth("done", 11))
          : j.status === "failed" ? chalk.red(padToWidth("failed", 11))
          : j.status === "running" ? chalk.cyan(padToWidth("running", 11))
          : chalk.yellow(padToWidth("queued", 11));
        const content = (j.summary || j.error || j.prompt).slice(0, 60);
        const dur = j.finishedAt && j.startedAt ? ` ${chalk.dim(`${((j.finishedAt - j.startedAt) / 1000).toFixed(1)}s`)}` : "";
        const hint = j.interrupted ? chalk.dim("（已中断，可续接）") : "";
        ctx.writeLine(`  ${status} ${chalk.gray(j.id)} ${chalk.dim(j.agentId)}${dur} ${content}${hint}`);
      }
      ctx.writeLine(chalk.gray("  （兼容视图：done 即子智能体 idle 可续接；完整操作 /subagents）"));
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
        // 自然语言：规则解析 → LLM 兜底（兜底结果经 reconcileCron 按原句校验并自动修复）
        let parsed: (NaturalSchedule & { notes?: string[] }) | null = parseNaturalSchedule(nl);
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
        if (ok && parsed.notes && parsed.notes.length > 0) {
          ctx.writeLine(chalk.gray(`  已按原句修正模型结果: ${parsed.notes.join("；")}`));
        }
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
