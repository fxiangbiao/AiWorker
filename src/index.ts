#!/usr/bin/env node
/**
 * AiWorker CLI 入口 — 流式交互版本
 * 命令处理采用注册表分发（src/commands/）：命令零闭包捕获，经 CommandContext 注入，可独立单测
 * 运行时装配统一由 src/core/bootstrap.ts 提供（TUI / server / headless 三种前端共用）
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";

import { loadEnvFile } from "./core/env-loader.js";
import { shouldOnboard, runOnboarding } from "./core/onboarding.js";
import { createRuntime } from "./core/bootstrap.js";
import { buildServerDeps } from "./server-deps.js";
import { runHeadless, resolveHeadlessCli } from "./core/headless-runner.js";
import type { HeadlessCliResolved } from "./core/headless-runner.js";
import { getAppVersion } from "./core/version.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import { renderer } from "./terminal/renderer.js";
import { tui } from "./terminal/tui.js";
import { StreamOutputRenderer } from "./terminal/output.js";
import { buildCliCommands } from "./commands/registry.js";
import { renderCommandHelp, hasRequiredArgs } from "./commands/misc.js";
import type { CommandContext } from "./commands/types.js";
import { startServer } from "./server.js";
import { setAskProvider, isAskWaiting } from "./tools/ask-channel.js";
import type { PermissionMode, StreamCallbacks } from "./types.js";

const program = new Command();

program.name("aiworker").description("AiWorker — 个人 AI Agent 助手").version(getAppVersion());

program
  .option("-m, --mode <mode>", "权限模式: ask | plan | auto", "auto")
  .option("-d, --dir <directory>", "工作目录（读写统一基准，默认 ./ai_default_project）", resolve(process.cwd(), "ai_default_project"))
  .option("--data-dir <directory>", "数据目录", resolve(process.cwd(), "data"))
  .option("--show-thinking", "显示模型思考过程（默认折叠）")
  .option("-p, --print <prompt>", "headless 模式：执行给定提示后退出（不进入交互）")
  .option("--output-format <format>", "headless 输出格式: text | json | stream-json", "text")
  .option("--session <id>", "headless：续接既有会话 id")
  .option("--agent <id>", "headless：直接指定智能体（缺省按提示词路由）")
  .option("--yes", "headless：本次运行放行需确认的工具（不覆盖 deny 规则与受保护路径）")
  .option("--max-iterations <n>", "headless：覆盖本次运行的迭代上限")
  .option("--server", "启动 HTTP API 服务")
  .option("--port <port>", "HTTP Server 端口", "3000")
  .action(async (options) => {
    // 最先加载 .env（供 DEEPSEEK_API_KEY 等使用；不覆盖已有环境变量）
    loadEnvFile();

    const workingDir = resolve(options.dir);
    const dataDir = resolve(options.dataDir);

    mkdirSync(workingDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(resolve(dataDir, "memory"), { recursive: true });
    mkdirSync(resolve(dataDir, "audit"), { recursive: true });

    // 三种前端：server（HTTP API）/ headless（-p 一次性）/ 交互 TUI（默认）
    const isServer = !!options.server;
    const isHeadless = options.print !== undefined;

    if (isServer && isHeadless) {
      process.stderr.write("✗ --server 与 -p/--print 不能同时使用（headless 为一次性运行，不提供 HTTP 服务）\n");
      process.exitCode = 2;
      return;
    }

    // 参数校验前置（不触发运行时装配/MCP 连接）：退出码 2 只来自参数问题
    let headlessConfig: HeadlessCliResolved | null = null;
    if (isHeadless) {
      const resolved = resolveHeadlessCli({
        print: options.print,
        outputFormat: options.outputFormat,
        session: options.session,
        agent: options.agent,
        mode: options.mode,
        maxIterations: options.maxIterations,
        yes: options.yes,
      });
      if (!resolved.ok) {
        process.stderr.write(`✗ ${resolved.error}\n`);
        process.exitCode = 2;
        return;
      }
      headlessConfig = resolved.value;
    }

    // 只有交互模式初始化 TUI；server / headless 走普通 stdout/stderr 分流
    if (!isServer && !isHeadless) {
      renderer.init();
    }

    // TUI 激活时：ask_user 提问走 TUI 输入行（答> 前缀 + Enter 提交），而非 cooked-mode stdin
    if (!isServer && !isHeadless && tui.isActive()) {
      setAskProvider((req) => tui.ask(req.question, req.options, 30000, req.multiple === true));
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

    // headless 不初始化 TUI：输入行、banner、状态区全部跳过（stdout 只留结构化输出）
    if (!isHeadless) {
      renderer.configureInput(resolve(dataDir, ".aiworker_history"), completer);

      // ─── Banner（版本号来自 package.json，动态居中防边框错位） ───
      const bannerTitle = `AiWorker v${getAppVersion()}`;
      const bannerInner = 36;
      const bannerPad = Math.max(0, bannerInner - bannerTitle.length);
      const bannerLeft = Math.floor(bannerPad / 2);
      const bannerRight = bannerPad - bannerLeft;
      stdout.write(chalk.cyan(`╔${"═".repeat(bannerInner)}╗\n`));
      stdout.write(chalk.cyan(`║${" ".repeat(bannerLeft)}${bannerTitle}${" ".repeat(bannerRight)}║\n`));
      stdout.write(chalk.cyan(`╚${"═".repeat(bannerInner)}╝\n\n`));
      stdout.write(chalk.gray(`工作目录: ${workingDir}\n`));
      stdout.write(chalk.gray(`数据目录: ${dataDir}\n`));
      stdout.write(chalk.gray(`权限模式: ${options.mode ?? "auto（config/permissions.json 或默认）"}\n\n`));
    }

    // ─── 首次运行引导（TUI 模式 + 未配置 key + 未完成过）───
    if (!isServer && !isHeadless && tui.isActive() && !process.env.DEEPSEEK_API_KEY && shouldOnboard(dataDir)) {
      await runOnboarding({
        ask: (q) => (tui.isActive() ? tui.ask(q, [], 60000, false) : Promise.resolve(null)),
        dataDir,
        workingDir,
        writeEnv: (key, value) => {
          // 立即生效 + 写 .env（不覆盖同 key 旧行）
          process.env[key] = value;
          const envPath = resolve(process.cwd(), ".env");
          const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
          const lines = existing.split(/\r?\n/).filter((l) => !l.trim().startsWith(`${key}=`));
          lines.push(`${key}=${value}`);
          writeFileSync(envPath, lines.join("\n") + "\n");
        },
        writeDefaultMode: (mode) => {
          const permPath = resolve(process.cwd(), "config", "permissions.json");
          let cfg: Record<string, unknown> = {};
          try {
            cfg = JSON.parse(readFileSync(permPath, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
          } catch {
            /* 文件缺失/损坏则重建 */
          }
          cfg.default_mode = mode;
          writeFileSync(permPath, JSON.stringify(cfg, null, 2) + "\n");
        },
        log: (line) => stdout.write(chalk.gray(`${line}\n`)),
      });
    }

    // headless 下所有人类可读提示走 stderr，保证 stdout 可被 jq 等直接消费
    const note = (text: string): void => {
      if (isHeadless) process.stderr.write(text);
      else stdout.write(text);
    };

    if (!process.env.DEEPSEEK_API_KEY) {
      note(chalk.yellow("⚠️  未检测到 DEEPSEEK_API_KEY 环境变量\n"));
      note(chalk.gray("   请设置后重启，或使用 /setup 配置。\n\n"));
    }

    // ─── 运行时装配（模型/会话/记忆/权限/hooks/专家/应用/进化/MCP/插件）───
    const runtime = await createRuntime({
      workingDir,
      dataDir,
      mode: options.mode as PermissionMode,
      showThinking: !!options.showThinking,
      startScheduler: !isHeadless,
      onFileDiff: (filePath, added, removed) => {
        // 终端只展示单行摘要，完整 diff 由 Web /diffs 查看
        outputRenderer.fileDiff(filePath, added, removed);
      },
    });

    const { agents, modelRouter, sessionStore, coordinator } = runtime;

    if (runtime.hooksCount > 0 && !isHeadless) {
      stdout.write(chalk.green(`✓ 已加载 ${runtime.hooksCount} 个 Hook\n`));
    }

    // ─── 启动状态区（统一精简格式：✓ 类别  内容；绿色仅保留图标；headless 不输出） ───
    if (!isHeadless) {
      const stat = (label: string, value: string): void => {
        stdout.write(chalk.green("✓ ") + label.padEnd(4) + chalk.gray(value) + "\n");
      };
      const plugins = runtime.getPlugins();
      const loadedPlugins = plugins.filter((p) => p.status === "loaded");
      const externalMcp = Object.values(runtime.getMcpStatuses()).filter((s) => !s.name.includes("builtin"));
      const failedMcp = externalMcp.filter((s) => !s.connected);

      stat("模型", modelRouter.getDisplayModel());
      stat("专家", `${Object.keys(agents).length}`);
      const toolParts: string[] = [];
      if (externalMcp.length > 0) {
        toolParts.push(`${externalMcp.length} MCP（${externalMcp.map((s) => s.name).join(", ")}）`);
      }
      if (loadedPlugins.length > 0) {
        const toolNames = loadedPlugins
          .flatMap((p) => p.registeredTools)
          .map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t));
        toolParts.push(`${loadedPlugins.length} 插件（${toolNames.join(", ")}）`);
      }
      stat("工具", toolParts.length > 0 ? toolParts.join(" · ") : "内置工具就绪");
      stat("技能", `${runtime.skillCount}`);
      const appCount = runtime.appManager.list().length;
      if (appCount > 0) stat("应用", `${appCount}`);
      if (runtime.projectProfile) {
        const typeLabel = runtime.projectProfile.type === "unknown" ? "未识别" : runtime.projectProfile.type;
        const pkgPart = runtime.projectProfile.pkgManager ? ` · ${runtime.projectProfile.pkgManager}` : "";
        const dirsPart =
          runtime.projectProfile.topDirs.length > 0 ? ` · ${runtime.projectProfile.topDirs.length} 个顶层目录` : "";
        stat("项目", `${typeLabel}${pkgPart}${dirsPart}`);
      }
      // 告警（黄色，状态区之后）
      for (const s of failedMcp) {
        stdout.write(chalk.yellow(`⚠ MCP ${s.name} 连接失败${s.error ? `: ${s.error}` : ""}\n`));
      }
      for (const p of plugins) {
        if (p.status === "error") {
          stdout.write(chalk.yellow(`⚠ 插件 ${p.name} 加载失败: ${p.error}\n`));
        }
      }
      stdout.write("\n");
    }

    if (isServer) {
      const port = parseInt(options.port, 10);
      startServer(buildServerDeps(runtime), port);
      return;
    }

    // ─── headless 一次性运行（-p）：结构化输出 + 稳定退出码 ───
    if (isHeadless && headlessConfig) {
      // --yes：打开进程内全量免确认开关（不落盘、不覆盖 deny 规则、never_auto_approve 与受保护路径）
      if (headlessConfig.allowAll) {
        runtime.permissionModel.setAutoApproveAll(true);
      }
      const abortController = new AbortController();
      const onInterrupt = (): void => {
        abortController.abort();
      };
      process.on("SIGINT", onInterrupt);
      try {
        process.exitCode = await runHeadless(
          { ...headlessConfig, mode: headlessConfig.mode ?? runtime.defaultMode, workingDir },
          {
            agents,
            model: modelRouter.getDisplayModel(),
            write: (text) => stdout.write(text),
            writeErr: (text) => process.stderr.write(text),
            signal: abortController.signal,
          },
        );
      } finally {
        process.off("SIGINT", onInterrupt);
        await runtime.shutdown();
      }
      return;
    }

    // ─── 会话内可变状态 ───
    const prefillQueue: string[] = [];
    const lastAnswer = { value: "" };
    let currentSessionId: string | undefined;
    let currentMode = options.mode as PermissionMode;

    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    stdout.write(chalk.gray("输入消息开始对话，/help 查看帮助，/plugins 查看插件\n\n"));

    // 初始状态栏
    renderer.printStatus({
      mode: currentMode,
      model: modelRouter.getDisplayModel(),
      tokensUsed: 0,
      queueSize: 0,
    });

    // 计算当前上下文窗口占用百分比（低频调用：仅 printStatus / 命令后；分母为当前 agent 生效模型窗口）
    const statusWindowPct = (): number | undefined => {
      try {
        const agent = agents[routeToExpert("")]!;
        const bd = runtime.contextBreakdown(
          agent.getConfig().systemPrompt,
          currentSessionId ?? "",
          "",
          agent.getId(),
        );
        // 1 位小数（review：1M 窗口下真实占比常 <1%，Math.round 归 0 会把"有占用"显示成"0%"）
        return bd.windowSize > 0 ? Math.max(0, Math.round(((bd.total / bd.windowSize) * 100) * 10) / 10) : undefined;
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
      showThinking: () => runtime.getShowThinking(),
      toggleThinking: () => {
        runtime.setShowThinking(!runtime.getShowThinking());
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
      skillCount: runtime.skillCount,
      workingDir,
      runtimeConfigPath: runtime.runtimeConfigPath,
      persistRuntimeConfig: runtime.persistRuntimeConfig,
      currentAgent: () => agents[routeToExpert("")]!,
      saveAgentConfig: (cfg) => runtime.saveAgentConfig(cfg.id, cfg),
      getContextBreakdown: (query: string) => {
        const agent = agents[routeToExpert("")]!;
        return runtime.contextBreakdown(
          agent.getConfig().systemPrompt,
          currentSessionId ?? "",
          query,
          agent.getId(),
        );
      },
      listCommands: () => cliCommands,
      appManager: runtime.appManager,
      appFactory: runtime.appFactory,
      evolutionEngine: runtime.evolutionEngine,
      rewindService: runtime.rewindService,
      permissionMemory: runtime.permissionMemory,
      write: (text) => stdout.write(text),
      writeLine: (line) => renderer.writeLine(line),
      ask: (q) => (tui.isActive() ? tui.ask(q, [], 60000, false) : Promise.resolve(null)),
      dataDir,
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
        // 命令级帮助：--help / -h / help 后缀，或必选参数命令无参数时
        if (arg === "--help" || arg === "-h" || arg === "help" || (!arg && hasRequiredArgs(matched))) {
          renderCommandHelp(matched, commandCtx);
          continue;
        }
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
            // ask_user 挂起等待回答时，状态栏提示用户输入
            status: isAskWaiting() ? "等待你的回答" : "思考中",
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

      // 思考内容跟踪（非 TUI 降级路径使用；TUI 回合块内自带摘要）
      let thinkingFirstLine = "";
      let thinkingLineCaptured = false;
      let needThinkingBreak = false;

      // TUI 回合块视图（思考/工具/回答可折叠）；非 TUI 保持旧 stdout 流式
      const turnActive = tui.isActive();
      if (turnActive) {
        const view = tui.startTurn();
        // showThinking=true → thinking 块默认展开全文；false（默认）→ 折叠摘要实时滚动
        view.openDefaultThinking = runtime.getShowThinking();
        outputRenderer.setTurn(view);
      }

      try {
        const streamCallbacks: StreamCallbacks = {
          onIterationStart: () => {
            // 迭代分隔线不再展示（用户要求精简）
          },
          onThinkingStart: () => {
            stopLiveStatus();
            if (!turnActive) {
              if (!runtime.getShowThinking()) return;
              thinkingFirstLine = "";
              thinkingLineCaptured = false;
              needThinkingBreak = true;
              renderer.writeLine(chalk.dim("🧠 思考: "));
              return;
            }
            // 首块出现时提示折叠键（每个回合一次）
            tui.maybeHintFoldKeys();
          },
          onThinkingDelta: (text) => {
            if (turnActive) {
              tui.currentTurnView()?.thinkingDelta(text);
              tui.requestRender();
              return;
            }
            if (runtime.getShowThinking()) {
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
            if (!turnActive) {
              // 非 TUI：回答开始时补打思考首行摘要（旧语义）
              if (!runtime.getShowThinking() && thinkingFirstLine) {
                renderer.writeLine(
                  chalk.dim(`🧠 ${thinkingFirstLine.slice(0, 120)}${thinkingFirstLine.length > 120 ? "..." : ""}`),
                );
                thinkingFirstLine = "";
                thinkingLineCaptured = false;
              } else if (needThinkingBreak) {
                needThinkingBreak = false;
              }
            }
            outputRenderer.writeChunk(text);
          },
          onToolCall: (name, args, id) => {
            stopLiveStatus();
            outputRenderer.toolStart(name, args, id);
          },
          onToolResult: (name, success, summary, id, artifacts) => {
            outputRenderer.toolResult(name, success, summary, id ?? "", artifacts);
          },
        };

        // 本轮 token 差分：运行前快照会话账本（无当前会话则 0 基线）
        const sidBefore = currentSessionId;
        const baseBefore = sidBefore ? modelRouter.getSessionTokens(sidBefore) : { prompt: 0, completion: 0 };
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

        // 回合定稿：释放注入 → meta 并入回合尾（正常/中断保留结构）
        outputRenderer.setTurn(null);
        const interrupted = (result.truncated ?? false) && !result.text;
        const tokensNow = currentSessionId ? modelRouter.getSessionTokens(currentSessionId) : { prompt: 0, completion: 0 };
        const turnPrompt = Math.max(0, tokensNow.prompt - baseBefore.prompt);
        const turnCompletion = Math.max(0, tokensNow.completion - baseBefore.completion);
        const pct = statusWindowPct();
        const pctStr = pct != null ? ` (窗口 ${pct}%)` : "";
        tui.finishTurn(
          `[迭代: ${result.iterations}, 工具: ${result.toolCallsExecuted}, 本轮: ↑${turnPrompt} ↓${turnCompletion} tok${pctStr}]`,
          { interrupted },
        );

        if (result.truncated && result.text) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          renderer.writeLine(chalk.yellow(short));
        } else if (result.text && result.text.startsWith("Agent")) {
          const short = result.text.length > 500 ? result.text.slice(0, 500) + "..." : result.text;
          renderer.writeLine(chalk.red(short));
        }
      } catch (err) {
        stopLiveStatus();
        outputRenderer.setTurn(null);
        tui.finishTurn("", { interrupted: true });
        renderer.writeLine(chalk.red(`✗ 执行失败: ${(err as Error).message}`));
      }

      tui.endAgentSession();
      tui.setOnInterrupt(null);

      // 状态栏
      commandCtx.printStatus();
    }

    // 清理
    renderer.destroy();
    await runtime.shutdown();
  });

program.parse();
