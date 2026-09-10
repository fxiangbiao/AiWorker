/**
 * 工具产物（artifact）构建测试（Sprint 45+ 预览）。
 * 用 toolRegistry 直接调 handler，验证 fs_read/fs_write/fs_edit 产出 file/diff artifact、
 * 二进制安全化，以及 preview.ts 纯函数（mime/kind/root/rel/sniff/diff）。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { toolRegistry } from "../src/core/tool-registry.js";
import type { ToolContext } from "../src/types.js";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import {
  mimeFromPath,
  kindFromMime,
  isTextPath,
  fileRootRel,
  buildFileArtifact,
  sniffIsBinary,
  simpleDiffLines,
} from "../src/core/preview.js";

const testDir = makeTestDir("preview-arts");

beforeAll(() => {
  clearTools();
  setupEnv(testDir);
});

afterAll(() => teardownEnv());

function ctx(dir: string): ToolContext {
  return { agentId: "test", sessionId: "test", workingDir: dir, permissions: "auto", dataDir: resolve(testDir, "data") };
}

describe("preview 工具产物（Sprint 45+）", () => {
  it("mimeFromPath / kindFromMime / isTextPath", () => {
    expect(mimeFromPath("a.md")).toBe("text/markdown");
    expect(mimeFromPath("b.ts")).toBe("text/typescript");
    expect(mimeFromPath("c.png")).toBe("image/png");
    expect(mimeFromPath("d.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFromPath("e.unknownext")).toBe("application/octet-stream");
    expect(kindFromMime(mimeFromPath("x.png"))).toBe("image");
    expect(kindFromMime(mimeFromPath("y.docx"))).toBe("office");
    expect(kindFromMime(mimeFromPath("z.pdf"))).toBe("pdf");
    expect(kindFromMime(mimeFromPath("a.md"))).toBe("text");
    expect(kindFromMime(mimeFromPath("v.mp4"))).toBe("video");
    expect(isTextPath("a.md")).toBe(true);
    expect(isTextPath("b.ts")).toBe(true);
    expect(isTextPath("v.mp4")).toBe(false);
  });

  it("fileRootRel / buildFileArtifact（project 相对路径）", () => {
    const wd = resolve(testDir, "proj");
    const src = resolve(wd, "src");
    mkdirSync(src, { recursive: true });
    const f = resolve(src, "x.md");
    writeFileSync(f, "# 标题", "utf-8");
    const rr = fileRootRel(f, wd, resolve(testDir, "data"));
    expect(rr.root).toBe("project");
    expect(rr.rel).toBe("src/x.md".replace(/\\/g, "/"));
    const a = buildFileArtifact(f, 5, wd, resolve(testDir, "data"));
    expect(a.type).toBe("file");
    if (a.type === "file") {
      expect(a.root).toBe("project");
      expect(a.rel).toBe("src/x.md".replace(/\\/g, "/"));
      expect(a.kind).toBe("text");
    }
  });

  it("sniffIsBinary / simpleDiffLines", () => {
    expect(sniffIsBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]))).toBe(true); // PNG 头含 NUL
    expect(sniffIsBinary(Buffer.from("hello world\nplain text"))).toBe(false);
    expect(simpleDiffLines("a\nb\nc", "a\nB\nc")).toEqual(["-b", "+B"]);
    expect(simpleDiffLines("same", "same")).toEqual(["~无内容变化"]);
  });

  it("fs_read 文本产物（含 root/rel）", async () => {
    const h = toolRegistry.getHandler("fs_read")!;
    const dir = resolve(testDir, "txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "note.md"), "# 标题\n正文", "utf-8");
    const r = await h({ path: "note.md" }, ctx(dir));
    expect(r.success).toBe(true);
    expect(r.content).toContain("标题");
    expect(r.artifacts?.length).toBe(1);
    const a = r.artifacts![0]!;
    expect(a.type).toBe("file");
    if (a.type === "file") {
      expect(a.kind).toBe("text");
      expect(a.rel).toBe("note.md");
      expect(a.mime).toBe("text/markdown");
    }
  });

  it("fs_read 二进制产物（不整读 utf-8，content 短元信息）", async () => {
    const h = toolRegistry.getHandler("fs_read")!;
    const dir = resolve(testDir, "bin");
    mkdirSync(dir, { recursive: true });
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
    writeFileSync(resolve(dir, "img.png"), pngHeader);
    const r = await h({ path: "img.png" }, ctx(dir));
    expect(r.success).toBe(true);
    expect(r.content).toContain("二进制");
    const a = r.artifacts![0]!;
    if (a.type === "file") expect(a.kind).toBe("image");
  });

  it("fs_edit 产物（file + diff patch）", async () => {
    const h = toolRegistry.getHandler("fs_edit")!;
    const dir = resolve(testDir, "ed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "t.ts"), "a\nb\nc", "utf-8");
    const r = await h({ path: "t.ts", oldText: "b", newText: "B" }, ctx(dir));
    expect(r.success).toBe(true);
    const kinds = r.artifacts?.map((x) => x.type) ?? [];
    expect(kinds).toContain("file");
    expect(kinds).toContain("diff");
    const diff = r.artifacts!.find((x) => x.type === "diff");
    if (diff?.type === "diff") expect(diff.patch).toContain("-b\n+B");
  });

  it("fs_write 产物（file）", async () => {
    const h = toolRegistry.getHandler("fs_write")!;
    const dir = resolve(testDir, "wr");
    mkdirSync(dir, { recursive: true });
    const r = await h({ path: "new.ts", content: "export const x = 1;" }, ctx(dir));
    expect(r.success).toBe(true);
    const a = r.artifacts?.[0];
    expect(a?.type).toBe("file");
    if (a?.type === "file") expect(a.kind).toBe("text");
  });
});
