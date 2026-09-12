/**
 * Sprint 48.3：回滚服务（预览/执行/冲突）+ /rewind 命令 + HTTP 端点 + 事件回放截断
 */

import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { CheckpointStore } from "../src/core/checkpoint-store.js";
import { RewindService } from "../src/core/rewind-service.js";
import { SessionStore } from "../src/memory/session-store.js";
import { rewindCommands } from "../src/commands/rewind.js";
import { startServer } from "../src/server.js";
import { makeTestDir, teardownEnv } from "./helpers.js";
import type { CliCommand, CommandContext } from "../src/commands/types.js";

const testDir = makeTestDir("rewind");
const workDir = resolve(testDir, "work");
mkdirSync(workDir, { recursive: true });

interface Fixture {
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore;
  service: RewindService;
  sessionId: string;
  fileA: string;
  fileB: string;
}

/** 构造两轮检查点：第 1 轮改 a.txt，第 2 轮改 b.txt */
function makeFixture(name: string): Fixture {
  const sessionStore = new SessionStore(resolve(testDir, `${name}.db`));
  const checkpointStore = new CheckpointStore(resolve(testDir, `${name}-data`));
  const sessionId = `s-${name}`;
  sessionStore.ensureSession(sessionId, "default");

  const fileA = resolve(workDir, `${name}-a.txt`);
  const fileB = resolve(workDir, `${name}-b.txt`);
  writeFileSync(fileA, "A0", "utf-8");
  writeFileSync(fileB, "B0", "utf-8");

  const begin = (turn: number, userInput: string): void => {
    checkpointStore.beginTurn(sessionId, turn, {
      userInput,
      messageSeqBefore: sessionStore.getLastMessageSeq(sessionId) + 1,
      eventSeqBefore: sessionStore.getEventCount(sessionId) + 1,
    });
  };
  const writeTurn = (turn: number, path: string, before: string, after: string): void => {
    checkpointStore.capture(sessionId, turn, path, before, { existedBefore: true, tool: "fs_edit" });
    writeFileSync(path, after, "utf-8");
    checkpointStore.recordAfter(sessionId, turn, path, after, { added: 1, removed: 1 });
  };

  begin(1, "把 a.txt 改成 A1");
  writeTurn(1, fileA, "A0", "A1");
  sessionStore.appendMessage(sessionId, { role: "user", content: "把 a.txt 改成 A1" });
  sessionStore.appendMessage(sessionId, { role: "assistant", content: "已改 a.txt" });

  begin(2, "把 b.txt 改成 B1");
  writeTurn(2, fileB, "B0", "B1");
  sessionStore.appendMessage(sessionId, { role: "user", content: "把 b.txt 改成 B1" });
  sessionStore.appendMessage(sessionId, { role: "assistant", content: "已改 b.txt" });

  return { sessionStore, checkpointStore, service: new RewindService({ sessionStore, checkpointStore }), sessionId, fileA, fileB };
}

function fakeCtx(service: RewindService, sessionId: string, answer: string | null = null) {
  const out: string[] = [];
  const ctx = {
    rewindService: service,
    currentSessionId: () => sessionId,
    write: (t: string) => out.push(t),
    writeLine: (t: string) => out.push(`${t}\n`),
    printStatus: () => undefined,
    ask: async () => answer,
  } as unknown as CommandContext;
  return { ctx, out, text: () => out.join("") };
}

const rewindCommand = rewindCommands.find((c) => c.name === "rewind") as CliCommand;

afterAll(() => {
  teardownEnv();
});

describe("RewindService（预览与执行）", () => {
  it("预览：回合范围、文件动作与将删除的消息数", () => {
    const fx = makeFixture("preview");
    const plan = fx.service.preview(fx.sessionId, 2, "all");
    expect(plan.turns).toEqual([2]);
    expect(plan.files.map((f) => f.path)).toEqual([fx.fileB]);
    expect(plan.files[0]!.action).toBe("restore");
    expect(plan.messageCount).toBe(2);
    expect(plan.blockers).toEqual([]);

    const full = fx.service.preview(fx.sessionId, 1, "all");
    expect(full.turns).toEqual([2, 1]);
    expect(new Set(full.files.map((f) => f.path))).toEqual(new Set([fx.fileA, fx.fileB]));
    expect(full.messageCount).toBe(4);
    fx.sessionStore.close();
  });

  it("无检查点 → 阻塞原因", () => {
    const fx = makeFixture("empty");
    const plan = fx.service.preview(fx.sessionId, 9, "all");
    expect(plan.blockers[0]).toContain("没有第 9 轮");
    const result = fx.service.apply(fx.sessionId, 9, "all");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有第 9 轮");
    fx.sessionStore.close();
  });

  it("执行（代码+对话）：文件还原 + 消息截断 + 追加 rewind 事件", () => {
    const fx = makeFixture("apply-all");
    const result = fx.service.apply(fx.sessionId, 2, "all");
    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([fx.fileB]);
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B0");
    expect(readFileSync(fx.fileA, "utf-8")).toBe("A1");
    expect(result.messagesDeleted).toBe(2);

    expect(fx.sessionStore.getMessages(fx.sessionId)).toHaveLength(2);
    expect(fx.sessionStore.replayEvents(fx.sessionId)).toHaveLength(2);
    expect(fx.sessionStore.verifyProjection(fx.sessionId).ok).toBe(true);
    const events = fx.sessionStore.getEvents(fx.sessionId);
    expect(events.some((e) => e.type === "rewind/applied")).toBe(true);
    fx.sessionStore.close();
  });

  it("仅对话：不动文件；仅代码：不动消息", () => {
    const chat = makeFixture("scope-chat");
    const chatResult = chat.service.apply(chat.sessionId, 2, "chat");
    expect(chatResult.restored).toEqual([]);
    expect(readFileSync(chat.fileB, "utf-8")).toBe("B1");
    expect(chatResult.messagesDeleted).toBe(2);

    const code = makeFixture("scope-code");
    const codeResult = code.service.apply(code.sessionId, 2, "code");
    expect(codeResult.restored).toEqual([code.fileB]);
    expect(readFileSync(code.fileB, "utf-8")).toBe("B0");
    expect(codeResult.messagesDeleted).toBe(0);
    expect(code.sessionStore.getMessages(code.sessionId)).toHaveLength(4);
    expect(code.sessionStore.replayEvents(code.sessionId)).toHaveLength(4);
    chat.sessionStore.close();
    code.sessionStore.close();
  });

  it("回滚后新追加的消息不受旧标记影响", () => {
    const fx = makeFixture("after-rewind");
    fx.service.apply(fx.sessionId, 2, "chat");
    fx.sessionStore.appendMessage(fx.sessionId, { role: "user", content: "新问题" });
    expect(fx.sessionStore.replayEvents(fx.sessionId)).toHaveLength(3);
    fx.sessionStore.close();
  });

  it("外部改动 → 冲突：预览标记，默认跳过，--force 覆盖", () => {
    const fx = makeFixture("conflict");
    writeFileSync(fx.fileB, "外部手改", "utf-8");

    const plan = fx.service.preview(fx.sessionId, 2, "all");
    expect(plan.files[0]).toMatchObject({ action: "conflict" });

    const blocked = fx.service.apply(fx.sessionId, 2, "code");
    expect(blocked.conflicts).toEqual([fx.fileB]);
    expect(readFileSync(fx.fileB, "utf-8")).toBe("外部手改");

    const forced = fx.service.apply(fx.sessionId, 2, "code", { force: true });
    expect(forced.restored).toEqual([fx.fileB]);
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B0");
    fx.sessionStore.close();
  });

  it("缺少对话阈值（无 messageSeqBefore）→ 阻塞对话回滚", () => {
    const sessionStore = new SessionStore(resolve(testDir, "no-threshold.db"));
    const checkpointStore = new CheckpointStore(resolve(testDir, "no-threshold-data"));
    sessionStore.ensureSession("s-nt", "default");
    checkpointStore.beginTurn("s-nt", 1, { userInput: "无阈值" });
    const service = new RewindService({ sessionStore, checkpointStore });
    expect(service.preview("s-nt", 1, "chat").blockers[0]).toContain("缺少对话回滚阈值");
    expect(service.apply("s-nt", 1, "all").ok).toBe(false);
    sessionStore.close();
  });
});

describe("/rewind 命令", () => {
  it("无参数：列出检查点", async () => {
    const fx = makeFixture("cmd-list");
    const { ctx, text } = fakeCtx(fx.service, fx.sessionId);
    await rewindCommand.handler(ctx, "", "/rewind");
    expect(text()).toContain("把 b.txt 改成 B1");
    expect(text()).toContain("1/1");
    fx.sessionStore.close();
  });

  it("--dry-run：只预览、不改动", async () => {
    const fx = makeFixture("cmd-dry");
    const { ctx, text } = fakeCtx(fx.service, fx.sessionId);
    await rewindCommand.handler(ctx, "2 --code --dry-run", "/rewind 2 --code --dry-run");
    expect(text()).toContain("--dry-run 仅预览");
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B1");
    fx.sessionStore.close();
  });

  it("交互选择：3 = 仅代码", async () => {
    const fx = makeFixture("cmd-interactive");
    const { ctx, text } = fakeCtx(fx.service, fx.sessionId, "3");
    await rewindCommand.handler(ctx, "2", "/rewind 2");
    expect(text()).toContain("已回滚到第 2 轮之前（仅代码）");
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B0");
    expect(fx.sessionStore.getMessages(fx.sessionId)).toHaveLength(4);
    fx.sessionStore.close();
  });

  it("无提问通道（ask 返回 null）→ fail-closed 取消", async () => {
    const fx = makeFixture("cmd-cancel");
    const { ctx, text } = fakeCtx(fx.service, fx.sessionId, null);
    await rewindCommand.handler(ctx, "2", "/rewind 2");
    expect(text()).toContain("已取消");
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B1");
    fx.sessionStore.close();
  });

  it("非法轮次参数与未注入服务时的提示", async () => {
    const fx = makeFixture("cmd-invalid");
    const { ctx, text } = fakeCtx(fx.service, fx.sessionId);
    await rewindCommand.handler(ctx, "abc", "/rewind abc");
    expect(text()).toContain("轮次需为正整数");

    const noService = { rewindService: undefined, currentSessionId: () => "s", write: () => {}, writeLine: (t: string) => void t, printStatus: () => {} } as unknown as CommandContext;
    const lines: string[] = [];
    (noService as unknown as { writeLine: (t: string) => void }).writeLine = (t) => lines.push(t);
    await rewindCommand.handler(noService, "", "/rewind");
    expect(lines.join("")).toContain("检查点服务不可用");
    fx.sessionStore.close();
  });
});

describe("HTTP 端点（/sessions/:id/checkpoints 与 /rewind）", () => {
  it("列表 → 预览 → 执行 → 广播", async () => {
    const fx = makeFixture("http");
    const server = startServer(
      {
        modelRouter: {} as never,
        workingDir: workDir,
        coordinator: {} as never,
        createAgent: () => undefined,
        getAgentList: () => [],
        skillNames: [],
        dataDir: resolve(testDir, "http-data"),
        sessionStore: fx.sessionStore,
        rewindService: fx.service,
      } as never,
      0,
    );
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1/sessions/${fx.sessionId}`;

    const listResp = await fetch(`${base}/checkpoints`);
    expect(listResp.status).toBe(200);
    const list = (await listResp.json()) as { turns: { turn: number }[] };
    expect(list.turns.map((t) => t.turn)).toEqual([1, 2]);

    const previewResp = await fetch(`${base}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toTurn: 2, scope: "all", dryRun: true }),
    });
    expect(previewResp.status).toBe(200);
    const preview = (await previewResp.json()) as { plan: { messageCount: number } };
    expect(preview.plan.messageCount).toBe(2);
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B1");

    const badResp = await fetch(`${base}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toTurn: 0, scope: "all" }),
    });
    expect(badResp.status).toBe(400);

    const applyResp = await fetch(`${base}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toTurn: 2, scope: "all" }),
    });
    expect(applyResp.status).toBe(200);
    const applied = (await applyResp.json()) as { ok: boolean; result: { restored: string[]; messagesDeleted: number } };
    expect(applied.ok).toBe(true);
    expect(applied.result.restored).toEqual([fx.fileB]);
    expect(applied.result.messagesDeleted).toBe(2);
    expect(readFileSync(fx.fileB, "utf-8")).toBe("B0");

    server.close();
    fx.sessionStore.close();
  });
});
