/**
 * 插件命令组 — plugins / install
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pluginManager } from "../core/plugin-manager.js";
import { packageInstaller } from "../core/package-installer.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";

export const pluginsCommands: CliCommand[] = [
  {
    name: "install",
    usage: "install <path> [-f]",
    description: "安装 .aw 插件/技能/MCP 包",
    detail: "解压 .aw 包（按 manifest.type 路由）：plugin→config/plugins/，skill→skills/，mcp→config/mcp.json；-f 覆盖安装",
    handler: async (ctx, arg) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const force = parts.includes("-f") || parts.includes("--force");
      const pkgPath = parts.find((p) => p !== "-f" && p !== "--force");
      if (!pkgPath) {
        ctx.writeLine(chalk.gray("用法: /install <path> [-f]  例: /install ./git-tools-v1.3.aw"));
        ctx.printStatus();
        return "continue";
      }
      if (!pkgPath.toLowerCase().endsWith(".aw")) {
        ctx.writeLine(chalk.yellow(`⚠ "${pkgPath}" 不是 .aw 包（后缀必须为 .aw）`));
        ctx.printStatus();
        return "continue";
      }
      const abs = existsSync(pkgPath) ? pkgPath : resolvePath(ctx.workingDir, pkgPath);
      if (!existsSync(abs)) {
        ctx.writeLine(chalk.red(`✗ 文件不存在: ${abs}`));
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.cyan(`\n📦 安装包: ${abs}`));
      const result = packageInstaller.install(abs, { force });
      if (result.success) {
        ctx.writeLine(chalk.green(`✓ 安装成功 [${result.type}] ${result.name} v${result.version}`));
        if (result.type === "plugin") {
          ctx.writeLine(chalk.dim(`  目录: ${result.targetDir}`));
          ctx.writeLine(chalk.dim("  重启或下次启动时自动加载（plugin-manager 扫描 config/plugins/）"));
        } else if (result.type === "mcp") {
          ctx.writeLine(chalk.dim(`  已合并到 ${result.targetDir}（立即生效，/mcps 查看）`));
        } else {
          ctx.writeLine(chalk.dim(`  目录: ${result.targetDir}`));
          ctx.writeLine(chalk.dim("  技能已就绪，输入 /技能名 激活"));
        }
      } else {
        ctx.writeLine(chalk.red(`✗ 安装失败: ${result.error}`));
      }
      ctx.printStatus();
      return "continue";
    },
  },
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
          for (const w of p.warnings ?? []) {
            ctx.writeLine(`      ${chalk.yellow("⚠")} ${chalk.yellow(w)}`);
          }
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
