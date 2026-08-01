#!/usr/bin/env node
/**
 * AiWorker CLI 入口 — 流式交互版本
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { stdout } from "node:process";

import { ModelRouter } from "./core/model-router.js";
import { ContextManager } from "./core/context-manager.js";
import { SessionStore } from "./memory/session-store.js";
import { ContextCompressor } from "./memory/compressor.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { initAuditLog } from "./core/audit-logger.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { loadHooksFromConfig } from "./hooks/hook-config-loader.js";
import { DefaultAgent } from "./agents/default-agent.js";
import { ResearchAgent } from "./agents/research-agent.js";
import { CodingAgent } from "./agents/coding-agent.js";
import { DataAnalysisAgent } from "./agents/data-analysis-agent.js";
import { ProductOpsAgent } from "./agents/product-ops-agent.js";
import { FinancialAgent } from "./agents/financial-agent.js";
import { GameDevAgent } from "./agents/game-dev-agent.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import { TeamCoordinator } from "./core/team-coordinator.js";
import { mcpManager } from "./mcp/mcp-manager.js";
import { renderer } from "./terminal/renderer.js";
import { inputCollector } from "./terminal/input.js";
import type { PermissionMode, StreamCallbacks, ModelProvider } from "./types.js";

const program = new Command();

program
  .name("aiworker")
  .description("AiWorker — 个人 AI Agent 助手")
  .version("0.1.0");

program
  .option("-m, --mode <mode>", "权限模式: ask | plan | craft", "craft")
  .option("-d, --dir <directory>", "工作目录", process.cwd())
  .option("--data-dir <directory>", "数据目录", resolve(process.cwd(), "data"))
  .option("-p, --project-dir <directory>", "项目输出目录", resolve(process.cwd(), "ai_default_project"))
  .option("--show-thinking", "显示模型思考过程（默认折叠）")
  .action(async (options) => {
    const workingDir = resolve(options.dir);
    const dataDir = resolve(options.dataDir);
    const projectDir = resolve(options.projectDir);

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    renderer.init();

    // ─── Banner ───
    stdout.write(chalk.cyan("╔══════════════════════════════════════╗\n"));
    stdout.write(chalk.cyan("║        AiWorker v0.1.0 (MVP)         ║\n"));
    stdout.write(chalk.cyan("╚══════════════════════════════════════╝\n\n"));
    stdout.write(chalk.gray(`工作目录: ${workingDir}\n`));
    stdout.write(chalk.gray(`数据目录: ${dataDir}\n`));
    stdout.write(chalk.gray(`权限模式: ${options.mode}\n\n`));

    if (!process.env.OPENAI_API_KEY) {
      stdout.write(chalk.yellow("⚠️  未检测到 OPENAI_API_KEY 环境变量\n"));
      stdout.write(chalk.gray("   MVP 演示模式：你可以输入消息，但模型调用将返回占位响应。\n\n"));
    }

    // ─── 初始化核心组件 ───
    registerBuiltinTools();

    const skillsDir = resolve(process.cwd(), "skills");
    const skillCount = skillRegistry.loadFromDir(skillsDir);
    if (skillCount > 0) {
      stdout.write(chalk.green(`✓ 已加载 ${skillCount} 个技能\n`));
    }

    const modelRouter = new ModelRouter();
    const sessionStore = new SessionStore(resolve(dataDir, "aiworker.db"));
    const modelProvider: ModelProvider = (opts) => modelRouter.complete(opts);
    const compressor = new ContextCompressor(modelProvider);
    const contextManager = new ContextManager(sessionStore, dataDir, compressor);
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
      onFileDiff: (filePath, added, removed) => {
        renderer.writeLine(`  ${chalk.gray("📄")} ${chalk.dim(filePath)} ${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`);
      },
    });
    if (hooksCount > 0) {
      stdout.write(chalk.green(`✓ 已加载 ${hooksCount} 个 Hook\n`));
    }

    const deps = { modelRouter, contextManager, sessionStore };
    const agents: Record<string, DefaultAgent | ResearchAgent | CodingAgent | DataAnalysisAgent | ProductOpsAgent | FinancialAgent | GameDevAgent> = {
      default: new DefaultAgent(deps),
      research: new ResearchAgent(deps),
      coding: new CodingAgent(deps),
      "data-analysis": new DataAnalysisAgent(deps),
      "product-ops": new ProductOpsAgent(deps),
      financial: new FinancialAgent(deps),
      "game-dev": new GameDevAgent(deps),
    };

    const coordinator = new TeamCoordinator(agents, modelRouter);

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
    stdout.write(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch\n"));
    stdout.write(chalk.green("✓ 专家智能体: 通用助手, 研究分析师, 编码工程师, 数据分析师, 产品运营, 理财顾问, 游戏设计师\n"));
    stdout.write(chalk.green("✓ Team 协调器已就绪: 支持多专家协作\n"));

    if (mcpServers.length > 0) {
      for (const s of mcpServers) {
        const icon = s.connected ? chalk.green("✓") : chalk.yellow("⚠");
        stdout.write(icon + chalk.green(` MCP: ${s.name} (${s.toolCount} 工具${s.connected ? "" : ", 连接失败"})\n`));
      }
    }
    stdout.write(chalk.gray("输入消息开始对话, /help 查看帮助, /plan <描述> 使用多专家协作\n\n"));

    // 初始状态栏
    renderer.printStatus({
      mode: currentMode,
      model: modelRouter.getCurrentModel(),
      tokensUsed: 0,
      tokensMax: 8000,
      queueSize: 0,
    });

    // ─── 交互循环 ───
    let prefillQueue: string[] = [];
    let currentSessionId: string | undefined;

    while (true) {
      let input: string;
      if (prefillQueue.length > 0) {
        const prefill = prefillQueue.shift()!;
        stdout.write(chalk.yellow(`\n📋 排队消息 → ${prefill.slice(0, 60)}\n`));
        input = prefill;
        // 直接消费排队消息，不阻塞等待输入
      } else {
        input = await renderer.prompt();
      }

      let trimmed = input ? input.trim() : "";
      if (!trimmed) {
        renderer.printStatus({
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
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
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: 0, tokensMax: 8000, queueSize: prefillQueue.length,
        });
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
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/help") {
        const table: [string, string, string][] = [
          ["/plan <描述>",     "多专家 DAG 协作",        "自动分解任务，拓扑序执行"],
          ["/debate <话题>",   "双专家辩论",             "两专家独立分析+互审+综合报告"],
          ["/mode <模式>",     "切换权限模式",           "ask(只读) / plan(确认后执行) / craft(自动执行)"],
          ["/new",             "开启新会话",             "清空上下文和 token 计数，重新开始"],
          ["/thinking",        "切换思考展示",           "折叠/展开模型的推理过程"],
          ["/skill <名称>",    "手动激活技能",           "如 /code-review, /debug, /data-cleaning"],
          ["/status",          "显示运行状态",           "模式/模型/token/排队"],
          ["/help",            "帮助信息",               "显示此表"],
          ["/exit",            "退出",                   ""],
        ];
        const colW = [20, 22, 50] as const;

        const hline = (left: string, mid: string, right: string) =>
          left + "─".repeat(colW[0]) + mid + "─".repeat(colW[1]) + mid + "─".repeat(colW[2]) + right;

        stdout.write(chalk.cyan(`\n${hline("┌─", "─┬─", "─┐")}\n`));
        stdout.write(`│ ${chalk.bold(padToWidth("命令", colW[0]))} │ ${chalk.bold(padToWidth("功能", colW[1]))} │ ${chalk.bold(padToWidth("说明", colW[2]))} │\n`);
        stdout.write(`${hline("├─", "─┼─", "─┤")}\n`);
        for (const [cmd, func, desc] of table) {
          const c = padToWidth(cmd, colW[0]);
          const f = padToWidth(func, colW[1]);
          const d = padToWidth(desc, colW[2]);
          stdout.write(`│ ${c} │ ${f} │ ${d} │\n`);
        }
        // 补充技能数量提示行
        const skillHint = `共 ${skillCount} 个，输入 /<技能名> 激活`;
        stdout.write(`│ ${padToWidth(chalk.dim("技能数量"), colW[0])} │ ${padToWidth(chalk.dim("快捷用法"), colW[1])} │ ${chalk.dim(skillHint)}${" ".repeat(Math.max(0, colW[2] - displayWidth(skillHint)))} │\n`);
        stdout.write(`${hline("└─", "─┴─", "─┘")}\n\n`);
        renderer.printStatus({
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/status") {
        const cost = modelRouter.getCost();
        stdout.write(chalk.gray(`模式: ${currentMode} | 模型: ${modelRouter.getCurrentModel()}\n`));
        stdout.write(chalk.gray(`Token: ${modelRouter.getTokenUsage()} (提示: ${modelRouter.getPromptTokens()}, 生成: ${modelRouter.getCompletionTokens()})`));
        if (cost > 0) stdout.write(          chalk.gray(` | 成本: ¥${cost.toFixed(4)}`));
        stdout.write(chalk.gray(`\n技能: ${skillCount} | 排队: ${prefillQueue.length}\n`));
        renderer.printStatus({
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/thinking") {
        showThinking = !showThinking;
        stdout.write(chalk.green(`✓ 思考展示: ${showThinking ? "展开" : "折叠"}\n`));
        renderer.printStatus({
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      // ─── 多专家辩论（/debate 命令） ───
      if (trimmed.startsWith("/debate ")) {
        const topic = trimmed.slice(8).trim();
        if (!topic) {
          stdout.write(chalk.red("请输入辩论话题，例如: /debate React vs Vue 技术选型\n"));
          renderer.printStatus({
            mode: currentMode, model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
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
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      // ─── 多专家协作（/plan 命令，必须在 /skill 之前） ───
      if (trimmed.startsWith("/plan ")) {
        const planDesc = trimmed.slice(6).trim();
        if (!planDesc) {
          stdout.write(chalk.red("请输入任务描述，例如: /plan 开发一款放置类手游\n"));
          renderer.printStatus({
            mode: currentMode, model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
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
            mode: currentMode, model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
          });
          continue;
        }

        const plan = planResult.plan;
        stdout.write(chalk.green(`✓ 计划已生成 (${plan.steps.length} 步, ${planResult.source})\n\n`));

        // 打印步骤列表作为进度模板
        const stepStatus: Record<string, string> = {};
        for (const step of plan.steps) {
          const deps = step.dependsOn.length > 0 ? chalk.gray(` ← ${step.dependsOn.join(", ")}`) : "";
          stdout.write(`  ${chalk.cyan("⚪")} ${chalk.cyan(step.id)}: ${chalk.yellow(step.expertId)} — ${step.description}${deps}\n`);
          stepStatus[step.id] = "⚪";
        }

        stdout.write("\n");

        const callbacks: StreamCallbacks = {
          onStepStart: (stepId, expertId) => {
            const step = plan.steps.find((s) => s.id === stepId);
            if (step) {
              stepStatus[stepId] = "🔵";
              stdout.write(`  ${chalk.cyan("🔵")} ${chalk.cyan(stepId)}: ${chalk.yellow(expertId)} — ${step.description} ${chalk.dim("(进行中...)")}\n`);
            }
          },
          onStepEnd: (stepId, success) => {
            const step = plan.steps.find((s) => s.id === stepId);
            if (step) {
              const icon = success ? chalk.green("✅") : chalk.red("❌");
              const status = success ? "" : chalk.gray(" (已跳过)");
              stepStatus[stepId] = success ? "✅" : "❌";
              stdout.write(`  ${icon} ${chalk.cyan(stepId)}: ${chalk.yellow(step.expertId)} — ${step.description}${status}\n`);
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
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed.startsWith("/")) {
        const skillName = trimmed.slice(1).trim();
        const skill = skillRegistry.getAll().find((s) =>
          s.name.toLowerCase() === skillName.toLowerCase()
        );
        if (skill) {
          stdout.write(chalk.cyan(`\n📋 调用技能: ${skill.name}\n`));
          trimmed = `请使用 ${skill.name} 技能完成任务：\n\n${skill.body}\n\n用户任务：\n`;
        } else {
          stdout.write(chalk.yellow(`\n未找到技能 "${skillName}"\n`));
          const allSkills = skillRegistry.getAll().map((s) => chalk.cyan(s.name));
          stdout.write(chalk.gray(`可用技能: ${allSkills.join(", ")}\n\n`));
          renderer.printStatus({
            mode: currentMode, model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
          });
          continue;
        }
      }

      // ─── 路由 & 执行 ───
      const expertId = routeToExpert(trimmed);
      const agent = agents[expertId];
      const agentName = agent.getName();

      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinIdx = 0;
      let spinnerTimer: ReturnType<typeof setInterval> | null = null;
      let spinnerDisabled = false;

      const startSpinner = () => {
        if (spinnerDisabled || spinnerTimer) return;
        spinIdx = 0;
        stdout.write(`\n${chalk.yellow(`AiWorker[${agentName}]> `)}${chalk.cyan(frames[0])} ${chalk.dim("思考中...")}`);
        spinnerTimer = setInterval(() => {
          stdout.write(`\r${chalk.yellow(`AiWorker[${agentName}]> `)}${chalk.cyan(frames[spinIdx % frames.length])} ${chalk.dim("思考中...")}`);
          spinIdx++;
        }, 120);
      };

      const stopSpinner = (permanent = false) => {
        if (permanent) { spinnerDisabled = true; needReprefix = true; }
        if (!spinnerTimer) return;
        clearInterval(spinnerTimer);
        spinnerTimer = null;
        stdout.write(`\r${chalk.yellow(`AiWorker[${agentName}]> `)}${" ".repeat(30)}\r${chalk.yellow(`AiWorker[${agentName}]> `)}`);
      };

      // 思考阶段：在 spinner 行用内联状态覆盖
      let thinkingTimer: ReturnType<typeof setInterval> | null = null;
      let liveStatusActive = false;
      const startLiveStatus = () => {
        liveStatusActive = true;
        thinkingTimer = setInterval(() => {
          if (spinnerTimer) return;
          renderer.updateLiveStatus({
            mode: currentMode,
            model: modelRouter.getCurrentModel(),
            tokensUsed: modelRouter.getTokenUsage(),
            tokensMax: 8000,
            queueSize: prefillQueue.length + inputCollector.getQueueSize(),
            iteration: undefined,
            maxIter: agents[expertId]?.getConfig().maxIterations,
          });
        }, 500);
      };
      const stopLiveStatus = () => {
        if (!liveStatusActive) return;
        liveStatusActive = false;
        if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
        renderer.endLiveStatus();
      };

      startSpinner();
      startLiveStatus();

      inputCollector.startListening(() => stopSpinner(true));

      // 标记：spinner 被用户打断后，首个 token 到达时重新建立输出行
      let needReprefix = false;

      // 思考内容跟踪
      let thinkingStarted = false;
      let thinkingFirstLine = "";
      let thinkingLineCaptured = false;
      let needThinkingBreak = false;

      try {
        const streamCallbacks: StreamCallbacks = {
          onThinkingStart: () => {
            if (!showThinking) return;
            thinkingStarted = false;
            thinkingFirstLine = "";
            thinkingLineCaptured = false;
            needThinkingBreak = true;
            if (spinnerTimer) stopSpinner();
            stopLiveStatus();
            stdout.write(`\n${chalk.dim("🧠 思考: ")}`);
          },
          onThinkingDelta: (text) => {
            if (showThinking) {
              if (!thinkingStarted) thinkingStarted = true;
              stdout.write(chalk.dim(text));
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
            if (spinnerTimer) stopSpinner();
            stopLiveStatus();
            if (needReprefix || spinnerDisabled) {
              stdout.write(`\n${chalk.yellow(`AiWorker[${agentName}]> `)}`);
              needReprefix = false;
              spinnerDisabled = false;
              needThinkingBreak = false;
            }
            if (!showThinking && thinkingFirstLine) {
              stdout.write(`\n${chalk.dim(`🧠 ${thinkingFirstLine.slice(0, 120)}${thinkingFirstLine.length > 120 ? "..." : ""}`)}\n`);
              thinkingFirstLine = "";
              thinkingLineCaptured = false;
            } else if (needThinkingBreak) {
              stdout.write("\n");
              needThinkingBreak = false;
            }
            stdout.write(text);
          },
          onToolCall: (name) => {
            stopSpinner();
            stopLiveStatus();
            stdout.write(`\n  ${chalk.blue(`🔧 ${name}`)}`);
          },
          onToolResult: (_name, success, summary) => {
            const icon = success ? chalk.green("✓") : chalk.red("✗");
            stdout.write(`  ${icon} ${summary.slice(0, 80)}\n`);
          },
        };

        const result = await agent.runStream(
          { instruction: trimmed, mode: currentMode, workingDir, sessionId: currentSessionId },
          workingDir,
          projectDir,
          streamCallbacks
        );
        currentSessionId = result.sessionId;

        stopSpinner();
        stopLiveStatus();

        if (result.truncated && result.text) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          stdout.write(`\n${chalk.yellow(short)}`);
        } else if (result.text && result.text.startsWith("Agent")) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          stdout.write(`\n${chalk.red(short)}`);
        }

        const cost = modelRouter.getCost();
        const costStr = cost > 0 ? `, ¥${cost.toFixed(4)}` : "";
        stdout.write(
          chalk.gray(`\n[迭代: ${result.iterations}, 工具: ${result.toolCallsExecuted}, token: ${modelRouter.getTokenUsage()}${costStr}]\n`)
        );
      } catch (err) {
        stopSpinner();
        stdout.write(chalk.red(`\n✗ 执行失败: ${(err as Error).message}\n`));
      }

      const queue = inputCollector.stopListening();
      // 将排队消息加入 prefill 队列
      prefillQueue.push(...queue);

      // 状态栏
      stdout.write("\n");
      renderer.printStatus({
        mode: currentMode,
        model: modelRouter.getCurrentModel(),
        tokensUsed: modelRouter.getTokenUsage(),
        tokensMax: 8000,
        queueSize: prefillQueue.length,
      });
    }

    // 清理
    renderer.destroy();
    sessionStore.close();
  });

function pickDebateAgents(
  topic: string,
  available: string[]
): { agentA: string; agentB: string } {
  const defaultPair = { agentA: "research", agentB: "coding" };

  if (available.length < 2) return defaultPair;

  const has = (id: string) => available.includes(id);

  if (/投资|股票|基金|理财|财务|资产/i.test(topic) && has("financial") && has("data-analysis")) {
    return { agentA: "financial", agentB: "data-analysis" };
  }
  if (/游戏/i.test(topic) && has("game-dev") && has("product-ops")) {
    return { agentA: "game-dev", agentB: "product-ops" };
  }
  if (/(?:技术选型|架构|框架|语言.*选择|React.*Vue|前后端)/i.test(topic) && has("coding") && has("research")) {
    return { agentA: "coding", agentB: "research" };
  }
  if (/(?:产品|运营|用户|市场|PRD)/i.test(topic) && has("product-ops") && has("research")) {
    return { agentA: "product-ops", agentB: "research" };
  }
  if (/数据|分析|统计|报表/i.test(topic) && has("data-analysis") && has("research")) {
    return { agentA: "data-analysis", agentB: "research" };
  }

  return defaultPair;
}

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[\d+(;\d+)*m/g, "").length;
}

function displayWidth(s: string): number {
  let w = 0;
  // strip ANSI first
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

program.parse();
