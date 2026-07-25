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
import { hookManager } from "./hooks/hook-manager.js";
import { DangerDetector } from "./security/danger-detector.js";
import { DefaultAgent } from "./agents/default-agent.js";
import { ResearchAgent } from "./agents/research-agent.js";
import { CodingAgent } from "./agents/coding-agent.js";
import { DataAnalysisAgent } from "./agents/data-analysis-agent.js";
import { ProductOpsAgent } from "./agents/product-ops-agent.js";
import { FinancialAgent } from "./agents/financial-agent.js";
import { GameDevAgent } from "./agents/game-dev-agent.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import { renderer } from "./terminal/renderer.js";
import { inputCollector } from "./terminal/input.js";
import type { PermissionMode, StreamCallbacks } from "./types.js";

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
    const compressor = new ContextCompressor();
    const contextManager = new ContextManager(sessionStore, dataDir, compressor);
    initAuditLog(dataDir);

    const dangerDetector = new DangerDetector();
    hookManager.on("onToolCallPre", async (ctx) => {
      const { toolName, args } = ctx.data;
      if (toolName === "terminal_exec" || toolName === "fs_write") {
        const input = typeof args === "string" ? args : JSON.stringify(args);
        const check = dangerDetector.check(input);
        if (check.isDangerous) {
          return { proceed: false, message: check.message };
        }
      }
      return void 0;
    });

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

    let currentMode = options.mode as PermissionMode;
    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    stdout.write(chalk.green("✓ 核心引擎就绪\n"));
    stdout.write(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch\n"));
    stdout.write(chalk.green("✓ 专家智能体: 通用助手, 研究分析师, 编码工程师, 数据分析师, 产品运营, 理财顾问, 游戏设计师\n"));
    stdout.write(chalk.green("✓ 安全层已启用: 危险检测 + 审计日志\n"));
    stdout.write(chalk.gray("输入消息开始对话, /help 查看帮助\n\n"));

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

      const trimmed = input ? input.trim() : "";
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
        stdout.write(chalk.gray("命令: /mode <ask|plan|craft> | /status | /exit\n"));
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
        if (permanent) spinnerDisabled = true;
        if (!spinnerTimer) return;
        clearInterval(spinnerTimer);
        spinnerTimer = null;
        // 清空 spinner 行，写入纯前缀，后续 token 从这行接着写
        stdout.write(`\r${chalk.yellow(`AiWorker[${agentName}]> `)}${" ".repeat(30)}\r${chalk.yellow(`AiWorker[${agentName}]> `)}`);
      };

      startSpinner();

      inputCollector.startListening(() => stopSpinner(true));

      try {
        const streamCallbacks: StreamCallbacks = {
          onThinkingStart: () => { if (!spinnerDisabled) startSpinner(); },
          onTextDelta: (text) => {
            stopSpinner();
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
