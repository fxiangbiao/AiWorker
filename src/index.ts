#!/usr/bin/env node
/**
 * AiWorker CLI 入口 — 流式交互版本
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { spawn } from "node:child_process";

import { ModelRouter } from "./core/model-router.js";
import { ContextManager } from "./core/context-manager.js";
import { ProjectProfiler } from "./core/project-profiler.js";
import { SessionStore } from "./memory/session-store.js";
import { ContextCompressor } from "./memory/compressor.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { initAuditLog } from "./core/audit-logger.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { loadHooksFromConfig } from "./hooks/hook-config-loader.js";
import { hookManager } from "./hooks/hook-manager.js";
import { createEvaluateSkillCreation } from "./hooks/handlers.js";
import { DefaultAgent } from "./agents/default-agent.js";
import { ResearchAgent } from "./agents/research-agent.js";
import { CodingAgent } from "./agents/coding-agent.js";
import { DataAnalysisAgent } from "./agents/data-analysis-agent.js";
import { ProductOpsAgent } from "./agents/product-ops-agent.js";
import { FinancialAgent } from "./agents/financial-agent.js";
import { GameDevAgent } from "./agents/game-dev-agent.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import { TeamCoordinator, pickDebateAgents } from "./core/team-coordinator.js";
import { mcpManager } from "./mcp/mcp-manager.js";
import { renderer } from "./terminal/renderer.js";
import { tui } from "./terminal/tui.js";
import { renderMarkdown } from "./terminal/markdown.js";
import { StreamOutputRenderer } from "./terminal/output.js";
import { startServer } from "./server.js";
import type { PermissionMode, StreamCallbacks, ModelProvider } from "./types.js";

const program = new Command();

program.name("aiworker").description("AiWorker — 个人 AI Agent 助手").version("0.1.0");

program
  .option("-m, --mode <mode>", "权限模式: ask | plan | craft", "craft")
  .option("-d, --dir <directory>", "工作目录", process.cwd())
  .option("--data-dir <directory>", "数据目录", resolve(process.cwd(), "data"))
  .option("-p, --project-dir <directory>", "项目输出目录", resolve(process.cwd(), "ai_default_project"))
  .option("--show-thinking", "显示模型思考过程（默认折叠）")
  .option("--server", "启动 HTTP API 服务")
  .option("--port <port>", "HTTP Server 端口", "3000")
  .action(async (options) => {
    const workingDir = resolve(options.dir);
    const dataDir = resolve(options.dataDir);
    const projectDir = resolve(options.projectDir);

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    // 非 server 模式初始化 TUI（交互模式）；server 模式走普通 stdout
    const isServer = !!options.server;
    if (!isServer) {
      renderer.init();
    }

    const outputRenderer = new StreamOutputRenderer();

    // TUI 输入配置：历史持久化 + Tab 补全
    const commands = ["/plan", "/debate", "/mode", "/new", "/log", "/context", "/skill", "/skills", "/skill-evo", "/status", "/config", "/thinking", "/copy", "/help", "/exit", "/sessions", "/switch"];
    const completer = (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      // 技能可直接用 /技能名 激活（无需 /skill 前缀）
      const skillNames = skillRegistry.getAll().map((s) => `/${s.name}`);
      const all = [...commands, ...skillNames];
      const hits = all.filter((c) => c.toLowerCase().startsWith(line.toLowerCase()));
      return [hits.length ? hits.slice(0, 10) : [], line];
    };
    renderer.configureInput(resolve(dataDir, ".aiworker_history"), completer);

    // ─── Banner ───
    stdout.write(chalk.cyan("╔══════════════════════════════════════╗\n"));
    stdout.write(chalk.cyan("║        AiWorker v0.1.0               ║\n"));
    stdout.write(chalk.cyan("╚══════════════════════════════════════╝\n\n"));
    stdout.write(chalk.gray(`工作目录: ${workingDir}\n`));
    stdout.write(chalk.gray(`输出目录: ${projectDir}\n`));
    stdout.write(chalk.gray(`数据目录: ${dataDir}\n`));
    stdout.write(chalk.gray(`权限模式: ${options.mode}\n\n`));

    if (!process.env.DEEPSEEK_API_KEY) {
      stdout.write(chalk.yellow("⚠️  未检测到 DEEPSEEK_API_KEY 环境变量\n"));
      stdout.write(chalk.gray("   请设置后重启。\n\n"));
    }

    // ─── 初始化核心组件 ───
    registerBuiltinTools();

    const skillsDir = resolve(process.cwd(), "skills");
    const skillCount = skillRegistry.loadFromDir(skillsDir);
    if (skillCount > 0) {
      stdout.write(chalk.green(`✓ 已加载 ${skillCount} 个技能\n`));
    }

    const modelRouter = new ModelRouter();
    // 恢复运行时覆盖（/config 持久化）
    const runtimeConfigPath = resolve(dataDir, "runtime-config.json");
    if (existsSync(runtimeConfigPath)) {
      try {
        modelRouter.applyOverrides(JSON.parse(readFileSync(runtimeConfigPath, "utf-8")) as Record<string, unknown>);
      } catch {
        /* 损坏则忽略 */
      }
    }
    const sessionStore = new SessionStore(resolve(dataDir, "aiworker.db"));
    const modelProvider: ModelProvider = (opts) => modelRouter.complete(opts);
    const compressor = new ContextCompressor(modelProvider);
    const contextManager = new ContextManager(sessionStore, dataDir, compressor);

    // 扫描工作目录，注入项目画像
    {
      const profiler = new ProjectProfiler(workingDir);
      const profile = profiler.scan();
      if (profile) {
        contextManager.setProjectProfile(profile);
        stdout.write(
          chalk.gray(`─ 项目: ${profile.type}, ${profile.pkgManager}, ${profile.topDirs.length} 个顶层目录\n`),
        );
      }
    }

    initAuditLog(dataDir);

    const dangerDetector = new DangerDetector();
    const permissionModel = new PermissionModel({
      defaultMode: options.mode as PermissionMode,
      modes: {
        ask: { description: "只读模式", allow_tool_calls: false, require_confirmation: true },
        plan: { description: "计划模式（列出后确认执行）", allow_tool_calls: true, require_confirmation: true },
        craft: { description: "自动执行（高风险仍需确认）", allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [workingDir],
      deniedPatterns: [],
    });

    const hooksDir = resolve(process.cwd(), "config");
    const hooksCount = loadHooksFromConfig(resolve(hooksDir, "hooks.json"), {
      dangerDetector,
      permissionModel,
      sessionStore,
      modelRouter,
      onFileDiff: (filePath, added, removed, diffText) => {
        outputRenderer.fileDiff(filePath, added, removed);
        if (diffText && diffText.trim()) {
          for (const line of diffText.split("\n")) {
            if (line.startsWith("+ ")) {
              stdout.write(`    ${chalk.green(line)}\n`);
            } else if (line.startsWith("- ")) {
              stdout.write(`    ${chalk.red(line)}\n`);
            } else {
              stdout.write(`    ${chalk.gray(line)}\n`);
            }
          }
        }
      },
    });
    if (hooksCount > 0) {
      stdout.write(chalk.green(`✓ 已加载 ${hooksCount} 个 Hook\n`));
    }

    const deps = { modelRouter, contextManager, sessionStore };
    const agents: Record<
      string,
      DefaultAgent | ResearchAgent | CodingAgent | DataAnalysisAgent | ProductOpsAgent | FinancialAgent | GameDevAgent
    > = {
      default: new DefaultAgent(deps),
      research: new ResearchAgent(deps),
      coding: new CodingAgent(deps),
      "data-analysis": new DataAnalysisAgent(deps),
      "product-ops": new ProductOpsAgent(deps),
      financial: new FinancialAgent(deps),
      "game-dev": new GameDevAgent(deps),
    };

    const coordinator = new TeamCoordinator(agents, modelRouter);

    if (options.server) {
      const port = parseInt(options.port, 10);
      startServer(
        {
          modelRouter,
          workingDir,
          projectDir,
          coordinator,
          createAgent: (agentId: string) => agents[agentId] ?? agents["default"],
          getAgentList: () =>
            Object.entries(agents).map(([id, a]) => ({ id, name: a.getName() })),
          skillNames: skillRegistry.getAll().map((s) => s.name),
          getSkills: () =>
            skillRegistry.getAll().map((s) => ({
              name: s.name,
              description: s.description ?? "",
              expert: s.expert ?? "general",
            })),
          sessionStore,
          getContextBreakdown: (systemPrompt: string, sessionId: string, userMessage: string, agentId?: string) =>
            contextManager.getContextBreakdown(systemPrompt, sessionId, userMessage, agentId),
          getSystemPrompt: () => (agents["default"] as { getSystemPrompt?: () => string }).getSystemPrompt?.() ?? "",
        },
        port,
      );
      return;
    }

    let currentMode = options.mode as PermissionMode;
    let showThinking = !!options.showThinking;
    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    // ─── MCP 服务器 ───
    const mcpConfigPath = resolve(process.cwd(), "config", "mcp.json");
    mcpManager.loadConfig(mcpConfigPath).catch(() => {});

    // 等待初始化完成（stdio 服务器需要时间启动）
    await new Promise((r) => setTimeout(r, 500));

    const mcpStatuses = mcpManager.getStatuses();
    const mcpServers = Object.values(mcpStatuses);

    stdout.write(chalk.green("✓ 核心引擎就绪\n"));
    stdout.write(chalk.green(`✓ 模型: ${modelRouter.getCurrentModel()}\n`));
    stdout.write(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch\n"));
    stdout.write(
      chalk.green("✓ 专家智能体: 通用助手, 研究分析师, 编码工程师, 数据分析师, 产品运营, 理财顾问, 游戏设计师\n"),
    );
    stdout.write(chalk.green("✓ Team 协调器已就绪: 支持多专家协作\n"));

    if (mcpServers.length > 0) {
      for (const s of mcpServers) {
        const icon = s.connected ? chalk.green("✓") : chalk.yellow("⚠");
        stdout.write(icon + chalk.green(` MCP: ${s.name} (${s.toolCount} 工具${s.connected ? "" : ", 连接失败"})\n`));
      }
    }
    stdout.write(chalk.gray("输入消息开始对话, /help 查看帮助, /plan <描述> 使用多专家协作\n\n"));

    // 初始状态栏
    if (!isServer) {
      renderer.printStatus({
        mode: currentMode,
        model: modelRouter.getCurrentModel(),
        tokensUsed: 0,
        queueSize: 0,
      });
    }

    // ─── 交互循环 ───
    const prefillQueue: string[] = [];
    let lastAnswerRaw = "";
    let currentSessionId: string | undefined;

    // 计算当前上下文窗口占用百分比（低频调用：仅 printStatus / 命令后）
    const statusWindowPct = (): number | undefined => {
      try {
        const agent = agents[routeToExpert("")];
        const bd = contextManager.getContextBreakdown(
          agent.getConfig().systemPrompt,
          currentSessionId ?? "",
          "",
        );
        return bd.windowSize > 0 ? Math.round((bd.total / bd.windowSize) * 100) : undefined;
      } catch {
        return undefined;
      }
    };

    while (true) {
      let input: string;
      if (prefillQueue.length > 0) {
        const prefill = prefillQueue.shift()!;
        stdout.write(chalk.yellow(`\n📋 排队消息 → ${prefill.slice(0, 60)}\n`));
        input = prefill;
        // 直接消费排队消息，不阻塞等待输入
      } else {
        input = await renderer.prompt();
        if (input && input.trim()) {
          renderer.recordHistory(input.trim());
        }
      }

      let trimmed = input ? input.trim() : "";
      if (!trimmed) {
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        // Defensive: prevent busy-loop if stdin is broken on Windows
        await new Promise<void>((r) => setTimeout(r, 50));
        continue;
      }

      // ─── 命令处理 ───
      if (trimmed === "/exit" || trimmed === "/quit") {
        stdout.write(chalk.gray("\n再见！\n"));
        break;
      }

      if (trimmed === "/new") {
        currentSessionId = undefined;
        modelRouter.resetTokenUsage();
        stdout.write(chalk.green("✓ 新会话已开始，上下文已清空\n"));
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: 0,
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/log") {
        const sessionId = currentSessionId;
        const turns = sessionId
          ? sessionStore.getTurnLogs(sessionId)
          : sessionStore.getRecentTurnLogs(20);
        if (turns.length === 0) {
          stdout.write(chalk.gray("暂无监控日志\n"));
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
          stdout.write(`\n${border}\n`);
          stdout.write(
            `│ ${headers.map((h, i) => padToWidth(h, widths[i]!)).join(" │ ")} │\n`,
          );
          stdout.write(`${sep}\n`);
          for (const r of rows) {
            stdout.write(`│ ${r.map((c, i) => padToWidth(c, widths[i]!)).join(" │ ")} │\n`);
          }
          stdout.write(`${bottom}\n`);
          stdout.write(
            chalk.gray(
              `累计: ${turns.length} 轮, ${(totalDur / 1000).toFixed(1)}s, ${totalTools} 次工具调用, ` +
                `输入 ${fmtK(totalPrompt)} tok, 输出 ${fmtK(totalCompletion)} tok`,
            ),
          );
          if (!sessionId) {
            stdout.write(chalk.gray(`（最近会话，/sessions 或 /switch 切换）\n`));
          } else {
            stdout.write("\n");
          }
        }
        continue;
      }

      if (trimmed === "/sessions") {
        const sessions = sessionStore.listSessions(20);
        if (sessions.length === 0) {
          stdout.write(chalk.gray("暂无历史会话\n"));
        } else {
          stdout.write("\n┌──────┬────────────┬────────────┬──────────────┬──────────────────────┐\n");
          stdout.write(
            `│ ${padToWidth("序号", 4)} │ ${padToWidth("时间", 10)} │ ${padToWidth("消息数", 10)} │ ${padToWidth("Agent", 12)} │ ${padToWidth("摘要", 20)} │\n`,
          );
          stdout.write("├──────┼────────────┼────────────┼──────────────┼──────────────────────┤\n");
          sessions.forEach((s, i) => {
            const time = new Date(s.updatedAt).toLocaleDateString();
            const agentLabel = s.agentId.length > 12 ? s.agentId.slice(0, 12) : s.agentId;
            let summary = s.firstUserMsg ?? s.summary ?? "(无)";
            // CJK 安全截断（displayWidth 计 2 列/字，列宽 20）
            while (displayWidth(summary) > 20) summary = summary.slice(0, -1);
            stdout.write(
              `│ ${String(i + 1).padEnd(4)} │ ${time.padEnd(10)} │ ${String(s.messageCount).padEnd(10)} │ ${padToWidth(agentLabel, 12)} │ ${padToWidth(summary, 20)} │\n`,
            );
          });
          stdout.write(`└──────┴────────────┴────────────┴──────────────┴──────────────────────┘\n`);
          stdout.write(chalk.gray(`共 ${sessions.length} 个会话，/switch <序号> 切换\n`));
        }
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed.startsWith("/switch ")) {
        const arg = trimmed.slice(8).trim();
        const sessions = sessionStore.listSessions(20);
        const idx = parseInt(arg, 10);
        let target: { id: string } | undefined;
        if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) {
          target = sessions[idx - 1];
        } else {
          target = sessions.find((s) => s.id.startsWith(arg));
        }
        if (target) {
          currentSessionId = target.id;
          stdout.write(chalk.green(`✓ 已切换到会话 (${arg})\n`));
        } else {
          stdout.write(chalk.red("未找到该会话，/sessions 查看列表\n"));
        }
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/copy") {
        if (!lastAnswerRaw) {
          stdout.write(chalk.gray("暂无回答可复制（先发送一条消息）\n"));
        } else {
          await copyToClipboard(lastAnswerRaw);
          stdout.write(chalk.green(`✓ 已复制原始 Markdown 到剪贴板 (${lastAnswerRaw.length} 字符)\n`));
        }
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/context" || trimmed.startsWith("/context ")) {
        const agent = agents[routeToExpert("")];
        const bd = contextManager.getContextBreakdown(
          agent.getConfig().systemPrompt,
          currentSessionId ?? "",
          trimmed === "/context" ? "" : trimmed.slice(9),
        );
        const ws = bd.windowSize;
        const bar = (v: number) => {
          const pct = ws > 0 ? (v / ws) * 100 : 0;
          const w = Math.round(pct / 5);
          const color = pct > 80 ? chalk.red : pct > 60 ? chalk.yellow : chalk.green;
          return `${color("█".repeat(w))}${chalk.gray("░".repeat(Math.max(0, 20 - w)))}`;
        };
        const fmtN = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

        stdout.write(`\n${chalk.bold("── 上下文占用 ──")}\n`);
        const fmt = (label: string, tok: number, extra?: string) => {
          const pct = ws > 0 ? `(${((tok / ws) * 100).toFixed(0)}%)` : "";
          const ext = extra ? ` ${chalk.dim(extra)}` : "";
          stdout.write(
            `│ ${chalk.dim(padToWidth(label, 10))} ${bar(tok)} ${chalk.white(fmtN(tok))}/${chalk.white(fmtN(ws))} ${pct}${ext}\n`,
          );
        };

        fmt("系统提示词", bd.systemPromptBase);
        fmt("项目记忆", bd.projectMemory);
        fmt("用户画像", bd.userProfile);
        fmt("情景记忆", bd.episodicMemory);
        const skillExtra = bd.skillsMatched.length > 0 ? `(${bd.skillsMatched.length}/${bd.skillsTotal})` : "";
        fmt("注入技能", bd.injectedSkills, skillExtra);
        fmt("会话历史", bd.conversationHistory);
        fmt("当前消息", bd.currentTurn);
        // 合计行需手动对齐：标签 "合计" = 2 CJK = 4 display cols, pad to 10 + 2 extra spaces = 12
        const totalLabel = padToWidth("合计", 12);
        stdout.write(
          `│ ${totalLabel}${" ".repeat(20)} ${chalk.bold(fmtN(bd.total))}/${chalk.bold(fmtN(ws))} (${((bd.total / ws) * 100).toFixed(0)}%)\n`,
        );

        const mcpStatuses = mcpManager.getStatuses();
        const mcpServers = Object.values(mcpStatuses);
        if (mcpServers.length > 0) {
          stdout.write(`\n${chalk.dim("── MCP 工具 ──")}\n`);
          for (const s of mcpServers) {
            const icon = s.connected ? chalk.green("✓") : chalk.red("✗");
            stdout.write(`│ ${icon} ${s.name}: ${s.toolCount} 工具\n`);
          }
        }

        stdout.write("\n");
        continue;
      }

      if (trimmed.startsWith("/mode ")) {
        const newMode = trimmed.slice(6).trim() as PermissionMode;
        if (["ask", "plan", "craft"].includes(newMode)) {
          currentMode = newMode;
          for (const a of Object.values(agents)) a.setMode(newMode);
          stdout.write(chalk.green(`✓ 已切换到 ${newMode} 模式\n`));
        } else {
          stdout.write(chalk.red("无效模式，可选: ask, plan, craft\n"));
        }
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/help") {
        // 用 Markdown 表格渲染（块级对齐 + 窄终端自动换行）
        const rows: [string, string, string][] = [
          ["/plan <描述>", "多专家 DAG 协作", "自动分解任务，拓扑序执行"],
          ["/debate <话题>", "双专家辩论", "两专家独立分析+互审+综合报告"],
          ["/mode <模式>", "切换权限模式", "ask(只读) / plan(确认后执行) / craft(自动执行)"],
          ["/new", "开启新会话", "清空上下文和 token 计数，重新开始"],
          ["/log", "查看监控日志", "当前 session 的轮次摘要表"],
          ["/context", "上下文占用分析", "分层 token 占比 + MCP 工具列表"],
          ["/skill-evo", "技能沉淀开关", "开启/关闭 LLM 自动提取技能"],
          ["/skill <名称>", "手动激活技能", "如 /code-review, /debug, /data-cleaning"],
          ["/status", "显示运行状态", "模式/模型/token/排队"],
          ["/config", "查看/配置模型与系统参数", "model/temperature/max-tokens/reset"],
          ["/sessions", "浏览历史会话", "列出最近会话，/switch <序号> 切换"],
          ["/switch <序号>", "切换会话", "恢复指定会话上下文继续对话"],
          ["/copy", "复制回答", "复制上次回答的原始 Markdown 到剪贴板"],
          ["/help", "帮助信息", "显示此表"],
          ["/exit", "退出", ""],
        ];
        const mdRows = [
          "| 命令 | 功能 | 说明 |",
          "|---|---|---|",
          ...rows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
        ];
        const rendered = renderMarkdown(mdRows.join("\n"));
        renderer.writeLine("");
        for (const line of rendered) renderer.writeLine(line);
        renderer.writeLine("");
        renderer.writeLine(chalk.dim(`💡 已加载 ${skillCount} 个技能，可直接输入 /技能名 激活（如 /code-review）`));
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/skills") {
        const all = skillRegistry.getAll();
        if (all.length === 0) {
          stdout.write(chalk.gray("暂无技能\n"));
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
          renderer.writeLine("");
          for (const [expert, skills] of byExpert) {
            renderer.writeLine(`  ${chalk.cyan(expert)}`);
            for (const s of skills) {
              const namePad = padToWidth(chalk.white(s.name), nameWidth);
              const desc = s.description ? chalk.dim(s.description) : "";
              renderer.writeLine(`    ${namePad}${desc}`);
            }
          }
          renderer.writeLine("");
          renderer.writeLine(
            chalk.dim(`💡 共 ${all.length} 个技能，直接输入 /技能名 激活（如 /code-review），/help 查看命令`),
          );
        }
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/status") {
        const cost = modelRouter.getCost();
        stdout.write(chalk.gray(`模式: ${currentMode} | 模型: ${modelRouter.getCurrentModel()}\n`));
        stdout.write(
          chalk.gray(
            `Token: ${modelRouter.getTokenUsage()} (提示: ${modelRouter.getPromptTokens()}, 生成: ${modelRouter.getCompletionTokens()})`,
          ),
        );
        if (cost > 0) stdout.write(chalk.gray(` | 成本: ¥${cost.toFixed(4)}`));
        stdout.write(chalk.gray(`\n技能: ${skillCount} | 排队: ${prefillQueue.length}\n`));
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/thinking") {
        showThinking = !showThinking;
        stdout.write(chalk.green(`✓ 思考展示: ${showThinking ? "展开" : "折叠"}\n`));
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/config" || trimmed.startsWith("/config ")) {
        const parts = trimmed.split(/\s+/).slice(1);
        const sub = parts[0] ?? "";
        const arg = parts[1] ?? "";
        const persist = () => {
          try {
            writeFileSync(runtimeConfigPath, JSON.stringify(modelRouter.getOverrides(), null, 2));
          } catch {
            /* 持久化失败静默 */
          }
        };

        if (sub === "model") {
          if (!arg) {
            stdout.write(chalk.gray(`用法: /config model <名称>  可选: ${modelRouter.getAvailableModels().map((m) => m.key).join(", ")}\n`));
          } else {
            const valid = modelRouter.getAvailableModels().find((m) => m.key === arg.toLowerCase());
            if (!valid) {
              stdout.write(chalk.red(`✗ 未知模型: ${arg}，可用: ${modelRouter.getAvailableModels().map((m) => m.key).join(", ")}\n`));
            } else {
              modelRouter.setDefaultModel(valid.key);
              persist();
              stdout.write(chalk.green(`✓ 默认模型 → ${valid.model} (${valid.provider})`));
              if (valid.key !== "default") stdout.write(chalk.dim(` via ${valid.key} profile`));
              stdout.write("\n");
              stdout.write(chalk.gray(`  该设置持久化到 ${runtimeConfigPath}，重启后仍生效。\n`));
            }
          }
        } else if (sub === "temperature" || sub === "temp") {
          if (!arg) {
            stdout.write(chalk.gray(`用法: /config temperature <0-2>  当前: ${modelRouter.getRuntimeConfig().temperature ?? "默认"}\n`));
          } else {
            const t = parseFloat(arg);
            if (isNaN(t) || t < 0 || t > 2) {
              stdout.write(chalk.red("✗ 温度需在 0-2 之间\n"));
            } else {
              modelRouter.setTemperature(t);
              persist();
              stdout.write(chalk.green(`✓ 温度 → ${t}\n`));
            }
          }
        } else if (sub === "max-tokens" || sub === "tokens") {
          if (!arg) {
            stdout.write(chalk.gray(`用法: /config max-tokens <数量>  当前: ${modelRouter.getRuntimeConfig().maxTokens ?? "默认"}\n`));
          } else {
            const n = parseInt(arg, 10);
            if (isNaN(n) || n < 100) {
              stdout.write(chalk.red("✗ max-tokens 需 ≥ 100\n"));
            } else {
              modelRouter.setMaxTokens(n);
              persist();
              stdout.write(chalk.green(`✓ max-tokens → ${n}\n`));
            }
          }
        } else if (sub === "reset") {
          modelRouter.setDefaultModel("");
          modelRouter.setTemperature(null);
          modelRouter.setMaxTokens(null);
          persist();
          stdout.write(chalk.green("✓ 已恢复配置文件默认（models.json）\n"));
        } else {
          // 默认：显示当前配置
          const rt = modelRouter.getRuntimeConfig();
          const cost = modelRouter.getCost();
          stdout.write(chalk.bold("\n── 模型配置 ──\n"));
          stdout.write(chalk.gray(`当前模型: ${modelRouter.getCurrentModel()}`));
          if (rt.profileKey) stdout.write(chalk.yellow(` (profile: ${rt.profileKey})`));
          stdout.write("\n");
          stdout.write(chalk.gray(`温度: ${rt.temperature ?? "默认"} | max-tokens: ${rt.maxTokens ?? "默认"}\n`));
          stdout.write(chalk.gray(`成本: ¥${cost.toFixed(4)}\n`));
          stdout.write(chalk.bold("\n── 可用模型 ──\n"));
          for (const m of modelRouter.getAvailableModels()) {
            const active = m.key === (rt.profileKey || "default") ? chalk.green(" ●") : "";
            stdout.write(chalk.gray(`  ${padToWidth(m.key, 10)} ${m.model} (${m.provider})${active}\n`));
          }
          stdout.write(chalk.bold("\n── 系统参数 ──\n"));
          stdout.write(chalk.gray(`  权限模式: ${currentMode} (用 /mode 切换)\n`));
          stdout.write(chalk.gray(`  思考展示: ${showThinking ? "展开" : "折叠"} (用 /thinking 切换)\n`));
          stdout.write(chalk.gray(`  技能沉淀: ${hookManager.has("onTaskComplete:evaluateSkillCreation") ? "开启" : "关闭"} (用 /skill-evo 切换)\n\n`));
          stdout.write(
            chalk.dim(
              `  可配置: /config model <名> | /config temperature <0-2> | /config max-tokens <n> | /config reset\n`,
            ),
          );
        }
        continue;
      }

      if (trimmed === "/skill-evo") {
        const id = "onTaskComplete:evaluateSkillCreation";
        if (hookManager.has(id)) {
          hookManager.off(id);
          stdout.write(chalk.yellow("✓ 技能自动沉淀: 关闭\n"));
        } else {
          // Re-register — factory needs the same deps as initial setup
          const handler = createEvaluateSkillCreation({ sessionStore, modelRouter });
          hookManager.on("onTaskComplete", handler, { id, priority: 10 });
          stdout.write(chalk.green("✓ 技能自动沉淀: 开启\n"));
        }
        continue;
      }

      // ─── 多专家辩论（/debate 命令） ───
      if (trimmed.startsWith("/debate ")) {
        const topic = trimmed.slice(8).trim();
        if (!topic) {
          stdout.write(chalk.red("请输入辩论话题，例如: /debate React vs Vue 技术选型\n"));
          renderer.printStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            windowPct: statusWindowPct(),
            queueSize: prefillQueue.length,
          });
          continue;
        }

        const { agentA, agentB } = pickDebateAgents(topic, coordinator.getAvailableAgents());
        stdout.write(chalk.cyan(`\n⚔  辩论模式: ${agentA} vs ${agentB}\n`));
        stdout.write(chalk.gray(`话题: ${topic}\n\n`));

        const debateCallbacks: StreamCallbacks = {
          onToolCall: (expertId, desc) => {
            stdout.write(`${chalk.blue(`🔧 ${expertId}`)}: ${desc}\n`);
          },
          onToolResult: (_name, success, summary) => {
            const icon = success ? chalk.green("✓") : chalk.red("✗");
            stdout.write(`  ${icon} ${summary.slice(0, 80)}\n`);
          },
        };

        try {
          const result = await coordinator.debate(topic, agentA, agentB, workingDir, projectDir, debateCallbacks);
          stdout.write(chalk.cyan("\n📋 辩论报告:\n"));
          stdout.write(result.text);
          stdout.write(`\n`);
        } catch (err) {
          stdout.write(chalk.red(`\n✗ 辩论失败: ${(err as Error).message}\n`));
        }

        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      // ─── 多专家协作（/plan 命令，必须在 /skill 之前） ───
      if (trimmed.startsWith("/plan ")) {
        const planDesc = trimmed.slice(6).trim();
        if (!planDesc) {
          stdout.write(chalk.red("请输入任务描述，例如: /plan 开发一款放置类手游\n"));
          renderer.printStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            windowPct: statusWindowPct(),
            queueSize: prefillQueue.length,
          });
          continue;
        }

        stdout.write(chalk.cyan(`\n🔗 Team 协调器正在规划...\n`));
        stdout.write(chalk.gray("分析任务 → 生成执行计划\n"));

        let planResult;
        try {
          planResult = await coordinator.plan(planDesc);
        } catch (err) {
          stdout.write(chalk.red(`\n✗ 规划失败: ${(err as Error).message}\n`));
          renderer.printStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            windowPct: statusWindowPct(),
            queueSize: prefillQueue.length,
          });
          continue;
        }

        const plan = planResult.plan;
        stdout.write(chalk.green(`✓ 计划已生成 (${plan.steps.length} 步, ${planResult.source})\n\n`));

        // 打印步骤列表作为进度模板
        const stepStatus: Record<string, string> = {};
        for (const step of plan.steps) {
          const deps = step.dependsOn.length > 0 ? chalk.gray(` ← ${step.dependsOn.join(", ")}`) : "";
          stdout.write(
            `  ${chalk.cyan("⚪")} ${chalk.cyan(step.id)}: ${chalk.yellow(step.expertId)} — ${step.description}${deps}\n`,
          );
          stepStatus[step.id] = "⚪";
        }

        stdout.write("\n");

        const callbacks: StreamCallbacks = {
          onStepStart: (stepId, expertId) => {
            const step = plan.steps.find((s) => s.id === stepId);
            if (step) {
              stepStatus[stepId] = "🔵";
              stdout.write(
                `  ${chalk.cyan("🔵")} ${chalk.cyan(stepId)}: ${chalk.yellow(expertId)} — ${step.description} ${chalk.dim("(进行中...)")}\n`,
              );
            }
          },
          onStepEnd: (stepId, success) => {
            const step = plan.steps.find((s) => s.id === stepId);
            if (step) {
              const icon = success ? chalk.green("✅") : chalk.red("❌");
              const status = success ? "" : chalk.gray(" (已跳过)");
              stepStatus[stepId] = success ? "✅" : "❌";
              stdout.write(
                `  ${icon} ${chalk.cyan(stepId)}: ${chalk.yellow(step.expertId)} — ${step.description}${status}\n`,
              );
            }
          },
          onToolCall: (expertId, desc) => {
            stdout.write(`    ${chalk.blue(`🔧 ${expertId}`)}: ${desc}\n`);
          },
          onToolResult: (_name, success, summary) => {
            const icon = success ? chalk.green("  ✓") : chalk.red("  ✗");
            stdout.write(`    ${icon} ${summary.slice(0, 80)}\n`);
          },
        };

        try {
          const result = await coordinator.execute(plan, workingDir, projectDir, callbacks);
          stdout.write(chalk.cyan("\n📋 汇总报告:\n"));
          stdout.write(result.text);
          stdout.write(`\n`);
        } catch (err) {
          stdout.write(chalk.red(`\n✗ 执行失败: ${(err as Error).message}\n`));
        }

        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed.startsWith("/")) {
        const skillName = trimmed.slice(1).trim();
        const skill = skillRegistry.getAll().find((s) => s.name.toLowerCase() === skillName.toLowerCase());
        if (skill) {
          stdout.write(chalk.cyan(`\n📋 调用技能: ${skill.name}\n`));
          trimmed = `请使用 ${skill.name} 技能完成任务：\n\n${skill.body}\n\n用户任务：\n`;
        } else {
          stdout.write(chalk.yellow(`\n未找到技能 "${skillName}"\n`));
          const allSkills = skillRegistry.getAll().map((s) => chalk.cyan(s.name));
          stdout.write(chalk.gray(`可用技能: ${allSkills.join(", ")}\n\n`));
          renderer.printStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            windowPct: statusWindowPct(),
            queueSize: prefillQueue.length,
          });
          continue;
        }
      }

      // ─── 路由 & 执行 ───
      const expertId = routeToExpert(trimmed);
      const agent = agents[expertId];

      // 进入 Agent 会话：禁用输入行，状态栏显示"思考中"
      tui.startAgentSession();

      // 思考阶段：状态栏实时刷新
      let thinkingTimer: ReturnType<typeof setInterval> | null = null;
      let liveStatusActive = false;
      const startLiveStatus = () => {
        liveStatusActive = true;
        thinkingTimer = setInterval(() => {
          renderer.updateLiveStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            queueSize: prefillQueue.length,
            iteration: undefined,
            maxIter: agents[expertId]?.getConfig().maxIterations,
            status: "思考中",
          });
        }, 500);
      };
      const stopLiveStatus = () => {
        if (!liveStatusActive) return;
        liveStatusActive = false;
        if (thinkingTimer) {
          clearInterval(thinkingTimer);
          thinkingTimer = null;
        }
      };

      startLiveStatus();

      const abortController = new AbortController();
      tui.setOnInterrupt(() => {
        // Ctrl+C 中断当前 Agent
        if (!abortController.signal.aborted) {
          abortController.abort();
          stopLiveStatus();
          renderer.writeLine(chalk.yellow("⏹ 已中断 Agent（Ctrl+C 再按一次退出）"));
        }
      });

      // 思考内容跟踪
      let thinkingStarted = false;
      let thinkingFirstLine = "";
      let thinkingLineCaptured = false;
      let needThinkingBreak = false;

      try {
        const streamCallbacks: StreamCallbacks = {
          onIterationStart: () => {
            // 迭代分隔线不再展示（用户要求精简）
          },
          onThinkingStart: () => {
            if (!showThinking) return;
            thinkingStarted = false;
            thinkingFirstLine = "";
            thinkingLineCaptured = false;
            needThinkingBreak = true;
            stopLiveStatus();
            renderer.writeLine(chalk.dim("🧠 思考: "));
          },
          onThinkingDelta: (text) => {
            if (showThinking) {
              if (!thinkingStarted) thinkingStarted = true;
              renderer.write(text);
            } else if (!thinkingLineCaptured) {
              const firstBreak = text.indexOf("\n");
              if (firstBreak !== -1) {
                thinkingFirstLine += text.slice(0, firstBreak);
                thinkingLineCaptured = true;
              } else {
                thinkingFirstLine += text;
              }
            }
          },
          onTextDelta: (text) => {
            stopLiveStatus();
            if (!showThinking && thinkingFirstLine) {
              renderer.writeLine(
                chalk.dim(`🧠 ${thinkingFirstLine.slice(0, 120)}${thinkingFirstLine.length > 120 ? "..." : ""}`),
              );
              thinkingFirstLine = "";
              thinkingLineCaptured = false;
            } else if (needThinkingBreak) {
              needThinkingBreak = false;
            }
            outputRenderer.writeChunk(text);
          },
          onToolCall: (name, args, id) => {
            stopLiveStatus();
            outputRenderer.toolStart(name, args, id);
          },
          onToolResult: (name, success, summary, id) => {
            outputRenderer.toolResult(name, success, summary, id ?? "");
          },
        };

        const result = await agent.runStream(
          { instruction: trimmed, mode: currentMode, workingDir, sessionId: currentSessionId },
          workingDir,
          projectDir,
          streamCallbacks,
          abortController.signal,
        );
        currentSessionId = result.sessionId;
        if (result.text) lastAnswerRaw = result.text;

        stopLiveStatus();
        outputRenderer.flush();

        if (result.truncated && result.text) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          renderer.writeLine(chalk.yellow(short));
        } else if (result.text && result.text.startsWith("Agent")) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          renderer.writeLine(chalk.red(short));
        }

        const cost = modelRouter.getCost();
        const costStr = cost > 0 ? `, ¥${cost.toFixed(4)}` : "";
        renderer.writeLine(
          chalk.gray(
            `[迭代: ${result.iterations}, 工具: ${result.toolCallsExecuted}, token: ${modelRouter.getTokenUsage()}${costStr}]`,
          ),
        );
      } catch (err) {
        stopLiveStatus();
        renderer.writeLine(chalk.red(`✗ 执行失败: ${(err as Error).message}`));
      }

      tui.endAgentSession();
      tui.setOnInterrupt(null);

      // 状态栏
      renderer.printStatus({
        mode: currentMode,
        model: modelRouter.getCurrentModel(),
        tokensUsed: modelRouter.getTokenUsage(),
        windowPct: statusWindowPct(),
        queueSize: prefillQueue.length,
      });
    }

    // 清理
    renderer.destroy();
    sessionStore.close();
  });

function displayWidth(s: string): number {
  let w = 0;
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\x1b\[\d+(;\d+)*m/g, "");
  for (const ch of clean) {
    // CJK + fullwidth chars take 2 columns
    w += (ch.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
  }
  return w;
}

function padToWidth(s: string, targetWidth: number): string {
  const w = displayWidth(s);
  if (w >= targetWidth) return s;
  return s + " ".repeat(targetWidth - w);
}

/** 毫秒 → 人类可读（<1s 显示 ms，否则 s） */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** token 数 → 千分位缩写（≥1000 显示 k，≥1e6 显示 m） */
function fmtK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 复制文本到系统剪贴板（Windows: clip.exe, macOS: pbcopy, Linux: xclip） */
async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "win32" ? "clip" : platform === "darwin" ? "pbcopy" : "xclip";
  const args = platform === "linux" ? ["-selection", "clipboard"] : [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { shell: platform === "win32" });
    let err = "";
    child.on("error", (e) => {
      err = e.message;
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `clipboard command failed (code ${code})`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

program.parse();
