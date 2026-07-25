import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AgentConfig, PermissionMode } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, "../../config/agents");

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
  permissions?: {
    defaultMode?: string;
    allowedTools?: string[];
    deniedTools?: string[];
  };
}

function normalizeAgentConfig(yaml: YamlAgentConfig): AgentConfig {
  return {
    id: yaml.id ?? yaml.name ?? "",
    name: yaml.name ?? yaml.id ?? "",
    displayName: yaml.displayName ?? yaml.name ?? "",
    type: (yaml.type ?? "default") as AgentConfig["type"],
    systemPrompt: (yaml.systemPrompt ?? "").trim(),
    modelPreference: yaml.modelPreference ?? "default",
    maxIterations: yaml.maxIterations ?? 30,
    sandbox: yaml.sandbox ?? false,
    tools: yaml.tools ?? [],
    mcpServers: yaml.mcpServers ?? [],
    permissions: {
      defaultMode: (yaml.permissions?.defaultMode ?? "ask") as PermissionMode,
      allowedTools: yaml.permissions?.allowedTools ?? [],
      deniedTools: yaml.permissions?.deniedTools ?? [],
    },
  };
}

export function loadAgentConfig(id: string): AgentConfig | null {
  try {
    const filePath = resolve(configDir, `${id}.yaml`);
    const raw = readFileSync(filePath, "utf-8");
    const yaml = parseYaml(raw) as YamlAgentConfig;
    return normalizeAgentConfig(yaml);
  } catch {
    return null;
  }
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
