/**
 * 进化命令组 — /evo（Sprint 39 第一期：观察 + 提议 + 采纳/拒绝）
 * observe / propose / list / adopt / reject
 */

import chalk from "chalk";
import type { CliCommand } from "./types.js";
import type { EvolutionProposal } from "../types.js";

const TYPE_LABEL: Record<string, string> = {
  "new-skill": "新技能",
  "new-tool": "新工具",
  "new-app": "新应用",
  "config-change": "配置变更",
  "tool-fix": "工具修复",
  "prompt-fix": "提示词修复",
};

const RISK_COLOR: Record<string, (s: string) => string> = {
  low: chalk.green,
  medium: chalk.yellow,
  high: chalk.red,
};

function renderProposal(p: EvolutionProposal): string {
  const risk = RISK_COLOR[p.risk]?.(p.risk) ?? chalk.gray(p.risk);
  const type = chalk.cyan(TYPE_LABEL[p.type] ?? p.type);
  const status =
    p.status === "pending" ? chalk.yellow("待确认") :
    p.status === "confirmed" ? chalk.blue("已确认") :
    p.status === "applied" ? chalk.green("已写入") :
    p.status === "rolled_back" ? chalk.gray("已回滚") : chalk.gray("已拒绝");
  return `  ${status} ${type} ${chalk.white(p.title)} ${chalk.dim(`[${risk}]`)} ${chalk.gray(p.id)}
     ${chalk.dim(p.reason)}`;
}

/** 采纳确认后的写入内容预览（不写入，供审查） */
function renderPreview(a: EvolutionProposal["action"]): string {
  switch (a.kind) {
    case "new-skill":
      return `    ${chalk.dim("专家")}: ${a.expert}\n    ${chalk.dim("SKILL.md")}:\n${a.body
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`;
    case "new-tool":
      return `    ${chalk.dim("生成工具")}: ${a.description}`;
    case "new-app":
      return `    ${chalk.dim("生成应用")}: ${a.description}`;
    case "config-change":
      return `    ${chalk.dim("配置项")}: ${a.field} = ${JSON.stringify(a.value)}`;
    case "tool-fix":
      return `    ${chalk.dim("工具")}: ${a.toolName}\n    ${chalk.dim("建议")}: ${a.suggestion}\n    ${chalk.dim("新描述")}: ${a.newDescription}`;
    case "prompt-fix":
      return `    ${chalk.dim("智能体")}: ${a.agentId}\n    ${chalk.dim("建议")}: ${a.suggestion}\n    ${chalk.dim("新提示词")}:\n${a.newPrompt
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`;
  }
}

export const evolutionCommands: CliCommand[] = [
  {
    name: "evo",
    usage: "evo <observe|propose|list|adopt|apply|rollback|diff|reject> [id]",
    description: "AI OS 进化引擎（观察/提议/两段式确认/回滚/对比）",
    detail: "observe 观察指标 / propose 生成提案（每日 ≤3 条）/ list 提案列表 / adopt <id> 确认提案（预览写入内容，不写入）/ apply <id> 确认写入（真正执行）/ rollback <id> 回滚快照还原 / diff <id> 查看变更前后对比 / reject <id> 拒绝",
    handler: async (ctx, arg) => {
      const evo = ctx.evolutionEngine;
      if (!evo) {
        ctx.writeLine(chalk.yellow("⚠ 进化引擎未初始化"));
        ctx.printStatus();
        return "continue";
      }
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";
      const id = parts[1] ?? "";

      switch (sub) {
        case "observe": {
          const obs = evo.observe();
          ctx.writeLine(chalk.cyan("\n📊 进化观察（最近 7 天）"));
          ctx.writeLine(`  ${chalk.dim("会话")}: ${obs.completion.sessions} · 完成率 ${Math.round(obs.completion.rate * 100)}% · 平均 ${obs.completion.avgTurns} 轮`);
          ctx.writeLine(`  ${chalk.dim("工具")}: ${obs.toolStats.length} 种 · ${obs.toolStats.reduce((s, t) => s + t.calls, 0)} 次调用`);
          for (const t of obs.toolStats.slice(0, 5)) {
            const rate = Math.round(t.successRate * 100);
            const color = rate >= 90 ? chalk.green : rate >= 60 ? chalk.yellow : chalk.red;
            ctx.writeLine(`    ${chalk.white(t.name)} ${color(`${rate}%`)} ${chalk.dim(`(${t.calls} 次, 失败 ${t.failed})`)}`);
          }
          if (obs.repeatedTasks.length > 0) {
            ctx.writeLine(`  ${chalk.dim("重复任务")}:`);
            for (const r of obs.repeatedTasks) {
              ctx.writeLine(`    ${chalk.white(r.pattern)} ${chalk.dim(`×${r.count}`)}`);
            }
          }
          ctx.writeLine(`  ${chalk.dim("用户干预")}: ${obs.userInterventions} 次`);
          ctx.writeLine(
            `  ${chalk.dim("生成")}: 应用 ${obs.generated.apps} · 文档 ${obs.generated.docs} · 更新 ${obs.generated.updates}`,
          );
          break;
        }
        case "propose": {
          ctx.writeLine(chalk.cyan("\n🔬 生成进化提案（meta-agent 分析中…）"));
          const result = await evo.propose();
          if (result.limited) {
            ctx.writeLine(chalk.yellow("⚠ 今日提案已达上限（3 条），明天再来"));
          } else if (result.ok) {
            ctx.writeLine(
              result.proposals.length > 0
                ? chalk.green(`✓ 生成 ${result.proposals.length} 条提案（/evo list 查看，/evo adopt <id> 确认）`)
                : chalk.gray("暂无值得提议的改进点"),
            );
          } else {
            ctx.writeLine(chalk.red(`✗ 提议失败: ${result.error}`));
          }
          break;
        }
        case "list": {
          const list = evo.list();
          if (list.length === 0) {
            ctx.writeLine(chalk.gray("暂无提案（/evo propose 生成）"));
          } else {
            ctx.writeLine("");
            for (const p of list) {
              ctx.writeLine(renderProposal(p));
              if (p.status === "confirmed") {
                ctx.writeLine(chalk.dim("     （已确认，/evo apply <id> 确认写入）"));
              } else if (p.status === "applied") {
                ctx.writeLine(chalk.dim("     （/evo rollback <id> 可回滚快照还原）"));
              }
            }
            ctx.writeLine("");
          }
          break;
        }
        case "adopt": {
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /evo adopt <id>"));
            break;
          }
          const result = evo.adopt(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已确认提案: ${id}（尚未写入）`));
            ctx.writeLine(chalk.cyan("  📋 将写入的内容:"));
            ctx.writeLine(renderPreview(result.preview!));
            ctx.writeLine(chalk.gray("  /evo apply <id> 确认写入，/evo reject <id> 撤销"));
          } else {
            ctx.writeLine(chalk.red(`✗ 确认失败: ${result.error}`));
          }
          break;
        }
        case "apply": {
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /evo apply <id>"));
            break;
          }
          ctx.writeLine(chalk.cyan(`\n✍️  确认写入: ${id}…`));
          const result = await evo.apply(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已写入: ${id}${result.jobId ? `（生成任务 ${result.jobId}）` : ""}${result.detail ? ` · ${result.detail}` : ""}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 写入失败: ${result.error}`));
          }
          break;
        }
        case "rollback": {
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /evo rollback <id>"));
            break;
          }
          ctx.writeLine(chalk.cyan(`\n↩️  回滚: ${id}（快照还原）…`));
          const result = evo.rollback(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已回滚: ${id}${result.detail ? ` · ${result.detail}` : ""}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 回滚失败: ${result.error}`));
          }
          break;
        }
        case "diff": {
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /evo diff <id>"));
            break;
          }
          const result = evo.change(id);
          if (!result.ok || !result.view) {
            ctx.writeLine(chalk.red(`✗ 获取变更失败: ${result.error}`));
            break;
          }
          const v = result.view;
          ctx.writeLine(chalk.cyan(`\n📋 变更对比: ${v.title}（${id}）`));
          if (v.before === undefined) {
            ctx.writeLine(chalk.green("  （纯新增内容）"));
          } else {
            ctx.writeLine(chalk.dim("  ── 修改前 ──"));
            ctx.writeLine(chalk.dim(v.before.split("\n").map((l) => `  ${l}`).join("\n")));
            ctx.writeLine(chalk.dim("  ── 修改后 ──"));
            ctx.writeLine(chalk.green(v.after.split("\n").map((l) => `  ${l}`).join("\n")));
          }
          ctx.writeLine(chalk.dim("  行级差异:"));
          for (const line of v.lines) {
            if (line.type === "add") ctx.writeLine(chalk.green(`  + ${line.text}`));
            else if (line.type === "del") ctx.writeLine(chalk.red(`  - ${line.text}`));
          }
          break;
        }
        case "reject": {
          if (!id) {
            ctx.writeLine(chalk.gray("用法: /evo reject <id>"));
            break;
          }
          const result = evo.reject(id);
          if (result.ok) {
            ctx.writeLine(chalk.green(`✓ 已拒绝: ${id}`));
          } else {
            ctx.writeLine(chalk.red(`✗ 拒绝失败: ${result.error}`));
          }
          break;
        }
        default:
          ctx.writeLine(chalk.gray("用法: /evo observe|propose|list|adopt <id>|apply <id>|rollback <id>|diff <id>|reject <id>"));
          break;
      }
      ctx.printStatus();
      return "continue";
    },
  },
];
