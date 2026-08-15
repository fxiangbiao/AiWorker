/**
 * 超长工具结果落盘（spill）单测（Sprint 26）
 * 覆盖：阈值内直返、超阈值落盘+定位符、无 dataDir 原地截断、落盘文件内容完整
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir } from "./helpers.js";
import { spillOrTruncate, SPILL_THRESHOLD, SPILL_PREVIEW_CHARS } from "../src/tools/spill.js";

describe("spillOrTruncate", () => {
  it("未超阈值原样返回", () => {
    expect(spillOrTruncate(undefined, "s1", "short")).toBe("short");
    expect(spillOrTruncate("/tmp", "s1", "x".repeat(SPILL_THRESHOLD))).toBe("x".repeat(SPILL_THRESHOLD));
  });

  it("超阈值且有 dataDir 时落盘并返回定位符（含路径/字符数/预览）", () => {
    const dir = makeTestDir("spill");
    const big = "A".repeat(SPILL_THRESHOLD + 500);
    const out = spillOrTruncate(dir, "sess-1", big, "txt");

    expect(out).toContain("[结果已落盘:");
    expect(out).toContain("spills/sess-1-");
    expect(out).toContain(`${big.length} 字符`);
    expect(out).toContain("A".repeat(SPILL_PREVIEW_CHARS));

    // 落盘文件真实存在且内容完整（事件只存定位符，完整内容在磁盘）
    const spillsDir = resolve(dir, "spills");
    expect(existsSync(spillsDir)).toBe(true);
    const files = readdirSync(spillsDir);
    expect(files.length).toBe(1);
    expect(readFileSync(resolve(spillsDir, files[0]!), "utf-8")).toBe(big);
  });

  it("无 dataDir 时原地截断（防上下文撑爆兜底）", () => {
    const big = "B".repeat(SPILL_THRESHOLD + 100);
    const out = spillOrTruncate(undefined, "s1", big);
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(SPILL_THRESHOLD);
    expect(out).toContain(`${big.length} 字符`);
  });
});
