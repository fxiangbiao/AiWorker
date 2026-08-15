/**
 * 多智能体协作命令组 — plan / debate
 */

import chalk from "chalk";
import { pickDebateAgents } from "../core/team-coordinator.js";
import type { StreamCallbacks } from "../types.js";
import type { CliCommand } from "./types.js";

export const collabCommands: CliCommand[] = [
  {
    name: "plan",
    usage: "plan <描述>",
    description: "多专家 DAG 协作",
    detail: "自动分解任务，拓扑序执行",
    handler: async (ctx, arg) => {
      const planDesc = arg;
      if (!planDesc) {
        ctx.writeLine(chalk.red("请输入任务描述，例如: /plan 开发一款放置类手游"));
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.cyan(`\n🔗 Team 协调器正在规划...`));
      ctx.writeLine(chalk.gray("分析任务 → 生成执行计划"));

      let planResult;
      try {
        planResult = await ctx.coordinator.plan(planDesc);
      } catch (err) {
        ctx.writeLine(chalk.red(`\n✗ 规划失败: ${(err as Error).message}`));
        ctx.printStatus();
        return "continue";
      }

      const plan = planResult.plan;
      ctx.writeLine(chalk.green(`✓ 计划已生成 (${plan.steps.length} 步, ${planResult.source})\n`));

      // 打印步骤列表作为进度模板
      const stepStatus: Record<string, string> = {};
      for (const step of plan.steps) {
        const deps = step.dependsOn.length > 0 ? chalk.gray(` ← ${step.dependsOn.join(", ")}`) : "";
        ctx.write(
          `  ${chalk.cyan("⚪")} ${chalk.cyan(step.id)}: ${chalk.yellow(step.expertId)} — ${step.description}${deps}\n`,
        );
        stepStatus[step.id] = "⚪";
      }

      ctx.write("\n");

      const callbacks: StreamCallbacks = {
        onStepStart: (stepId, expertId) => {
          const step = plan.steps.find((s) => s.id === stepId);
          if (step) {
            stepStatus[stepId] = "🔵";
            ctx.write(
              `  ${chalk.cyan("🔵")} ${chalk.cyan(stepId)}: ${chalk.yellow(expertId)} — ${step.description} ${chalk.dim("(进行中...)")}\n`,
            );
          }
        },
        onStepEnd: (stepId, success) => {
          const step = plan.steps.find((s) => s.id === stepId);
          if (step) {
            const icon = success ? chalk.green("✅") : chalk.red("❌");
            const status = success ? "" : chalk.gray(" (已跳过)");
            stepStatus[stepId] = success ? "✅" : "❌";
            ctx.write(
              `  ${icon} ${chalk.cyan(stepId)}: ${chalk.yellow(step.expertId)} — ${step.description}${status}\n`,
            );
          }
        },
        onToolCall: (expertId, desc) => {
          ctx.write(`    ${chalk.blue(`🔧 ${expertId}`)}: ${desc}\n`);
        },
        onToolResult: (_name, success, summary) => {
          const icon = success ? chalk.green("  ✓") : chalk.red("  ✗");
          ctx.write(`    ${icon} ${summary.slice(0, 80)}\n`);
        },
      };

      try {
        const result = await ctx.coordinator.execute(plan, ctx.workingDir, callbacks);
        ctx.write(chalk.cyan("\n📋 汇总报告:\n"));
        ctx.write(result.text);
        ctx.write(`\n`);
      } catch (err) {
        ctx.writeLine(chalk.red(`\n✗ 执行失败: ${(err as Error).message}`));
      }

      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "debate",
    usage: "debate <话题>",
    description: "双专家辩论",
    detail: "两专家独立分析+互审+综合报告",
    handler: async (ctx, arg) => {
      const topic = arg;
      if (!topic) {
        ctx.writeLine(chalk.red("请输入辩论话题，例如: /debate React vs Vue 技术选型"));
        ctx.printStatus();
        return "continue";
      }

      const { agentA, agentB } = pickDebateAgents(topic, ctx.coordinator.getAvailableAgents());
      ctx.writeLine(chalk.cyan(`\n⚔  辩论模式: ${agentA} vs ${agentB}`));
      ctx.writeLine(chalk.gray(`话题: ${topic}\n`));

      const debateCallbacks: StreamCallbacks = {
        onToolCall: (expertId, desc) => {
          ctx.write(`${chalk.blue(`🔧 ${expertId}`)}: ${desc}\n`);
        },
        onToolResult: (_name, success, summary) => {
          const icon = success ? chalk.green("✓") : chalk.red("✗");
          ctx.write(`  ${icon} ${summary.slice(0, 80)}\n`);
        },
      };

      try {
        const result = await ctx.coordinator.debate(topic, agentA, agentB, ctx.workingDir, debateCallbacks);
        ctx.write(chalk.cyan("\n📋 辩论报告:\n"));
        ctx.write(result.text);
        ctx.write(`\n`);
      } catch (err) {
        ctx.writeLine(chalk.red(`\n✗ 辩论失败: ${(err as Error).message}`));
      }

      ctx.printStatus();
      return "continue";
    },
  },
];
