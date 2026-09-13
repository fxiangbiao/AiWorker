/**
 * 设置页写面测试（Sprint 50 / IA 重构）
 *
 * 覆盖三件本轮新增/收口的可写面，每件都必须回答"写到哪里、能否失败得干净、何时生效"：
 * 1. `GET/POST /api/v1/sandbox`——沙箱配置（设置→工作区/安全），**立即生效**（每次工具调用现读磁盘）
 * 2. `POST /api/v1/permissions` 的 `set-protected-paths` / `set-never-auto-approve`——安全清单，
 *    需要在**不重启**的情况下更新运行中的 PermissionModel，且移除内置基线时必须显式确认
 * 3. `POST /api/v1/config` 补上的写入门（跨站 403 → 缺 token 401）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { makeTestDir } from "./helpers.js";
import { startServer } from "../src/server.js";
import { PermissionMemory } from "../src/security/permission-memory.js";
import { DEFAULT_PROTECTED_PATHS, PermissionModel } from "../src/security/permission-model.js";
import { describeSandboxPolicy, loadSandboxPolicy, resolveSandboxConfigPath, resolveSandboxWritePath, saveSandboxPolicy } from "../src/security/sandbox.js";
import type { PermissionConfig, PermissionRule } from "../src/types.js";

const testDir = makeTestDir("settings-api");
const configDir = join(testDir, "config");
const permissionsPath = join(configDir, "permissions.json");
const sandboxPath = join(configDir, "sandbox.json");

const BASE_PERMISSIONS = {
  default_mode: "auto",
  rules: [] as PermissionRule[],
  never_auto_approve: ["terminal_exec"],
  protected_paths: [".git", ".ssh", ".env", "id_rsa"],
  custom_field: "保留我",
};

function writePermissionsFile(): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(permissionsPath, `\uFEFF${JSON.stringify(BASE_PERMISSIONS, null, 2)}\n`, "utf-8");
}

function writeSandboxFile(): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    sandboxPath,
    `\uFEFF${JSON.stringify({ enabled: true, allowDirs: [], allowWriteDirs: [], allowReadDirs: [], denyCommands: [], stripSecretEnv: true, custom_field: "保留我" }, null, 2)}\n`,
    "utf-8",
  );
}

function modelFromFile(): PermissionModel {
  const raw = JSON.parse(readFileSync(permissionsPath, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  return new PermissionModel({
    defaultMode: "auto",
    modes: {
      ask: { description: "只读", allow_tool_calls: true, readOnly: true },
      plan: { description: "计划", allow_tool_calls: false, require_confirmation: true },
      auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
    },
    allowedDirs: [],
    deniedPatterns: [],
    rules: (raw.rules as PermissionRule[]) ?? [],
    neverAutoApprove: raw.never_auto_approve as string[],
    protectedPaths: raw.protected_paths as string[],
  } as PermissionConfig);
}

function fileJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

/** 起一个只注入本轮所需 deps 的 server，返回 base/token/close */
async function startTestServer(deps: Record<string, unknown>): Promise<{ base: string; token: string; close: () => void }> {
  const server = startServer(
    {
      modelRouter: {} as never,
      workingDir: testDir,
      coordinator: {} as never,
      createAgent: () => undefined,
      getAgentList: () => [],
      skillNames: [],
      dataDir: testDir,
      ...deps,
    } as never,
    0,
  );
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    token: readFileSync(join(testDir, "server-token"), "utf-8"),
    close: () => server.close(),
  };
}

describe("沙箱配置读写（saveSandboxPolicy / GET POST /sandbox）", () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    writeSandboxFile();
  });

  it("写路径跟随 --dir（不落到安装目录），保留未知键与 BOM，改完立即读到新值", () => {
    expect(resolveSandboxWritePath(testDir)).toBe(sandboxPath);
    const r = saveSandboxPolicy(
      { allowWriteDirs: [join(testDir, "work")], denyCommands: ["rm -rf", "format"], stripSecretEnv: false },
      { workingDir: testDir },
    );
    expect(r.ok).toBe(true);
    expect(r.path).toBe(sandboxPath);

    const written = fileJson(sandboxPath);
    expect(written.custom_field).toBe("保留我"); // 未知键保留
    expect(written.allowWriteDirs).toEqual([join(testDir, "work")]);
    expect(written.stripSecretEnv).toBe(false);
    expect(readFileSync(sandboxPath, "utf-8").charCodeAt(0)).toBe(0xfeff); // BOM 保留

    // 生效性：loadSandboxPolicy 每次现读磁盘 → 不需要重启
    const policy = loadSandboxPolicy(resolveSandboxConfigPath(testDir));
    expect(policy.allowWriteDirs).toEqual([join(testDir, "work")]);
    expect(policy.denyCommands).toEqual(["rm -rf", "format"]);
    expect(policy.stripSecretEnv).toBe(false);
  });

  it("校验拒绝：未知键 / 非布尔 / 相对路径 / 空条目 / 多行命令，且不落盘", () => {
    const before = readFileSync(sandboxPath, "utf-8");
    expect(saveSandboxPolicy({ allowWriteDir: [] }, { workingDir: testDir }).reason).toContain("未知配置项");
    expect(saveSandboxPolicy({ enabled: "yes" }, { workingDir: testDir }).reason).toContain("布尔值");
    expect(saveSandboxPolicy({ allowReadDirs: ["relative/dir"] }, { workingDir: testDir }).reason).toContain("绝对路径");
    expect(saveSandboxPolicy({ denyCommands: ["  "] }, { workingDir: testDir }).reason).toContain("空条目");
    expect(saveSandboxPolicy({ denyCommands: ["a\nb"] }, { workingDir: testDir }).reason).toContain("多行");
    expect(readFileSync(sandboxPath, "utf-8")).toBe(before);
  });

  it("目录去重（大小写不敏感）且 effective 展示回退后的真实生效范围", () => {
    const dir = join(testDir, "Work");
    expect(saveSandboxPolicy({ allowReadDirs: [dir, dir.toUpperCase()] }, { workingDir: testDir }).ok).toBe(true);
    expect((fileJson(sandboxPath).allowReadDirs as string[]).length).toBe(1);

    // 留空 → 回退工作目录：用户必须能看到"真正生效的范围"
    saveSandboxPolicy({ allowReadDirs: [], allowWriteDirs: [], allowDirs: [] }, { workingDir: testDir });
    const eff = describeSandboxPolicy(loadSandboxPolicy(resolveSandboxConfigPath(testDir)), testDir);
    expect(eff.allowDirs).toEqual([testDir]);
    expect(eff.allowWriteDirs).toEqual([testDir]);
    expect(eff.allowReadDirs).toEqual([testDir]);
  });

  it("已有同名文件但不是沙箱配置 → 拒绝覆盖（不碰别的工具的配置）", () => {
    writeFileSync(sandboxPath, JSON.stringify({ totally: "other" }), "utf-8");
    const r = saveSandboxPolicy({ enabled: false }, { workingDir: testDir });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("拒绝覆盖");
    expect(fileJson(sandboxPath)).toEqual({ totally: "other" });
  });

  it("HTTP：GET 返回读/写路径与生效值；POST 走三道门并在失败时回带当前快照", async () => {
    const { base, token, close } = await startTestServer({});
    try {
      const got = (await (await fetch(`${base}/sandbox`)).json()) as {
        writePath: string;
        readPath: string;
        exists: boolean;
        policy: { enabled: boolean };
        effective: { allowWriteDirs: string[] };
      };
      expect(got.writePath).toBe(sandboxPath);
      expect(got.exists).toBe(true);
      expect(got.policy.enabled).toBe(true);
      expect(got.effective.allowWriteDirs).toEqual([testDir]); // 配置里为空 → 回退工作目录

      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aiworker-token": token, ...headers },
          body: JSON.stringify(body),
        });

      expect((await post({ enabled: false }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post({ enabled: false }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post({ enabled: false }, { "x-aiworker-token": "" })).status).toBe(401);

      const bad = await post({ allowWriteDirs: ["rel"] });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain("绝对路径");

      const ok = await post({ allowReadDirs: [join(testDir, "shared")] });
      expect(ok.status).toBe(200);
      expect((fileJson(sandboxPath).allowReadDirs as string[])).toEqual([join(testDir, "shared")]);

      expect((await fetch(`${base}/sandbox`, { method: "DELETE" })).status).toBe(405);
    } finally {
      close();
    }
  });
});

describe("安全清单写入（PermissionMemory.setSafetyList / /permissions 扩展）", () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    writePermissionsFile();
  });

  it("未确认移除内置基线 → 拒绝，且文件与内存都不动", () => {
    const model = modelFromFile();
    const memory = new PermissionMemory({ model, configPath: permissionsPath, log: () => {} });
    const before = readFileSync(permissionsPath, "utf-8");
    const kept = [".git", ".env"];

    const r = memory.setSafetyList("protected_paths", kept, { defaults: DEFAULT_PROTECTED_PATHS });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("需确认");
    // 被移除的正是"内置基线里没被保留的那些"——逐条对齐，避免把数量写死
    expect([...(r.removedDefaults ?? [])].sort()).toEqual(
      [...DEFAULT_PROTECTED_PATHS].filter((d) => !kept.includes(d)).sort(),
    );
    expect(readFileSync(permissionsPath, "utf-8")).toBe(before);
    expect(model.getProtectedPaths()).toEqual([".git", ".ssh", ".env", "id_rsa"]);
  });

  it("确认后落盘并**立即**更新运行中的模型（无需重启），并保留其他字段与 BOM", () => {
    const model = modelFromFile();
    const memory = new PermissionMemory({ model, configPath: permissionsPath, log: () => {} });

    // 新增一条：清单 = 全部内置基线 + secrets（不丢任何基线 → 无需确认）
    const added = memory.setSafetyList(
      "protected_paths",
      [...DEFAULT_PROTECTED_PATHS, "secrets"],
      { defaults: DEFAULT_PROTECTED_PATHS },
    );
    expect(added.ok).toBe(true);
    expect(added.warning).toBeUndefined();
    const afterAdd = fileJson(permissionsPath);
    expect(afterAdd.custom_field).toBe("保留我");
    expect(afterAdd.protected_paths).toEqual([...DEFAULT_PROTECTED_PATHS, "secrets"]);
    expect(readFileSync(permissionsPath, "utf-8").charCodeAt(0)).toBe(0xfeff);
    // 生效性：模型已经用新清单判定（大小写/斜杠归一化与构造时一致）
    expect(model.getProtectedPaths()).toContain("secrets");
    expect(model.isProtectedTarget("cat secrets/token")).toBe(true);
    expect(model.isProtectedTarget(".SSH/id_rsa")).toBe(true); // 归一化后大小写不敏感
    // 注意：`.ssh/id_rsa` 命中的是 `.ssh` 段规则，与 id_rsa 这条无关——测 id_rsa 必须用不带 .ssh 的路径
    expect(model.isProtectedTarget("C:/keys/id_rsa")).toBe(true);

    const dropped = memory.setSafetyList("protected_paths", [".git", ".ssh", ".env"], {
      defaults: DEFAULT_PROTECTED_PATHS,
      acknowledge: true,
    });
    expect(dropped.ok).toBe(true);
    expect(dropped.warning).toContain("id_rsa");
    expect(model.isProtectedTarget("C:/keys/id_rsa")).toBe(false);
    expect(model.getProtectedPaths()).not.toContain("id_rsa");
  });

  it("永不自动批准：写入即生效；非法条目一律拒绝", () => {
    const model = modelFromFile();
    const memory = new PermissionMemory({ model, configPath: permissionsPath, log: () => {} });
    expect(model.isNeverAutoApprove("terminal_exec")).toBe(true);

    const r = memory.setSafetyList("never_auto_approve", ["terminal_exec", "fs_write"], { defaults: [] });
    expect(r.ok).toBe(true);
    expect(fileJson(permissionsPath).never_auto_approve).toEqual(["terminal_exec", "fs_write"]);
    expect(model.isNeverAutoApprove("fs_write")).toBe(true);

    expect(memory.setSafetyList("never_auto_approve", "terminal_exec", { defaults: [] }).reason).toContain("数组");
    expect(memory.setSafetyList("never_auto_approve", [123], { defaults: [] }).reason).toContain("字符串");
    expect(memory.setSafetyList("never_auto_approve", ["  "], { defaults: [] }).reason).toContain("空字符串");
    expect(memory.setSafetyList("never_auto_approve", ["a\r\nb"], { defaults: [] }).reason).toContain("多行");
  });

  it("HTTP：GET 带出生效清单与内置基线；POST 需 token，未确认移除基线返回 400 与被移除项", async () => {
    const model = modelFromFile();
    const memory = new PermissionMemory({ model, configPath: permissionsPath, log: () => {} });
    const { base, token, close } = await startTestServer({ permissionMemory: memory, permissionModel: model });
    try {
      const got = (await (await fetch(`${base}/permissions`)).json()) as {
        mode: string;
        protectedPaths: { fromConfig: string[] | null; defaults: string[]; effective: string[] };
        neverAutoApprove: { fromConfig: string[] | null; effective: string[] };
      };
      expect(got.mode).toBe("auto"); // 只读展示当前模式
      expect(got.protectedPaths.fromConfig).toEqual([".git", ".ssh", ".env", "id_rsa"]);
      expect(got.protectedPaths.defaults).toEqual([...DEFAULT_PROTECTED_PATHS]);
      expect(got.protectedPaths.effective).toContain(".ssh");
      expect(got.neverAutoApprove.effective).toEqual(["terminal_exec"]);

      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}/permissions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aiworker-token": token, ...headers },
          body: JSON.stringify(body),
        });

      expect((await post({ action: "set-protected-paths", values: [] }, { "x-aiworker-token": "" })).status).toBe(401);
      expect((await post({ action: "set-protected-paths", values: [] }, { "sec-fetch-site": "cross-site" })).status).toBe(403);

      const needAck = await post({ action: "set-protected-paths", values: [".git"] });
      expect(needAck.status).toBe(400);
      const ackBody = (await needAck.json()) as { error: string; removedDefaults: string[] };
      expect(ackBody.error).toContain("需确认");
      expect(ackBody.removedDefaults.length).toBeGreaterThan(0);

      const confirmed = await post({ action: "set-protected-paths", values: [".git"], acknowledge: true });
      expect(confirmed.status).toBe(200);
      expect(model.getProtectedPaths()).toEqual([".git"]);

      expect((await post({ action: "set-never-auto-approve", values: [] })).status).toBe(200);
      expect(model.getNeverAutoApprove()).toEqual([]);
      // 空清单会清掉文件里的键值（此时文件里是 []，不再是缺失）
      const listed = (await (await fetch(`${base}/permissions`)).json()) as { neverAutoApprove: { fromConfig: string[] | null } };
      expect(listed.neverAutoApprove.fromConfig).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("POST /config 写入门（Sprint 50 收口）", () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("跨站 403 / 缺 token 401 / 缺字段 400 / 合法请求 200（并回带最新状态）", async () => {
    const applied: Array<{ field: string; value: unknown }> = [];
    const { base, token, close } = await startTestServer({
      getConfigState: () => ({ model: "deepseek-flash", thinking: true }),
      setConfigField: (field: string, value: unknown) => {
        applied.push({ field, value });
        return { ok: true };
      },
    });
    try {
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}/config`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aiworker-token": token, ...headers },
          body: JSON.stringify(body),
        });

      expect((await post({ field: "thinking", value: false }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post({ field: "thinking", value: false }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post({ field: "thinking", value: false }, { "x-aiworker-token": "" })).status).toBe(401);
      expect((await post({})).status).toBe(400);
      expect(applied).toEqual([]);

      const ok = await post({ field: "thinking", value: false });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; state: { thinking: boolean } };
      expect(body.ok).toBe(true);
      expect(body.state.thinking).toBe(true); // state 来自 mock getConfigState
      expect(applied).toEqual([{ field: "thinking", value: false }]);

      // GET 不需要写入门（只读）
      expect((await fetch(`${base}/config`)).status).toBe(200);
    } finally {
      close();
    }
  });
});
