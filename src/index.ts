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
import { loadEnvFile } from "./core/env-loader.js";
import { shouldOnboard, runOnboarding } from "./core/onboarding.js";
import { jobRunner } from "./core/job-runner.js";
import { scheduler } from "./core/scheduler.js";
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
import { hookManager } from "./hooks/hook-manager.js";
import { createEvaluateSkillCreation } from "./hooks/handlers.js";
import { DefaultAgent } from "./agents/default-agent.js";
import { ResearchAgent } from "./agents/research-agent.js";
import { CodingAgent } from "./agents/coding-agent.js";
import { DataAnalysisAgent } from "./agents/data-analysis-agent.js";
import { ProductOpsAgent } from "./agents/product-ops-agent.js";
import { FinancialAgent } from "./agents/financial-agent.js";
import { GameDevAgent } from "./agents/game-dev-agent.js";
import { GenericAgent } from "./agents/generic-agent.js";
import { BaseAgent } from "./agents/base-agent.js";
import { loadAgentConfig, loadAllAgentConfigs, saveAgentConfig as persistAgentConfig, deleteAgentConfig as removeAgentConfig, hasAgentConfig } from "./core/agent-config-loader.js";
import { routeToExpert } from "./agents/router.js";
import { skillRegistry } from "./core/skill-registry.js";
import { toolRegistry } from "./core/tool-registry.js";
import { TeamCoordinator } from "./core/team-coordinator.js";
import { pluginManager } from "./core/plugin-manager.js";
import { AppManager } from "./core/app-manager.js";
import { AppFactory } from "./core/app-factory.js";
import { generatorQueue } from "./core/generator-queue.js";
import { EvolutionEngine } from "./core/evolution-engine.js";
import { auditLogger } from "./core/audit-logger.js";
import { appRuntime } from "./core/app-runtime.js";
import { processManager } from "./core/process-manager.js";
import { getAppVersion } from "./core/version.js";
import { mcpManager } from "./mcp/mcp-manager.js";
import { renderer } from "./terminal/renderer.js";
import { tui } from "./terminal/tui.js";
import { StreamOutputRenderer } from "./terminal/output.js";
import { buildCliCommands } from "./commands/registry.js";
import { renderCommandHelp, hasRequiredArgs } from "./commands/misc.js";
import type { CommandContext } from "./commands/types.js";
import { startServer } from "./server.js";
import { setAskProvider, isAskWaiting, requestAsk } from "./tools/ask-channel.js";
import type { PermissionMode, PermissionConfig, StreamCallbacks, ModelProvider, AgentConfig } from "./types.js";

const program = new Command();

program.name("aiworker").description("AiWorker — 个人 AI Agent 助手").version(getAppVersion());

program
  .option("-m, --mode <mode>", "权限模式: ask | plan | auto", "auto")
  .option("-d, --dir <directory>", "工作目录（读写统一基准，默认 ./ai_default_project）", resolve(process.cwd(), "ai_default_project"))
  .option("--data-dir <directory>", "数据目录", resolve(process.cwd(), "data"))
  .option("--show-thinking", "显示模型思考过程（默认折叠）")
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

    // 非 server 模式初始化 TUI（交互模式）；server 模式走普通 stdout
    const isServer = !!options.server;
    if (!isServer) {
      renderer.init();
    }

    // TUI 激活时：ask_user 提问走 TUI 输入行（答> 前缀 + Enter 提交），而非 cooked-mode stdin
    if (!isServer && tui.isActive()) {
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

    // ─── 首次运行引导（TUI 模式 + 未配置 key + 未完成过）───
    if (!isServer && tui.isActive() && !process.env.DEEPSEEK_API_KEY && shouldOnboard(dataDir)) {
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

    if (!process.env.DEEPSEEK_API_KEY) {
      stdout.write(chalk.yellow("⚠️  未检测到 DEEPSEEK_API_KEY 环境变量\n"));
      stdout.write(chalk.gray("   请设置后重启，或使用 /setup 配置。\n\n"));
    }

    // ─── 初始化核心组件 ───
    registerBuiltinTools();

    const skillsDir = resolve(process.cwd(), "skills");
    const skillCount = skillRegistry.loadFromDir(skillsDir);

    const modelRouter = new ModelRouter();
    // 恢复运行时覆盖（/config 持久化；迭代上限已统一由 config/agents/*.yaml 管理，不再读 runtime-config 的 iterations）
    const runtimeConfigPath = resolve(dataDir, "runtime-config.json");
    if (existsSync(runtimeConfigPath)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimeConfigPath, "utf-8")) as Record<string, unknown>;
        delete parsed.iterations; // 旧版本遗留的迭代上限（已统一由 config/agents/*.yaml 管理）
        modelRouter.applyOverrides(parsed as Parameters<typeof modelRouter.applyOverrides>[0]);
      } catch {
        /* 损坏则忽略 */
      }
    }
    const sessionStore = new SessionStore(resolve(dataDir, "aiworker.db"));
    const modelProvider: ModelProvider = (opts) => modelRouter.complete(opts);
    const compressor = new ContextCompressor(modelProvider);
    const contextManager = new ContextManager(sessionStore, dataDir, compressor);

    // 扫描工作目录，注入项目画像（unknown = 未识别项目类型，展示层友好化）
    const profiler = new ProjectProfiler(workingDir);
    const projectProfile = profiler.scan();
    if (projectProfile) contextManager.setProjectProfile(projectProfile);

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

    const deps = { modelRouter, contextManager, sessionStore, dataDir, processManager };

    // ─── 智能体装配（内置 7 专家 + 自定义 GenericAgent）───
    const BUILTIN_AGENT_IDS = new Set([
      "default",
      "research",
      "coding",
      "data-analysis",
      "product-ops",
      "financial",
      "game-dev",
    ]);

    /** 构建智能体实例：内置用对应类（内部 YAML 覆盖），自定义用 GenericAgent（需 YAML 存在） */
    function buildAgent(id: string): BaseAgent | null {
      switch (id) {
        case "default":
          return new DefaultAgent(deps);
        case "research":
          return new ResearchAgent(deps);
        case "coding":
          return new CodingAgent(deps);
        case "data-analysis":
          return new DataAnalysisAgent(deps);
        case "product-ops":
          return new ProductOpsAgent(deps);
        case "financial":
          return new FinancialAgent(deps);
        case "game-dev":
          return new GameDevAgent(deps);
        default: {
          const cfg = loadAgentConfig(id);
          return cfg ? new GenericAgent(cfg, deps) : null;
        }
      }
    }

    const agents: Record<string, BaseAgent> = {};
    for (const id of BUILTIN_AGENT_IDS) {
      const a = buildAgent(id);
      if (a) agents[id] = a;
    }
    // 自定义智能体（config/agents/*.yaml 中非内置 id）
    for (const id of Object.keys(loadAllAgentConfigs())) {
      if (!BUILTIN_AGENT_IDS.has(id) && !agents[id]) {
        const a = buildAgent(id);
        if (a) agents[id] = a;
      }
    }

    /** 热重载：编辑/保存 YAML 后重建实例（内置回默认或 YAML 覆盖；自定义按 YAML） */
    function reloadAgent(id: string): boolean {
      const a = buildAgent(id);
      if (!a) return false;
      agents[id] = a;
      return true;
    }

    function removeAgent(id: string): void {
      delete agents[id];
    }

    /** 剥离运行时注入的绑定技能段（applyDeclaredSkills 会拼进 systemPrompt；持久化时应只存原始 Prompt） */
    function stripSkillSection(prompt: string): string {
      const s = prompt.indexOf("-- 绑定技能 --");
      const e = s >= 0 ? prompt.indexOf("-- 绑定技能结束 --", s) : -1;
      if (s < 0 || e < 0) return prompt;
      return (prompt.slice(0, s) + prompt.slice(e + "-- 绑定技能结束 --".length)).replace(/\n{3,}/g, "\n\n").trim();
    }

    /** 保存智能体配置（快照 + 剥离技能段 + 展开 mcp/插件工具进白名单 + 热重载） */
    function saveAgentConfig(id: string, cfg: AgentConfig): { ok: boolean; error?: string } {
      const expanded: AgentConfig = {
        ...cfg,
        systemPrompt: stripSkillSection(cfg.systemPrompt),
        tools: [
          ...new Set([
            ...cfg.tools,
            ...cfg.mcpServers.map((s) => `mcp_${s}_`),
            ...(cfg.plugins ?? []).flatMap((p) => pluginManager.getPlugin(p)?.registeredTools ?? []),
          ]),
        ],
      };
      persistAgentConfig(expanded);
      if (!reloadAgent(id)) return { ok: false, error: "智能体配置加载失败" };
      return { ok: true };
    }

    function deleteAgentConfig(id: string): { ok: boolean } {
      removeAgentConfig(id);
      if (BUILTIN_AGENT_IDS.has(id)) reloadAgent(id); // 内置：回 TS 默认
      else removeAgent(id); // 自定义：移除
      return { ok: true };
    }

    // 应用持久化的每专家迭代上限：已统一由 config/agents/*.yaml 管理（智能体 Tab / /config iterations），此处不再覆盖

    // ─── AI OS 应用管理器（Sprint 34：应用生命周期 + 子进程能力桥） ───
    const appManager = new AppManager(dataDir, appRuntime);
    appRuntime.init({
      dataDir,
      modelRouter,
      requestAsk: (question, options) => requestAsk(question, options ?? [], false),
      onCrashed: (id, crashCount) => appManager.onCrashed(id, crashCount),
    });
    await appManager.init();

    // ─── 应用工厂（Sprint 35 v2：agent-loop + fs_write 生成） ───
    const appFactory = new AppFactory(deps, appManager);
    generatorQueue.init(appFactory);

    // server 与 CLI 共用：思考展示开关（server 经配置端点可改）
    let showThinking = !!options.showThinking;
    // 持久化运行时配置（server 配置端点与 CLI /config 共用；迭代上限由 YAML 管理，不写入）
    const persistRuntimeConfig = () => {
      try {
        writeFileSync(runtimeConfigPath, JSON.stringify(modelRouter.getOverrides(), null, 2));
      } catch {
        /* 持久化失败静默 */
      }
    };
    // Web 配置端点与进化引擎共用：应用并持久化单个配置项
    const applyConfigField = (field: string, value: unknown): { ok: boolean; error?: string } => {
      try {
        switch (field) {
          case "model": {
            const v = String(value);
            const valid = modelRouter.getAvailableModels().find((m) => m.key === v);
            if (!valid) return { ok: false, error: `未知模型: ${v}` };
            modelRouter.setDefaultModel(v);
            break;
          }
          case "addModel": {
            const v = value as { key?: string; model?: string; baseURL?: string; provider?: string; apiKey?: string; temperature?: number; maxTokens?: number };
            const m = v?.model;
            const b = v?.baseURL;
            if (!v?.key || !m || !b) {
              return { ok: false, error: "添加模型需 key/model/baseURL" };
            }
            if (!modelRouter.addProfile(v.key, { model: m, baseURL: b, provider: v.provider, apiKey: v.apiKey, temperature: v.temperature, maxTokens: v.maxTokens })) {
              return { ok: false, error: `添加失败: key「${v.key}」已存在或非法` };
            }
            // 写回 config/models.json（保留 default/pricing/routing 等字段）
            const modelsPath = resolve(process.cwd(), "config", "models.json");
            const cfg = JSON.parse(readFileSync(modelsPath, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown> & { profiles?: Record<string, unknown> };
            if (!cfg.profiles || typeof cfg.profiles !== "object") cfg.profiles = {};
            cfg.profiles[v.key.trim().toLowerCase()] = modelRouter.getProfileRaw(v.key);
            writeFileSync(modelsPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
            break;
          }
          case "temperature": {
            const t = Number(value);
            if (Number.isNaN(t) || t < 0 || t > 2) return { ok: false, error: "温度需在 0-2 之间" };
            modelRouter.setTemperature(t);
            break;
          }
          case "maxTokens": {
            const n = Number(value);
            if (Number.isNaN(n) || n < 100) return { ok: false, error: "max-tokens 需 ≥ 100" };
            modelRouter.setMaxTokens(n);
            break;
          }
          case "thinking":
            showThinking = value === true;
            break;
          case "skillEvo":
            if (hookManager.has("onTaskComplete:evaluateSkillCreation")) {
              hookManager.off("onTaskComplete:evaluateSkillCreation");
            } else {
              hookManager.on(
                "onTaskComplete",
                createEvaluateSkillCreation({ sessionStore, modelRouter }),
                { id: "onTaskComplete:evaluateSkillCreation", priority: 10 },
              );
            }
            break;
          case "reset":
            modelRouter.setDefaultModel("");
            modelRouter.setTemperature(null);
            modelRouter.setMaxTokens(null);
            break;
          default:
            return { ok: false, error: `未知配置项: ${field}` };
        }
        persistRuntimeConfig();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };

    // ─── 进化引擎（Sprint 39 第一期：观察 + 提议 + 采纳/拒绝） ───
    const evolutionEngine = new EvolutionEngine({
      dataDir,
      observation: {
        listSessions: (limit) => sessionStore.listSessions(limit),
        getEvents: (sessionId) => sessionStore.getEvents(sessionId),
        auditCount: (action) => auditLogger.countByAction(action),
      },
      modelRouter,
      submitGenerate: (spec) =>
        generatorQueue.submit({
          description: spec.description,
          type: spec.type,
          sessionId: spec.sessionId ?? "evolution",
        }),
      setConfigField: applyConfigField,
    });

    // ─── 后台任务 + 定时调度（server 与 CLI 模式共用）───
    jobRunner.init({
      createAgent: (agentId) => agents[agentId] ?? agents["default"],
      workingDir,
      sessionStore,
      mode: defaultMode,
    });
    scheduler.init(
      { submit: (agentId, prompt) => jobRunner.submit(agentId, prompt) },
      resolve(process.cwd(), "config", "schedule.json"),
    );
    scheduler.start();

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

    // ─── 插件（config/plugins/，fail-soft：单个失败不阻断启动） ───
    const pluginsDir = resolve(process.cwd(), "config", "plugins");
    await pluginManager.loadFromDir(pluginsDir, { dataDir });

    // ─── 启动状态区（统一精简格式：✓ 类别  内容；绿色仅保留图标） ───
    const stat = (label: string, value: string): void => {
      stdout.write(chalk.green("✓ ") + label.padEnd(4) + chalk.gray(value) + "\n");
    };
    const plugins = pluginManager.getPlugins();
    const loadedPlugins = plugins.filter((p) => p.status === "loaded");
    const externalMcp = mcpServers.filter((s) => !s.name.includes("builtin"));
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
    stat("技能", `${skillCount}`);
    const appCount = appManager.list().length;
    if (appCount > 0) stat("应用", `${appCount}`);
    if (projectProfile) {
      const typeLabel = projectProfile.type === "unknown" ? "未识别" : projectProfile.type;
      const pkgPart = projectProfile.pkgManager ? ` · ${projectProfile.pkgManager}` : "";
      const dirsPart = projectProfile.topDirs.length > 0 ? ` · ${projectProfile.topDirs.length} 个顶层目录` : "";
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

    if (options.server) {
      const port = parseInt(options.port, 10);
      startServer(
        {
          modelRouter,
          workingDir,
          coordinator,
          createAgent: (agentId: string) => agents[agentId] ?? agents["default"],
          getAgentList: () =>
            Object.entries(agents).map(([id, a]) => {
              const cfg = a.getConfig();
              return {
                id,
                name: a.getName(),
                displayName: cfg.displayName,
                type: cfg.type,
                modelPreference: cfg.modelPreference,
                maxIterations: cfg.maxIterations,
                tools: cfg.tools,
                skills: cfg.skills ?? [],
                mcpServers: cfg.mcpServers,
                plugins: cfg.plugins ?? [],
                strictTools: cfg.strictTools ?? false,
                permissions: cfg.permissions,
                systemPrompt: cfg.systemPrompt,
                isCustom: !BUILTIN_AGENT_IDS.has(id),
                hasConfig: hasAgentConfig(id),
              };
            }),
          saveAgentConfig,
          deleteAgentConfig,
          isBuiltinAgent: (id: string) => BUILTIN_AGENT_IDS.has(id),
          getAgentMeta: () => ({
            tools: toolRegistry.getAll().map((t) => ({ name: t.definition.function.name, description: t.definition.function.description ?? "" })),
            skills: skillRegistry.getAll().map((s) => ({ name: s.name, expert: s.expert, description: s.description })),
            mcp: Object.values(mcpManager.getStatuses()).map((s) => ({
              name: s.name,
              connected: s.connected,
              toolCount: s.toolCount,
            })),
            plugins: pluginManager.getPlugins().map((p) => ({
              name: p.name,
              tools: p.registeredTools,
              status: p.status,
            })),
          }),
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
          getPlugins: () => pluginManager.getPlugins(),
          appManager,
          appFactory,
          generatorQueue,
          getConfigState: () => ({
            model: modelRouter.getDisplayModel(),
            availableModels: modelRouter.getAvailableModels().map((m) => ({ key: m.key, model: m.model, provider: m.provider })),
            runtimeConfig: modelRouter.getRuntimeConfig(),
            thinking: showThinking,
            skillEvo: hookManager.has("onTaskComplete:evaluateSkillCreation"),
            appVersion: getAppVersion(),
          }),
          setConfigField: applyConfigField,
          evolutionEngine,
        },
        port,
      );
      return;
    }

    let currentMode = options.mode as PermissionMode;
    for (const a of Object.values(agents)) {
      a.setMode(currentMode);
    }

    stdout.write(chalk.gray("输入消息开始对话，/help 查看帮助，/plugins 查看插件\n\n"));

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
      persistRuntimeConfig,
      currentAgent: () => agents[routeToExpert("")]!,
      saveAgentConfig: (cfg) => saveAgentConfig(cfg.id, cfg),
      getContextBreakdown: (query: string) => {
        const agent = agents[routeToExpert("")]!;
        return contextManager.getContextBreakdown(agent.getConfig().systemPrompt, currentSessionId ?? "", query);
      },
      listCommands: () => cliCommands,
      appManager,
      appFactory,
      evolutionEngine,
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
