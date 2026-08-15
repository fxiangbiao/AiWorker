#!/usr/bin/env node
/**
 * AiWorker CLI 入口 — 流式交互版本
 * 命令处理采用注册表分发（src/commands/）：命令零闭包捕获，经 CommandContext 注入，可独立单测
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";

import { ModelRouter } from "./core/model-router.js";
import { ContextManager } from "./core/context-manager.js";
import { ProjectProfiler } from "./core/project-profiler.js";
import { SessionStore } from "./memory/session-store.js";
import { TelemetryCoordinator } from "./memory/telemetry.js";
import { ContextCompressor } from "./memory/compressor.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { initAuditLog } from "./core/audit-logger.js";
import { DangerDetector } from "./security/danger-detector.js";
import { PermissionModel } from "./security/permission-model.js";
import { ApprovalService } from "./security/approval-service.js";
import { requestConfirm } from "./hooks/confirm-channel.js";
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
import { tui } from "./terminal/tui.js";
import { StreamOutputRenderer } from "./terminal/output.js";
import { buildCliCommands } from "./commands/registry.js";
import type { CommandContext } from "./commands/types.js";
import { startServer } from "./server.js";
import type { PermissionMode, PermissionConfig, StreamCallbacks, ModelProvider } from "./types.js";

const program = new Command();

program.name("aiworker").description("AiWorker — 个人 AI Agent 助手").version("0.1.0");

program
  .option("-m, --mode <mode>", "权限模式: ask | plan | auto", "auto")
  .option("-d, --dir <directory>", "工作目录（读写统一基准，默认 ./ai_default_project）", resolve(process.cwd(), "ai_default_project"))
  .option("--data-dir <directory>", "数据目录", resolve(process.cwd(), "data"))
  .option("--show-thinking", "显示模型思考过程（默认折叠）")
  .option("--server", "启动 HTTP API 服务")
  .option("--port <port>", "HTTP Server 端口", "3000")
  .action(async (options) => {
    const workingDir = resolve(options.dir);
    const dataDir = resolve(options.dataDir);

    mkdirSync(workingDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });

    // 非 server 模式初始化 TUI（交互模式）；server 模式走普通 stdout
    const isServer = !!options.server;
    if (!isServer) {
      renderer.init();
    }

    const outputRenderer = new StreamOutputRenderer();

    // CLI 命令注册表（模块化拆分，顺序即匹配优先级与 /help 展示顺序）
    const cliCommands = buildCliCommands();

    // TUI 输入配置：历史持久化 + Tab 补全（命令列表由注册表派生）
    const completer = (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      const commandNames = cliCommands.flatMap((c) => [`/${c.name}`, ...(c.aliases ?? []).map((a) => `/${a}`)]);
      const hits = [...commandNames, ...skillRegistry.getAll().map((s) => `/${s.name}`)]
        .filter((c) => c.toLowerCase().startsWith(line.toLowerCase()))
        .slice(0, 10);
      return [hits.length ? hits : [], line];
    };
    renderer.configureInput(resolve(dataDir, ".aiworker_history"), completer);

    // ─── Banner ───
    stdout.write(chalk.cyan("╔══════════════════════════════════════╗\n"));
    stdout.write(chalk.cyan("║        AiWorker v0.1.0               ║\n"));
    stdout.write(chalk.cyan("╚══════════════════════════════════════╝\n\n"));
    stdout.write(chalk.gray(`工作目录: ${workingDir}\n`));
    stdout.write(chalk.gray(`数据目录: ${dataDir}\n`));
    stdout.write(chalk.gray(`权限模式: ${options.mode ?? "auto（config/permissions.json 或默认）"}\n\n`));

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

    // 读取 config/permissions.json（权限模型配置源）；CLI --mode 显式传入时覆盖默认模式
    let permConfig: {
      default_mode?: PermissionMode;
      modes?: PermissionConfig["modes"];
      allowed_dirs?: string[];
      denied_patterns?: string[];
    } = {};
    try {
      const permPath = resolve(process.cwd(), "config", "permissions.json");
      if (existsSync(permPath)) {
        // 去除 UTF-8 BOM（Windows 编辑器保存时可能附加）
        const raw = readFileSync(permPath, "utf-8").replace(/^\uFEFF/, "");
        permConfig = JSON.parse(raw);
      }
    } catch {
      permConfig = {};
    }

    const defaultMode = (options.mode as PermissionMode) || permConfig.default_mode || "auto";
    const modes: PermissionConfig["modes"] = {
      ask: { description: "只读问答（仅只读工具）", allow_tool_calls: true, readOnly: true },
      plan: { description: "计划模式（每步确认后执行）", allow_tool_calls: true, require_confirmation: true },
      auto: { description: "自动执行（高风险仍需确认）", allow_tool_calls: true, high_risk_confirm: true },
    };
    // 文件中的 modes 覆盖默认（保留默认的 allow_tool_calls 语义）
    for (const m of Object.keys(modes) as PermissionMode[]) {
      if (permConfig.modes?.[m]) modes[m] = { ...modes[m], ...permConfig.modes[m] };
    }

    const dangerDetector = new DangerDetector(permConfig.denied_patterns);
    const permissionModel = new PermissionModel({
      defaultMode,
      modes,
      allowedDirs: (permConfig.allowed_dirs && permConfig.allowed_dirs.length > 0) ? permConfig.allowed_dirs : [workingDir],
      deniedPatterns: permConfig.denied_patterns ?? [],
    });
    // 审批服务：权限决策单点（hooks 内三个权限 handler 均委托于此，fail-closed）
    const approval = new ApprovalService({
      permissionModel,
      dangerDetector,
      workingDir,
      confirm: (req) => requestConfirm(req.message, req.options, req.title),
    });

    const hooksDir = resolve(process.cwd(), "config");
    const telemetry = new TelemetryCoordinator(dataDir);
    const hooksCount = loadHooksFromConfig(resolve(hooksDir, "hooks.json"), {
      dangerDetector,
      permissionModel,
      approval,
      sessionStore,
      modelRouter,
      workingDir,
      dataDir,
      telemetry,
      onFileDiff: (filePath, added, removed, _diffText) => {
        // 终端只展示单行摘要，完整 diff 由 Web /diffs 查看
        outputRenderer.fileDiff(filePath, added, removed);
      },
    });
    if (hooksCount > 0) {
      stdout.write(chalk.green(`✓ 已加载 ${hooksCount} 个 Hook\n`));
    }

    const deps = { modelRouter, contextManager, sessionStore, dataDir };
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

    // ─── MCP 服务器（在 server / CLI 分支之前统一加载） ───
    const mcpConfigPath = resolve(process.cwd(), "config", "mcp.json");
    // await 连接完成（loadConfig 内部会等待 stdio 子进程初始化），并加超时保护避免卡死
    await Promise.race([
      mcpManager.loadConfig(mcpConfigPath).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    const mcpStatuses = mcpManager.getStatuses();
    const mcpServers = Object.values(mcpStatuses);
    if (mcpServers.length > 0) {
      stdout.write(chalk.green(`✓ 系统加载 ${mcpServers.length} 个 MCP\n`));
      for (const s of mcpServers) {
        const icon = s.connected ? chalk.green("✓") : chalk.yellow("⚠");
        stdout.write(icon + chalk.green(` MCP: ${s.name} (${s.toolCount} 工具${s.connected ? "" : ", 连接失败"})\n`));
      }
    } else {
      stdout.write(chalk.gray("⚠ 未加载 MCP（检查 config/mcp.json）\n"));
    }

    if (options.server) {
      const port = parseInt(options.port, 10);
      startServer(
        {
          modelRouter,
          workingDir,
          coordinator,
          createAgent: (agentId: string) => agents[agentId] ?? agents["default"],
          getAgentList: () =>
            Object.entries(agents).map(([id, a]) => ({ id, name: a.getName() })),
          skillNames: skillRegistry.getAll().map((s) => s.name),
          getSkills: () =>
            skillRegistry.getAll().map((s) => ({
              name: s.name,
              version: s.version ?? "1.0",
              description: s.description ?? "",
              expert: s.expert ?? "general",
              triggers: s.triggers ?? [],
              body: s.body ?? "",
              raw: s.raw ?? "",
            })),
          sessionStore,
          dataDir,
          getContextBreakdown: (systemPrompt: string, sessionId: string, userMessage: string, agentId?: string) =>
            contextManager.getContextBreakdown(systemPrompt, sessionId, userMessage, agentId),
          getSystemPrompt: () => (agents["default"] as { getSystemPrompt?: () => string }).getSystemPrompt?.() ?? "",
          getMcpStatuses: () => mcpManager.getStatuses(),
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

    stdout.write(chalk.green("✓ 核心引擎就绪\n"));
    stdout.write(chalk.green(`✓ 模型: ${modelRouter.getDisplayModel()}\n`));
    stdout.write(chalk.green("✓ 内置工具已注册: fs_read, fs_write, fs_list, terminal_exec, web_search, web_fetch\n"));
    stdout.write(
      chalk.green("✓ 专家智能体: 通用助手, 研究分析师, 编码工程师, 数据分析师, 产品运营, 理财顾问, 游戏设计师\n"),
    );
    stdout.write(chalk.green("✓ Team 协调器已就绪: 支持多专家协作\n"));
    stdout.write(chalk.gray("输入消息开始对话, /help 查看帮助, /plan <描述> 使用多专家协作\n\n"));

    // 初始状态栏
    if (!isServer) {
      renderer.printStatus({
        mode: currentMode,
        model: modelRouter.getDisplayModel(),
        tokensUsed: 0,
        queueSize: 0,
      });
    }

    // ─── 会话内可变状态 ───
    const prefillQueue: string[] = [];
    const lastAnswer = { value: "" };
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

    // ─── 命令上下文（显式注入，命令模块零闭包捕获） ───
    const commandCtx: CommandContext = {
      mode: () => currentMode,
      setMode: (m) => {
        currentMode = m;
        for (const a of Object.values(agents)) a.setMode(m);
      },
      showThinking: () => showThinking,
      toggleThinking: () => {
        showThinking = !showThinking;
      },
      currentSessionId: () => currentSessionId,
      setCurrentSessionId: (id) => {
        currentSessionId = id;
      },
      prefillQueue,
      lastAnswer,
      agents,
      coordinator,
      modelRouter,
      sessionStore,
      skillCount,
      workingDir,
      runtimeConfigPath,
      persistRuntimeConfig: () => {
        try {
          writeFileSync(runtimeConfigPath, JSON.stringify(modelRouter.getOverrides(), null, 2));
        } catch {
          /* 持久化失败静默 */
        }
      },
      getContextBreakdown: (query: string) => {
        const agent = agents[routeToExpert("")]!;
        return contextManager.getContextBreakdown(agent.getConfig().systemPrompt, currentSessionId ?? "", query);
      },
      listCommands: () => cliCommands,
      write: (text) => stdout.write(text),
      writeLine: (line) => renderer.writeLine(line),
      printStatus: () =>
        renderer.printStatus({
          mode: currentMode,
          model: modelRouter.getDisplayModel(),
          tokensUsed: modelRouter.getTokenUsage(),
          windowPct: statusWindowPct(),
          queueSize: prefillQueue.length,
        }),
    };

    // ─── 交互循环 ───
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
        commandCtx.printStatus();
        // Defensive: prevent busy-loop if stdin is broken on Windows
        await new Promise<void>((r) => setTimeout(r, 50));
        continue;
      }

      // ─── 命令分发（注册表，按 cliCommands 顺序匹配） ───
      const matched = cliCommands.find((c) => {
        const names = [c.name, ...(c.aliases ?? [])];
        return names.some((n) => trimmed === `/${n}` || trimmed.startsWith(`/${n} `));
      });
      if (matched) {
        const spaceIdx = trimmed.indexOf(" ");
        const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
        const action = await matched.handler(commandCtx, arg, trimmed);
        if (action === "exit") break;
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
          commandCtx.printStatus();
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
            model: modelRouter.getDisplayModel(),
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
          streamCallbacks,
          abortController.signal,
        );
        currentSessionId = result.sessionId;
        if (result.text) lastAnswer.value = result.text;

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
      commandCtx.printStatus();
    }

    // 清理
    renderer.destroy();
    await telemetry.shutdown();
    sessionStore.close();
  });

program.parse();
