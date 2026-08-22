/**
 * .aw 包导出命令组 — pkg export / list（打包技能/MCP/插件为 .aw 分发文件）
 */

import chalk from "chalk";
import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { packageInstaller, AW_EXTENSION } from "../core/package-installer.js";
import type { CliCommand } from "./types.js";

const TYPES = ["skill", "mcp", "plugin"] as const;

export const packageCommands: CliCommand[] = [
  {
    name: "pkg",
    usage: "pkg export <skill|mcp|plugin> <名称> [路径] | pkg list",
    description: "打包导出技能/MCP/插件为 .aw 分发文件",
    detail: "导出 .aw（zip + manifest）；安装用 /install <文件>",
    handler: async (ctx, _arg, line) => {
      const parts = line.split(/\s+/).slice(1);
      const sub = parts[0] ?? "";

      if (sub === "list") {
        const exportable = packageInstaller.listExportable();
        const installed = packageInstaller.listInstalled();
        ctx.writeLine(chalk.bold("\n可导出资产"));
        ctx.writeLine(chalk.gray(`  技能: ${exportable.skills.join(", ") || "(无)"}`));
        ctx.writeLine(chalk.gray(`  MCP : ${exportable.mcp.join(", ") || "(无)"}`));
        ctx.writeLine(chalk.gray(`  插件: ${exportable.plugins.join(", ") || "(无)"}`));
        if (installed.length > 0) {
          ctx.writeLine(chalk.bold("\n已安装 .aw 包"));
          for (const i of installed) {
            ctx.writeLine(chalk.gray(`  [${i.type}] ${i.name} v${i.version}`));
          }
        }
        ctx.printStatus();
        return "continue";
      }

      if (sub === "export") {
        const type = parts[1] as (typeof TYPES)[number];
        const name = parts[2];
        if (!TYPES.includes(type) || !name) {
          ctx.writeLine(chalk.gray("用法: /pkg export <skill|mcp|plugin> <名称> [输出路径]"));
          return "continue";
        }
        const out = packageInstaller.exportPackage(type, name);
        if (!out) {
          ctx.writeLine(chalk.red(`✗ 未找到 ${type}: ${name}`));
          return "continue";
        }
        const outPath = parts[3]
          ? resolve(parts[3])
          : resolve(process.cwd(), `${out.manifest.name}-${out.manifest.version}${AW_EXTENSION}`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, out.data);
        ctx.writeLine(chalk.green(`✓ 已导出 [${type}] ${out.manifest.name} v${out.manifest.version} → ${outPath}`));
        ctx.writeLine(chalk.gray(`  安装: /install ${outPath}`));
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.gray("用法: /pkg export <skill|mcp|plugin> <名称> [路径] | /pkg list"));
      return "continue";
    },
  },
];
