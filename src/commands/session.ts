/**
 * 会话与上下文命令组 — new / log / sessions / switch / copy / trace / context
 */

import chalk from "chalk";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { mcpManager } from "../mcp/mcp-manager.js";
import { projectTrace, computeSessionStats } from "../core/trace.js";
import { renderTrace } from "../terminal/trace-view.js";
import { copyToClipboard } from "./clipboard.js";
import { renderSessionMarkdown } from "../memory/session-export.js";
import { displayWidth, padToWidth, formatDuration, fmtK } from "./format.js";
import type { CliCommand } from "./types.js";

export const sessionCommands: CliCommand[] = [
  {
    name: "new",
    usage: "new",
    description: "开启新会话",
    detail: "清空上下文和 token 计数，重新开始",
    handler: async (ctx) => {
      ctx.setCurrentSessionId(undefined);
      ctx.modelRouter.resetTokenUsage();
      ctx.writeLine(chalk.green("✓ 新会话已开始，上下文已清空"));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "log",
    usage: "log",
    description: "查看监控日志",
    detail: "当前 session 的轮次摘要表",
    handler: async (ctx) => {
      const sessionId = ctx.currentSessionId();
      const turns = sessionId
        ? ctx.sessionStore.getTurnLogs(sessionId)
        : ctx.sessionStore.getRecentTurnLogs(20);
      if (turns.length === 0) {
        ctx.writeLine(chalk.gray("暂无监控日志"));
      } else {
        let totalDur = 0;
        let totalTools = 0;
        let totalPrompt = 0;
        let totalCompletion = 0;
        const rows: string[][] = [];
        for (const t of turns) {
          const dur = t.finishedAt - t.startedAt;
          totalDur += dur;
          totalTools += t.toolCallsTotal;
          totalPrompt += t.tokensPrompt;
          totalCompletion += t.tokensCompletion;
          const status = t.finishReason === "stop" ? "✅" : "⚠️";
          rows.push([
            String(t.seq),
            String(t.iterations),
            String(t.toolCallsTotal),
            formatDuration(dur),
            fmtK(t.tokensPrompt),
            fmtK(t.tokensCompletion),
            status,
          ]);
        }
        const headers = ["轮次", "迭代", "工具", "耗时", "输入tok", "输出tok", "状态"];
        const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]!))));
        const border = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
        const sep = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
        const bottom = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
        ctx.write(`\n${border}\n`);
        ctx.write(`│ ${headers.map((h, i) => padToWidth(h, widths[i]!)).join(" │ ")} │\n`);
        ctx.write(`${sep}\n`);
        for (const r of rows) {
          ctx.write(`│ ${r.map((c, i) => padToWidth(c, widths[i]!)).join(" │ ")} │\n`);
        }
        ctx.write(`${bottom}\n`);
        ctx.write(
          chalk.gray(
            `累计: ${turns.length} 轮, ${(totalDur / 1000).toFixed(1)}s, ${totalTools} 次工具调用, ` +
              `输入 ${fmtK(totalPrompt)} tok, 输出 ${fmtK(totalCompletion)} tok`,
          ),
        );
        if (!sessionId) {
          ctx.write(chalk.gray(`（最近会话，/sessions 或 /switch 切换）\n`));
        } else {
          ctx.write("\n");
        }
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "sessions",
    usage: "sessions",
    description: "浏览历史会话",
    detail: "列出最近会话，/switch <序号> 切换",
    handler: async (ctx) => {
      const sessions = ctx.sessionStore.listSessions(20);
      if (sessions.length === 0) {
        ctx.writeLine(chalk.gray("暂无历史会话"));
      } else {
        ctx.write("\n┌──────┬────────────┬──────────┬────────────┬──────────────┬──────────────────────┐\n");
        ctx.write(
          `│ ${padToWidth("序号", 4)} │ ${padToWidth("时间", 10)} │ ${padToWidth("轮数", 8)} │ ${padToWidth("消息数", 10)} │ ${padToWidth("Agent", 12)} │ ${padToWidth("摘要", 20)} │\n`,
        );
        ctx.write("├──────┼────────────┼──────────┼────────────┼──────────────┼──────────────────────┤\n");
        sessions.forEach((s, i) => {
          const time = new Date(s.updatedAt).toLocaleDateString();
          const agentLabel = s.agentId.length > 12 ? s.agentId.slice(0, 12) : s.agentId;
          let summary = s.firstUserMsg ?? s.summary ?? "(无)";
          // CJK 安全截断（displayWidth 计 2 列/字，列宽 20）
          while (displayWidth(summary) > 20) summary = summary.slice(0, -1);
          ctx.write(
            `│ ${String(i + 1).padEnd(4)} │ ${time.padEnd(10)} │ ${String(s.turnCount).padEnd(8)} │ ${String(s.messageCount).padEnd(10)} │ ${padToWidth(agentLabel, 12)} │ ${padToWidth(summary, 20)} │\n`,
          );
        });
        ctx.write(`└──────┴────────────┴──────────┴────────────┴──────────────┴──────────────────────┘\n`);
        ctx.write(chalk.gray(`共 ${sessions.length} 个会话，/switch <序号> 切换\n`));
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "switch",
    usage: "switch <序号>",
    description: "切换会话",
    detail: "恢复指定会话上下文继续对话",
    handler: async (ctx, arg) => {
      const sessions = ctx.sessionStore.listSessions(20);
      const idx = parseInt(arg, 10);
      let target: { id: string } | undefined;
      if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
        target = sessions[idx - 1];
      } else {
        target = sessions.find((s) => s.id.startsWith(arg));
      }
      if (target) {
        ctx.setCurrentSessionId(target.id);
        ctx.writeLine(chalk.green(`✓ 已切换到会话 (${arg})`));
      } else {
        ctx.writeLine(chalk.red("未找到该会话，/sessions 查看列表"));
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "export",
    usage: "export [序号]",
    description: "导出会话为 Markdown 文件",
    detail: "默认当前会话；/export <序号> 按 /sessions 序号导出；写入工作目录 <标题>.md",
    handler: async (ctx, arg) => {
      let targetId = ctx.currentSessionId();
      if (arg.trim()) {
        const sessions = ctx.sessionStore.listSessions(20);
        const idx = parseInt(arg.trim(), 10);
        if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
          targetId = sessions[idx - 1]!.id;
        } else {
          const found = sessions.find((s) => s.id.startsWith(arg.trim()));
          if (found) targetId = found.id;
        }
      }
      if (!targetId) {
        ctx.writeLine(chalk.gray("暂无会话可导出（先进行一轮对话，或 /export <序号> 指定会话）"));
        ctx.printStatus();
        return "continue";
      }
      const messages = ctx.sessionStore.getSessionMessages(targetId);
      const sessions = ctx.sessionStore.listSessions(1000);
      const meta = sessions.find((s) => s.id === targetId);
      const title = meta?.summary ?? targetId.slice(0, 12);
      const md = renderSessionMarkdown(title, targetId, messages);
      // 文件名安全化：非法字符替换
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50) || "session";
      const outPath = resolve(ctx.workingDir, `${safeTitle}.md`);
      mkdirSync(ctx.workingDir, { recursive: true });
      writeFileSync(outPath, md, "utf-8");
      ctx.writeLine(chalk.green(`✓ 已导出会话「${title}」→ ${outPath}`));
      ctx.writeLine(chalk.gray(`  ${messages.length} 条消息 · ${md.length} 字符`));
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "copy",
    usage: "copy",
    description: "复制回答",
    detail: "复制上次回答的原始 Markdown 到剪贴板",
    handler: async (ctx) => {
      if (!ctx.lastAnswer.value) {
        ctx.writeLine(chalk.gray("暂无回答可复制（先发送一条消息）"));
      } else {
        await copyToClipboard(ctx.lastAnswer.value);
        ctx.writeLine(chalk.green(`✓ 已复制原始 Markdown 到剪贴板 (${ctx.lastAnswer.value.length} 字符)`));
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "trace",
    usage: "trace [序号]",
    description: "查看会话轨迹",
    detail: "事件时间线 + 统计，--json 输出",
    handler: async (ctx, arg) => {
      let targetSessionId = ctx.currentSessionId();
      if (arg && arg !== "--json") {
        const sessions = ctx.sessionStore.listSessions(20);
        const idx = parseInt(arg, 10);
        if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
          targetSessionId = sessions[idx - 1]!.id;
        } else {
          const found = sessions.find((s) => s.id.startsWith(arg));
          if (found) targetSessionId = found.id;
        }
      }
      if (!targetSessionId) {
        ctx.writeLine(chalk.gray("暂无会话轨迹（先进行一轮对话，或 /trace <序号> 指定会话）"));
        ctx.printStatus();
        return "continue";
      }
      const events = ctx.sessionStore.getEvents(targetSessionId);
      if (events.length === 0) {
        ctx.writeLine(chalk.gray("该会话暂无事件记录（事件溯源自 Sprint 24 起生效）"));
        ctx.printStatus();
        return "continue";
      }
      const items = projectTrace(events);
      const stats = computeSessionStats(targetSessionId, events);
      if (arg === "--json") {
        ctx.write(`${JSON.stringify({ sessionId: targetSessionId, items, stats }, null, 2)}\n`);
      } else {
        ctx.writeLine("");
        for (const line of renderTrace(items, stats)) ctx.writeLine(line);
        ctx.writeLine("");
      }
      ctx.printStatus();
      return "continue";
    },
  },
  {
    name: "context",
    usage: "context [查询]",
    description: "上下文占用分析",
    detail: "分层 token 占比 + MCP 工具列表",
    handler: async (ctx, arg) => {
      const breakdown = ctx.getContextBreakdown(arg);
      const ws = breakdown.windowSize;
      const bar = (v: number) => {
        const pct = ws > 0 ? (v / ws) * 100 : 0;
        const w = Math.round(pct / 5);
        const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
        return `${color("█".repeat(w))}${chalk.gray("░".repeat(Math.max(0, 20 - w)))}`;
      };
      const fmtN = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

      ctx.write(`\n${chalk.bold("── 上下文占用 ──")}\n`);
      const fmt = (label: string, tok: number, extra?: string) => {
        const pct = ws > 0 ? `(${((tok / ws) * 100).toFixed(0)}%)` : "";
        const ext = extra ? ` ${chalk.dim(extra)}` : "";
        ctx.write(
          `│ ${chalk.dim(padToWidth(label, 10))} ${bar(tok)} ${chalk.white(fmtN(tok))}/${chalk.white(fmtN(ws))} ${pct}${ext}\n`,
        );
      };

      fmt("系统提示词", breakdown.systemPromptBase);
      fmt("项目记忆", breakdown.projectMemory);
      fmt("用户画像", breakdown.userProfile);
      fmt("情景记忆", breakdown.episodicMemory);
      const skillExtra = breakdown.skillsMatched.length > 0 ? `(${breakdown.skillsMatched.length}/${breakdown.skillsTotal})` : "";
      fmt("注入技能", breakdown.injectedSkills, skillExtra);
      fmt("会话历史", breakdown.conversationHistory);
      fmt("当前消息", breakdown.currentTurn);
      const totalLabel = padToWidth("合计", 12);
      ctx.write(
        `│ ${totalLabel}${" ".repeat(20)} ${chalk.bold(fmtN(breakdown.total))}/${chalk.bold(fmtN(ws))} (${((breakdown.total / ws) * 100).toFixed(0)}%)\n`,
      );

      const mcpStatuses = mcpManager.getStatuses();
      const mcpServers = Object.values(mcpStatuses);
      if (mcpServers.length > 0) {
        ctx.write(`\n${chalk.dim("── MCP 工具 ──")}\n`);
        for (const s of mcpServers) {
          const icon = s.connected ? chalk.green("✓") : chalk.red("✗");
          ctx.write(`│ ${icon} ${s.name}: ${s.toolCount} 工具\n`);
        }
      }

      ctx.write("\n");
      ctx.printStatus();
      return "continue";
    },
  },
];
