/**
 * 运行时装配层 — TUI / HTTP Server / headless 三种前端共用的唯一装配入口
 * （Sprint 48 从 index.ts 抽出：装配顺序与依赖注入与抽出前逐字一致，仅去除前端相关副作用）
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { ModelRouter } from "./model-router.js";
import { ContextManager } from "./context-manager.js";
import { jobRunner } from "./job-runner.js";
import { subagentRunner } from "./subagent-runner.js";
import { registerSubagentTools } from "./subagent-tools.js";
import { scheduler } from "./scheduler.js";
import { ProjectProfiler } from "./project-profiler.js";
import { SessionStore } from "../memory/session-store.js";
import { TelemetryCoordinator } from "../memory/telemetry.js";
import { ContextCompressor } from "../memory/compressor.js";
import { registerBuiltinTools } from "../tools/builtin.js";
import { initAuditLog } from "./audit-logger.js";
import { DangerDetector } from "../security/danger-detector.js";
import { PermissionModel } from "../security/permission-model.js";
import { ApprovalService } from "../security/approval-service.js";
import { PermissionMemory, resolvePermissionConfigPath } from "../security/permission-memory.js";
import { DEFAULT_PROTECTED_PATHS } from "../security/permission-model.js";
import { requestConfirm } from "../hooks/confirm-channel.js";
import { loadHooksFromConfig } from "../hooks/hook-config-loader.js";
import { hookManager } from "../hooks/hook-manager.js";
import { setCompletedTurnsResolver } from "../hooks/turn-registry.js";
import { createEvaluateSkillCreation } from "../hooks/handlers.js";
import { DefaultAgent } from "../agents/default-agent.js";
import { ResearchAgent } from "../agents/research-agent.js";
import { CodingAgent } from "../agents/coding-agent.js";
import { DataAnalysisAgent } from "../agents/data-analysis-agent.js";
import { ProductOpsAgent } from "../agents/product-ops-agent.js";
import { FinancialAgent } from "../agents/financial-agent.js";
import { GameDevAgent } from "../agents/game-dev-agent.js";
import { GenericAgent } from "../agents/generic-agent.js";
import { BaseAgent } from "../agents/base-agent.js";
import {
  loadAgentConfig,
  loadAllAgentConfigs,
  saveAgentConfig as persistAgentConfig,
  deleteAgentConfig as removeAgentConfig,
} from "./agent-config-loader.js";
import { skillRegistry } from "./skill-registry.js";
import { toolRegistry } from "./tool-registry.js";
import { TeamCoordinator } from "./team-coordinator.js";
import { pluginManager } from "./plugin-manager.js";
import { AppManager } from "./app-manager.js";
import { AppFactory } from "./app-factory.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { RewindService } from "./rewind-service.js";
import { packageInstaller } from "./package-installer.js";
import { generatorQueue } from "./generator-queue.js";
import { EvolutionEngine } from "./evolution-engine.js";
import { EvolutionCases } from "./evolution-cases.js";
import { auditLogger } from "./audit-logger.js";
import { appRuntime } from "./app-runtime.js";
import { processManager } from "./process-manager.js";
import { mcpManager } from "../mcp/mcp-manager.js";
import { eventBus } from "../server/event-bus.js";
import { requestAsk } from "../tools/ask-channel.js";
import type {
  AgentConfig,
  McpServerStatus,
  ModelProvider,
  PermissionConfig,
  PermissionMode,
  PluginInfo,
  ProjectProfile,
} from "../types.js";

/** 内置专家 id（自定义智能体为其补集） */
export const BUILTIN_AGENT_IDS = new Set([
  "default",
  "research",
  "coding",
  "data-analysis",
  "product-ops",
  "financial",
  "game-dev",
]);

export interface RuntimeOptions {
  workingDir: string;
  dataDir: string;
  /** 权限模式：显式传入时覆盖 config/permissions.json 的 default_mode */
  mode?: PermissionMode;
  showThinking?: boolean;
  /** 是否启动定时调度器（headless 一次性运行传 false，避免定时器阻止进程退出） */
  startScheduler?: boolean;
  /** 文件变更摘要回调（TUI 单行展示；Web/headless 不传则忽略） */
  onFileDiff?: (filePath: string, added: number, removed: number, diffText?: string) => void;
}

export interface Runtime {
  workingDir: string;
  dataDir: string;
  defaultMode: PermissionMode;
  runtimeConfigPath: string;
  skillCount: number;
  hooksCount: number;
  projectProfile: ProjectProfile | null;
  modelRouter: ModelRouter;
  sessionStore: SessionStore;
  contextManager: ContextManager;
  permissionModel: PermissionModel;
  approval: ApprovalService;
  permissionMemory: PermissionMemory;
  telemetry: TelemetryCoordinator;
  coordinator: TeamCoordinator;
  agents: Record<string, BaseAgent>;
  checkpointStore: CheckpointStore;
  rewindService: RewindService;
  appManager: AppManager;
  appFactory: AppFactory;
  evolutionEngine: EvolutionEngine;
  isBuiltinAgent(id: string): boolean;
  reloadAgent(id: string): boolean;
  saveAgentConfig(id: string, cfg: AgentConfig): { ok: boolean; error?: string };
  deleteAgentConfig(id: string): { ok: boolean };
  getShowThinking(): boolean;
  setShowThinking(value: boolean): void;
  persistRuntimeConfig(): void;
  applyConfigField(field: string, value: unknown): { ok: boolean; error?: string };
  contextBreakdown(
    systemPrompt: string,
    sessionId: string,
    userMessage: string,
    agentId?: string,
  ): ReturnType<ContextManager["getContextBreakdown"]>;
  getDefaultSystemPrompt(): string;
  getAgentSystemPrompt(agentId: string): string | undefined;
  getMcpStatuses(): Record<string, McpServerStatus>;
  getPlugins(): PluginInfo[];
  shutdown(): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const workingDir = resolve(options.workingDir);
  const dataDir = resolve(options.dataDir);

  mkdirSync(workingDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resolve(dataDir, "memory"), { recursive: true });
  mkdirSync(resolve(dataDir, "audit"), { recursive: true });

  registerBuiltinTools();
  registerSubagentTools();

  const skillsDir = resolve(process.cwd(), "skills");
  const skillCount = skillRegistry.loadFromDir(skillsDir);

  const modelRouter = new ModelRouter();
  // 恢复运行时覆盖（/config 持久化；迭代上限已统一由 config/agents/*.yaml 管理，不再读 runtime-config 的 iterations）
  const runtimeConfigPath = resolve(dataDir, "runtime-config.json");
  if (existsSync(runtimeConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(runtimeConfigPath, "utf-8")) as Record<string, unknown>;
      delete parsed.iterations;
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

  // 读取权限配置（Sprint 49 第二轮：跟随 --dir；文件缺失/损坏时用**内置安全默认值**兜底，不静默清空保护）
  let permConfig: {
    default_mode?: PermissionMode;
    modes?: PermissionConfig["modes"];
    allowed_dirs?: string[];
    denied_patterns?: string[];
    rules?: PermissionConfig["rules"];
    never_auto_approve?: string[];
    protected_paths?: string[];
  } = {};
  const permissionConfigPath = resolvePermissionConfigPath(workingDir);
  try {
    if (existsSync(permissionConfigPath)) {
      // 去除 UTF-8 BOM（Windows 编辑器保存时可能附加）
      const raw = readFileSync(permissionConfigPath, "utf-8").replace(/^\uFEFF/, "");
      permConfig = JSON.parse(raw);
    } else {
      console.warn(`[permissions] 未找到 ${permissionConfigPath}，使用内置默认策略（受保护路径取内置清单）`);
    }
  } catch (err) {
    console.warn(
      `[permissions] ${permissionConfigPath} 解析失败（${(err as Error).message}），使用内置默认策略——受保护路径取内置清单，不会静默清空`,
    );
    permConfig = {};
  }

  const defaultMode = options.mode || permConfig.default_mode || "auto";
  const modes: PermissionConfig["modes"] = {
    ask: { description: "只读问答（仅只读工具）", allow_tool_calls: true, readOnly: true },
    plan: { description: "计划模式（每步确认后执行）", allow_tool_calls: true, require_confirmation: true },
    auto: { description: "自动执行（高风险仍需确认）", allow_tool_calls: true, high_risk_confirm: true },
  };
  for (const m of Object.keys(modes) as PermissionMode[]) {
    if (permConfig.modes?.[m]) modes[m] = { ...modes[m], ...permConfig.modes[m] };
  }

  const dangerDetector = new DangerDetector(permConfig.denied_patterns);
  const permissionModel = new PermissionModel({
    defaultMode,
    modes,
    allowedDirs: permConfig.allowed_dirs && permConfig.allowed_dirs.length > 0 ? permConfig.allowed_dirs : [workingDir],
    deniedPatterns: permConfig.denied_patterns ?? [],
    rules: permConfig.rules ?? [],
    neverAutoApprove: permConfig.never_auto_approve ?? [],
    // 缺配置时回落到内置受保护路径清单（`.git`/`.ssh`/`.env`/`id_rsa` …），避免"读不到配置 = 没有保护"
    protectedPaths: permConfig.protected_paths ?? [...DEFAULT_PROTECTED_PATHS],
  });
  // 审批服务：权限决策单点（hooks 内三个权限 handler 均委托于此，fail-closed）
  // 权限记忆（Sprint 49）：项目级规则写 `<--dir>/config/permissions.json`（无则回落启动目录），会话级只留内存
  const permissionMemory = new PermissionMemory({
    model: permissionModel,
    configPath: permissionConfigPath,
    workingDir,
  });
  const approval = new ApprovalService({
    permissionModel,
    dangerDetector,
    workingDir,
    confirm: (req) => requestConfirm(req.message, req.options, req.title),
    permissionMemory,
  });

  const telemetry = new TelemetryCoordinator(dataDir);
  const checkpointStore = new CheckpointStore(dataDir);
  // 回合号回填：口径取 turn_logs（onTaskComplete 与 commitTurn 同批写入 = 已提交回合）。
  // 不用检查点 manifest：它在回合**开始**时创建，未提交的回合也有目录，用它回填会跳号并破坏"异常回合复用同一号"
  setCompletedTurnsResolver((sessionId) => sessionStore.getLastTurnSeq(sessionId));
  const hooksCount = loadHooksFromConfig(resolve(process.cwd(), "config", "hooks.json"), {
    dangerDetector,
    permissionModel,
    approval,
    sessionStore,
    modelRouter,
    workingDir,
    dataDir,
    telemetry,
    checkpointStore,
    onFileDiff: options.onFileDiff,
  });

  const deps = { modelRouter, contextManager, sessionStore, dataDir, processManager };

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
  for (const id of Object.keys(loadAllAgentConfigs())) {
    if (!BUILTIN_AGENT_IDS.has(id) && !agents[id]) {
      const a = buildAgent(id);
      if (a) agents[id] = a;
    }
  }

  function reloadAgent(id: string): boolean {
    const a = buildAgent(id);
    if (!a) return false;
    agents[id] = a;
    return true;
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
    if (BUILTIN_AGENT_IDS.has(id)) reloadAgent(id);
    else delete agents[id];
    return { ok: true };
  }

  // ─── AI OS 应用管理器（应用生命周期 + 子进程能力桥） ───
  const appManager = new AppManager(dataDir, appRuntime);
  appRuntime.init({
    dataDir,
    modelRouter,
    requestAsk: (question, askOptions) => requestAsk(question, askOptions ?? [], false),
    onCrashed: (id, crashCount) => appManager.onCrashed(id, crashCount),
  });
  await appManager.init();
  packageInstaller.appManager = appManager;

  const appFactory = new AppFactory(deps, appManager);
  generatorQueue.init(appFactory);

  let showThinking = !!options.showThinking;
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
        // "model" 是文档化的规范字段名；"profileKey" 是 GET /config 的读侧字段名，
        // 前端曾按读侧名写回（报「未知配置项: profileKey」）—— 两个名字都收，避免同义字段各写一半
        case "model":
        case "profileKey": {
          const v = String(value);
          // 大小写归一：profile key 在 addProfile/setDefaultModel 里都按 lowercase 存，
          // 校验若用原始串比对就会"能存进去、选不回来"（CLI /config model 已归一，此处对齐）
          const normalized = v.trim().toLowerCase();
          const valid = modelRouter.getAvailableModels().find((m) => m.key === normalized);
          if (!valid) return { ok: false, error: `未知模型: ${v}` };
          modelRouter.setDefaultModel(valid.key);
          break;
        }
        case "addModel": {
          const v = value as {
            key?: string;
            model?: string;
            baseURL?: string;
            provider?: string;
            apiKey?: string;
            temperature?: number;
            maxTokens?: number;
          };
          const m = v?.model;
          const b = v?.baseURL;
          if (!v?.key || !m || !b) {
            return { ok: false, error: "添加模型需 key/model/baseURL" };
          }
          if (
            !modelRouter.addProfile(v.key, {
              model: m,
              baseURL: b,
              provider: v.provider,
              apiKey: v.apiKey,
              temperature: v.temperature,
              maxTokens: v.maxTokens,
            })
          ) {
            return { ok: false, error: `添加失败: key「${v.key}」已存在或非法` };
          }
          // 写回 config/models.json（保留 default/contextWindow/routing 等字段；pricing 已移除——费用由平台统计）
          const modelsPath = resolve(process.cwd(), "config", "models.json");
          const cfg = JSON.parse(readFileSync(modelsPath, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown> & {
            profiles?: Record<string, unknown>;
          };
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
            hookManager.on("onTaskComplete", createEvaluateSkillCreation({ sessionStore, modelRouter }), {
              id: "onTaskComplete:evaluateSkillCreation",
              priority: 10,
            });
          }
          break;
        case "reset":
          modelRouter.setDefaultModel("");
          modelRouter.setTemperature(null);
          modelRouter.setMaxTokens(null);
          break;
        default:
          return { ok: false, error: `未知配置项: ${field}（可用：model/profileKey/addModel/temperature/maxTokens/thinking/skillEvo/reset）` };
      }
      persistRuntimeConfig();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  // ─── 进化引擎（观察 + 提议 + 两段式确认 + 快照回滚） ───
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
    patchToolDescription: (toolName, newDescription) => {
      if (!newDescription) return { ok: false, error: "工具描述不能为空" };
      const cur = toolRegistry.getAll().find((t) => t.definition.function.name === toolName);
      if (!cur) return { ok: false, error: `工具不存在: ${toolName}` };
      toolRegistry.register(
        toolName,
        { ...cur.definition, function: { ...cur.definition.function, description: newDescription } },
        cur.handler,
        { enabled: cur.enabled, availabilityCheck: cur.availabilityCheck, plugin: cur.plugin },
      );
      return { ok: true };
    },
    applyPromptFix: (agentId, newPrompt) => {
      const agent = agents[agentId];
      if (!agent) return { ok: false, error: `智能体不存在: ${agentId}` };
      const cfg = agent.getConfig();
      return saveAgentConfig(agentId, { ...cfg, systemPrompt: newPrompt });
    },
    // A/B 评测裁判（modelRouter 判断文本是否足以引导正确完成；输出非 JSON 抛错 → runEval 按用例跳过降级）
    scoreCase: async (task, text, expected) => {
      const prompt = `你是 AiWorker 的评测裁判。判断「工具描述/系统提示词」是否足以让智能体正确完成给定任务。严格输出单个 JSON 对象。
# 任务
${task}${expected ? `\n# 期望达成\n${expected}` : ""}
# 待评文本
${text}
# 输出
{"ok": true|false, "reason": "≤50 字原因"}
（ok=true 表示该文本信息足以引导正确完成；ok=false 表示模糊/缺失关键信息/会误导）`;
      const t0 = performance.now();
      const resp = await modelRouter.completeWithProfile("default", [{ role: "user", content: prompt }]);
      const jsonText = (resp.text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      let parsed: { ok?: unknown; reason?: unknown };
      try {
        parsed = JSON.parse(jsonText) as { ok?: unknown; reason?: unknown };
      } catch {
        throw new Error("裁判输出非 JSON");
      }
      return {
        ok: parsed.ok === true,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : undefined,
        latencyMs: performance.now() - t0,
      };
    },
    cases: new EvolutionCases(resolve(dataDir, "evolution", "cases")),
    getToolDescription: (name) =>
      toolRegistry.getAll().find((t) => t.definition.function.name === name)?.definition.function.description,
    getAgentSystemPrompt: (agentId) => agents[agentId]?.getConfig().systemPrompt,
    snapshot: {
      dataDir,
      skillsDir: resolve(process.cwd(), "skills"),
      agentsDir: resolve(process.cwd(), "config", "agents"),
      runtimeConfigPath: resolve(dataDir, "runtime-config.json"),
      getToolDefinition: (name) => toolRegistry.getAll().find((t) => t.definition.function.name === name)?.definition,
    },
    restoreHooks: {
      registerTool: (name, definition) => {
        const cur = toolRegistry.getAll().find((t) => t.definition.function.name === name);
        if (cur) {
          toolRegistry.register(name, definition, cur.handler, {
            enabled: cur.enabled,
            availabilityCheck: cur.availabilityCheck,
            plugin: cur.plugin,
          });
        }
      },
      reloadSkill: (filePath) => {
        skillRegistry.reloadSkill(filePath);
      },
      unloadSkill: (name) => skillRegistry.unloadSkill(name),
      reloadAgent: (id) => reloadAgent(id),
    },
  });

  // 生成结果回写：gen/done|failed|canceled → 进化台账（new-tool/new-app 提案）
  eventBus.subscribe((data) => {
    const d = data as { type?: string; jobId?: string; result?: { app?: { id?: string } } };
    if ((d.type === "gen/done" || d.type === "gen/failed" || d.type === "gen/canceled") && d.jobId) {
      evolutionEngine.onGenResult(d.jobId, d.type === "gen/done", d.result?.app?.id, d.type === "gen/canceled");
    }
  });

  // ─── 后台任务 + 定时调度（server 与 CLI 模式共用）───
  // 后台执行统一由 subagentRunner 承担；jobRunner 仅作兼容视图（/jobs、POST /jobs、scheduler）
  const createAgentFn = (agentId: string) => agents[agentId] ?? agents["default"];
  subagentRunner.init({
    createAgent: createAgentFn,
    workingDir,
    sessionStore,
    getMode: () => permissionModel.getMode(),
  });
  scheduler.init(
    { submit: (agentId, prompt) => jobRunner.submit(agentId, prompt) },
    resolve(process.cwd(), "config", "schedule.json"),
  );
  let schedulerStarted = false;
  if (options.startScheduler !== false) {
    scheduler.start();
    schedulerStarted = true;
  }

  const coordinator = new TeamCoordinator(agents, modelRouter);
  const rewindService = new RewindService({ sessionStore, checkpointStore });

  // ─── MCP 服务器（三种前端统一加载） ───
  const mcpConfigPath = resolve(process.cwd(), "config", "mcp.json");
  await Promise.race([
    mcpManager.loadConfig(mcpConfigPath).catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);

  // ─── 插件（config/plugins/，fail-soft：单个失败不阻断启动） ───
  await pluginManager.loadFromDir(resolve(process.cwd(), "config", "plugins"), { dataDir });

  const runtime: Runtime = {
    workingDir,
    dataDir,
    defaultMode,
    runtimeConfigPath,
    skillCount,
    hooksCount,
    projectProfile,
    modelRouter,
    sessionStore,
    contextManager,
    permissionModel,
    approval,
    permissionMemory,
    telemetry,
    coordinator,
    agents,
    checkpointStore,
    rewindService,
    appManager,
    appFactory,
    evolutionEngine,
    isBuiltinAgent: (id) => BUILTIN_AGENT_IDS.has(id),
    reloadAgent,
    saveAgentConfig,
    deleteAgentConfig,
    getShowThinking: () => showThinking,
    setShowThinking: (value) => {
      showThinking = value;
    },
    persistRuntimeConfig,
    applyConfigField,
    contextBreakdown: (systemPrompt, sessionId, userMessage, agentId) =>
      contextManager.getContextBreakdown(
        systemPrompt,
        sessionId,
        userMessage,
        agentId,
        agentId
          ? modelRouter.getContextWindow(agents[agentId]?.getConfig().modelPreference)
          : modelRouter.getContextWindow(),
      ),
    getDefaultSystemPrompt: () =>
      (agents["default"] as { getSystemPrompt?: () => string }).getSystemPrompt?.() ?? "",
    getAgentSystemPrompt: (agentId) =>
      (agents[agentId] as { getConfig?: () => { systemPrompt?: string } } | undefined)?.getConfig?.().systemPrompt,
    getMcpStatuses: () => mcpManager.getStatuses(),
    getPlugins: () => pluginManager.getPlugins(),
    shutdown: async () => {
      await subagentRunner.shutdown();
      if (schedulerStarted) {
        scheduler.stop();
        schedulerStarted = false;
      }
      // 释放子进程句柄：应用进程显式停止（持久化状态）、MCP 服务器断开（否则进程无法自然退出）
      for (const app of appManager.list()) {
        if (!appRuntime.isRunning(app.id)) continue;
        try {
          await appManager.stop(app.id);
        } catch {
          /* 停止失败不阻塞退出 */
        }
      }
      for (const name of Object.keys(mcpManager.getStatuses())) {
        try {
          mcpManager.disconnectServer(name);
        } catch {
          /* 断开失败不阻塞退出 */
        }
      }
      await telemetry.shutdown();
      sessionStore.close();
    },
  };

  return runtime;
}
