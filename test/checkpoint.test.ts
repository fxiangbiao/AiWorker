/**
 * Sprint 48.2：检查点存储（捕获/恢复/冲突/保留策略）与 captureDiff 集成
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CheckpointStore } from "../src/core/checkpoint-store.js";
import { RewindService } from "../src/core/rewind-service.js";
import { createCaptureDiff, createTurnLogger } from "../src/hooks/handlers.js";
import { resetTurns, pendingTurn, setCompletedTurnsResolver } from "../src/hooks/turn-registry.js";
import { SessionStore } from "../src/memory/session-store.js";
import { makeTestDir, teardownEnv } from "./helpers.js";
import type { HookContext } from "../src/types.js";

const testDir = makeTestDir("checkpoint");
const workDir = resolve(testDir, "work");
mkdirSync(workDir, { recursive: true });

let store: CheckpointStore;
let sessionStore: SessionStore;
const sessionId = "s-checkpoint";

beforeEach(() => {
  store = new CheckpointStore(resolve(testDir, "data"));
  resetTurns();
});

afterAll(() => {
  sessionStore?.close();
  teardownEnv();
});

afterEach(() => {
  setCompletedTurnsResolver(null);
  resetTurns();
});

describe("CheckpointStore（捕获与恢复）", () => {
  it("已存在文件：恢复变更前内容", () => {
    const file = resolve(workDir, "a.md");
    writeFileSync(file, "原始内容", "utf-8");
    store.beginTurn(sessionId, 1, { userInput: "改 a.md", messageSeqBefore: 1 });
    store.capture(sessionId, 1, file, "原始内容", { existedBefore: true, tool: "fs_edit" });
    store.recordAfter(sessionId, 1, file, "改动后", { added: 1, removed: 1 });
    writeFileSync(file, "改动后", "utf-8");

    const result = store.restore(sessionId, 1);
    expect(result.restored).toEqual([file]);
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(file, "utf-8")).toBe("原始内容");
  });

  it("回合前不存在的新文件：恢复即删除", () => {
    const file = resolve(workDir, "new.txt");
    writeFileSync(file, "新建内容", "utf-8");
    store.beginTurn(sessionId, 2);
    store.capture(sessionId, 2, file, null, { existedBefore: false, tool: "fs_write" });
    store.recordAfter(sessionId, 2, file, "新建内容");

    const result = store.restore(sessionId, 2);
    expect(result.deleted).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it("同回合同路径只记首次（回滚基准 = 回合起点）", () => {
    const file = resolve(workDir, "twice.txt");
    writeFileSync(file, "v1", "utf-8");
    store.beginTurn(sessionId, 3);
    store.capture(sessionId, 3, file, "v1", { existedBefore: true, tool: "fs_edit" });
    store.capture(sessionId, 3, file, "v2", { existedBefore: true, tool: "fs_edit" });
    expect(store.getManifest(sessionId, 3)?.files).toHaveLength(1);
    writeFileSync(file, "v3", "utf-8");
    store.restore(sessionId, 3);
    expect(readFileSync(file, "utf-8")).toBe("v1");
  });

  it("冲突检测：外部改动默认拒绝覆盖，force 才覆盖", () => {
    const file = resolve(workDir, "conflict.txt");
    writeFileSync(file, "before", "utf-8");
    store.beginTurn(sessionId, 4);
    store.capture(sessionId, 4, file, "before", { existedBefore: true, tool: "fs_edit" });
    store.recordAfter(sessionId, 4, file, "after");
    writeFileSync(file, "外部改动", "utf-8");

    const blocked = store.restore(sessionId, 4);
    expect(blocked.conflicts).toEqual([file]);
    expect(readFileSync(file, "utf-8")).toBe("外部改动");

    const forced = store.restore(sessionId, 4, { force: true });
    expect(forced.restored).toEqual([file]);
    expect(readFileSync(file, "utf-8")).toBe("before");
  });

  it("二进制与大文件不入 blob，标记不可恢复", () => {
    const bin = resolve(workDir, "bin.dat");
    const big = resolve(workDir, "big.txt");
    writeFileSync(bin, "a\u0000b", "utf-8");
    store.beginTurn(sessionId, 5);
    store.capture(sessionId, 5, bin, "a\u0000b", { existedBefore: true, tool: "fs_edit" });
    const small = new CheckpointStore(resolve(testDir, "data-small"), { maxBlobBytes: 4 });
    small.beginTurn("s2", 1);
    small.capture("s2", 1, big, "0123456789", { existedBefore: true, tool: "fs_edit" });

    const entries = store.getManifest(sessionId, 5)?.files ?? [];
    expect(entries[0]).toMatchObject({ restorable: false, reason: "binary" });
    const result = store.restore(sessionId, 5);
    expect(result.skipped[0]).toMatchObject({ reason: "binary" });
    expect(small.getManifest("s2", 1)?.files[0]).toMatchObject({ restorable: false, reason: "too-large" });
  });

  it("terminal_exec 变更只记录、明确跳过", () => {
    const file = resolve(workDir, "via-terminal.txt");
    store.beginTurn(sessionId, 6);
    store.markUnrestorable(sessionId, 6, file, "terminal_exec", "terminal_exec");
    const result = store.restore(sessionId, 6);
    expect(result.skipped).toEqual([{ path: file, reason: "terminal_exec" }]);
    expect(result.restored).toEqual([]);
  });

  it("manifest 不存在时 markUnrestorable 也拒绝（禁隐式建盘）", () => {
    const orphan = resolve(workDir, "orphan.txt");
    store.markUnrestorable("s-orphan", 1, orphan, "terminal_exec", "terminal_exec");
    expect(store.getManifest("s-orphan", 1)).toBeNull();
    expect(store.listTurns("s-orphan")).toEqual([]);
  });

  it("保留策略：仅留最近 N 个回合", () => {
    const kept = new CheckpointStore(resolve(testDir, "data-keep"), { keepTurns: 3 });
    for (let turn = 1; turn <= 5; turn++) kept.beginTurn("s3", turn);
    expect(kept.listTurns("s3").map((m) => m.turn)).toEqual([3, 4, 5]);
  });

  it("manifest 损坏 / 不存在时 fail-soft", () => {
    const dir = resolve(testDir, "data", "checkpoints", sessionId, "turn-9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "manifest.json"), "{ 坏掉的 json", "utf-8");
    expect(store.getManifest(sessionId, 9)).toBeNull();
    expect(store.listTurns(sessionId).map((m) => m.turn)).not.toContain(9);
    expect(store.restore(sessionId, 9).skipped[0]?.reason).toBe("检查点不存在");
  });

  it("回合起点元数据取首次值（同号回合复用不覆盖）", () => {
    store.beginTurn(sessionId, 7, { userInput: "第一次", messageSeqBefore: 5 });
    store.beginTurn(sessionId, 7, { userInput: "第二次", messageSeqBefore: 9 });
    const manifest = store.getManifest(sessionId, 7);
    expect(manifest).toMatchObject({ userInput: "第一次", messageSeqBefore: 5 });
  });

  it("Sprint 52 T7：manifest 不存在即拒绝登记（不隐式建盘）", () => {
    const capped = new CheckpointStore(resolve(testDir, "data-reject"), { keepTurns: 3 });
    const r = capped.capture("s52", 99, resolve(workDir, "far.txt"), "old", { existedBefore: true, tool: "fs_write" });
    expect(r).toBeNull();
    expect(capped.getManifest("s52", 99)).toBeNull();
    expect(capped.listTurns("s52")).toEqual([]);
  });

  it("Sprint 52 T7：keepTurns 内 manifest 存在时 normal capture", () => {
    const capped = new CheckpointStore(resolve(testDir, "data-ok"), { keepTurns: 3 });
    capped.beginTurn("s52b", 2, { messageSeqBefore: 1 });
    const r = capped.capture("s52b", 2, resolve(workDir, "near.txt"), "old", { existedBefore: true, tool: "fs_write" });
    expect(r).not.toBeNull();
    expect(capped.getManifest("s52b", 2)?.files.length).toBe(1);
  });

  it("Sprint 52 T7：>20 回合 prune 后子写入被拒（prune 时序回归）", () => {
    const capped = new CheckpointStore(resolve(testDir, "data-prune"), { keepTurns: 20 });
    for (let turn = 1; turn <= 25; turn++) {
      capped.beginTurn("s52c", turn, { messageSeqBefore: turn });
    }
    const expected = Array.from({ length: 20 }, (_, i) => i + 6);
    expect(capped.listTurns("s52c").map((m) => m.turn)).toEqual(expected);
    // 已 prune 的回合 5：拒绝登记，且不会复活该回合、不会多删合法回合
    expect(capped.capture("s52c", 5, resolve(workDir, "pruned.txt"), "old", { existedBefore: true, tool: "fs_write" })).toBeNull();
    expect(capped.listTurns("s52c").map((m) => m.turn)).toEqual(expected);
  });
});

describe("captureDiff 与检查点集成（回合日志 + 写前快照）", () => {
  it("fs_write 写入后可回到回合起点，并记录对话回滚阈值", async () => {
    sessionStore = new SessionStore(resolve(testDir, "data", "integ.db"));
    const cp = new CheckpointStore(resolve(testDir, "data-integ"));
    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: cp });
    const capture = createCaptureDiff({
      workingDir: workDir,
      dataDir: resolve(testDir, "data-integ"),
      checkpointStore: cp,
      scanThrottleMs: 0,
    });

    const sid = "s-integ";
    const file = resolve(workDir, "integ.md");
    writeFileSync(file, "旧内容", "utf-8");
    sessionStore.ensureSession(sid, "default");
    sessionStore.appendMessage(sid, { role: "user", content: "上一轮的问题" });

    const ctx = (event: HookContext["event"], data: Record<string, unknown>): HookContext => ({
      event,
      agentId: "default",
      sessionId: sid,
      data,
    });

    await turnLogger(ctx("onMessage", { instruction: "把 integ.md 改成新内容" }));
    const args = JSON.stringify({ path: file, content: "新内容" });
    await capture(ctx("onToolCallPre", { toolName: "fs_write", args }));
    writeFileSync(file, "新内容", "utf-8");
    await capture(ctx("onToolCallPost", { toolName: "fs_write", args, result: { success: true, content: "ok" } }));

    const manifest = cp.getManifest(sid, 1);
    expect(manifest?.userInput).toBe("把 integ.md 改成新内容");
    expect(manifest?.messageSeqBefore).toBe(2);
    expect(manifest?.files[0]).toMatchObject({ path: file, existedBefore: true, restorable: true, tool: "fs_write" });

    const restored = cp.restore(sid, 1);
    expect(restored.restored).toEqual([file]);
    expect(readFileSync(file, "utf-8")).toBe("旧内容");

    await turnLogger(ctx("onTaskComplete", { messages: [], truncated: false, toolCallsExecuted: 1, iterations: 1 }));
    expect(sessionStore.getEvents(sid).some((e) => e.type === "turn/end")).toBe(true);
    void turnLogger;
  });

  it("Sprint 52 T7 路线 B：子智能体写入登记到父会话的 spawn 回合，父 /rewind 一次回滚父子全部", async () => {
    const { registerOwnership, clearRegistry } = await import("../src/core/subagent-ownership.js");
    const { RewindService } = await import("../src/core/rewind-service.js");
    sessionStore = new SessionStore(resolve(testDir, "data", "route-b.db"));
    const cp = new CheckpointStore(resolve(testDir, "data-routeb"));
    clearRegistry();

    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: cp });
    const capture = createCaptureDiff({
      workingDir: workDir,
      dataDir: resolve(testDir, "data-routeb"),
      checkpointStore: cp,
      scanThrottleMs: 0,
    });

    const parentSid = "s-parent-b";
    const childSid = "wk-child-b";
    sessionStore.ensureSession(parentSid, "default");
    sessionStore.ensureSession(childSid, "default");

    const parentFile = resolve(workDir, "parent-b.md");
    const childFile = resolve(workDir, "child-b.md");
    writeFileSync(parentFile, "父-旧", "utf-8");
    writeFileSync(childFile, "子-旧", "utf-8");

    const ctx = (sid: string, event: HookContext["event"], data: Record<string, unknown>): HookContext => ({
      event,
      agentId: "default",
      sessionId: sid,
      data,
    });

    // 父回合 1 开启；spawn 时钉住 parentTurnAtSpawn = 1
    await turnLogger(ctx(parentSid, "onMessage", { instruction: "并行调研" }));
    expect(pendingTurn(parentSid)).toBe(1);
    registerOwnership({
      parentSessionId: parentSid,
      parentTurnAtSpawn: pendingTurn(parentSid),
      childSessionId: childSid,
      spawnedAt: Date.now(),
    });

    // 父自己写一个文件
    const parentArgs = JSON.stringify({ path: parentFile, content: "父-新" });
    await capture(ctx(parentSid, "onToolCallPre", { toolName: "fs_write", args: parentArgs }));
    writeFileSync(parentFile, "父-新", "utf-8");
    await capture(ctx(parentSid, "onToolCallPost", { toolName: "fs_write", args: parentArgs, result: { success: true, content: "ok" } }));

    // 子智能体写一个文件 → 应登记到父会话 turn 1
    const childArgs = JSON.stringify({ path: childFile, content: "子-新" });
    await capture(ctx(childSid, "onToolCallPre", { toolName: "fs_write", args: childArgs }));
    writeFileSync(childFile, "子-新", "utf-8");
    await capture(ctx(childSid, "onToolCallPost", { toolName: "fs_write", args: childArgs, result: { success: true, content: "ok" } }));

    // 子会话自己没有检查点目录（写入全部登记在父回合）
    expect(cp.listTurns(childSid)).toEqual([]);
    const parentManifest = cp.getManifest(parentSid, 1);
    expect(parentManifest?.files.map((f) => f.path).sort()).toEqual([childFile, parentFile].sort());

    await turnLogger(ctx(parentSid, "onTaskComplete", { messages: [], truncated: false, toolCallsExecuted: 1, iterations: 1 }));
    await turnLogger(ctx(childSid, "onTaskComplete", { messages: [], truncated: false, toolCallsExecuted: 1, iterations: 1 }));

    // 父 /rewind 1 → 父子改动一次回滚
    const rewind = new RewindService({ sessionStore, checkpointStore: cp });
    const plan = rewind.preview(parentSid, 1, "code");
    expect(plan.files.map((f) => f.path).sort()).toEqual([childFile, parentFile].sort());
    const result = rewind.apply(parentSid, 1, "code", { force: true });
    expect(result.ok).toBe(true);
    expect(readFileSync(parentFile, "utf-8")).toBe("父-旧");
    expect(readFileSync(childFile, "utf-8")).toBe("子-旧");

    clearRegistry();
  });

  it("Sprint 52 T7：spawn 回合 manifest 不存在时拒绝登记 + 审计（父空闲 spawn 的固有代价）", async () => {
    const { registerOwnership, clearRegistry } = await import("../src/core/subagent-ownership.js");
    const { initAuditLog, auditLogger } = await import("../src/core/audit-logger.js");
    sessionStore = new SessionStore(resolve(testDir, "data", "route-b2.db"));
    const cp = new CheckpointStore(resolve(testDir, "data-routeb2"));
    clearRegistry();
    initAuditLog(resolve(testDir, "data-routeb2"));

    const capture = createCaptureDiff({
      workingDir: workDir,
      dataDir: resolve(testDir, "data-routeb2"),
      checkpointStore: cp,
      scanThrottleMs: 0,
    });

    const parentSid = "s-parent-idle";
    const childSid = "wk-child-idle";
    sessionStore.ensureSession(parentSid, "default");
    sessionStore.ensureSession(childSid, "default");
    // 父空闲 spawn：未 beginTurn，父 turn 无 manifest
    registerOwnership({
      parentSessionId: parentSid,
      parentTurnAtSpawn: 7,
      childSessionId: childSid,
      spawnedAt: Date.now(),
    });

    const file = resolve(workDir, "idle-child.md");
    writeFileSync(file, "旧", "utf-8");
    const args = JSON.stringify({ path: file, content: "新" });
    const ctx = (event: HookContext["event"], data: Record<string, unknown>): HookContext => ({
      event,
      agentId: "default",
      sessionId: childSid,
      data,
    });
    await capture(ctx("onToolCallPre", { toolName: "fs_write", args }));

    expect(cp.getManifest(parentSid, 7)).toBeNull();
    expect(cp.listTurns(parentSid)).toEqual([]);
    const rejected = auditLogger.queryBySession(childSid).filter((e) => e.action === "checkpoint:rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.result).toBe("blocked");

    clearRegistry();
  });
});

describe("D4 检查点归属（父会话 /rewind 与子会话改动）", () => {
  it("D4-a 子会话写入只进子会话检查点，父 /rewind 看不见；turn 号来自进程内计数器", async () => {
    sessionStore = new SessionStore(resolve(testDir, "data", "d4a.db"));
    const projDir = resolve(testDir, "proj");
    mkdirSync(projDir, { recursive: true });
    const parentSid = sessionStore.createSession("probe").id;
    const childSid = sessionStore.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: store });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: resolve(testDir, "data"),
      checkpointStore: store,
      scanThrottleMs: 0,
    });

    // 真实钩子路径：父会话与子会话各自触发 onMessage
    await turnLogger({
      event: "onMessage",
      agentId: "probe",
      sessionId: parentSid,
      data: { instruction: "父问题" },
    });
    await turnLogger({
      event: "onMessage",
      agentId: "probe",
      sessionId: childSid,
      data: { instruction: "子任务" },
    });

    expect(store.getManifest(parentSid, 1)?.userInput).toBe("父问题");
    expect(store.getManifest(parentSid, 1)?.messageSeqBefore).toBe(1);
    // 两个会话各自从 turn-1 开始 → 计数器按会话独立，与 getLastMessageSeq 无关
    expect(store.getManifest(childSid, 1)?.userInput).toBe("子任务");

    const write = async (sid: string, file: string, content: string) => {
      const args = JSON.stringify({ path: file, content });
      await capture({ event: "onToolCallPre", agentId: "probe", sessionId: sid, data: { toolName: "fs_write", args } });
      writeFileSync(file, content);
      await capture({
        event: "onToolCallPost",
        agentId: "probe",
        sessionId: sid,
        data: { toolName: "fs_write", args, result: { success: true, content: "写入完成" } },
      });
    };

    const parentFile = resolve(projDir, "parent.txt");
    const childFile = resolve(projDir, "child.txt");
    await write(parentSid, parentFile, "P");
    await write(childSid, childFile, "C");

    const preview = new RewindService({ sessionStore, checkpointStore: store }).preview(
      parentSid,
      1,
      "all",
    );
    const paths = preview.files.map((f) => f.path);
    expect(paths).toContain(parentFile);
    expect(paths).not.toContain(childFile);
    expect(store.getManifest(childSid, 1)!.files.map((f) => f.path)).toEqual([childFile]);
  });

  it("D4-b 进程重启后 pendingTurn 从已提交回合回填：新回合落到 turn-N+1，不并入旧 manifest（T0.5 修复后）", async () => {
    sessionStore = new SessionStore(resolve(testDir, "data", "d4b.db"));
    const projDir = resolve(testDir, "proj2");
    mkdirSync(projDir, { recursive: true });
    const sid = sessionStore.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: store });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: resolve(testDir, "data"),
      checkpointStore: store,
      scanThrottleMs: 0,
    });

    // 第 1 回合（真实顺序：onMessage → 落库 user → 工具写入 → onTaskComplete 提交）
    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "老问题" } });
    sessionStore.appendMessage(sid, { role: "user", content: "老问题" });
    const first = resolve(projDir, "first.txt");
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: first }) },
    });
    await turnLogger({
      event: "onTaskComplete",
      agentId: "probe",
      sessionId: sid,
      data: { messages: [], truncated: false, toolCallsExecuted: 1, iterations: 1 },
    });
    // 「已提交回合」的真源：turn_logs.seq（onTaskComplete 与 commitTurn 同批写入）
    expect(sessionStore.getTurnLogs(sid).map((t) => t.seq)).toEqual([1]);

    // 与 bootstrap 一致的回填接线（生产在 bootstrap 注入；测试里按同一口径接线）
    setCompletedTurnsResolver((session) => sessionStore.getLastTurnSeq(session));

    resetTurns(sid); // 模拟进程重启：内存计数清空，DB 保留

    // 修复后：pendingTurn 从已提交回合回填 → 2（修复前恒为 1，新回合会并入旧 turn-1）
    expect(pendingTurn(sid)).toBe(2);

    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "重启后的问题" } });
    sessionStore.appendMessage(sid, { role: "user", content: "重启后的问题" });
    const second = resolve(projDir, "second.txt");
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: second }) },
    });

    expect(store.listTurns(sid).map((m) => m.turn)).toEqual([1, 2]);
    const oldTurn = store.getManifest(sid, 1)!;
    expect(oldTurn.userInput).toBe("老问题");
    expect(oldTurn.files.map((f) => f.path)).toEqual([first]);
    const newTurn = store.getManifest(sid, 2)!;
    expect(newTurn.userInput).toBe("重启后的问题");
    expect(newTurn.files.map((f) => f.path)).toEqual([second]);
    // 元数据是新回合的值，不是旧回合的（messageSeqBefore: turn1=1, turn2=2）
    expect(oldTurn.messageSeqBefore).toBe(1);
    expect(newTurn.messageSeqBefore).toBe(2);
  });
});

describe("T0.5 缺陷② 重启后回合号从已提交回合回填", () => {
  it("未注入解析器时行为与修复前完全一致：重启后 pendingTurn 回到 1（无回填）", async () => {
    sessionStore = new SessionStore(resolve(testDir, "data", "t05a.db"));
    const sid = sessionStore.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: store });

    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "Q1" } });
    sessionStore.appendMessage(sid, { role: "user", content: "Q1" });
    await turnLogger({
      event: "onTaskComplete",
      agentId: "probe",
      sessionId: sid,
      data: { messages: [], truncated: false, toolCallsExecuted: 0, iterations: 1 },
    });
    expect(sessionStore.getLastTurnSeq(sid)).toBe(1);

    resetTurns(sid);
    expect(pendingTurn(sid)).toBe(1);
  });

  it("解析器抛错时不把异常抛给工具调用路径（按无回填处理）", () => {
    setCompletedTurnsResolver(() => {
      throw new Error("模拟 DB 不可读");
    });
    expect(() => pendingTurn("sess-resolver-throw")).not.toThrow();
    expect(pendingTurn("sess-resolver-throw")).toBe(1);
  });

  it("口径实测：回合已开始未提交 → manifest 已建而 turn_logs 为空；用 turn_logs 回填不跳号", async () => {
    sessionStore = new SessionStore(resolve(testDir, "data", "t05c.db"));
    const projDir = resolve(testDir, "proj3");
    mkdirSync(projDir, { recursive: true });
    const sid = sessionStore.createSession("probe").id;
    const turnLogger = createTurnLogger({ sessionStore, checkpointStore: store });
    const capture = createCaptureDiff({
      workingDir: projDir,
      dataDir: resolve(testDir, "data"),
      checkpointStore: store,
      scanThrottleMs: 0,
    });

    // 回合开始（beginTurn 建 manifest）→ 写了文件 → **未提交**（没有 onTaskComplete）
    await turnLogger({ event: "onMessage", agentId: "probe", sessionId: sid, data: { instruction: "未提交的问题" } });
    sessionStore.appendMessage(sid, { role: "user", content: "未提交的问题" });
    await capture({
      event: "onToolCallPre",
      agentId: "probe",
      sessionId: sid,
      data: { toolName: "fs_write", args: JSON.stringify({ path: resolve(projDir, "orphan.txt") }) },
    });

    // 两个候选数据源在此分叉：manifest 口径 = 1，turn_logs 口径 = 0
    expect(store.listTurns(sid).map((m) => m.turn)).toEqual([1]);
    expect(sessionStore.getLastTurnSeq(sid)).toBe(0);

    setCompletedTurnsResolver((session) => sessionStore.getLastTurnSeq(session));
    resetTurns(sid);
    // 选 turn_logs：异常回合的号被复用（不跳号、不把号推高）
    expect(pendingTurn(sid)).toBe(1);
  });
});
