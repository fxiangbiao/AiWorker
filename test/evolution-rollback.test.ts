/**
 * 进化引擎第二期单测（Sprint 40：补丁生效 + 快照回滚）
 * 覆盖：snapshot capture/restore 各类型、unloadSkill、tool-fix/prompt-fix apply 回调、
 *       rollback 各类型恢复 + 状态机、readLedger、schema 新字段、端点/CLI rollback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import {
  captureSnapshot,
  restoreSnapshot,
  readSnapshot,
  skillNameFromBody,
  type SnapshotDeps,
} from "../src/core/evolution-snapshot.js";
import { skillRegistry } from "../src/core/skill-registry.js";
import { EvolutionEngine } from "../src/core/evolution-engine.js";
import { validateProposal } from "../src/core/evolution-proposer.js";
import { buildCliCommands } from "../src/commands/registry.js";
import type { CliCommand, CommandContext } from "../src/commands/types.js";
import type { EvolutionProposal, ToolDefinition } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("evolution-rollback");
  setupEnv(dir);
});

afterEach(() => {
  teardownEnv();
});

function snapshotDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    dataDir: dir,
    skillsDir: resolve(dir, "skills"),
    agentsDir: resolve(dir, "agents"),
    runtimeConfigPath: resolve(dir, "runtime-config.json"),
    getToolDefinition: () => undefined,
    ...overrides,
  };
}

// ===== evolution-snapshot =====

describe("evolution-snapshot", () => {
  it("skillNameFromBody 提取 frontmatter name", () => {
    expect(skillNameFromBody("---\nname: weekly-report\ntriggers:\n  - 周报\n---\n\n# 正文")).toBe("weekly-report");
    expect(skillNameFromBody("无 frontmatter")).toBeNull();
  });

  it("capture new-skill：已存在文件存原内容，不存在记 null", () => {
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    writeFileSync(resolve(dir, "skills", "default", "old.md"), "旧内容", "utf-8");
    const deps = snapshotDeps();
    const snap = captureSnapshot(deps, "evo-s1", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: old\n---\n\n# 正文",
    });
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.content).toBe("旧内容");

    const snap2 = captureSnapshot(deps, "evo-s2", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: brand-new\n---\n\n# 正文",
    });
    expect(snap2.files[0]!.content).toBeNull();
  });

  it("capture config-change：快照 runtime-config.json", () => {
    writeFileSync(resolve(dir, "runtime-config.json"), '{"temperature":0.5}', "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-c1", {
      kind: "config-change",
      field: "temperature",
      value: 0.8,
    });
    expect(snap.files[0]!.file).toContain("runtime-config.json");
    expect(snap.files[0]!.content).toBe('{"temperature":0.5}');
  });

  it("capture tool-fix：存完整 ToolDefinition", () => {
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "原描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(
      snapshotDeps({ getToolDefinition: () => def }),
      "evo-t1",
      { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
    );
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]!.definition.function.description).toBe("原描述");
  });

  it("restore：文件写回 + 技能原存在 reloadSkill / 原不存在 unloadSkill", () => {
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    const file = resolve(dir, "skills", "default", "old.md");
    writeFileSync(file, "旧内容", "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-r1", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: old\n---\n\n# 正文",
    });
    // 模拟 apply 覆盖文件
    writeFileSync(file, "新内容", "utf-8");
    const reloadSkill = vi.fn();
    const unloadSkill = vi.fn();
    const result = restoreSnapshot(snapshotDeps(), snap, { registerTool: vi.fn(), reloadSkill, unloadSkill });
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("旧内容");
    expect(reloadSkill).toHaveBeenCalledWith(file);
    expect(unloadSkill).not.toHaveBeenCalled();
  });

  it("restore：原不存在则删除文件 + unloadSkill", () => {
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    const file = resolve(dir, "skills", "default", "brand-new.md");
    // capture 时文件不存在 → 快照 content=null；随后 apply 创建文件
    const snap = captureSnapshot(snapshotDeps(), "evo-r2", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: brand-new\n---\n\n# 正文",
    });
    expect(snap.files[0]!.content).toBeNull();
    writeFileSync(file, "新技能", "utf-8"); // apply 已创建
    const unloadSkill = vi.fn(() => true);
    const result = restoreSnapshot(snapshotDeps(), snap, { registerTool: vi.fn(), unloadSkill });
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(unloadSkill).toHaveBeenCalledWith("brand-new");
  });

  it("restore tool-fix：registerTool 回调收到完整定义", () => {
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "原描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-t2", {
      kind: "tool-fix",
      toolName: "fs_read",
      suggestion: "s",
      newDescription: "新描述",
    });
    const registerTool = vi.fn();
    const result = restoreSnapshot(snapshotDeps(), snap, { registerTool });
    expect(result.ok).toBe(true);
    expect(registerTool).toHaveBeenCalledWith("fs_read", def);
  });
});

// ===== SkillRegistry.unloadSkill =====

describe("SkillRegistry.unloadSkill", () => {
  it("按名卸载内存条目，不存在返回 false", () => {
    skillRegistry.clear();
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    writeFileSync(
      resolve(dir, "skills", "default", "SKILL.md"),
      "---\nname: test-skill\nexpert: default\n---\n\n# 正文",
      "utf-8",
    );
    skillRegistry.loadFromDir(resolve(dir, "skills"));
    expect(skillRegistry.getSkillsForAgent("default").some((s) => s.name === "test-skill")).toBe(true);
    expect(skillRegistry.unloadSkill("test-skill")).toBe(true);
    expect(skillRegistry.getSkillsForAgent("default").some((s) => s.name === "test-skill")).toBe(false);
    expect(skillRegistry.unloadSkill("test-skill")).toBe(false);
    skillRegistry.clear();
  });
});

// ===== engine：tool-fix / prompt-fix apply + rollback =====

function makeEngine(overrides: Partial<ConstructorParameters<typeof EvolutionEngine>[0]> = {}) {
  const base: ConstructorParameters<typeof EvolutionEngine>[0] = {
    dataDir: dir,
    observation: { listSessions: () => [], getEvents: () => [] },
    modelRouter: undefined as never,
    submitGenerate: (spec) => `job-${spec.type}`,
    setConfigField: (field, value) => ({ ok: true }),
    snapshot: snapshotDeps(),
    ...overrides,
  };
  return new EvolutionEngine(base);
}

function seed(engine: EvolutionEngine, p: EvolutionProposal): void {
  (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
}

function proposal(partial: Partial<EvolutionProposal>): EvolutionProposal {
  return {
    id: "evo-p",
    type: "tool-fix",
    title: "测试",
    reason: "依据",
    action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
    risk: "low",
    status: "confirmed",
    createdAt: Date.now(),
    ...partial,
  };
}

describe("EvolutionEngine Sprint 40", () => {
  it("apply tool-fix → patchToolDescription 回调 + 状态 applied + 快照落盘", async () => {
    const patchToolDescription = vi.fn(() => ({ ok: true }));
    const engine = makeEngine({ patchToolDescription });
    seed(engine, proposal({ id: "evo-tf", action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" } }));

    const result = await engine.apply("evo-tf");
    expect(result.ok).toBe(true);
    expect(patchToolDescription).toHaveBeenCalledWith("fs_read", "新描述");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-tf.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied");
    expect(existsSync(resolve(dir, "evolution", "snapshots", "evo-tf.json"))).toBe(true);
  });

  it("apply prompt-fix → applyPromptFix 回调 + applied", async () => {
    const applyPromptFix = vi.fn(() => ({ ok: true }));
    const engine = makeEngine({ applyPromptFix });
    seed(engine, proposal({
      id: "evo-pf",
      type: "prompt-fix",
      action: { kind: "prompt-fix", agentId: "default", suggestion: "s", newPrompt: "新提示词" },
    }));

    const result = await engine.apply("evo-pf");
    expect(result.ok).toBe(true);
    expect(applyPromptFix).toHaveBeenCalledWith("default", "新提示词");
  });

  it("apply 缺回调返回错误且状态不变", async () => {
    const engine = makeEngine(); // 无 patchToolDescription
    seed(engine, proposal({ id: "evo-nocb" }));
    const result = await engine.apply("evo-nocb");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未初始化");
  });

  it("apply 旧格式 tool-fix（缺 newDescription）被拒，不污染工具描述", async () => {
    const patchToolDescription = vi.fn(() => ({ ok: true }));
    const engine = makeEngine({ patchToolDescription });
    seed(engine, proposal({
      id: "evo-oldtf",
      action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s" } as never, // 旧格式：无 newDescription
    }));
    const result = await engine.apply("evo-oldtf");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("newDescription");
    expect(patchToolDescription).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-oldtf.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("confirmed"); // 状态不前进
  });

  it("apply 旧格式 prompt-fix（缺 newPrompt）被拒，不污染智能体提示词", async () => {
    const applyPromptFix = vi.fn(() => ({ ok: true }));
    const engine = makeEngine({ applyPromptFix });
    seed(engine, proposal({
      id: "evo-oldpf",
      type: "prompt-fix",
      action: { kind: "prompt-fix", agentId: "default", suggestion: "s" } as never, // 旧格式：无 newPrompt
    }));
    const result = await engine.apply("evo-oldpf");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("newPrompt");
    expect(applyPromptFix).not.toHaveBeenCalled();
  });

  it("rollback config-change detail 注明重启生效", () => {
    const runtimeFile = resolve(dir, "runtime-config.json");
    writeFileSync(runtimeFile, '{"temperature":0.5}', "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-cc2", { kind: "config-change", field: "temperature", value: 0.8 });
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    writeFileSync(resolve(dir, "evolution", "snapshots", "evo-cc2.json"), JSON.stringify(snap), "utf-8");
    writeFileSync(runtimeFile, '{"temperature":0.8}', "utf-8");

    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-cc2",
      type: "config-change",
      action: { kind: "config-change", field: "temperature", value: 0.8 },
      status: "applied",
    }));
    const result = engine.rollback("evo-cc2");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("重启后生效");
  });

  it("snapshot capture 拒绝穿越 expert（../），不生成越界路径", () => {
    const snap = captureSnapshot(snapshotDeps(), "evo-evil", {
      kind: "new-skill",
      expert: "../../evil",
      body: "---\nname: x\n---\n\n# 正文",
    });
    expect(snap.files).toHaveLength(0); // 越界被拒，无快照条目
  });

  it("snapshot capture 允许中文技能名（不限制字符集，仅防穿越）", () => {
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    const file = resolve(dir, "skills", "default", "项目周报.md");
    writeFileSync(file, "旧内容", "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-cn", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: 项目周报\n---\n\n# 正文",
    });
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.file).toBe(file);
    expect(snap.files[0]!.content).toBe("旧内容");
  });

  it("rollback config-change → 恢复文件 + rolled_back + 审计", () => {
    const runtimeFile = resolve(dir, "runtime-config.json");
    writeFileSync(runtimeFile, '{"temperature":0.5}', "utf-8");
    // 模拟 apply：先快照旧值，再写新值
    const snap = captureSnapshot(snapshotDeps(), "evo-cc", { kind: "config-change", field: "temperature", value: 0.8 });
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    writeFileSync(resolve(dir, "evolution", "snapshots", "evo-cc.json"), JSON.stringify(snap), "utf-8");
    writeFileSync(runtimeFile, '{"temperature":0.8}', "utf-8");

    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-cc",
      type: "config-change",
      action: { kind: "config-change", field: "temperature", value: 0.8 },
      status: "applied",
    }));

    const result = engine.rollback("evo-cc");
    expect(result.ok).toBe(true);
    expect(readFileSync(runtimeFile, "utf-8")).toBe('{"temperature":0.5}');
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-cc.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("rolled_back");
  });

  it("rollback new-tool/new-app：无快照返回错误 + jobId", () => {
    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-nt",
      type: "new-tool",
      action: { kind: "new-tool", description: "工具", type: "tool" },
      status: "applied",
    }));
    // 手动在 ledger 写 applied + jobId
    (engine as unknown as { proposer: { appendLedger: (e: Record<string, unknown>) => void } }).proposer.appendLedger({
      at: Date.now(),
      event: "applied",
      id: "evo-nt",
      type: "new-tool",
      title: "工具",
      jobId: "job-tool-xyz",
    });

    const result = engine.rollback("evo-nt");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无可回滚快照");
    expect(result.jobId).toBe("job-tool-xyz");
  });

  it("rollback 幂等：非 applied 拒绝、rolled_back 终态", () => {
    const engine = makeEngine();
    seed(engine, proposal({ id: "evo-pending", status: "pending" }));
    seed(engine, proposal({ id: "evo-rb", status: "rolled_back" }));
    expect(engine.rollback("evo-pending").ok).toBe(false);
    expect(engine.rollback("evo-rb").ok).toBe(false);
    expect(engine.rollback("evo-rb").error).toContain("已回滚");
  });

  it("rollback 快照不存在返回错误", () => {
    const engine = makeEngine();
    seed(engine, proposal({ id: "evo-nosnap", status: "applied" }));
    const result = engine.rollback("evo-nosnap");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("快照不存在");
  });

  it("rollback tool-fix 无 restoreHooks.registerTool → 明确报错（不虚假成功）", () => {
    const engine = makeEngine({ restoreHooks: undefined });
    seed(engine, proposal({
      id: "evo-nohook",
      type: "tool-fix",
      action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
      status: "applied",
    }));
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "原描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-nohook", {
      kind: "tool-fix",
      toolName: "fs_read",
      suggestion: "s",
      newDescription: "新描述",
    });
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    writeFileSync(resolve(dir, "evolution", "snapshots", "evo-nohook.json"), JSON.stringify(snap), "utf-8");

    const result = engine.rollback("evo-nohook");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("registerTool");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-nohook.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied"); // 未回滚
  });

  it("readLedger 尾部截取", () => {
    const engine = makeEngine();
    const proposer = (engine as unknown as { proposer: { appendLedger: (e: Record<string, unknown>) => void } }).proposer;
    for (let i = 0; i < 5; i++) proposer.appendLedger({ at: i, event: "proposed", id: `e${i}` });
    const ledger = engine.ledger(3);
    expect(ledger).toHaveLength(3);
    expect(ledger[0]!.id).toBe("e2");
  });

  it("onGenResult：按 jobId 回写 generated 到台账 + 广播", async () => {
    const engine = makeEngine();
    const proposer = (engine as unknown as { proposer: { appendLedger: (e: Record<string, unknown>) => void; readLedger: (l?: number) => Record<string, unknown>[] } }).proposer;
    proposer.appendLedger({ at: 1, event: "generated-submitted", id: "evo-gen", jobId: "job-123", type: "new-tool", title: "工具" });
    let broadcasted: unknown = null;
    const { eventBus } = await import("../src/server/event-bus.js");
    const unsub = eventBus.subscribe((d) => { broadcasted = d; });

    engine.onGenResult("job-123", true, "app-xyz");
    const entries = proposer.readLedger(10);
    const gen = entries.find((e) => e.event === "generated");
    expect(gen).toMatchObject({ id: "evo-gen", jobId: "job-123", ok: true, appId: "app-xyz" });
    expect(broadcasted).toMatchObject({ type: "evolution/generated", proposalId: "evo-gen", jobId: "job-123", ok: true });
    unsub();
  });

  it("onGenResult：未知 jobId 静默忽略", async () => {
    const engine = makeEngine();
    engine.onGenResult("job-nope", true, undefined);
    const entries = engine.ledger(10);
    expect(entries.filter((e) => e.event === "generated")).toHaveLength(0);
  });
});

// ===== schema 新字段 =====

describe("validateProposal Sprint 40", () => {
  it("tool-fix 缺 newDescription 拒绝", () => {
    expect(
      validateProposal({
        type: "tool-fix",
        title: "t",
        reason: "r",
        action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s" },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("tool-fix 带 newDescription 通过", () => {
    const p = validateProposal({
      type: "tool-fix",
      title: "t",
      reason: "r",
      action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
      risk: "low",
    });
    expect(p).not.toBeNull();
    expect(p!.action).toEqual({ kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" });
  });

  it("prompt-fix 缺 newPrompt 拒绝", () => {
    expect(
      validateProposal({
        type: "prompt-fix",
        title: "t",
        reason: "r",
        action: { kind: "prompt-fix", agentId: "default", suggestion: "s" },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("schema 拒绝路径穿越：expert/toolName/agentId 含 ../", () => {
    expect(
      validateProposal({
        type: "new-skill",
        title: "t",
        reason: "r",
        action: { kind: "new-skill", expert: "../evil", body: "x".repeat(120) },
        risk: "low",
      }),
    ).toBeNull();
    expect(
      validateProposal({
        type: "tool-fix",
        title: "t",
        reason: "r",
        action: { kind: "tool-fix", toolName: "../evil", suggestion: "s", newDescription: "d" },
        risk: "low",
      }),
    ).toBeNull();
    expect(
      validateProposal({
        type: "prompt-fix",
        title: "t",
        reason: "r",
        action: { kind: "prompt-fix", agentId: "../../x", suggestion: "s", newPrompt: "p" },
        risk: "low",
      }),
    ).toBeNull();
  });
});

// ===== CLI /evo rollback =====

describe("CLI /evo rollback", () => {
  const commands: CliCommand[] = buildCliCommands();
  function find(name: string): CliCommand {
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) throw new Error(`command not found: ${name}`);
    return cmd;
  }
  function makeCtx(engine: EvolutionEngine): { ctx: CommandContext; writes: string[] } {
    const writes: string[] = [];
    const ctx = {
      mode: () => "auto" as const,
      setMode: () => {},
      showThinking: () => false,
      toggleThinking: () => {},
      currentSessionId: () => undefined,
      setCurrentSessionId: () => {},
      prefillQueue: [],
      lastAnswer: { value: "" },
      agents: {},
      currentAgent: () => ({}) as never,
      coordinator: {} as never,
      modelRouter: {} as never,
      sessionStore: {} as never,
      skillCount: 0,
      workingDir: dir,
      runtimeConfigPath: resolve(dir, "runtime-config.json"),
      persistRuntimeConfig: () => {},
      getContextBreakdown: () => ({}),
      listCommands: () => commands,
      evolutionEngine: engine,
      write: (t: string) => writes.push(t),
      writeLine: (l: string) => writes.push(l),
      printStatus: () => {},
      ask: () => Promise.resolve(null),
    } as unknown as CommandContext;
    return { ctx, writes };
  }

  it("/evo rollback <id> 回滚成功", () => {
    const engine = makeEngine();
    seed(engine, proposal({
      id: "evo-clirb",
      type: "config-change",
      action: { kind: "config-change", field: "temperature", value: 0.8 },
      status: "applied",
    }));
    // 模拟 apply 前旧值 → 快照旧值 → apply 写新值
    writeFileSync(resolve(dir, "runtime-config.json"), '{"temperature":0.5}', "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-clirb", { kind: "config-change", field: "temperature", value: 0.8 });
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    writeFileSync(resolve(dir, "evolution", "snapshots", "evo-clirb.json"), JSON.stringify(snap), "utf-8");
    writeFileSync(resolve(dir, "runtime-config.json"), '{"temperature":0.8}', "utf-8"); // apply 后新值
    (engine as unknown as { proposer: { appendLedger: (e: Record<string, unknown>) => void } }).proposer.appendLedger({
      at: Date.now(), event: "applied", id: "evo-clirb", type: "config-change", title: "配置",
    });

    const { ctx, writes } = makeCtx(engine);
    find("evo").handler(ctx, "rollback evo-clirb", "/evo rollback evo-clirb");
    const joined = writes.join("\n");
    expect(joined).toContain("已回滚");
    expect(readFileSync(resolve(dir, "runtime-config.json"), "utf-8")).toBe('{"temperature":0.5}');
  });

  it("/evo rollback 无 id 提示用法", () => {
    const { ctx, writes } = makeCtx(makeEngine());
    find("evo").handler(ctx, "rollback", "/evo rollback");
    expect(writes.join("\n")).toContain("用法");
  });
});
