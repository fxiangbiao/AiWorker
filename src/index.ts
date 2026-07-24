#!/usr/bin/env node
/**
 * AiWorker CLI 入口
 * Phase 1 MVP — 跑通 "指令→工具调用→结果" 闭环
 */

import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { ModelRouter } from "./core/model-router.js";
import { ContextManager } from "./core/context-manager.js";
import { SessionStore } from "./memory/session-store.js";
import { ContextCompressor } from "./memory/compressor.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { initAuditLog } from "./core/audit-logger.js";
import { hookManager } from "./hooks/hook-manager.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { DefaultAgent } from "./agents/default-agent.js";
import { ResearchAgent } from "./agents/research-agent.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import type { PermissionMode, AgentConfig } from "./types.js";

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

    // 确保数据目录
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });

    console.log(chalk.cyan("╔══════════════════════════════════════╗"));
    console.log(chalk.cyan("║        AiWorker v0.1.0 (MVP)         ║"));
    console.log(chalk.cyan("╚══════════════════════════════════════╝"));
    console.log(chalk.gray(`工作目录: ${workingDir}`));
    console.log(chalk.gray(`数据目录: ${dataDir}`));
    console.log(chalk.gray(`权限模式: ${options.mode}`));
    console.log();

    // 检查 API Key
    if (!process.env.OPENAI_API_KEY) {
      console.log(chalk.yellow("⚠️  未检测到 OPENAI_API_KEY 环境变量"));
      console.log(chalk.gray("   请设置后重试: export OPENAI_API_KEY=sk-..."));
      console.log(chalk.gray("   或在 config/models.json 中配置其他 provider"));
      console.log();
      console.log(chalk.gray("MVP 演示模式：你可以输入消息，但模型调用将返回占位响应。"));
      console.log();
    }

    // 初始化核心组件
    registerBuiltinTools();

    // 加载技能
    const skillsDir = resolve(process.cwd(), "skills");
    const skillCount = skillRegistry.loadFromDir(skillsDir);
    if (skillCount > 0) {
      console.log(chalk.green(`✓ 已加载 ${skillCount} 个技能`));
    }

    const modelRouter = new ModelRouter();
    const sessionStore = new SessionStore(resolve(dataDir, "aiworker.db"));
    const compressor = new ContextCompressor();
    const contextManager = new ContextManager(sessionStore, dataDir, compressor);
    initAuditLog(dataDir);

    // 注册安全 Hook
    const dangerDetector = new DangerDetector();
    hookManager.on("onToolCallPre", async (ctx) => {
      const { toolName, args } = ctx.data;
      if (toolName === "terminal_exec" || toolName === "fs_write") {
        const input = typeof args === "string" ? args : JSON.stringify(args);
        const check = dangerDetector.check(input);
        if (check.isDangerous) {
          return {
            proceed: false,
            message: check.message,
          };
        }
      }
      return void 0;
    });

    // 创建智能体实例
    const deps = { modelRouter, contextManager, sessionStore };
    const agents: Record<string, DefaultAgent | ResearchAgent> = {
      default: new DefaultAgent(deps),
      research: new ResearchAgent(deps),
    };

    let currentMode = options.mode as PermissionMode;
    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    console.log(chalk.green("✓ 核心引擎就绪"));
    console.log(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch"));
    console.log(chalk.green("✓ 专家智能体: 通用助手, 研究分析师"));
    console.log(chalk.green("✓ 安全层已启用: 危险检测 + 审计日志"));
    console.log();
    console.log(chalk.gray("输入消息开始对话，Ctrl+C 退出"));
    console.log(chalk.gray("命令: /mode <ask|plan|craft> 切换模式 | /exit 退出"));
    console.log();

    // 交互循环
    while (true) {
      const { input } = await inquirer.prompt([
        {
          type: "input",
          name: "input",
          message: chalk.cyan("你>"),
          prefix: "",
        },
      ]);

      const trimmed = input.trim();
      if (!trimmed) continue;

      // 内置命令
      if (trimmed === "/exit" || trimmed === "/quit") {
        console.log(chalk.gray("再见！"));
        break;
      }

      if (trimmed.startsWith("/mode ")) {
        const newMode = trimmed.slice(6).trim() as PermissionMode;
        if (["ask", "plan", "craft"].includes(newMode)) {
          currentMode = newMode;
          for (const a of Object.values(agents)) {
            a.setMode(newMode);
          }
          console.log(chalk.green(`✓ 已切换到 ${newMode} 模式`));
        } else {
          console.log(chalk.red("无效模式，可选: ask, plan, craft"));
        }
        console.log();
        continue;
      }

      if (trimmed === "/help") {
        console.log(chalk.gray("命令:"));
        console.log(chalk.gray("  /mode <ask|plan|craft>  切换权限模式"));
        console.log(chalk.gray("  /exit                   退出"));
        console.log();
        continue;
      }

      // 路由选择智能体
      const expertId = routeToExpert(trimmed);
      const agent = agents[expertId];
      const agentName = agents[expertId].getName();

      // 执行任务
      process.stdout.write(chalk.yellow(`AiWorker[${agentName}]> `));
      try {
        const result = await agent.run(
          { instruction: trimmed, mode: currentMode, workingDir },
          workingDir
        );

        if (result.truncated) {
          console.log(chalk.yellow(result.text));
        } else {
          console.log(result.text);
        }

        console.log(
          chalk.gray(
            `  [迭代: ${result.iterations}, 工具调用: ${result.toolCallsExecuted}]`
          )
        );
      } catch (err) {
        console.log(chalk.red(`✗ 执行失败: ${(err as Error).message}`));
      }
      console.log();
    }

    // 清理
    sessionStore.close();
  });

program.parse();
