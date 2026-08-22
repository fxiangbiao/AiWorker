/**
 * 策略化命令沙箱测试（Sprint 28）
 * 覆盖：策略加载默认值 / BOM 容错 / allowDirs 放行 / cwd 越界拒绝 /
 *       denyCommands 拦截 / sanitizeEnv 剥离敏感变量 / 接入 terminal_exec
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv, clearTools } from "./helpers.js";
import { toolRegistry } from "../src/core/tool-registry.js";
import type { ToolContext } from "../src/types.js";

const testDir = makeTestDir("sandbox");

function writeConfig(content: string): string {
  const path = join(testDir, "sandbox.json");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("17. 策略化命令沙箱", () => {
  it("默认策略：缺失配置文件回退默认值", async () => {
    const { loadSandboxPolicy } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(policy.enabled).toBe(true);
    expect(policy.allowDirs).toEqual([]);
    expect(policy.denyCommands).toEqual([]);
    expect(policy.stripSecretEnv).toBe(true);
  });

  it("BOM 容错 + 配置解析", async () => {
    const { loadSandboxPolicy } = await import("../src/security/sandbox.js");
    const path = writeConfig('\uFEFF{"enabled":true,"allowDirs":["C:/work"],"denyCommands":["rm -rf"],"stripSecretEnv":false}');
    const policy = loadSandboxPolicy(path);
    expect(policy.allowDirs).toContain(resolve("C:/work"));
    expect(policy.denyCommands).toEqual(["rm -rf"]);
    expect(policy.stripSecretEnv).toBe(false);
  });

  it("cwd 越界拒绝（fail-closed），工作目录内放行", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const workingDir = resolve(testDir);
    expect(checkCommand("echo hi", workingDir, workingDir, policy).allowed).toBe(true);
    const outside = resolve(workingDir, "..", "..");
    const r = checkCommand("echo hi", outside, workingDir, policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("越界");
  });

  it("allowDirs 配置后覆盖默认 workingDir", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const allowedDir = resolve(testDir, "allowed");
    mkdirSync(allowedDir, { recursive: true });
    const path = writeConfig(JSON.stringify({ enabled: true, allowDirs: [allowedDir] }));
    const policy = loadSandboxPolicy(path);
    expect(checkCommand("echo hi", allowedDir, resolve(testDir), policy).allowed).toBe(true);
    expect(checkCommand("echo hi", resolve(testDir), resolve(testDir), policy).allowed).toBe(false);
  });

  it("denyCommands 子串匹配拦截（大小写不敏感）", async () => {
    const { loadSandboxPolicy, checkCommand, checkDeniedCommand } = await import("../src/security/sandbox.js");
    const path = writeConfig(JSON.stringify({ enabled: true, denyCommands: ["npm publish"] }));
    const policy = loadSandboxPolicy(path);
    expect(checkDeniedCommand("npm publish --dry-run", policy).allowed).toBe(false);
    expect(checkDeniedCommand("NPM PUBLISH test", policy).allowed).toBe(false);
    expect(checkDeniedCommand("npm install", policy).allowed).toBe(true);
    expect(checkCommand("npm publish", resolve(testDir), resolve(testDir), policy).allowed).toBe(false);
  });

  it("disabled 策略全部放行", async () => {
    const { loadSandboxPolicy, checkCommand, checkDeniedCommand } = await import("../src/security/sandbox.js");
    const path = writeConfig(JSON.stringify({ enabled: false, denyCommands: ["rm"] }));
    const policy = loadSandboxPolicy(path);
    expect(checkDeniedCommand("rm -rf /", policy).allowed).toBe(true);
    expect(checkCommand("echo x", resolve(testDir, ".."), resolve(testDir), policy).allowed).toBe(true);
  });

  it("sanitizeEnv 剥离敏感变量、保留 PATH", async () => {
    const { sanitizeEnv } = await import("../src/security/sandbox.js");
    const env = {
      PATH: "C:/bin",
      DEEPSEEK_API_KEY: "sk-1",
      OPENAI_API_KEY: "sk-2",
      MY_TOKEN: "t",
      PASSWORD: "p",
      USERNAME: "alan",
      SystemRoot: "C:/Windows",
    };
    const out = sanitizeEnv(env);
    expect(out.PATH).toBe("C:/bin");
    expect(out.SystemRoot).toBe("C:/Windows");
    expect(out.USERNAME).toBe("alan");
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.MY_TOKEN).toBeUndefined();
    expect(out.PASSWORD).toBeUndefined();
  });
});

describe("18. 沙箱接入 terminal_exec", () => {
  const ctx: ToolContext = {
    agentId: "test",
    sessionId: "sandbox-test",
    workingDir: process.cwd(),
    permissions: "auto",
  };

  beforeAll(() => {
    clearTools();
    setupEnv(testDir);
  });

  afterAll(() => {
    teardownEnv();
    rmSync(join(testDir, "allowed"), { recursive: true, force: true });
  });

  it("cwd 越界被沙箱拒绝（不执行命令）", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo hi", cwd: resolve(process.cwd(), "..") }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("越界");
  });

  it("工作目录内正常执行", async () => {
    const handler = toolRegistry.getHandler("terminal_exec")!;
    const result = await handler({ command: "echo AWN-SANDBOX-OK" }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain("AWN-SANDBOX-OK");
  });
});
