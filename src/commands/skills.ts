/**
 * 技能命令组 — skill / skills / skill-evo
 */

import chalk from "chalk";
import { skillRegistry } from "../core/skill-registry.js";
import { hookManager } from "../hooks/hook-manager.js";
import { createEvaluateSkillCreation } from "../hooks/handlers.js";
import { displayWidth, padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

export const skillsCommands: CliCommand[] = [
  {
    name: "skill",
    usage: "skill <名称>",
    description: "手动激活技能",
    detail: "如 /skill code-review, /skill debug（等价 /技能名）",
    handler: async (ctx, arg) => {
      const skillName = arg.trim();
      if (!skillName) {
        ctx.writeLine(chalk.gray(`用法: /skill <名称>  可用: ${skillRegistry.getAll().map((s) => s.name).join(", ")}`));
        ctx.printStatus();
        return "continue";
      }
      const skill = skillRegistry.getAll().find((s) => s.name.toLowerCase() === skillName.toLowerCase());
      if (!skill) {
        ctx.writeLine(chalk.yellow(`\n未找到技能 "${skillName}"`));
        const allSkills = skillRegistry.getAll().map((s) => chalk.cyan(s.name));
        ctx.writeLine(chalk.gray(`可用技能: ${allSkills.join(", ")}\n`));
        ctx.printStatus();
        return "continue";
      }
      ctx.writeLine(chalk.cyan(`\n📋 调用技能: ${skill.name}`));
      // 排队消息：主循环顶部自动消费并走路由
      ctx.prefillQueue.push(`请使用 ${skill.name} 技能完成任务：\n\n${skill.body}\n\n用户任务：\n`);
      return "continue";
    },
  },
  {
    name: "skills",
    usage: "skills",
    description: "查看全部技能",
    detail: "分组展示技能名称与描述",
    handler: async (ctx) => {
      const all = skillRegistry.getAll();
      if (all.length === 0) {
        ctx.writeLine(chalk.gray("暂无技能"));
      } else {
        // 按专家分组，名称对齐 + 描述
        const byExpert = new Map<string, typeof all>();
        for (const s of all) {
          const list = byExpert.get(s.expert) ?? [];
          list.push(s);
          byExpert.set(s.expert, list);
        }
        const nameWidth = Math.min(
          24,
          Math.max(8, ...all.map((s) => displayWidth(s.name))) + 2,
        );
        ctx.writeLine("");
        for (const [expert, skills] of byExpert) {
          ctx.writeLine(`  ${chalk.cyan(expert)}`);
          for (const s of skills) {
            const namePad = padToWidth(chalk.white(s.name), nameWidth);
            const desc = s.description ? chalk.dim(s.description) : "";
            ctx.writeLine(`    ${namePad}${desc}`);
          }
        }
        ctx.writeLine("");
        ctx.writeLine(
          chalk.dim(`💡 共 ${all.length} 个技能，直接输入 /技能名 激活（如 /code-review），/help 查看命令`),
        );
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "skill-evo",
    usage: "skill-evo",
    description: "切换技能自动沉淀",
    detail: "向后兼容：已并入 /config skill-evo",
    handler: async (ctx) => {
      const id = "onTaskComplete:evaluateSkillCreation";
      if (hookManager.has(id)) {
        hookManager.off(id);
        ctx.writeLine(chalk.yellow("✓ 技能自动沉淀: 关闭（可用 /config skill-evo 切换）"));
      } else {
        const handler = createEvaluateSkillCreation({ sessionStore: ctx.sessionStore, modelRouter: ctx.modelRouter });
        hookManager.on("onTaskComplete", handler, { id, priority: 10 });
        ctx.writeLine(chalk.green("✓ 技能自动沉淀: 开启（可用 /config skill-evo 切换）"));
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
