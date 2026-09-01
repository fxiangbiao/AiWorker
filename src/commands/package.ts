/**
 * .aw 包导出命令组 — pkg export / list（打包技能/MCP/插件为 .aw 分发文件）
 */

import chalk from "chalk";
import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { packageInstaller, AW_EXTENSION } from "../core/package-installer.js";
import type { CliCommand } from "./types.js";

const TYPES = ["skill", "mcp", "plugin", "app"] as const;

export const packageCommands: CliCommand[] = [
  {
    name: "pkg",
    usage: "pkg export <skill|mcp|plugin|app> <名称> [路径] [--raw] | pkg list",
    description: "打包导出技能/MCP/插件/应用（.aw 或裸格式）",
    detail: "默认 .aw；--raw 输出裸格式（skill→.md、mcp→.json、plugin→复制目录）；安装用 /install；app 从 data/apps/<id> 打包（含 app.json 全目录）",
    handler: async (ctx, _arg, line) => {
      const parts = line.split(/\s+/).slice(1);
      const sub = parts[0] ?? "";
      const raw = parts.includes("--raw");

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
        // parts = [export, type, name, path?]；剔除标志后：posArgs = [type, name, path?]
        const posArgs = parts.filter((p) => p !== "--raw" && p !== "export");
        const type = posArgs[0] as (typeof TYPES)[number];
        const name = posArgs[1];
        if (!TYPES.includes(type) || !name) {
          ctx.writeLine(chalk.gray("用法: /pkg export <skill|mcp|plugin|app> <名称> [路径] [--raw]"));
          return "continue";
        }

        if (raw) {
          // 裸格式导出
          if (type === "app") {
            ctx.writeLine(chalk.red("✗ app 仅支持 .aw 打包（多文件目录），不支持裸导出"));
            return "continue";
          }
          if (type === "plugin") {
            const dest = posArgs[2] ? resolve(posArgs[2]) : null;
            if (!dest) {
              ctx.writeLine(chalk.gray("插件裸导出需指定目标目录: /pkg export plugin <名称> <目录> --raw"));
              return "continue";
            }
            const out = packageInstaller.copyPluginDir(name, dest);
            ctx.writeLine(out ? chalk.green(`✓ 已导出插件目录 → ${out}`) : chalk.red(`✗ 未找到插件: ${name}`));
            return "continue";
          }
          const out = packageInstaller.exportRaw(type, name);
          if (!out) {
            ctx.writeLine(chalk.red(`✗ 未找到 ${type}: ${name}`));
            return "continue";
          }
          const outPath = posArgs[2] ? resolve(posArgs[2]) : resolve(process.cwd(), out.filename);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, out.data);
          ctx.writeLine(chalk.green(`✓ 已导出裸格式 [${type}] ${name} → ${outPath}`));
          ctx.printStatus();
          return "continue";
        }

        // .aw 包导出
        const out = packageInstaller.exportPackage(type, name);
        if (!out) {
          ctx.writeLine(chalk.red(`✗ 未找到 ${type}: ${name}`));
          return "continue";
        }
        const outPath = posArgs[2]
          ? resolve(posArgs[2])
          : resolve(process.cwd(), `${out.manifest.name}-${out.manifest.version}${AW_EXTENSION}`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, out.data);
        ctx.writeLine(chalk.green(`✓ 已导出 [${type}] ${out.manifest.name} v${out.manifest.version} → ${outPath}`));
        ctx.writeLine(chalk.gray(`  安装: /install ${outPath}（裸格式: 加 --raw）`));
        ctx.printStatus();
        return "continue";
      }

      ctx.writeLine(chalk.gray("用法: /pkg export <skill|mcp|plugin|app> <名称> [路径] [--raw] | /pkg list"));
      return "continue";
    },
  },
];
