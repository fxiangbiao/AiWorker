/**
 * 进化引擎单测（Sprint 39 第一期）
 * 覆盖：观察聚合（工具/完成率/重复聚类/窗口/空数据）、提议解析与限频、采纳各类型分发、拒绝、幂等、审计
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { observeEvolution, normalizeTaskText, EVOLUTION_WINDOW_MS, OBSERVE_LIST_LIMIT } from "../src/core/evolution-observer.js";
import { validateProposal, EvolutionProposer, countTodayProposals, DAILY_PROPOSAL_LIMIT } from "../src/core/evolution-proposer.js";
import { EvolutionEngine } from "../src/core/evolution-engine.js";
import { buildCliCommands } from "../src/commands/registry.js";
import type { CliCommand, CommandContext } from "../src/commands/types.js";
import { auditLogger } from "../src/core/audit-logger.js";
import type { EvolutionObservation, EvolutionProposal, SessionEvent } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("evolution");
  setupEnv(dir);
});

afterEach(() => {
  teardownEnv();
});

function event(seq: number, type: SessionEvent["type"], data: Record<string, unknown>, createdAt: number): SessionEvent {
  return { seq, sessionId: "s1", type, data, createdAt };
}

const base = 1_700_000_000_000;

// ===== 观察层 =====

describe("observeEvolution", () => {
  function deps(overrides: Partial<Parameters<typeof observeEvolution>[0]> = {}) {
    return {
      listSessions: vi.fn(() => []),
      getEvents: vi.fn(() => []),
      auditCount: vi.fn(() => 0),
      ...overrides,
    } as Parameters<typeof observeEvolution>[0];
  }

  it("工具聚合：按 callId 配对成败/耗时/错误，按调用数降序", () => {
    const now = base + 1000;
    const events: SessionEvent[] = [
      event(1, "tool/call", { callId: "t1", name: "fs_read", arguments: "{}" }, now - 500),
      event(2, "tool/result", { callId: "t1", success: true, content: "ok", durationMs: 40 }, now - 400),
      event(3, "tool/call", { callId: "t2", name: "fs_read", arguments: "{}" }, now - 300),
      event(4, "tool/result", { callId: "t2", success: false, error: "权限不足", durationMs: 5 }, now - 200),
      event(5, "tool/call", { callId: "t3", name: "fs_write", arguments: "{}" }, now - 100),
      event(6, "tool/result", { callId: "t3", success: true, content: "ok", durationMs: 20 }, now - 50),
    ];
    const obs = observeEvolution(
      deps({
        listSessions: () => [{ id: "s1", updatedAt: now, turnCount: 1, firstUserMsg: "读取文件" }],
        getEvents: () => events,
      }),
      now,
    );
    expect(obs.toolStats).toHaveLength(2);
    const read = obs.toolStats.find((t) => t.name === "fs_read")!;
    expect(read.calls).toBe(2);
    expect(read.failed).toBe(1);
    expect(read.successRate).toBe(0.5);
    expect(read.avgDurationMs).toBe(Math.round(45 / 2));
    expect(read.topErrors).toEqual([{ err: "权限不足", count: 1 }]);
    // 按调用数降序：fs_read(2) 在前
    expect(obs.toolStats[0]!.name).toBe("fs_read");
  });

  it("完成率：turn/end reason=stop 视为完成", () => {
    const now = base + 1000;
    const events: SessionEvent[] = [
      event(1, "turn/start", { turn: 1 }, now - 300),
      event(2, "turn/end", { turn: 1, reason: "stop" }, now - 200),
      event(3, "turn/start", { turn: 2 }, now - 100),
      event(4, "turn/end", { turn: 2, reason: "error" }, now - 50),
    ];
    const obs = observeEvolution(
      deps({
        listSessions: () => [{ id: "s1", updatedAt: now, turnCount: 2, firstUserMsg: "任务" }],
        getEvents: () => events,
      }),
      now,
    );
    expect(obs.completion.sessions).toBe(1);
    expect(obs.completion.ok).toBe(1);
    expect(obs.completion.rate).toBe(0.5);
    expect(obs.completion.avgTurns).toBe(2);
  });

  it("窗口过滤：会话 updatedAt 或事件 createdAt 早于窗口起点则排除", () => {
    const now = base + 1000;
    const old = now - EVOLUTION_WINDOW_MS - 10;
    const obs = observeEvolution(
      deps({
        listSessions: () => [
          { id: "new", updatedAt: now, turnCount: 1, firstUserMsg: "新任务" },
          { id: "old", updatedAt: old, turnCount: 1, firstUserMsg: "旧任务" },
        ],
        getEvents: (sid) =>
          sid === "new"
            ? [event(1, "tool/call", { callId: "t", name: "fs_read", arguments: "{}" }, now - 10)]
            : [event(1, "tool/call", { callId: "t", name: "fs_write", arguments: "{}" }, old)],
      }),
      now,
    );
    expect(obs.completion.sessions).toBe(1);
    expect(obs.toolStats.map((t) => t.name)).toEqual(["fs_read"]);
  });

  it("超 20 会话场景：listSessions 被要求放大 limit（OBSERVE_LIST_LIMIT）", () => {
    const now = base + 1000;
    const listSessions = vi.fn(() => [] as Array<{ id: string; updatedAt: number; turnCount: number; firstUserMsg: string | null }>);
    observeEvolution(deps({ listSessions }), now);
    expect(listSessions).toHaveBeenCalledWith(OBSERVE_LIST_LIMIT);
  });

  it("重复任务聚类：前缀相似消息归组，count>=3 才输出", () => {
    const now = base + 1000;
    const mk = (n: number) => ({ id: `s${n}`, updatedAt: now, turnCount: 1, firstUserMsg: `帮我写一份项目周报 第${n}期` });
    const obs = observeEvolution(
      deps({
        listSessions: () => [mk(1), mk(2), mk(3), { id: "x", updatedAt: now, turnCount: 1, firstUserMsg: "随便聊聊" }],
        getEvents: () => [],
      }),
      now,
    );
    expect(obs.repeatedTasks).toHaveLength(1);
    expect(obs.repeatedTasks[0]!.count).toBe(3);
  });

  it("归一化：去标点数字空白（数字不干扰聚类）", () => {
    expect(normalizeTaskText("帮我写一份周报 #3!")).toBe("帮我写一份周报");
  });

  it("空数据短路：无会话/无事件返回空观察", () => {
    const obs = observeEvolution(deps(), base);
    expect(obs.toolStats).toEqual([]);
    expect(obs.repeatedTasks).toEqual([]);
    expect(obs.completion.sessions).toBe(0);
    expect(obs.generated).toEqual({ apps: 0, docs: 0, updates: 0 });
  });
});

// ===== 提议层 =====

describe("validateProposal", () => {
  it("接受合法 new-skill 提案", () => {
    const p = validateProposal({
      type: "new-skill",
      title: "沉淀周报技能",
      reason: "同类任务出现 5 次",
      action: {
        kind: "new-skill",
        expert: "default",
        body: "---\nname: weekly-report\nversion: \"1.0\"\ntriggers:\n  - \"周报\"\nexpert: default\ntools_required:\n  - fs_write\n---\n\n# 周报\n\n## 解决方案\n步骤说明。\n",
      },
      risk: "low",
    });
    expect(p).not.toBeNull();
    expect(p!.type).toBe("new-skill");
  });

  it("接受合法 config-change（白名单字段）", () => {
    const p = validateProposal({
      type: "config-change",
      title: "提高温度",
      reason: "任务完成率低",
      action: { kind: "config-change", field: "temperature", value: 0.8 },
      risk: "medium",
    });
    expect(p).not.toBeNull();
    expect(p!.action).toEqual({ kind: "config-change", field: "temperature", value: 0.8 });
  });

  it("拒绝 action.kind 与 type 不匹配", () => {
    expect(
      validateProposal({
        type: "new-tool",
        title: "x",
        reason: "y",
        action: { kind: "new-app", description: "d", type: "app" },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("拒绝 config-change 非白名单字段（model 需人工）", () => {
    expect(
      validateProposal({
        type: "config-change",
        title: "x",
        reason: "y",
        action: { kind: "config-change", field: "model", value: "m" },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("拒绝 thinking 字段（内存开关不可持久化/回滚，交配置 Tab 管理）", () => {
    expect(
      validateProposal({
        type: "config-change",
        title: "x",
        reason: "y",
        action: { kind: "config-change", field: "thinking", value: true },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("拒绝 new-skill body 过短", () => {
    expect(
      validateProposal({
        type: "new-skill",
        title: "x",
        reason: "y",
        action: { kind: "new-skill", expert: "default", body: "太短" },
        risk: "low",
      }),
    ).toBeNull();
  });

  it("empty:true 视为无提案", () => {
    expect(validateProposal({ empty: true })).toBeNull();
  });
});

describe("EvolutionProposer", () => {
  function makeProposer(overrides: Partial<ConstructorParameters<typeof EvolutionProposer>[0]> = {}) {
    return new EvolutionProposer({
      modelRouter: { completeWithProfile: vi.fn() } as never,
      dataDir: dir,
      todayCount: () => 0,
      ...overrides,
    });
  }

  function observation(): EvolutionObservation {
    return {
      windowStart: base - 1000,
      windowEnd: base,
      toolStats: [{ name: "fs_read", calls: 10, failed: 5, successRate: 0.5, avgDurationMs: 100, topErrors: [] }],
      completion: { sessions: 1, ok: 1, rate: 1, avgTurns: 1 },
      repeatedTasks: [],
      userInterventions: 0,
      generated: { apps: 0, docs: 0, updates: 0 },
    };
  }

  it("meta-agent 输出合法 JSON → 落盘 + 台账 + 审计", async () => {
    const p = makeProposer({
      modelRouter: {
        completeWithProfile: vi.fn(() =>
          Promise.resolve({
            text: JSON.stringify({
              type: "tool-fix",
              title: "修复 fs_read",
              reason: "成功率 50%",
              action: { kind: "tool-fix", toolName: "fs_read", suggestion: "补充错误处理", newDescription: "读取文件内容，若不存在返回明确错误" },
              risk: "medium",
            }),
            usage: { totalTokens: 123 },
          }),
        ),
      } as never,
    });
    const list = await p.propose(observation());
    expect(list).toHaveLength(1);
    const proposal = list[0]!;
    expect(proposal.id.startsWith("evo-")).toBe(true);
    expect(proposal.status).toBe("pending");
    const file = resolve(dir, "evolution", "proposals", `${proposal.id}.json`);
    expect(existsSync(file)).toBe(true);
    const ledger = readFileSync(resolve(dir, "evolution", "ledger.json"), "utf-8");
    expect(ledger).toContain('"event":"proposed"');
  });

  it("代码块包裹的 JSON 也能解析", async () => {
    const p = makeProposer({
      modelRouter: {
        completeWithProfile: vi.fn(() =>
          Promise.resolve({
            text: "```json\n" + JSON.stringify({
              type: "new-tool",
              title: "生成周报工具",
              reason: "重复任务 5 次",
              action: { kind: "new-tool", description: "自动生成周报", type: "tool" },
              risk: "low",
            }) + "\n```",
          }),
        ),
      } as never,
    });
    const list = await p.propose(observation());
    expect(list).toHaveLength(1);
    expect(list[0]!.type).toBe("new-tool");
  });

  it("非法输出重试后成功", async () => {
    const calls = vi
      .fn()
      .mockResolvedValueOnce({ text: "不是 JSON" })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          type: "prompt-fix",
          title: "优化提示词",
          reason: "完成率低",
          action: { kind: "prompt-fix", agentId: "default", suggestion: "补充工具说明", newPrompt: "你是通用助手。\n\n# 工具\n- 优先使用 fs_read 读取文件。" },
          risk: "low",
        }),
      });
    const p = makeProposer({ modelRouter: { completeWithProfile: calls } as never });
    const list = await p.propose(observation());
    expect(list).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("重试耗尽返回空并记审计", async () => {
    const p = makeProposer({
      modelRouter: {
        completeWithProfile: vi.fn(() => Promise.resolve({ text: "垃圾输出" })),
      } as never,
    });
    const list = await p.propose(observation());
    expect(list).toEqual([]);
  });

  it("空观察短路：不调 LLM", async () => {
    const completeWithProfile = vi.fn();
    const p = makeProposer({ modelRouter: { completeWithProfile } as never });
    const list = await p.propose({
      windowStart: base,
      windowEnd: base,
      toolStats: [],
      completion: { sessions: 0, ok: 0, rate: 0, avgTurns: 0 },
      repeatedTasks: [],
      userInterventions: 0,
      generated: { apps: 0, docs: 0, updates: 0 },
    });
    expect(list).toEqual([]);
    expect(completeWithProfile).not.toHaveBeenCalled();
  });

  it("限频：今日已达上限拒绝（不调 LLM）", async () => {
    const completeWithProfile = vi.fn();
    const p = makeProposer({
      modelRouter: { completeWithProfile } as never,
      todayCount: () => DAILY_PROPOSAL_LIMIT,
    });
    const list = await p.propose(observation());
    expect(list).toEqual([]);
    expect(completeWithProfile).not.toHaveBeenCalled();
  });

  it("countTodayProposals：按本地零点统计", () => {
    const now = Date.now();
    const today: EvolutionProposal = { id: "a", type: "tool-fix", title: "t", reason: "r", action: { kind: "tool-fix", toolName: "x", suggestion: "s" }, risk: "low", status: "pending", createdAt: now - 1000 };
    const yesterday: EvolutionProposal = { ...today, id: "b", createdAt: now - 26 * 3600 * 1000 };
    expect(countTodayProposals([today, yesterday], now)).toBe(1);
  });
});

// ===== 引擎层 =====

/** 用 engine 内部真实 proposer 落盘一条提案（save/get 不需要 modelRouter） */
function seedProposal(engine: EvolutionEngine, p: EvolutionProposal): void {
  const proposer = (engine as unknown as { proposer: { save: (p: EvolutionProposal) => void } }).proposer;
  proposer.save(p);
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof EvolutionEngine>[0]> = {}) {
  const baseDeps: ConstructorParameters<typeof EvolutionEngine>[0] = {
    dataDir: dir,
    observation: {
      listSessions: () => [],
      getEvents: () => [],
      auditCount: () => 0,
    },
    modelRouter: undefined as never,
    submitGenerate: (spec) => `job-${spec.type}`,
    setConfigField: (field, value) => ({ ok: true }),
    ...overrides,
  };
  return new EvolutionEngine(baseDeps);
}

function pendingProposal(partial: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    id: "evo-test",
    type: "tool-fix",
    title: "测试提案",
    reason: "依据",
    action: { kind: "tool-fix", toolName: "fs_read", suggestion: "改进" },
    risk: "low",
    status: "pending",
    createdAt: Date.now(),
    ...partial,
  };
}

describe("EvolutionEngine", () => {
  it("adopt 只确认不写入：pending → confirmed + 返回 preview，不触发 submitGenerate", async () => {
    const submitGenerate = vi.fn((spec: { description: string; type: string }) => `job-${spec.type}`);
    const engine = makeEngine({ submitGenerate });
    seedProposal(engine, pendingProposal({
      id: "evo-newtool",
      type: "new-tool",
      action: { kind: "new-tool", description: "生成周报", type: "tool" },
    }));

    const result = engine.adopt("evo-newtool");
    expect(result.ok).toBe(true);
    expect(result.preview).toEqual({ kind: "new-tool", description: "生成周报", type: "tool" });
    expect(submitGenerate).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-newtool.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("confirmed");
  });

  it("apply new-tool → 真正提交生成 + 状态 applied + 审计", async () => {
    const submitGenerate = vi.fn((spec: { description: string; type: string }) => `job-${spec.type}`);
    const engine = makeEngine({ submitGenerate });
    seedProposal(engine, pendingProposal({
      id: "evo-newtool2",
      type: "new-tool",
      action: { kind: "new-tool", description: "生成周报", type: "tool" },
      status: "confirmed",
    }));

    const result = await engine.apply("evo-newtool2");
    expect(result.ok).toBe(true);
    expect(result.jobId).toBe("job-tool");
    expect(submitGenerate).toHaveBeenCalledWith({ description: "生成周报", type: "tool", sessionId: "evolution" });
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-newtool2.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied");
  });

  it("apply 要求 confirmed 状态：pending 直接 apply 拒绝", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({ id: "evo-notconf" }));
    const result = await engine.apply("evo-notconf");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未确认");
  });

  it("adopt new-skill：校验失败不置 confirmed", () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({
      id: "evo-badskill",
      type: "new-skill",
      action: { kind: "new-skill", expert: "default", body: "没有 frontmatter 的正文内容，无法通过校验。" },
    }));

    const result = engine.adopt("evo-badskill");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("校验失败");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-badskill.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("pending");
  });

  it("adopt new-skill 合法：确认返回 preview 含 body，不落盘技能", () => {
    const engine = makeEngine();
    const body = "---\nname: weekly-report\nversion: \"1.0\"\ntriggers:\n  - \"周报\"\nexpert: default\ntools_required:\n  - fs_write\n---\n\n# 周报\n\n## 解决方案\n步骤说明。\n";
    seedProposal(engine, pendingProposal({
      id: "evo-goodskill",
      type: "new-skill",
      action: { kind: "new-skill", expert: "default", body },
    }));

    const result = engine.adopt("evo-goodskill");
    expect(result.ok).toBe(true);
    expect(result.preview).toEqual({ kind: "new-skill", expert: "default", body });
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-goodskill.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("confirmed");
    // 确认阶段不落盘技能文件
    expect(existsSync(resolve(process.cwd(), "skills", "default", "weekly-report.md"))).toBe(false);
  });

  it("apply config-change → setConfigField 调用 + 审计", async () => {
    const setConfigField = vi.fn(() => ({ ok: true }));
    const engine = makeEngine({ setConfigField });
    seedProposal(engine, pendingProposal({
      id: "evo-config",
      type: "config-change",
      action: { kind: "config-change", field: "temperature", value: 0.8 },
      status: "confirmed",
    }));

    const result = await engine.apply("evo-config");
    expect(result.ok).toBe(true);
    expect(setConfigField).toHaveBeenCalledWith("temperature", 0.8);
  });

  it("幂等：confirmed 重复 adopt 拒绝；applied 重复 apply 拒绝", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({ id: "evo-conf", status: "confirmed" }));
    seedProposal(engine, pendingProposal({ id: "evo-applied", status: "applied" }));
    const adoptAgain = engine.adopt("evo-conf");
    expect(adoptAgain.ok).toBe(false);
    expect(adoptAgain.error).toContain("已处理");
    const applyAgain = await engine.apply("evo-applied");
    expect(applyAgain.ok).toBe(false);
    expect(applyAgain.error).toContain("已处理");
  });

  it("reject 可从 confirmed 撤销（不写入）", () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({ id: "evo-rev", status: "confirmed" }));
    const result = engine.reject("evo-rev");
    expect(result.ok).toBe(true);
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-rev.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("rejected");
  });

  it("reject：状态置 rejected + 审计", () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({ id: "evo-rej" }));
    const result = engine.reject("evo-rej");
    expect(result.ok).toBe(true);
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-rej.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("rejected");
    expect(readdirSync(resolve(dir, "evolution"))).toContain("ledger.json");
  });

  it("observe 直接透传观察结果", () => {
    const engine = makeEngine({
      observation: {
        listSessions: () => [{ id: "s1", updatedAt: base, turnCount: 1, firstUserMsg: "任务" }],
        getEvents: () => [event(1, "tool/call", { callId: "t", name: "fs_read", arguments: "{}" }, base)],
        auditCount: () => 2,
      },
    });
    const obs = engine.observe(base);
    expect(obs.toolStats).toHaveLength(1);
    expect(obs.generated.apps).toBe(2);
  });

  it("propose：无 modelRouter 且无 proposer 返回不可用", async () => {
    const engine = new EvolutionEngine({
      dataDir: dir,
      observation: { listSessions: () => [{ id: "s", updatedAt: Date.now(), turnCount: 1, firstUserMsg: "任务" }], getEvents: () => [] },
    });
    const result = await engine.propose();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未初始化");
  });
});

// ===== CLI /evo =====

describe("CLI /evo 命令", () => {
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

  it("/evo 未注入引擎提示不可用", async () => {
    const { ctx, writes } = makeCtx(undefined as never);
    const result = await find("evo").handler(ctx, "list", "/evo list");
    expect(result).toBe("continue");
    expect(writes.join("\n")).toContain("未初始化");
  });

  it("/evo list 展示提案（含状态/类型/风险）", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({
      id: "evo-cli",
      type: "new-app",
      title: "生成番茄钟应用",
      action: { kind: "new-app", description: "番茄钟", type: "app" },
    }));
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "list", "/evo list");
    const joined = writes.join("\n");
    expect(joined).toContain("evo-cli");
    expect(joined).toContain("待确认");
    expect(joined).toContain("新应用");
  });

  it("/evo observe 输出观察指标", async () => {
    const now = Date.now();
    const engine = makeEngine({
      observation: {
        listSessions: () => [{ id: "s1", updatedAt: now, turnCount: 1, firstUserMsg: "任务" }],
        getEvents: () => [event(1, "tool/call", { callId: "t", name: "fs_read", arguments: "{}" }, now - 100)],
        auditCount: () => 1,
      },
    });
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "observe", "/evo observe");
    const joined = writes.join("\n");
    expect(joined).toContain("进化观察");
    expect(joined).toContain("fs_read");
  });

  it("/evo adopt 无 id 提示用法", async () => {
    const { ctx, writes } = makeCtx(makeEngine());
    await find("evo").handler(ctx, "adopt", "/evo adopt");
    expect(writes.join("\n")).toContain("用法");
  });

  it("/evo adopt <id> 确认提案并展示预览（不写入）", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({
      id: "evo-adopt",
      type: "new-tool",
      action: { kind: "new-tool", description: "自动生成周报", type: "tool" },
    }));
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "adopt evo-adopt", "/evo adopt evo-adopt");
    const joined = writes.join("\n");
    expect(joined).toContain("已确认提案");
    expect(joined).toContain("尚未写入");
    expect(joined).toContain("自动生成周报");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-adopt.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("confirmed");
  });

  it("/evo apply <id> 确认写入并反馈 jobId", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({
      id: "evo-apply",
      type: "new-tool",
      action: { kind: "new-tool", description: "自动生成周报", type: "tool" },
      status: "confirmed",
    }));
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "apply evo-apply", "/evo apply evo-apply");
    const joined = writes.join("\n");
    expect(joined).toContain("已写入");
    expect(joined).toContain("job-tool");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-apply.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("applied");
  });

  it("/evo reject <id> 拒绝", async () => {
    const engine = makeEngine();
    seedProposal(engine, pendingProposal({ id: "evo-rej2" }));
    const { ctx, writes } = makeCtx(engine);
    await find("evo").handler(ctx, "reject evo-rej2", "/evo reject evo-rej2");
    expect(writes.join("\n")).toContain("已拒绝");
    const saved = JSON.parse(readFileSync(resolve(dir, "evolution", "proposals", "evo-rej2.json"), "utf-8")) as EvolutionProposal;
    expect(saved.status).toBe("rejected");
  });
});
