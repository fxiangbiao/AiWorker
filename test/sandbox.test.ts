/**
 * 策略化命令沙箱测试（Sprint 28）
 * 覆盖：策略加载默认值 / BOM 容错 / allowDirs 放行 / cwd 越界拒绝 /
 *       denyCommands 拦截 / sanitizeEnv 剥离敏感变量 / 接入 terminal_exec
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { makeTestDir, setupEnv, teardownEnv, clearTools, makeDirLink, DIR_LINK_SUPPORTED } from "./helpers.js";
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

describe("19. 沙箱写入目标约束（Sprint 47）", () => {
  const wdPath = resolve(testDir, "wr-root");
  const outsidePath = resolve(testDir, "wr-outside.txt");

  it("重定向到工作目录内放行、目录外拒绝", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    mkdirSync(wdPath, { recursive: true });
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand("echo hi > out.txt", wdPath, wdPath, policy).allowed).toBe(true);
    const r = checkCommand(`echo hi > "${outsidePath}"`, wdPath, wdPath, policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("写入越界");
  });

  it("2>&1、>nul 等伪目标不算写入", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand("node x.js 2>&1", wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand("chcp 65001 >nul & echo hi", wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("写入类命令的目录外绝对路径被拒绝（含 PowerShell 包裹）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const ps = `powershell -Command "Set-Content -Path ${outsidePath} -Value 1"`;
    const r = checkCommand(ps, wdPath, wdPath, policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("写入越界");
  });

  it("目录内相对路径写入放行（del *.log / mkdir sub / copy a b）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand("del *.log", wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand("mkdir sub", wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand("copy a.txt b.txt", wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("含变量/通配的不可解析写入目标 fail-closed", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const r = checkCommand("echo x > $env:TEMP\\a.txt", wdPath, wdPath, policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("无法静态解析");
  });

  it("allowWriteDirs 配置后覆盖默认工作目录", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const extra = resolve(testDir, "wr-extra");
    mkdirSync(extra, { recursive: true });
    const path = writeConfig(JSON.stringify({ enabled: true, allowWriteDirs: [wdPath, extra] }));
    const policy = loadSandboxPolicy(path);
    expect(checkCommand(`echo hi > "${resolve(extra, "a.txt")}"`, wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand(`echo hi > "${outsidePath}"`, wdPath, wdPath, policy).allowed).toBe(false);
  });

  it("沙箱关闭时不施加写入约束", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const path = writeConfig(JSON.stringify({ enabled: false }));
    const policy = loadSandboxPolicy(path);
    expect(checkCommand(`echo hi > "${outsidePath}"`, wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("注释文本里的写入词不误判（git commit -m \"copy fix\"）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand('git commit -m "copy fix"', wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("带值开关不遮蔽真实写入目标（-Encoding / -ItemType / -Value）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const evilDir = resolve(testDir, "wr-evil");
    for (const cmd of [
      `Set-Content -Encoding utf8 "${outsidePath}" -Value hi`,
      `Add-Content -Value hi -Path "${outsidePath}"`,
      `Out-File -Encoding utf8 "${outsidePath}"`,
      `New-Item -ItemType Directory -Path "${evilDir}"`,
    ]) {
      const r = checkCommand(cmd, wdPath, wdPath, policy);
      expect(r.allowed, cmd).toBe(false);
      expect(r.reason).toContain("写入越界");
    }
  });

  it("写入类命令的源与目标都校验（只查首个 token 会被 copy/move 绕过）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand(`Copy-Item a.txt "${outsidePath}"`, wdPath, wdPath, policy).allowed).toBe(false);
    expect(checkCommand(`Move-Item "${outsidePath}" a.txt`, wdPath, wdPath, policy).allowed).toBe(false);
    expect(checkCommand("Copy-Item a.txt b.txt", wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand("Set-Content -Path out.txt -Value \"see docs/notes\"", wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("PowerShell 别名与常见写入程序纳入校验（目录外拒绝、目录内放行）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const evilDir = resolve(testDir, "wr-evil");
    const denied = [
      `rm -rf "${outsidePath}"`,
      `rm -rf ${evilDir}`,
      `ri "${outsidePath}"`,
      `ni -ItemType Directory "${evilDir}"`,
      `sc "${outsidePath}" hi`,
      `cp a.txt "${outsidePath}"`,
      `mv a.txt "${outsidePath}"`,
      `curl -o "${outsidePath}" https://example.com/a.zip`,
      `Invoke-WebRequest -OutFile "${outsidePath}" https://example.com/a.zip`,
      `robocopy . "${evilDir}" /E`,
      `xcopy /E . "${evilDir}"`,
      `tar -xf a.zip -C "${evilDir}"`,
      `git clone https://example.com/a.git "${evilDir}"`,
      `npm install --prefix "${evilDir}"`,
    ];
    for (const cmd of denied) expect(checkCommand(cmd, wdPath, wdPath, policy).allowed, cmd).toBe(false);

    const allowed = [
      "rm -rf dist",
      "ni -ItemType Directory sub",
      "cp a.txt b.txt",
      "curl -o out.zip https://example.com/a.zip",
      "robocopy . build /E",
      "tar -xf a.zip -C sub",
      "git clone https://example.com/a.git local-clone",
      "npm install --prefix .",
      "git status",
    ];
    for (const cmd of allowed) expect(checkCommand(cmd, wdPath, wdPath, policy).allowed, cmd).toBe(true);
  });

  it("重定向引号感知：引号内的 > 不算重定向，解释器包裹内仍拦截", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    expect(checkCommand('echo "compare > C:\\Windows\\a.txt"', wdPath, wdPath, policy).allowed).toBe(true);
    expect(checkCommand(`cmd /c "echo x > ${outsidePath}"`, wdPath, wdPath, policy).allowed).toBe(false);
    expect(checkCommand(`powershell -Command "Out-File -FilePath ${outsidePath}"`, wdPath, wdPath, policy).allowed).toBe(false);
  });
});

describe("20. 路径策略与命令沙箱同源（Sprint 49）", () => {
  const wdPath = resolve(testDir, "pp-root");
  const outsidePath = resolve(testDir, "pp-outside");

  beforeAll(() => {
    mkdirSync(wdPath, { recursive: true });
    mkdirSync(outsidePath, { recursive: true });
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("命令写入目标经符号链接越界被拦截（与 fs 工具同一真实路径判定）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const policy = loadSandboxPolicy(join(testDir, "not-exist.json"));
    const link = resolve(wdPath, "esc");
    rmSync(link, { recursive: true, force: true });
    expect(makeDirLink(link, outsidePath)).toBe(true);
    expect(checkCommand("Set-Content -Path esc\\pwned.txt -Value x", wdPath, wdPath, policy).allowed).toBe(false);
    expect(checkCommand("echo hi > esc\\pwned.txt", wdPath, wdPath, policy).allowed).toBe(false);
  });

  it("allowReadDirs 不影响命令层写入约束（读根与写根相互独立）", async () => {
    const { loadSandboxPolicy, checkCommand } = await import("../src/security/sandbox.js");
    const path = writeConfig(JSON.stringify({ enabled: true, allowReadDirs: [outsidePath] }));
    const policy = loadSandboxPolicy(path);
    expect(checkCommand(`echo hi > "${resolve(outsidePath, "a.txt")}"`, wdPath, wdPath, policy).allowed).toBe(false);
    expect(checkCommand(`echo hi > "${resolve(wdPath, "a.txt")}"`, wdPath, wdPath, policy).allowed).toBe(true);
  });

  it("配置 include allowReadDirs 的解析（默认空数组，留空回退工作目录）", async () => {
    const { loadSandboxPolicy } = await import("../src/security/sandbox.js");
    expect(loadSandboxPolicy(join(testDir, "not-exist.json")).allowReadDirs).toEqual([]);
    const path = writeConfig(JSON.stringify({ enabled: true, allowReadDirs: [outsidePath] }));
    expect(loadSandboxPolicy(path).allowReadDirs).toEqual([resolve(outsidePath)]);
  });

  it("配置路径跟随 --dir：工作目录优先于启动目录，无关同名文件被忽略", async () => {
    const { resolveSandboxConfigPath } = await import("../src/security/sandbox.js");
    const base = makeTestDir("sandbox-path");
    const work = join(base, "work");
    const cwd = join(base, "cwd");
    mkdirSync(join(work, "config"), { recursive: true });
    mkdirSync(join(cwd, "config"), { recursive: true });

    writeFileSync(join(cwd, "config", "sandbox.json"), JSON.stringify({ enabled: true, allowWriteDirs: [cwd] }), "utf-8");
    expect(resolveSandboxConfigPath(work, cwd)).toBe(join(cwd, "config", "sandbox.json"));

    writeFileSync(join(work, "config", "sandbox.json"), JSON.stringify({ enabled: true, allowWriteDirs: [work] }), "utf-8");
    expect(resolveSandboxConfigPath(work, cwd)).toBe(join(work, "config", "sandbox.json"));

    // 工作目录里放一份"别的工具的" sandbox.json → 忽略并回落启动目录
    writeFileSync(join(work, "config", "sandbox.json"), JSON.stringify({ unrelated: 1 }), "utf-8");
    expect(resolveSandboxConfigPath(work, cwd)).toBe(join(cwd, "config", "sandbox.json"));

    // 两边都没有 → 回落到包内 config/sandbox.json（存在 && 有已知键）
    const empty = makeTestDir("sandbox-path-empty");
    expect(resolveSandboxConfigPath(empty, join(base, "no-such"))).toContain("config");
  });
});
