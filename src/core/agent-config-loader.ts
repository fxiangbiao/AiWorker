import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentConfig, PermissionMode } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, "../../config/agents");

export const VALID_MODELS = new Set(["default", "coding", "reasoning", "writing", "creative", "lite"]);

interface YamlAgentConfig {
  id?: string;
  name?: string;
  displayName?: string;
  type?: string;
  systemPrompt?: string;
  modelPreference?: string;
  maxIterations?: number;
  sandbox?: boolean;
  tools?: string[];
  mcpServers?: string[];
  skills?: string[];
  plugins?: string[];
  strictTools?: boolean;
  subagents?: boolean;
  permissions?: {
    defaultMode?: string;
    allowedTools?: string[];
    deniedTools?: string[];
  };
}

function normalizeAgentConfig(yaml: YamlAgentConfig): AgentConfig {
  const modelPref = yaml.modelPreference ?? "default";
  return {
    id: yaml.id ?? yaml.name ?? "",
    name: yaml.name ?? yaml.id ?? "",
    displayName: yaml.displayName ?? yaml.name ?? "",
    type: (yaml.type ?? "default") as AgentConfig["type"],
    systemPrompt: (yaml.systemPrompt ?? "").trim(),
    modelPreference: VALID_MODELS.has(modelPref) ? modelPref : "default",
    maxIterations: yaml.maxIterations ?? 30,
    sandbox: yaml.sandbox ?? false,
    tools: yaml.tools ?? [],
    mcpServers: yaml.mcpServers ?? [],
    skills: yaml.skills ?? [],
    plugins: yaml.plugins ?? [],
    strictTools: yaml.strictTools ?? false,
    subagents: yaml.subagents ?? false,
    permissions: {
      defaultMode: (yaml.permissions?.defaultMode ?? "ask") as PermissionMode,
      allowedTools: yaml.permissions?.allowedTools ?? [],
      deniedTools: yaml.permissions?.deniedTools ?? [],
    },
  };
}

function toYamlConfig(config: AgentConfig): YamlAgentConfig {
  return {
    id: config.id,
    name: config.name,
    displayName: config.displayName,
    type: config.type,
    systemPrompt: config.systemPrompt,
    modelPreference: config.modelPreference,
    maxIterations: config.maxIterations,
    sandbox: config.sandbox,
    tools: config.tools,
    mcpServers: config.mcpServers,
    skills: config.skills,
    plugins: config.plugins,
    strictTools: config.strictTools,
    subagents: config.subagents,
    permissions: {
      defaultMode: config.permissions.defaultMode,
      allowedTools: config.permissions.allowedTools,
      deniedTools: config.permissions.deniedTools,
    },
  };
}

/** 从指定目录加载（测试隔离用；生产用默认 config/agents） */
export function loadAgentConfigFromDir(id: string, dir: string): AgentConfig | null {
  try {
    const filePath = resolve(dir, `${id}.yaml`);
    const raw = readFileSync(filePath, "utf-8");
    const yaml = parseYaml(raw) as YamlAgentConfig;
    return normalizeAgentConfig(yaml);
  } catch {
    return null;
  }
}

export function loadAgentConfig(id: string): AgentConfig | null {
  return loadAgentConfigFromDir(id, configDir);
}

/** 是否存在 YAML 覆盖（内置智能体"已自定义"徽标；自定义智能体即存在） */
export function hasAgentConfig(id: string, dir?: string): boolean {
  return existsSync(resolve(dir ?? configDir, `${id}.yaml`));
}

/** 保存智能体配置（整体快照；目录不存在自动创建） */
export function saveAgentConfig(config: AgentConfig, dir?: string): void {
  const target = dir ?? configDir;
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, `${config.id}.yaml`), stringifyYaml(toYamlConfig(config)), "utf-8");
}

/** 删除智能体配置（恢复内置默认 / 删除自定义） */
export function deleteAgentConfig(id: string, dir?: string): boolean {
  const target = dir ?? configDir;
  const filePath = resolve(target, `${id}.yaml`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function loadAllAgentConfigs(): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {};
  try {
    const files = readdirSync(configDir);
    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const id = file.replace(/\.(yaml|yml)$/, "");
      const config = loadAgentConfig(id);
      if (config) result[id] = config;
    }
  } catch {
    // config dir may not exist
  }
  return result;
}
