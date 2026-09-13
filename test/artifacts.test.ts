/**
 * 产物工作台测试（Sprint 50）
 * 覆盖：去重与权威源、快照绝对路径归一化、deleted 保留、跨会话截断降级、老会话降级、
 *       端点参数校验与真实数据源合并
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildArtifactWorkspace, kindFromExt, normalizePath } from "../src/core/artifacts.js";
import { collectDocs } from "../src/core/docs-index.js";
import { startServer } from "../src/server.js";
import { SessionStore } from "../src/memory/session-store.js";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import type { CheckpointManifest, DiffSession, DocEntry, SessionEvent } from "../src/types.js";

const testDir = makeTestDir("artifacts");
setupEnv(testDir);
afterAll(() => teardownEnv());

const WD = resolve(testDir, "proj");

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = 1000): SessionEvent =>
  ({ seq: ++seq, sessionId: "s1", type, data, createdAt: at, source: "test" }) as unknown as SessionEvent;

function inputs(over: Partial<Parameters<typeof buildArtifactWorkspace>[0]> = {}) {
  return {
    sessionId: "s1",
    scope: "session" as const,
    workingDir: WD,
    events: [] as SessionEvent[],
    diffs: [] as DiffSession[],
    docs: [] as DocEntry[],
    checkpoints: [] as CheckpointManifest[],
    ...over,
  };
}

describe("kindFromExt 与路径归一化", () => {
  it("按扩展名判型，未知回落 other，无扩展名不误判", () => {
    expect(kindFromExt("a/b/c.png")).toBe("image");
    expect(kindFromExt("D:\\x\\report.MD")).toBe("text");
    expect(kindFromExt("noext")).toBe("other");
    expect(kindFromExt("archive.zip")).toBe("other");
    expect(kindFromExt(".gitignore")).toBe("other");
  });

  it("工作目录内给 project:相对路径，目录外保留绝对路径键", () => {
    const inside = normalizePath(join(WD, "src", "a.ts"), WD);
    expect(inside.key).toBe("project:src/a.ts");
    expect(inside.rel).toBe("src/a.ts");
    const outside = normalizePath(resolve(testDir, "elsewhere", "b.txt"), WD);
    expect(outside.key.startsWith("abs:")).toBe(true);
    expect(outside.rel).toBeUndefined();
  });
});

describe("产物合并（去重与权威源）", () => {
  it("同一文件来自 工具产物 + 快照 + 检查点 → 只出现一次，字段各取权威源", () => {
    const file = join(WD, "src", "a.ts");
    const ws = buildArtifactWorkspace(
      inputs({
        events: [
          ev("turn/start", { turn: 3 }, 1000),
          ev("tool/call", { callId: "t1", name: "fs_write", arguments: "{}" }, 1100),
          ev("tool/result", { callId: "t1", success: true, content: "ok", artifacts: [
            { type: "file", path: file, mime: "text/typescript", size: 2048, kind: "text", root: "project", rel: "src/a.ts" },
          ] }, 1200),
        ],
        diffs: [{ sessionId: "s1", files: [{ path: file, added: 12, removed: 3, lines: [{ type: "add", text: "x" }] }], createdAt: 900, updatedAt: 1300 }],
        checkpoints: [{ sessionId: "s1", turn: 3, createdAt: 1000, files: [{ path: file, restorable: true, tool: "fs_write", added: 12, removed: 3 }] }],
      }),
    );

    const item = ws.items.find((i) => i.rel === "src/a.ts")!;
    expect(ws.items.filter((i) => i.rel === "src/a.ts")).toHaveLength(1);
    expect(item.sources.sort()).toEqual(["checkpoint", "snapshot", "tool"]);
    expect(item.kind).toBe("text");
    expect(item.mime).toBe("text/typescript");
    expect(item.size).toBe(2048);
    expect(item.added).toBe(12);
    expect(item.removed).toBe(3);
    expect(item.change).toBe("modified");
    expect(item.restorable).toBe(true);
    expect(item.turn).toBe(3);
    expect(item.tool).toBe("fs_write");
    expect(item.hasDiff).toBe(true);
  });

  it("快照绝对路径与工具产物 rel 归一化到同一键（否则会重复）", () => {
    const file = join(WD, "docs", "readme.md");
    const ws = buildArtifactWorkspace(
      inputs({
        events: [
          ev("tool/result", { callId: "t1", success: true, content: "ok", artifacts: [
            { type: "file", path: file, mime: "text/markdown", size: 10, kind: "text", root: "project", rel: "docs/readme.md" },
          ] }, 500),
        ],
        diffs: [{ sessionId: "s1", files: [{ path: file, added: 1, removed: 0, lines: [] }], createdAt: 100, updatedAt: 600 }],
        docs: [{ root: "project", path: "docs/readme.md", title: "readme", size: 10, mtime: 700 }],
      }),
    );
    expect(ws.items).toHaveLength(1);
    expect(ws.items[0]!.sources.sort()).toEqual(["docs", "snapshot", "tool"]);
  });

  it("link 产物按 url 去重，重复搜索结果只保留一条", () => {
    const link = { type: "link" as const, url: "https://example.com/a", title: "A", site: "example.com" };
    const ws = buildArtifactWorkspace(
      inputs({
        events: [
          ev("tool/result", { callId: "t1", success: true, content: "", artifacts: [link] }, 100),
          ev("tool/result", { callId: "t2", success: true, content: "", artifacts: [link] }, 200),
        ],
      }),
    );
    const links = ws.items.filter((i) => i.type === "link");
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://example.com/a");
    expect(links[0]!.site).toBe("example.com");
  });

  it("快照里已删除的文件仍然列出并标注（用户要知道它一度存在）", () => {
    const gone = join(WD, "old.txt");
    const ws = buildArtifactWorkspace(
      inputs({ diffs: [{ sessionId: "s1", files: [{ path: gone, added: 0, removed: 5, lines: [], deleted: true }], createdAt: 1, updatedAt: 2 }] }),
    );
    const item = ws.items[0]!;
    expect(item.change).toBe("deleted");
    expect(item.degraded).toContain("已删除");
    expect(ws.counts.byChange.deleted).toBe(1);
  });

  it("二进制快照只给元信息（不给 diff 视图）", () => {
    const bin = join(WD, "shot.png");
    const ws = buildArtifactWorkspace(
      inputs({ diffs: [{ sessionId: "s1", files: [{ path: bin, added: 0, removed: 0, lines: [], binary: true }], createdAt: 1, updatedAt: 2 }] }),
    );
    expect(ws.items[0]!.kind).toBe("image");
    expect(ws.items[0]!.hasDiff).toBe(false);
    expect(ws.items[0]!.degraded).toContain("二进制");
  });

  it("新增（只有 added）与修改（add+del 并存）区分正确", () => {
    const created = join(WD, "new.ts");
    const edited = join(WD, "edit.ts");
    const ws = buildArtifactWorkspace(
      inputs({
        diffs: [{
          sessionId: "s1",
          files: [
            { path: created, added: 9, removed: 0, lines: [] },
            { path: edited, added: 2, removed: 4, lines: [] },
          ],
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
    );
    expect(ws.items.find((i) => i.rel === "new.ts")!.change).toBe("added");
    expect(ws.items.find((i) => i.rel === "edit.ts")!.change).toBe("modified");
  });

  it("范围 session 只取本会话快照；all 取全部并统计 kinds", () => {
    const diffs: DiffSession[] = [
      { sessionId: "s1", files: [{ path: join(WD, "a.txt"), added: 1, removed: 0, lines: [] }], createdAt: 1, updatedAt: 5 },
      { sessionId: "s2", files: [{ path: join(WD, "b.png"), added: 0, removed: 0, lines: [], binary: true }], createdAt: 1, updatedAt: 6 },
    ];
    const only = buildArtifactWorkspace(inputs({ diffs }));
    expect(only.items).toHaveLength(1);
    const all = buildArtifactWorkspace(inputs({ diffs, scope: "all" }));
    expect(all.items).toHaveLength(2);
    expect(all.counts.byKind.image).toBe(1);
    expect(all.counts.total).toBe(2);
  });

  it("跨会话截断与结构性缺失都会写进 degraded", () => {
    const ws = buildArtifactWorkspace(inputs({ scope: "all", truncatedSessions: 3, degraded: ["early-session", "no-rewind"] }));
    expect(ws.degraded).toContain("tool-artifacts-truncated");
    expect(ws.degraded).toContain("early-session");
    expect(ws.degraded).toContain("no-rewind");
  });

  it("时间线按回合升序返回", () => {
    const ws = buildArtifactWorkspace(
      inputs({
        checkpoints: [
          { sessionId: "s1", turn: 3, createdAt: 300, files: [] },
          { sessionId: "s1", turn: 1, createdAt: 100, files: [] },
        ],
      }),
    );
    expect(ws.timeline.map((t) => t.turn)).toEqual([1, 3]);
  });
});

describe("collectDocs（/docs 与产物面板共用一份实现）", () => {
  it("只收 .md；会话资产递归、项目文档按深度与数量上限", () => {
    const dataDir = join(testDir, "docs-data");
    const proj = join(testDir, "docs-proj");
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
    mkdirSync(join(dataDir, "docs", "sub"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(join(proj, "node_modules"), { recursive: true });
    writeFileSync(join(dataDir, "docs", "a.md"), "# a\n", "utf-8");
    writeFileSync(join(dataDir, "docs", "sub", "b.md"), "# b\n", "utf-8");
    writeFileSync(join(dataDir, "docs", "c.txt"), "no\n", "utf-8");
    writeFileSync(join(proj, "README.md"), "# r\n", "utf-8");
    writeFileSync(join(proj, "src", "code.ts"), "no\n", "utf-8");
    writeFileSync(join(proj, "node_modules", "dep.md"), "# dep\n", "utf-8");

    const docs = collectDocs(dataDir, proj);
    const keys = docs.map((d) => `${d.root}:${d.path}`).sort();
    expect(keys).toEqual(["project:README.md", "session:a.md", "session:sub/b.md"]);
  });
});

describe("GET /api/v1/artifacts", () => {
  let server: Server | undefined;
  let base = "";
  let store: SessionStore;
  const sessionId = "artifacts-sess";

  beforeAll(async () => {
    const dataDir = join(testDir, "srv-data");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    store = new SessionStore(join(dataDir, "aiworker.db"));
    store.createSession("default");
    store.ensureSession(sessionId, "default");
    store.setWorkingDir(sessionId, WD);
    const file = join(WD, "made.txt");
    store.appendEvent(sessionId, "tool/result", {
      callId: "c1",
      success: true,
      content: "written",
      artifacts: [{ type: "file", path: file, mime: "text/plain", size: 5, kind: "text", root: "project", rel: "made.txt" }],
    });
    server = startServer({ sessionStore: store, workingDir: WD, dataDir, modelRouter: { getCurrentModel: () => "m" } } as never, 0);
    await new Promise<void>((r) => server!.once("listening", () => r()));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(() => {
    server?.close();
    store?.close();
  });

  it("缺少 sessionId → 400；非法 scope → 400", async () => {
    expect((await fetch(`${base}/artifacts`)).status).toBe(400);
    expect((await fetch(`${base}/artifacts?sessionId=${sessionId}&scope=nope`)).status).toBe(400);
  });

  it("返回合并后的工具产物与降级标记", async () => {
    const resp = await fetch(`${base}/artifacts?sessionId=${sessionId}`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { items: Array<{ rel?: string; sources: string[] }>; degraded: string[]; timeline: unknown[] };
    expect(data.items.some((i) => i.rel === "made.txt" && i.sources.includes("tool"))).toBe(true);
    // 未注入 rewindService → 标注降级（而非静默给空时间线）
    expect(data.degraded).toContain("no-rewind");
    expect(Array.isArray(data.timeline)).toBe(true);
  });

  it("未知 sessionId 返回空结果而不是 500", async () => {
    const resp = await fetch(`${base}/artifacts?sessionId=does-not-exist`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
  });
});
