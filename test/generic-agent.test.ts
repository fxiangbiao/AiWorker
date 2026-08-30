import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericAgent } from "../src/agents/generic-agent.js";
import { skillRegistry } from "../src/core/skill-registry.js";
import type { AgentConfig } from "../src/types.js";

/** 暴露 protected 方法供测试 */
class ExposedAgent extends GenericAgent {
  apply(): void {
    this.applyDeclaredSkills();
  }
}

const deps = {
  modelRouter: {} as never,
  contextManager: {} as never,
  sessionStore: {} as never,
};

function makeCfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "test-agent",
    displayName: "测试智能体",
    type: "custom",
    systemPrompt: "你是测试助手。",
    modelPreference: "default",
    maxIterations: 30,
    sandbox: false,
    tools: [],
    mcpServers: [],
    skills: [],
    plugins: [],
    strictTools: false,
    permissions: { defaultMode: "ask", allowedTools: [], deniedTools: [] },
    ...over,
  };
}

describe("GenericAgent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "generic-agent-"));
    skillRegistry.clear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    skillRegistry.clear();
  });

  it("构造持有配置副本（修改不污染源对象）", () => {
    const cfg = makeCfg();
    const agent = new GenericAgent(cfg, deps as never);
    agent.setMaxIterations(99);
    agent.setMode("auto");
    expect(agent.getConfig().maxIterations).toBe(99);
    expect(agent.getConfig().permissions.defaultMode).toBe("auto");
    expect(cfg.maxIterations).toBe(30);
    expect(cfg.permissions.defaultMode).toBe("ask");
    expect(agent.getId()).toBe("test-agent");
    expect(agent.getName()).toBe("测试智能体");
  });

  it("applyDeclaredSkills 注入绑定技能正文（幂等替换）", () => {
    const skillDir = join(dir, "test-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test-skill\nexpert: general\n---\n# 测试技能\n这是技能正文内容。");
    expect(skillRegistry.loadFromDir(dir)).toBe(1);

    const agent = new ExposedAgent(makeCfg({ skills: ["test-skill"] }), deps as never);
    const before = agent.getConfig().systemPrompt;
    agent.apply();
    const after = agent.getConfig().systemPrompt;
    expect(after).toContain("测试技能");
    expect(after).toContain("这是技能正文内容");
    // 幂等：再次注入不重复叠加
    agent.apply();
    expect(agent.getConfig().systemPrompt).toBe(after);
    expect(before).not.toContain("绑定技能");
  });

  it("未声明技能时不注入", () => {
    const agent = new ExposedAgent(makeCfg(), deps as never);
    agent.apply();
    expect(agent.getConfig().systemPrompt).toBe("你是测试助手。");
  });
});
