/**
 * HTTP Server 依赖装配 — 把运行时（bootstrap）映射为 startServer 所需的 ServerDeps
 * （Sprint 48：从 index.ts 抽出，字段与抽出前逐字一致）
 */

import { generatorQueue } from "./core/generator-queue.js";
import { mcpManager } from "./mcp/mcp-manager.js";
import { pluginManager } from "./core/plugin-manager.js";
import { skillRegistry } from "./core/skill-registry.js";
import { toolRegistry } from "./core/tool-registry.js";
import { getAppVersion } from "./core/version.js";
import { hookManager } from "./hooks/hook-manager.js";
import { hasAgentConfig } from "./core/agent-config-loader.js";
import type { Runtime } from "./core/bootstrap.js";
import type { ServerDeps } from "./server.js";

export function buildServerDeps(runtime: Runtime): ServerDeps {
  const agents = runtime.agents;
  return {
    modelRouter: runtime.modelRouter,
    workingDir: runtime.workingDir,
    coordinator: runtime.coordinator,
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
          isCustom: !runtime.isBuiltinAgent(id),
          hasConfig: hasAgentConfig(id),
        };
      }),
    saveAgentConfig: runtime.saveAgentConfig,
    deleteAgentConfig: runtime.deleteAgentConfig,
    isBuiltinAgent: runtime.isBuiltinAgent,
    getAgentMeta: () => ({
      tools: toolRegistry.getAll().map((t) => ({
        name: t.definition.function.name,
        description: t.definition.function.description ?? "",
      })),
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
    sessionStore: runtime.sessionStore,
    dataDir: runtime.dataDir,
    getContextBreakdown: (systemPrompt, sessionId, userMessage, agentId) =>
      runtime.contextBreakdown(systemPrompt, sessionId, userMessage, agentId),
    getSystemPrompt: () => runtime.getDefaultSystemPrompt(),
    getAgentSystemPrompt: (agentId: string) => runtime.getAgentSystemPrompt(agentId),
    getMcpStatuses: () => runtime.getMcpStatuses(),
    getPlugins: () => runtime.getPlugins(),
    appManager: runtime.appManager,
    appFactory: runtime.appFactory,
    generatorQueue,
    evolutionEngine: runtime.evolutionEngine,
    rewindService: runtime.rewindService,
    permissionMemory: runtime.permissionMemory,
    permissionModel: runtime.permissionModel,
    getConfigState: () => ({
      model: runtime.modelRouter.getDisplayModel(),
      availableModels: runtime.modelRouter.getAvailableModels().map((m) => ({
        key: m.key,
        model: m.model,
        provider: m.provider,
      })),
      runtimeConfig: runtime.modelRouter.getRuntimeConfig(),
      thinking: runtime.getShowThinking(),
      skillEvo: hookManager.has("onTaskComplete:evaluateSkillCreation"),
      appVersion: getAppVersion(),
    }),
    setConfigField: runtime.applyConfigField,
  };
}
