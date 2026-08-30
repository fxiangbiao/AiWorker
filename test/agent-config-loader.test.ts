import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveAgentConfig,
  loadAgentConfigFromDir,
  hasAgentConfig,
  deleteAgentConfig,
} from "../src/core/agent-config-loader.js";
import type { AgentConfig } from "../src/types.js";

const cfg: AgentConfig = {
  id: "my-agent",
  name: "my-agent",
  displayName: "我的智能体",
  type: "custom",
  systemPrompt: "你是测试助手，负责示例任务。",
  modelPreference: "coding",
  maxIterations: 40,
  sandbox: false,
  tools: ["fs_read", "mcp_github_"],
  mcpServers: ["github"],
  skills: ["skill-a"],
  plugins: ["my-plugin"],
  strictTools: true,
  permissions: { defaultMode: "plan", allowedTools: ["fs_read"], deniedTools: ["terminal_exec"] },
};

describe("agent-config-loader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agents-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("保存后可从目录加载（roundtrip 完整字段）", () => {
    saveAgentConfig(cfg, dir);
    const loaded = loadAgentConfigFromDir("my-agent", dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("my-agent");
    expect(loaded!.displayName).toBe("我的智能体");
    expect(loaded!.systemPrompt).toBe(cfg.systemPrompt);
    expect(loaded!.modelPreference).toBe("coding");
    expect(loaded!.maxIterations).toBe(40);
    expect(loaded!.tools).toEqual(["fs_read", "mcp_github_"]);
    expect(loaded!.mcpServers).toEqual(["github"]);
    expect(loaded!.skills).toEqual(["skill-a"]);
    expect(loaded!.plugins).toEqual(["my-plugin"]);
    expect(loaded!.strictTools).toBe(true);
    expect(loaded!.permissions.defaultMode).toBe("plan");
    expect(loaded!.permissions.deniedTools).toEqual(["terminal_exec"]);
  });

  it("hasAgentConfig / deleteAgentConfig", () => {
    expect(hasAgentConfig("my-agent", dir)).toBe(false);
    saveAgentConfig(cfg, dir);
    expect(hasAgentConfig("my-agent", dir)).toBe(true);
    expect(deleteAgentConfig("my-agent", dir)).toBe(true);
    expect(hasAgentConfig("my-agent", dir)).toBe(false);
    expect(deleteAgentConfig("my-agent", dir)).toBe(false);
  });

  it("不存在的 id 返回 null", () => {
    expect(loadAgentConfigFromDir("nope", dir)).toBeNull();
  });

  it("非法 modelPreference 降级为 default", () => {
    saveAgentConfig({ ...cfg, modelPreference: "bogus" }, dir);
    const loaded = loadAgentConfigFromDir("my-agent", dir);
    expect(loaded!.modelPreference).toBe("default");
  });
});
