/**
 * 极简 .env 加载器测试（Sprint 30）
 * 覆盖：KEY=VALUE / 注释 / 空行 / 引号剥除 / 不覆盖已有变量 / BOM / 缺失文件
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { makeTestDir } from "./helpers.js";

const dir = makeTestDir("env-loader");

const KEYS = ["AWN_TEST_KEY1", "AWN_TEST_KEY2", "AWN_TEST_KEY3", "AWN_TEST_QUOTED", "AWN_TEST_EXISTING"];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  rmSync(resolve(dir, ".env"), { force: true });
});

function writeEnv(content: string): string {
  const path = resolve(dir, ".env");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("19. env-loader", () => {
  it("解析 KEY=VALUE、注释与空行", async () => {
    const { loadEnvFile } = await import("../src/core/env-loader.js");
    writeEnv("# 注释\n\nAWN_TEST_KEY1=value1\nAWN_TEST_KEY2=value2\n");
    loadEnvFile(resolve(dir, ".env"));
    expect(process.env.AWN_TEST_KEY1).toBe("value1");
    expect(process.env.AWN_TEST_KEY2).toBe("value2");
  });

  it("剥除可选引号", async () => {
    const { loadEnvFile } = await import("../src/core/env-loader.js");
    writeEnv('AWN_TEST_QUOTED="hello world"\nAWN_TEST_KEY3=\'single\'');
    loadEnvFile(resolve(dir, ".env"));
    expect(process.env.AWN_TEST_QUOTED).toBe("hello world");
    expect(process.env.AWN_TEST_KEY3).toBe("single");
  });

  it("不覆盖已有环境变量", async () => {
    const { loadEnvFile } = await import("../src/core/env-loader.js");
    process.env.AWN_TEST_EXISTING = "original";
    writeEnv("AWN_TEST_EXISTING=from-file");
    loadEnvFile(resolve(dir, ".env"));
    expect(process.env.AWN_TEST_EXISTING).toBe("original");
  });

  it("BOM 容错", async () => {
    const { loadEnvFile } = await import("../src/core/env-loader.js");
    writeEnv("\uFEFFAWN_TEST_KEY1=bom-ok");
    loadEnvFile(resolve(dir, ".env"));
    expect(process.env.AWN_TEST_KEY1).toBe("bom-ok");
  });

  it("缺失文件静默", async () => {
    const { loadEnvFile } = await import("../src/core/env-loader.js");
    expect(() => loadEnvFile(resolve(dir, "not-exist.env"))).not.toThrow();
  });
});
