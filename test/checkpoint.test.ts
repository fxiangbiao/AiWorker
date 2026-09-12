/**
 * Sprint 48.2：检查点存储（捕获/恢复/冲突/保留策略）与 captureDiff 集成
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CheckpointStore } from "../src/core/checkpoint-store.js";
import { createCaptureDiff, createTurnLogger } from "../src/hooks/handlers.js";
import { resetTurns } from "../src/hooks/turn-registry.js";
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
    store.capture(sessionId, 5, bin, "a\u0000b", { existedBefore: true, tool: "fs_edit" });
    const small = new CheckpointStore(resolve(testDir, "data-small"), { maxBlobBytes: 4 });
    small.capture("s2", 1, big, "0123456789", { existedBefore: true, tool: "fs_edit" });

    const entries = store.getManifest(sessionId, 5)?.files ?? [];
    expect(entries[0]).toMatchObject({ restorable: false, reason: "binary" });
    const result = store.restore(sessionId, 5);
    expect(result.skipped[0]).toMatchObject({ reason: "binary" });
    expect(small.getManifest("s2", 1)?.files[0]).toMatchObject({ restorable: false, reason: "too-large" });
  });

  it("terminal_exec 变更只记录、明确跳过", () => {
    const file = resolve(workDir, "via-terminal.txt");
    store.markUnrestorable(sessionId, 6, file, "terminal_exec", "terminal_exec");
    const result = store.restore(sessionId, 6);
    expect(result.skipped).toEqual([{ path: file, reason: "terminal_exec" }]);
    expect(result.restored).toEqual([]);
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
});
