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
  .action(async (options) => {
    const workingDir = resolve(options.dir);
    const dataDir = resolve(options.dataDir);

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });

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
    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    stdout.write(chalk.green("✓ 核心引擎就绪\n"));
    stdout.write(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch\n"));
    stdout.write(chalk.green("✓ 专家智能体: 通用助手, 研究分析师, 编码工程师, 数据分析师, 产品运营, 理财顾问, 游戏设计师\n"));
    stdout.write(chalk.green("✓ Team 协调器已就绪: 支持多专家协作\n"));
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
        continue;
      }

      // ─── 命令处理 ───
      if (trimmed === "/exit" || trimmed === "/quit") {
        stdout.write(chalk.gray("\n再见！\n"));
        break;
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
        stdout.write(chalk.gray("命令: /mode <ask|plan|craft> | /status | /exit | /<skill名>\n"));
        stdout.write(chalk.gray("多专家协作: /plan <描述> 自动编排多个专家协作完成任务\n"));
        stdout.write(chalk.gray("技能: /code-review /debug /report-generation /data-cleaning ... 等37个\n"));
        renderer.printStatus({
          mode: currentMode, model: modelRouter.getCurrentModel(),
          tokensUsed: modelRouter.getTokenUsage(), tokensMax: 8000, queueSize: prefillQueue.length,
        });
        continue;
      }

      if (trimmed === "/status") {
        stdout.write(chalk.gray(`模式: ${currentMode} | 模型: ${modelRouter.getCurrentModel()} | Token: ${modelRouter.getTokenUsage()}\n`));
        stdout.write(chalk.gray(`技能: ${skillCount} | 排队: ${prefillQueue.length}\n`));
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

      // ─── 多专家协作（/plan 命令） ───
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
        stdout.write(chalk.green(`✓ 计划已生成 (${plan.steps.length} 步, ${planResult.source})\n`));

        // 展示计划
        for (const step of plan.steps) {
          const deps = step.dependsOn.length > 0 ? chalk.gray(` ← ${step.dependsOn.join(", ")}`) : "";
          stdout.write(`  ${chalk.cyan(step.id)}: ${chalk.yellow(step.expertId)} — ${step.description}${deps}\n`);
        }

        stdout.write("\n");

        const callbacks: StreamCallbacks = {
          onToolCall: (expertId, desc) => {
            stdout.write(`${chalk.blue(`🔧 ${expertId}`)}: ${desc}\n`);
          },
          onToolResult: (_name, success, summary) => {
            const icon = success ? chalk.green("✓") : chalk.red("✗");
            stdout.write(`  ${icon} ${summary.slice(0, 80)}\n`);
          },
        };

        try {
          const result = await coordinator.execute(plan, workingDir, callbacks);
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

      // ─── 路由 & 执行 ───
      const expertId = routeToExpert(trimmed);
      const agent = agents[expertId];
      const agentName = agent.getName();

      // "思考中" spinner — 每轮 LLM 调用从新行开始，\r 只更新当前帧行
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinIdx = 0;
      let spinnerTimer: ReturnType<typeof setInterval> | null = null;
      let spinnerDisabled = false;

      const startSpinner = () => {
        if (spinnerDisabled || spinnerTimer) return;
        spinIdx = 0;
        // 新行开始，保证 spinner 在自己独立的行上
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

      startSpinner();

      inputCollector.startListening(() => stopSpinner(true));

      // 标记：spinner 被用户打断后，首个 token 到达时重新建立输出行
      let needReprefix = false;

      try {
        const streamCallbacks: StreamCallbacks = {
          onThinkingStart: () => { if (!spinnerDisabled) startSpinner(); },
          onTextDelta: (text) => {
            if (spinnerTimer) {
              // spinner 仍在运行 → 正常停止
              stopSpinner();
            } else if (needReprefix || spinnerDisabled) {
              // spinner 已被用户打断 → 在新行重新建立前缀
              stdout.write(`\n${chalk.yellow(`AiWorker[${agentName}]> `)}`);
              needReprefix = false;
              spinnerDisabled = false; // 允许后续 thinking 阶段重启 spinner
            }
            stdout.write(text);
          },
          onToolCall: (name) => {
            stopSpinner();
            stdout.write(`\n  ${chalk.blue(`🔧 ${name}`)}`);
          },
          onToolResult: (_name, success, summary) => {
            const icon = success ? chalk.green("✓") : chalk.red("✗");
            stdout.write(`  ${icon} ${summary.slice(0, 80)}\n`);
          },
        };

        const result = await agent.runStream(
          { instruction: trimmed, mode: currentMode, workingDir },
          workingDir,
          streamCallbacks
        );

        stopSpinner();

        if (result.truncated && result.text) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          stdout.write(`\n${chalk.yellow(short)}`);
        }

        stdout.write(
          chalk.gray(`\n[迭代: ${result.iterations}, 工具调用: ${result.toolCallsExecuted}]\n`)
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

program.parse();
