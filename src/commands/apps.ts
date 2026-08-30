/**
 * 应用命令组 — /app（AI OS 应用生命周期 + 即时生成，Sprint 34/35）
 * list / info / install / start / stop / destroy / new / update / focus / close
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { eventBus } from "../server/event-bus.js";
import { padToWidth } from "./format.js";
import type { CliCommand } from "./types.js";
import type { AppSpec } from "../types.js";

const TYPE_LABEL: Record<string, string> = {
  tool: "工具",
  skill: "技能",
  agent: "智能体",
  service: "服务",
  app: "应用",
};

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return chalk.green("●");
    case "starting":
      return chalk.cyan("◐");
    case "stopping":
      return chalk.yellow("◑");
    case "failed":
      return chalk.red("✗");
    case "destroyed":
      return chalk.gray("✕");
    default:
      return chalk.gray("○");
  }
}

function permLabel(perms: string[]): string {
  if (perms.length === 0) return chalk.dim("无");
  return perms.join(", ");
}

export const appsCommands: CliCommand[] = [
  {
    name: "app",
    usage: "app <list|info|install|start|stop|destroy|new|update|focus|close> [参数]",
    description: "AI OS 应用生命周期管理 + 即时生成",
    detail: "list 列表 / info <id> 详情 / install <路径> 安装目录 / start|stop <id> / destroy <id> 销毁 / new <描述> 即时生成（自动识别类型，文档型产出到 data/docs/）/ update <id> <变更> 迭代生成（数据保留）/ focus|close <id> 窗口指令",
    handler: async (ctx, arg) => {
      const mgr = ctx.appManager;
      const factory = ctx.appFactory;
      if (!mgr) {
        ctx.writeLine(chalk.yellow("⚠ 应用管理器未初始化"));
        ctx.printStatus();
        return "continue";
      }
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "new": {
          if (!factory) {
            ctx.writeLine(chalk.yellow("⚠ 应用工厂未初始化"));
            break;
          }
          if (!rest) {
            ctx.writeLine(chalk.gray("用法: /app new <描述>  例: /app new 番茄钟 | /app new 一份项目周报（文档型）"));
            break;
          }
          ctx.writeLine(chalk.cyan(`\n✨ 生成中: ${rest}（自动识别类型，生成后 Web 端自动打开）`));
          const spec: AppSpec = { description: rest, type: "app", sessionId: ctx.currentSessionId() };
          const result = await factory.generate(spec);
          if (result.ok && result.docPath) {
            ctx.writeLine(chalk.green(`✓ 文档已生成: ${result.docPath}`));
            ctx.writeLine(chalk.dim("  Web 端文档工作台可查看"));
          } else if (result.ok && result.app) {
            ctx.writeLine(chalk.green(`✓ 应用已生成并启动: ${result.app.id} v${result.app.version}`));
            ctx.writeLine(chalk.dim("  Web 端已弹出窗口；/app destroy 可销毁"));
          } else {
            ctx.writeLine(chalk.red(`✗ 生成失败: ${result.error}`));
          }
          break;
        }
        case "update": {
          if (!factory) {
            ctx.writeLine(chalk.yellow("⚠ 应用工厂未初始化"));
            break;
          }
          const id = parts[1] ?? "";
          const desc = parts.slice(2).join(" ").trim();
          if (!id || !desc) {
            ctx.writeLine(chalk.gray("用法: /app update <id> <变更描述>  例: /app update pomodoro 加暂停按钮"));
            break;
          }
          ctx.writeLine(chalk.cyan(`\n✨ 迭代更新: ${id}（只重生成逻辑文件，数据保留）`));
          const result = await factory.update(id, desc, ctx.currentSessionId());
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已更新: ${id} v${result.app?.version}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 更新失败: ${result.error}`));
          }
          break;
        }
        case "focus": {
          const id = rest.trim();
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /app focus <id>"));
            break;
          }
          eventBus.broadcast({ type: "app/window", action: "focus", appId: id });
          ctx.writeLine(chalk.green(`✓ 已发送窗口置前指令: ${id}`));
          break;
        }
        case "close": {
          const id = rest.trim();
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /app close <id>"));
            break;
          }
          eventBus.broadcast({ type: "app/window", action: "close", appId: id });
          ctx.writeLine(chalk.green(`✓ 已发送关闭窗口指令: ${id}`));
          break;
        }
        case "list": {
          const apps = mgr.list();
          if (apps.length === 0) {
            ctx.writeLine(chalk.gray("暂无应用（/app install <目录> 安装第一个）"));
          } else {
            ctx.writeLine("");
            for (const a of apps) {
              const pluginMark = a.plugin ? chalk.dim(" [插件]") : "";
              const version = chalk.dim(` v${a.version}`);
              const tools = a.tools.length > 0 ? chalk.dim(` · ${a.tools.length} 工具`) : "";
              ctx.writeLine(
                `  ${statusIcon(a.status)} ${chalk.white(padToWidth(`${a.id}${pluginMark}`, 24))}${version}${chalk.dim(" " + (TYPE_LABEL[a.type] ?? a.type))}${tools}`,
              );
              if (a.lastError) ctx.writeLine(`      ${chalk.red("✗ " + a.lastError)}`);
            }
            ctx.writeLine("");
          }
          break;
        }
        case "info": {
          const id = rest.trim();
          const app = mgr.get(id);
          if (!app) {
            ctx.writeLine(chalk.red(`✗ 应用不存在: ${id}`));
          } else {
            ctx.writeLine("");
            ctx.writeLine(`  ${statusIcon(app.status)} ${chalk.white(app.name)} ${chalk.dim(`v${app.version}`)} ${chalk.dim(`(${TYPE_LABEL[app.type] ?? app.type}${app.plugin ? ", 插件" : ""})`)}`);
            ctx.writeLine(`  ${chalk.dim(app.description)}`);
            ctx.writeLine(`  ${chalk.dim("id")}: ${app.id}`);
            ctx.writeLine(`  ${chalk.dim("状态")}: ${app.status}${app.crashCount ? chalk.yellow(`（崩溃 ${app.crashCount} 次）`) : ""}`);
            ctx.writeLine(`  ${chalk.dim("权限")}: ${permLabel(app.permissions)}`);
            ctx.writeLine(`  ${chalk.dim("工具")}: ${app.tools.length > 0 ? app.tools.join(", ") : chalk.dim("无")}`);
            ctx.writeLine(`  ${chalk.dim("autostart")}: ${app.autostart ? chalk.green("是") : "否"}`);
            if (app.originSessionId) ctx.writeLine(`  ${chalk.dim("来源会话")}: ${app.originSessionId}`);
            if (app.lastError) ctx.writeLine(`  ${chalk.red("错误: " + app.lastError)}`);
            ctx.writeLine("");
          }
          break;
        }
        case "install": {
          const force = rest.includes("-f") || rest.includes("--force");
          const path = rest.split(/\s+/).filter((p) => p !== "-f" && p !== "--force").join(" ");
          if (!path) {
            ctx.writeLine(chalk.gray("用法: /app install <目录> [-f]  例: /app install ./my-tool-app"));
            break;
          }
          const abs = existsSync(path) ? path : resolvePath(ctx.workingDir, path);
          if (!existsSync(abs)) {
            ctx.writeLine(chalk.red(`✗ 路径不存在: ${abs}`));
            break;
          }
          ctx.writeLine(chalk.cyan(`\n📦 安装应用: ${abs}`));
          const result = mgr.installFromDir(abs, { force, originSessionId: ctx.currentSessionId() });
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 安装成功: ${result.app?.id} v${result.app?.version}（/app start ${result.app?.id} 启动）`));
          } else {
            ctx.writeLine(chalk.red(`✗ 安装失败: ${result.error}`));
          }
          break;
        }
        case "start": {
          const id = rest.trim();
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /app start <id>"));
            break;
          }
          const result = await mgr.start(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已启动: ${id}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 启动失败: ${result.error}`));
          }
          break;
        }
        case "stop": {
          const id = rest.trim();
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /app stop <id>"));
            break;
          }
          const result = await mgr.stop(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已停止: ${id}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 停止失败: ${result.error}`));
          }
          break;
        }
        case "destroy": {
          const id = rest.trim();
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /app destroy <id>"));
            break;
          }
          const app = mgr.get(id);
          if (!app) {
            ctx.writeLine(chalk.red(`✗ 应用不存在: ${id}`));
            break;
          }
          if (ctx.ask) {
            const answer = await ctx.ask(`销毁应用「${app.name}」将删除其全部代码与数据，确定？(y/N)`);
            if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
              ctx.writeLine(chalk.gray("已取消"));
              break;
            }
          }
          const result = await mgr.destroy(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已销毁: ${id}（代码/进程/权限全清）`));
          } else {
            ctx.writeLine(chalk.red(`✗ 销毁失败: ${result.error}`));
          }
          break;
        }
        default:
          ctx.writeLine(chalk.gray("用法: /app list|info|install|start|stop|destroy"));
          break;
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
