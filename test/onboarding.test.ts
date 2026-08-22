/**
 * 首次运行引导测试（Sprint 30）
 * 覆盖：触发条件 / 三步流程（写 .env + permissions.json + 标记）/ 跳过语义
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeTestDir } from "./helpers.js";

describe("20. 首次运行引导", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTestDir("onboarding");
  });

  it("shouldOnboard：未完成标记时触发，完成后不再触发", async () => {
    const { shouldOnboard, onboardingMarkPath, runOnboarding } = await import("../src/core/onboarding.js");
    expect(shouldOnboard(dir)).toBe(true);

    const logs: string[] = [];
    const result = await runOnboarding({
      ask: async () => "sk-test-key",
      dataDir: dir,
      workingDir: resolve(dir, "work"),
      writeEnv: (k, v) => {
        process.env[k] = v;
        writeFileSync(resolve(dir, ".env"), `${k}=${v}\n`);
      },
      writeDefaultMode: (m) => writeFileSync(resolve(dir, "permissions.json"), JSON.stringify({ default_mode: m })),
      log: (l) => logs.push(l),
    });

    expect(result).toBe("completed");
    expect(existsSync(onboardingMarkPath(dir))).toBe(true);
    expect(shouldOnboard(dir)).toBe(false);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-test-key");
    expect(readFileSync(resolve(dir, ".env"), "utf-8")).toContain("DEEPSEEK_API_KEY=sk-test-key");
    expect(readFileSync(resolve(dir, "permissions.json"), "utf-8")).toContain("auto");
    expect(logs.some((l) => l.includes("引导完成"))).toBe(true);
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("跳过（无 key）也写标记，返回 skipped", async () => {
    const { shouldOnboard, onboardingMarkPath, runOnboarding } = await import("../src/core/onboarding.js");
    const result = await runOnboarding({
      ask: async () => null,
      dataDir: dir,
      workingDir: resolve(dir, "work"),
      writeEnv: () => {},
      writeDefaultMode: () => {},
      log: () => {},
    });
    expect(result).toBe("skipped");
    expect(existsSync(onboardingMarkPath(dir))).toBe(true);
    expect(shouldOnboard(dir)).toBe(false);
  });

  it("非法模式回退 auto", async () => {
    const { runOnboarding } = await import("../src/core/onboarding.js");
    const modes: string[] = [];
    const result = await runOnboarding({
      ask: async (q) => (q.includes("权限模式") ? "banana" : null),
      dataDir: dir,
      workingDir: dir,
      writeEnv: () => {},
      writeDefaultMode: (m) => modes.push(m),
      log: () => {},
    });
    expect(result).toBe("skipped");
    expect(modes).toEqual(["auto"]);
  });
});
