/**
 * 配置与状态命令组 — mode / status / thinking / config
 */

import chalk from "chalk";
import { hookManager } from "../hooks/hook-manager.js";
import { createEvaluateSkillCreation } from "../hooks/handlers.js";
import { getAppVersion } from "../core/version.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";
import type { PermissionMode } from "../types.js";

export const configCommands: CliCommand[] = [
  {
    name: "mode",
    usage: "mode <ask/plan/auto>",
    description: "切换权限模式",
    detail: "ask(只读) / plan(确认后执行) / auto(自动执行)",
    handler: async (ctx, arg) => {
      const newMode = arg.trim() as PermissionMode;
      if (["ask", "plan", "auto"].includes(newMode)) {
        ctx.setMode(newMode);
        ctx.writeLine(chalk.green(`✓ 已切换到 ${newMode} 模式`));
      } else {
        ctx.writeLine(chalk.red("无效模式，可选: ask, plan, auto"));
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "status",
    usage: "status",
    description: "显示运行状态",
    detail: "版本/模式/模型/token/专家/技能/排队",
    handler: async (ctx) => {
      const cost = ctx.modelRouter.getCost();
      ctx.write(chalk.gray(`AiWorker v${getAppVersion()} | 模式: ${ctx.mode()} | 模型: ${ctx.modelRouter.getDisplayModel()}\n`));
      ctx.write(
        chalk.gray(
          `Token: ${ctx.modelRouter.getTokenUsage()} (提示: ${ctx.modelRouter.getPromptTokens()}, 生成: ${ctx.modelRouter.getCompletionTokens()})`,
        ),
      );
      if (cost > 0) ctx.write(chalk.gray(` | 成本: ¥${cost.toFixed(4)}`));
      const experts = Object.values(ctx.agents)
        .map((a) => a.getName())
        .join(" / ");
      ctx.write(chalk.gray(`\n专家: ${experts}\n`));
      ctx.write(chalk.gray(`技能: ${ctx.skillCount} | 排队: ${ctx.prefillQueue.length}\n`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "thinking",
    aliases: ["thought"],
    usage: "thinking",
    description: "切换思考展示",
    detail: "向后兼容：已并入 /config thinking",
    handler: async (ctx) => {
      ctx.toggleThinking();
      ctx.writeLine(chalk.green(`✓ 思考展示: ${ctx.showThinking() ? "展开" : "折叠"}（可用 /config thinking 切换）`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "config",
    usage: "config",
    description: "查看/配置模型与系统参数",
    detail: "持久化到 data/runtime-config.json",
    handler: async (ctx, _arg, line) => {
      const parts = line.split(/\s+/).slice(1);
      const sub = parts[0] ?? "";
      const arg = parts[1] ?? "";
      const persist = () => ctx.persistRuntimeConfig();

      if (sub === "model") {
        if (!arg) {
          ctx.writeLine(chalk.gray(`用法: /config model <名称>  可选: ${ctx.modelRouter.getAvailableModels().map((m) => m.key).join(", ")}`));
        } else {
          const valid = ctx.modelRouter.getAvailableModels().find((m) => m.key === arg.toLowerCase());
          if (!valid) {
            ctx.writeLine(chalk.red(`✗ 未知模型: ${arg}，可用: ${ctx.modelRouter.getAvailableModels().map((m) => m.key).join(", ")}`));
          } else {
            ctx.modelRouter.setDefaultModel(valid.key);
            persist();
            ctx.write(chalk.green(`✓ 默认模型 → ${valid.model} (${valid.provider})`));
            if (valid.key !== "default") ctx.write(chalk.dim(` via ${valid.key} profile`));
            ctx.write("\n");
            ctx.writeLine(chalk.gray(`  该设置持久化到 ${ctx.runtimeConfigPath}，重启后仍生效。`));
          }
        }
      } else if (sub === "temperature" || sub === "temp") {
        if (!arg) {
          ctx.writeLine(chalk.gray(`用法: /config temperature <0-2>  当前: ${ctx.modelRouter.getRuntimeConfig().temperature ?? "默认"}`));
        } else {
          const t = parseFloat(arg);
          if (isNaN(t) || t < 0 || t > 2) {
            ctx.writeLine(chalk.red("✗ 温度需在 0-2 之间"));
          } else {
            ctx.modelRouter.setTemperature(t);
            persist();
            ctx.writeLine(chalk.green(`✓ 温度 → ${t}`));
          }
        }
      } else if (sub === "max-tokens" || sub === "tokens") {
        if (!arg) {
          ctx.writeLine(chalk.gray(`用法: /config max-tokens <数量>  当前: ${ctx.modelRouter.getRuntimeConfig().maxTokens ?? "默认"}`));
        } else {
          const n = parseInt(arg, 10);
          if (isNaN(n) || n < 100) {
            ctx.writeLine(chalk.red("✗ max-tokens 需 ≥ 100"));
          } else {
            ctx.modelRouter.setMaxTokens(n);
            persist();
            ctx.writeLine(chalk.green(`✓ max-tokens → ${n}`));
          }
        }
      } else if (sub === "skill-evo" || sub === "skill-evolution") {
        const id = "onTaskComplete:evaluateSkillCreation";
        if (hookManager.has(id)) {
          hookManager.off(id);
          ctx.writeLine(chalk.yellow("✓ 技能自动沉淀: 关闭"));
        } else {
          const handler = createEvaluateSkillCreation({ sessionStore: ctx.sessionStore, modelRouter: ctx.modelRouter });
          hookManager.on("onTaskComplete", handler, { id, priority: 10 });
          ctx.writeLine(chalk.green("✓ 技能自动沉淀: 开启"));
        }
      } else if (sub === "thinking" || sub === "thought") {
        ctx.toggleThinking();
        ctx.writeLine(chalk.green(`✓ 思考展示: ${ctx.showThinking() ? "展开" : "折叠"}`));
      } else if (sub === "reset") {
        ctx.modelRouter.setDefaultModel("");
        ctx.modelRouter.setTemperature(null);
        ctx.modelRouter.setMaxTokens(null);
        persist();
        ctx.writeLine(chalk.green("✓ 已恢复配置文件默认（models.json）"));
      } else {
        // 默认：显示当前配置
        const rt = ctx.modelRouter.getRuntimeConfig();
        const cost = ctx.modelRouter.getCost();
        ctx.write(chalk.bold("\n── 模型配置 ──\n"));
        ctx.write(chalk.gray(`当前模型: ${ctx.modelRouter.getDisplayModel()}`));
        if (rt.profileKey) ctx.write(chalk.yellow(` (profile: ${rt.profileKey})`));
        ctx.write("\n");
        ctx.write(chalk.gray(`温度: ${rt.temperature ?? "默认"} | max-tokens: ${rt.maxTokens ?? "默认"}\n`));
        ctx.write(chalk.gray(`成本: ¥${cost.toFixed(4)}\n`));
        ctx.write(chalk.bold("\n── 可用模型 ──\n"));
        for (const m of ctx.modelRouter.getAvailableModels()) {
          const active = m.key === (rt.profileKey || "default") ? chalk.green(" ●") : "";
          ctx.write(chalk.gray(`  ${padToWidth(m.key, 10)} ${m.model} (${m.provider})${active}\n`));
        }
        ctx.write(chalk.bold("\n── 系统参数 ──\n"));
        ctx.write(chalk.gray(`  权限模式: ${ctx.mode()} (用 /mode 切换)\n`));
        ctx.write(chalk.gray(`  思考展示: ${ctx.showThinking() ? "展开" : "折叠"} (用 /config thinking 切换)\n`));
        ctx.write(chalk.gray(`  技能沉淀: ${hookManager.has("onTaskComplete:evaluateSkillCreation") ? "开启" : "关闭"} (用 /config skill-evo 切换)\n\n`));
        ctx.write(
          chalk.dim(
            `  可配置: /config model <名> | /config temperature <0-2> | /config max-tokens <n> | /config thinking | /config skill-evo | /config reset\n`,
          ),
        );
      }
      // 配置变更后立即刷新状态栏（模型/profile 变化立即可见）
      ctx.printStatus();
      return "continue";
    },
  },
];
