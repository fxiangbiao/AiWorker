/**
 * 智能体配置热载回归测试（Bug 修复）
 * 根因：内置 agent 旧实现模块级 `const cfg = loadAgentConfig(id) ?? 默认` 只在 import 时执行一次；
 * Web「保存并生效」写 YAML + reloadAgent 重建实例后仍拿到旧配置 → 工具勾选不生效/回显丢失。
 * 修复：构造时重读 YAML（super(loadAgentConfig(id) ?? 默认)）。
 * 断言：每次构造都调用 loader.loadAgentConfig(id)。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../src/types.js";

vi.mock("../src/core/agent-config-loader.js", () => ({
  loadAgentConfig: vi.fn(() => ({
    id: "coding",
    name: "coding",
    displayName: "编码工程师",
    type: "coding",
    systemPrompt: "p",
    modelPreference: "coding",
    maxIterations: 50,
    sandbox: false,
    tools: ["fs_read"],
    mcpServers: [],
    skills: [],
    plugins: [],
    strictTools: false,
    permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
  } as AgentConfig)),
  loadAgentConfigFromDir: () => null,
  loadAllAgentConfigs: () => ({}),
  saveAgentConfig: () => {},
  deleteAgentConfig: () => true,
  hasAgentConfig: () => true,
  VALID_MODELS: new Set(["default", "coding"]),
}));

function mockDeps() {
  return { modelRouter: {}, contextManager: {}, sessionStore: {} } as never;
}

describe("内置智能体配置热载（保存后重新构造读取最新 YAML）", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("每次 new CodingAgent 都调用 loadAgentConfig（不再复用模块级一次性常量）", async () => {
    const { CodingAgent } = await import("../src/agents/coding-agent.js");
    const loader = (await import("../src/core/agent-config-loader.js")) as {
      loadAgentConfig: ReturnType<typeof vi.fn>;
    };

    new CodingAgent(mockDeps());
    new CodingAgent(mockDeps());
    expect(loader.loadAgentConfig).toHaveBeenCalledTimes(2);
    expect(loader.loadAgentConfig).toHaveBeenCalledWith("coding");
  });

  it("YAML 变更后新实例工具随之更新（模拟 Web 保存 → reloadAgent）", async () => {
    const loader = (await import("../src/core/agent-config-loader.js")) as {
      loadAgentConfig: ReturnType<typeof vi.fn>;
    };
    const { CodingAgent } = await import("../src/agents/coding-agent.js");

    // 首次：YAML 无 fs_edit
    loader.loadAgentConfig.mockReturnValue({
      id: "coding", name: "coding", displayName: "编码工程师", type: "coding",
      systemPrompt: "p", modelPreference: "coding", maxIterations: 50, sandbox: false,
      tools: ["fs_read"], mcpServers: [], skills: [], plugins: [], strictTools: false,
      permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
    } as AgentConfig);
    const before = new CodingAgent(mockDeps());
    expect(before.getConfig().tools).toEqual(["fs_read"]);

    // 模拟 Web 勾选 fs_edit 保存：YAML tools 更新
    loader.loadAgentConfig.mockReturnValue({
      id: "coding", name: "coding", displayName: "编码工程师", type: "coding",
      systemPrompt: "p", modelPreference: "coding", maxIterations: 50, sandbox: false,
      tools: ["fs_read", "fs_edit"], mcpServers: [], skills: [], plugins: [], strictTools: false,
      permissions: { defaultMode: "auto", allowedTools: [], deniedTools: [] },
    } as AgentConfig);
    const after = new CodingAgent(mockDeps());
    expect(after.getConfig().tools).toEqual(["fs_read", "fs_edit"]);

    // 旧实例不受影响（BaseAgent 构造拷贝），新实例已热载
    expect(before.getConfig().tools).toEqual(["fs_read"]);
  });
});
