/**
 * 轨迹时间轴渲染 — CLI /trace 命令
 * 复用 index.ts 命令渲染风格（stdout + chalk），不依赖帧缓冲组件
 */

import chalk from "chalk";
import type { TraceItem, SessionStats } from "../types.js";

function statusIcon(item: TraceItem): string {
  if (item.status === "fail") return chalk.red("✗");
  if (item.status === "running") return chalk.yellow("◌");
  return chalk.green("✓");
}

function durationOf(item: TraceItem): string {
  if (item.durationMs === undefined) return "";
  if (item.durationMs < 1000) return chalk.dim(` ${item.durationMs}ms`);
  return chalk.dim(` ${(item.durationMs / 1000).toFixed(1)}s`);
}

function tokensOf(item: TraceItem): string {
  if (!item.tokens || item.tokens.totalTokens === 0) return "";
  return chalk.dim(` ${item.tokens.totalTokens} tok`);
}

export function renderTrace(items: TraceItem[], stats: SessionStats): string[] {
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      `── 轨迹时间线 ── ${stats.turnCount} 轮 · ${stats.stepCount} 步 · ${stats.toolCallsTotal} 工具` +
        `（失败 ${stats.toolCallsFailed}）· ${stats.tokensTotal} tok · ${(stats.wallMs / 1000).toFixed(1)}s ──`,
    ),
  );

  for (const item of items) {
    switch (item.type) {
      case "turn":
        lines.push(
          `  ${statusIcon(item)} ${chalk.cyan(item.label)}${durationOf(item)}${item.detail ? chalk.dim(` ${item.detail}`) : ""}`,
        );
        break;
      case "step":
        lines.push(`    ${chalk.dim("├─")} ${chalk.yellow(item.label)}${durationOf(item)}`);
        break;
      case "user":
        lines.push(`      ${chalk.green("└─ 用户")}: ${chalk.dim(item.detail ?? "")}`);
        break;
      case "assistant":
        lines.push(`      ${chalk.blue("└─ 助手")}: ${chalk.dim(item.detail ?? "")}${tokensOf(item)}`);
        break;
      case "tool":
        lines.push(
          `      ${statusIcon(item)} ${chalk.cyan(`🔧 ${item.label}`)}${durationOf(item)}` +
            `${item.status === "fail" ? chalk.red(` ${item.detail ?? "失败"}`) : ""}`,
        );
        break;
      case "memory":
        lines.push(`      ${chalk.magenta("◈ 记忆")}: ${chalk.dim(item.detail ?? "")}`);
        break;
      case "title":
        lines.push(`      ${chalk.gray("✎ 标题")}: ${chalk.dim(item.detail ?? "")}`);
        break;
      default:
        break;
    }
  }

  if (stats.errorCount > 0) {
    lines.push(chalk.red(`⚠ ${stats.errorCount} 处错误（结束原因: ${stats.finishReason}）`));
  }
  return lines;
}
