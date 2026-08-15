/**
 * 插件命令组 — plugins
 */

import chalk from "chalk";
import { pluginManager } from "../core/plugin-manager.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

export const pluginsCommands: CliCommand[] = [
  {
    name: "plugins",
    usage: "plugins",
    description: "查看插件",
    detail: "列出 config/plugins/ 已加载插件、状态与注册工具",
    handler: async (ctx) => {
      const plugins = pluginManager.getPlugins();
      if (plugins.length === 0) {
        ctx.writeLine(chalk.gray("未加载任何插件（检查 config/plugins/ 目录）"));
      } else {
        ctx.writeLine("");
        for (const p of plugins) {
          const icon = p.status === "loaded" ? chalk.green("✓") : chalk.red("✗");
          const version = p.version ? chalk.dim(` v${p.version}`) : "";
          const loadedDetail =
            p.status === "loaded"
              ? chalk.dim(` · ${p.registeredTools.length} 工具, ${p.registeredHooks} hook`)
              : chalk.red(` · ${p.error ?? "加载失败"}`);
          ctx.writeLine(`  ${icon} ${chalk.white(padToWidth(p.name, 20))}${version}${loadedDetail}`);
          for (const t of p.registeredTools) {
            ctx.writeLine(`      ${chalk.dim("└")} ${chalk.cyan(t)}`);
          }
        }
        ctx.writeLine("");
        ctx.writeLine(chalk.dim("💡 插件目录: config/plugins/<name>/（开发文档见 README「插件开发」）"));
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
