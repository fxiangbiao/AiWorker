/**
 * 进化变更对比单测（Sprint 40 补：前后对比展示）
 * 覆盖：diffLines LCS、四类 before/after 提取、buildChangeView、engine.change、CLI /evo diff
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { diffLines, extractBefore, extractAfter, buildChangeView } from "../src/core/evolution-diff.js";
import { captureSnapshot, type SnapshotDeps } from "../src/core/evolution-snapshot.js";
import { EvolutionEngine } from "../src/core/evolution-engine.js";
import { buildCliCommands } from "../src/commands/registry.js";
import type { CliCommand, CommandContext } from "../src/commands/types.js";
import type { EvolutionProposal, ToolDefinition } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("evolution-diff");
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

// ===== diffLines =====

describe("diffLines", () => {
  it("完全相同的文本只有 same 行", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(lines.every((l) => l.type === "same")).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("新增行标记 add，删除行标记 del", () => {
    const lines = diffLines("a\nb", "a\nb\nc");
    const adds = lines.filter((l) => l.type === "add");
    expect(adds).toEqual([{ type: "add", text: "c" }]);
  });

  it("混合变更：删除+新增", () => {
    const lines = diffLines("第一行\n旧行\n第三行", "第一行\n新行\n第三行");
    expect(lines.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["旧行"]);
    expect(lines.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["新行"]);
  });

  it("diffLines 参数防御：undefined 不崩溃", () => {
    const lines = diffLines(undefined, undefined);
    expect(lines.every((l) => l.type === "same")).toBe(true); // 空串 → 空行，不崩溃
    const l2 = diffLines("旧", undefined);
    expect(l2.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["旧"]);
  });
});

// ===== extractBefore / extractAfter =====

describe("extractBefore/After", () => {
  it("tool-fix：before=快照原描述，after=newDescription", () => {
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "读取文件内容。", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-t", {
      kind: "tool-fix",
      toolName: "fs_read",
      suggestion: "s",
      newDescription: "读取文件内容，若不存在返回明确错误。",
    });
    const action = { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "读取文件内容，若不存在返回明确错误。" } as const;
    expect(extractBefore(snap, action)).toBe("读取文件内容。");
    expect(extractAfter(action)).toBe("读取文件内容，若不存在返回明确错误。");
  });

  it("config-change：before=快照 runtime-config 对应字段，after=新值", () => {
    writeFileSync(resolve(dir, "runtime-config.json"), '{"temperature":0.5}', "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-c", { kind: "config-change", field: "temperature", value: 0.8 });
    const action = { kind: "config-change", field: "temperature", value: 0.8 } as const;
    expect(extractBefore(snap, action)).toBe("0.5");
    expect(extractAfter(action)).toContain('"temperature": 0.8');
  });

  it("prompt-fix：before=快照 YAML 的 systemPrompt，after=newPrompt", () => {
    mkdirSync(resolve(dir, "agents"), { recursive: true });
    writeFileSync(
      resolve(dir, "agents", "default.yaml"),
      "id: default\nsystemPrompt: |\n  你是通用助手。\n  第一条规则。\n",
      "utf-8",
    );
    const snap = captureSnapshot(snapshotDeps(), "evo-p", { kind: "prompt-fix", agentId: "default", suggestion: "s", newPrompt: "你是通用助手。" });
    const action = { kind: "prompt-fix", agentId: "default", suggestion: "s", newPrompt: "你是通用助手。" } as const;
    expect(extractBefore(snap, action)).toContain("你是通用助手。");
    expect(extractAfter(action)).toBe("你是通用助手。");
  });

  it("new-skill：before=原技能文件（无则 undefined），after=body", () => {
    mkdirSync(resolve(dir, "skills", "default"), { recursive: true });
    writeFileSync(resolve(dir, "skills", "default", "old.md"), "旧技能", "utf-8");
    const snap = captureSnapshot(snapshotDeps(), "evo-n", {
      kind: "new-skill",
      expert: "default",
      body: "---\nname: old\n---\n\n# 新正文",
    });
    const action = { kind: "new-skill", expert: "default", body: "---\nname: old\n---\n\n# 新正文" } as const;
    expect(extractBefore(snap, action)).toBe("旧技能");
    expect(extractAfter(action)).toContain("# 新正文");
  });

  it("new-tool/new-app：无 before，after=描述", () => {
    const action = { kind: "new-tool", description: "自动生成周报", type: "tool" } as const;
    expect(extractBefore(null, action)).toBeUndefined();
    expect(extractAfter(action)).toContain("自动生成周报");
  });
});

// ===== buildChangeView =====

describe("buildChangeView", () => {
  it("纯新增：全部 add 行", () => {
    const p: EvolutionProposal = {
      id: "evo-x",
      type: "new-tool",
      title: "工具",
      reason: "r",
      action: { kind: "new-tool", description: "周报工具", type: "tool" },
      risk: "low",
      status: "applied",
      createdAt: 1,
    };
    const view = buildChangeView(p, null);
    expect(view.before).toBeUndefined();
    expect(view.lines.every((l) => l.type === "add")).toBe(true);
  });

  it("修改类：含 del + add 行", () => {
    const p: EvolutionProposal = {
      id: "evo-y",
      type: "tool-fix",
      title: "修复",
      reason: "r",
      action: { kind: "tool-fix", toolName: "fs_read", suggestion: "s", newDescription: "新描述" },
      risk: "low",
      status: "applied",
      createdAt: 1,
    };
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "旧描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-y", p.action);
    const view = buildChangeView(p, snap);
    expect(view.before).toBe("旧描述");
    expect(view.lines.some((l) => l.type === "del")).toBe(true);
    expect(view.lines.some((l) => l.type === "add")).toBe(true);
  });
});

// ===== engine.change =====

function makeEngine(): EvolutionEngine {
  return new EvolutionEngine({
    dataDir: dir,
    observation: { listSessions: () => [], getEvents: () => [] },
    modelRouter: undefined as never,
    snapshot: snapshotDeps(),
  });
}

describe("EvolutionEngine.change", () => {
  it("返回 ChangeView（有快照时含 before）", () => {
    const engine = makeEngine();
    const p: EvolutionProposal = {
      id: "evo-chg",
      type: "tool-fix",
      title: "修复",
      reason: "r",
      action: { kind: "tool-fix", toolName: "now", suggestion: "s", newDescription: "新描述" },
      risk: "low",
      status: "applied",
      createdAt: 1,
    };
    (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
    const def: ToolDefinition = {
      type: "function",
      function: { name: "now", description: "旧描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-chg", p.action);
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    const fs = require("node:fs");
    fs.writeFileSync(resolve(dir, "evolution", "snapshots", "evo-chg.json"), JSON.stringify(snap), "utf-8");

    const result = engine.change("evo-chg");
    expect(result.ok).toBe(true);
    expect(result.view!.before).toBe("旧描述");
    expect(result.view!.after).toBe("新描述");
  });

  it("无快照（new-tool）也返回视图（纯新增）", () => {
    const engine = makeEngine();
    const p: EvolutionProposal = {
      id: "evo-nt2",
      type: "new-tool",
      title: "工具",
      reason: "r",
      action: { kind: "new-tool", description: "周报工具", type: "tool" },
      risk: "low",
      status: "applied",
      createdAt: 1,
    };
    (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
    const result = engine.change("evo-nt2");
    expect(result.ok).toBe(true);
    expect(result.view!.before).toBeUndefined();
  });

  it("提案不存在返回错误", () => {
    const engine = makeEngine();
    const result = engine.change("evo-missing");
    expect(result.ok).toBe(false);
  });

  it("旧格式 tool-fix（无 newDescription）+ 快照存在 → 不崩溃，after 有兜底", () => {
    const engine = makeEngine();
    const p = {
      id: "evo-legacy",
      type: "tool-fix",
      title: "修复 fs_read",
      reason: "r",
      action: { kind: "tool-fix", toolName: "fs_read", suggestion: "读取前先检查存在性" }, // 旧格式：无 newDescription
      risk: "low",
      status: "applied",
      createdAt: 1,
    } as unknown as EvolutionProposal;
    (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
    const def: ToolDefinition = {
      type: "function",
      function: { name: "fs_read", description: "读取文件内容。", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-legacy", p.action as never);
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    const fs = require("node:fs");
    fs.writeFileSync(resolve(dir, "evolution", "snapshots", "evo-legacy.json"), JSON.stringify(snap), "utf-8");

    const result = engine.change("evo-legacy");
    expect(result.ok).toBe(true);
    expect(result.view!.before).toBe("读取文件内容。");
    expect(result.view!.after).toContain("旧格式提案无新描述");
    expect(result.view!.lines.length).toBeGreaterThan(0);
  });
});

// ===== CLI /evo diff =====

describe("CLI /evo diff", () => {
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

  it("/evo diff <id> 输出变更对比（含修改前/后）", async () => {
    const engine = makeEngine();
    const p: EvolutionProposal = {
      id: "evo-clidiff",
      type: "tool-fix",
      title: "修复 now",
      reason: "r",
      action: { kind: "tool-fix", toolName: "now", suggestion: "s", newDescription: "新描述" },
      risk: "low",
      status: "applied",
      createdAt: 1,
    };
    (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer.save(p);
    const def: ToolDefinition = {
      type: "function",
      function: { name: "now", description: "旧描述", parameters: { type: "object", properties: {} } },
    };
    const snap = captureSnapshot(snapshotDeps({ getToolDefinition: () => def }), "evo-clidiff", p.action);
    mkdirSync(resolve(dir, "evolution", "snapshots"), { recursive: true });
    const fs = require("node:fs");
    fs.writeFileSync(resolve(dir, "evolution", "snapshots", "evo-clidiff.json"), JSON.stringify(snap), "utf-8");

    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "diff evo-clidiff", "/evo diff evo-clidiff");
    const joined = writes.join("\n");
    expect(joined).toContain("变更对比");
    expect(joined).toContain("修改前");
    expect(joined).toContain("旧描述");
    expect(joined).toContain("新描述");
  });

  it("/evo diff 无 id 提示用法", async () => {
    const { ctx, writes } = makeCtx(makeEngine());
    await find("evo").handler(ctx, "diff", "/evo diff");
    expect(writes.join("\n")).toContain("用法");
  });
});
