/**
 * 权限记忆测试（Sprint 49 / P1-4）
 * 覆盖：会话/项目两级来源 / 原子落盘与字段保留 / 撤销与重置 / 非法与缺失文件的 fail-closed /
 *       allow 不得架空 never_auto_approve 与受保护路径 / deny 不被 allow 覆盖 / 审计事件
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join, dirname, resolve } from "node:path";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { startServer } from "../src/server.js";
import { auditLogger } from "../src/core/audit-logger.js";
import { PermissionMemory, resolvePermissionConfigPath } from "../src/security/permission-memory.js";
import { PermissionModel } from "../src/security/permission-model.js";
import type { PermissionConfig, PermissionRule } from "../src/types.js";

const testDir = makeTestDir("permission-memory");
const configDir = join(testDir, "config");
const configPath = join(configDir, "permissions.json");

const BASE_CONFIG = {
  default_mode: "auto",
  modes: {
    ask: { description: "只读", allow_tool_calls: true, readOnly: true },
    plan: { description: "计划", allow_tool_calls: false, require_confirmation: true },
    auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
  },
  allowed_dirs: [],
  rules: [],
  never_auto_approve: ["terminal_exec"],
  protected_paths: [".git", ".ssh", ".env", "id_rsa"],
  custom_field: "保留我",
};

/** 由文件内容构造模型（与 bootstrap 的加载路径一致） */
function modelFromFile(path: string, extra: Partial<PermissionConfig> = {}): PermissionModel {
  const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  return new PermissionModel({
    defaultMode: (raw.default_mode as PermissionConfig["defaultMode"]) ?? "auto",
    modes: raw.modes as PermissionConfig["modes"],
    allowedDirs: [],
    deniedPatterns: [],
    rules: raw.rules as PermissionRule[],
    neverAutoApprove: raw.never_auto_approve as string[],
    protectedPaths: raw.protected_paths as string[],
    ...extra,
  } as PermissionConfig);
}

function writeConfig(rules: unknown[] = [], hadBom = true): void {
  mkdirSync(configDir, { recursive: true });
  const body = JSON.stringify({ ...BASE_CONFIG, rules }, null, 2);
  writeFileSync(configPath, `${hadBom ? "\uFEFF" : ""}${body}\n`, "utf-8");
}

interface Harness {
  memory: PermissionMemory;
  model: PermissionModel;
  events: string[];
  fileRules: () => unknown[];
  fileText: () => string;
}

function makeHarness(extra: Partial<PermissionConfig> = {}): Harness {
  const model = modelFromFile(configPath, extra);
  const events: string[] = [];
  const memory = new PermissionMemory({ model, configPath, log: (e) => events.push(`${e.action}:${e.detail}`) });
  return {
    memory,
    model,
    events,
    fileRules: () => {
      const raw = JSON.parse(readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
      return (raw.rules as unknown[]) ?? [];
    },
    fileText: () => readFileSync(configPath, "utf-8"),
  };
}

describe("权限记忆（Sprint 49）", () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    writeConfig([]);
  });

  it("会话级规则：只进内存、立即生效、不落盘", () => {
    const before = makeHarness();
    const rule: PermissionRule = { tool: "fs_write", match: "*notes*", action: "allow" };
    const r = before.memory.add(rule, "session");
    expect(r.ok).toBe(true);
    expect(r.rule?.source).toBe("session");
    expect(before.fileRules()).toEqual([]);

    const list = before.memory.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: "fs_write", action: "allow", source: "session" });
    expect(before.model.evaluateRules("fs_write", "/p/notes.md")?.action).toBe("allow");
    expect(before.events[0]).toContain("permission:rule-added:session");
  });

  it("项目级规则：落盘（保留其他字段与 BOM）并立即生效", () => {
    const h = makeHarness();
    const r = h.memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project");
    expect(r.ok).toBe(true);
    expect(r.rule?.source).toBe("project");
    expect(h.fileText().charCodeAt(0)).toBe(0xfeff);

    const raw = JSON.parse(h.fileText().replace(/^\uFEFF/, "")) as Record<string, unknown>;
    expect(raw.custom_field).toBe("保留我");
    expect(raw.never_auto_approve).toEqual(["terminal_exec"]);
    expect(raw.rules).toEqual([{ tool: "fs_write", match: "*notes*", action: "allow" }]);
    expect(h.model.evaluateRules("fs_write", "/p/notes.md")?.action).toBe("allow");
  });

  it("重启后项目级规则自然生效（新模型从同一文件加载）", () => {
    const h = makeHarness();
    h.memory.add({ tool: "fs_write", action: "allow" }, "project");
    const restarted = modelFromFile(configPath);
    expect(restarted.listRules()).toHaveLength(1);
    expect(restarted.listRules()[0]?.source).toBe("project");
    expect(restarted.evaluateRules("fs_write", "/p/a.md")?.action).toBe("allow");
  });

  it("撤销：项目级写回文件、会话级只清内存", () => {
    const h = makeHarness();
    h.memory.add({ tool: "fs_write", action: "allow" }, "project");
    h.memory.add({ tool: "fs_read", action: "allow" }, "session");

    expect(h.memory.revoke({ tool: "fs_write", action: "allow" }).ok).toBe(true);
    expect(h.fileRules()).toEqual([]);
    expect(h.memory.list().map((r) => r.tool)).toEqual(["fs_read"]);

    expect(h.memory.revoke({ tool: "fs_read", action: "allow" }).ok).toBe(true);
    expect(h.memory.list()).toEqual([]);
    expect(h.memory.revoke({ tool: "fs_read", action: "allow" }).ok).toBe(false);
  });

  it("重置项目级规则：文件 rules 清空，会话级不受影响", () => {
    const h = makeHarness();
    h.memory.add({ tool: "fs_write", action: "allow" }, "project");
    h.memory.add({ tool: "fs_read", action: "allow" }, "session");
    expect(h.memory.resetProject().ok).toBe(true);
    expect(h.fileRules()).toEqual([]);
    expect(h.memory.list().map((r) => r.source)).toEqual(["session"]);
    expect(h.memory.clearSession()).toBe(1);
    expect(h.memory.list()).toEqual([]);
  });

  it("非法 JSON / 顶层非对象：拒绝写入且文件原样不动（fail-closed）", () => {
    const h = makeHarness();
    const broken = '{"rules": [';
    writeFileSync(configPath, broken, "utf-8");
    const r = h.memory.add({ tool: "fs_write", action: "allow" }, "project");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不是合法 JSON");
    expect(readFileSync(configPath, "utf-8")).toBe(broken);

    writeFileSync(configPath, "[]\n", "utf-8");
    expect(h.memory.add({ tool: "fs_write", action: "allow" }, "project").reason).toContain("顶层必须是对象");

    // 模板存在但损坏 → 也不新建（不在一份读不懂的基础策略上创建授权文件）
    const dir2 = makeTestDir("permission-memory-broken-base");
    const basePath = join(dir2, "config", "permissions.json");
    const targetPath = join(dir2, "proj", "config", "permissions.json");
    mkdirSync(dirname(basePath), { recursive: true });
    writeFileSync(basePath, "{ broken", "utf-8");
    const h2 = new PermissionMemory({
      model: new PermissionModel({ defaultMode: "auto", modes: { ask: { description: "", allow_tool_calls: true, readOnly: true }, plan: { description: "", allow_tool_calls: true, require_confirmation: true }, auto: { description: "", allow_tool_calls: true, high_risk_confirm: true } }, allowedDirs: [], deniedPatterns: [] } as PermissionConfig),
      configPath: basePath,
      workingDir: join(dir2, "proj"),
      log: () => {},
    });
    expect(h2.add({ tool: "fs_write", match: "*x*", action: "allow" }, "project").ok).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
  });

  it("文件缺失 → 首次写入即创建（项目配置跟随 --dir，不碰启动目录配置）", () => {
    const dir2 = makeTestDir("permission-memory-create");
    const basePath = join(dir2, "config", "permissions.json");
    const proj = join(dir2, "proj");
    const targetPath = join(proj, "config", "permissions.json");
    mkdirSync(dirname(basePath), { recursive: true });
    const baseBody = `${JSON.stringify({ default_mode: "auto", rules: [{ tool: "fs_write", match: "*base*", action: "deny" }], protected_paths: [".env"] }, null, 2)}\n`;
    writeFileSync(basePath, baseBody, "utf-8");

    const memory = new PermissionMemory({
      model: new PermissionModel({ defaultMode: "auto", modes: { ask: { description: "", allow_tool_calls: true, readOnly: true }, plan: { description: "", allow_tool_calls: true, require_confirmation: true }, auto: { description: "", allow_tool_calls: true, high_risk_confirm: true } }, allowedDirs: [], deniedPatterns: [] } as PermissionConfig),
      configPath: basePath,
      workingDir: proj,
      log: () => {},
    });

    expect(memory.getConfigPath()).toBe(basePath); // 尚未创建 → 读启动目录配置
    expect(memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project").ok).toBe(true);
    expect(memory.getConfigPath()).toBe(targetPath); // 创建后读取来源切到项目配置

    const created = JSON.parse(readFileSync(targetPath, "utf-8")) as { rules: unknown[]; protected_paths?: string[] };
    expect(created.protected_paths).toEqual([".env"]); // 以启动目录配置为模板，没丢基础策略
    expect(created.rules).toEqual([
      { tool: "fs_write", match: "*base*", action: "deny" },
      { tool: "fs_write", match: "*notes*", action: "allow" },
    ]);
    expect(readFileSync(basePath, "utf-8")).toBe(baseBody); // 启动目录配置一字未改
  });

  it("项目配置路径已有同名文件（别的工具的）时拒绝覆盖", () => {
    const dir2 = makeTestDir("permission-memory-foreign");
    const proj = join(dir2, "proj");
    const targetPath = join(proj, "config", "permissions.json");
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify({ other_tool: true })}\n`, "utf-8");
    const memory = new PermissionMemory({
      model: new PermissionModel({ defaultMode: "auto", modes: { ask: { description: "", allow_tool_calls: true, readOnly: true }, plan: { description: "", allow_tool_calls: true, require_confirmation: true }, auto: { description: "", allow_tool_calls: true, high_risk_confirm: true } }, allowedDirs: [], deniedPatterns: [] } as PermissionConfig),
      workingDir: proj,
      log: () => {},
    });
    const r = memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("拒绝覆盖");
    expect(readFileSync(targetPath, "utf-8")).toBe(`${JSON.stringify({ other_tool: true })}\n`);
  });

  it("规则格式非法、或 allow 会架空保护时拒绝写入", () => {
    const h = makeHarness();
    expect(h.memory.add({ tool: "", action: "allow" }, "project").reason).toContain("格式非法");
    expect(h.memory.add({ tool: "fs_write", action: "denyy" } as unknown as PermissionRule, "project").reason).toContain("格式非法");

    const never = h.memory.add({ tool: "terminal_exec", action: "allow" }, "project");
    expect(never.ok).toBe(false);
    expect(never.reason).toContain("never_auto_approve");

    for (const match of [".ssh/*", "*id_rsa", ".env", "**/.git/**"]) {
      const r = h.memory.add({ tool: "fs_write", match, action: "allow" }, "project");
      expect(r.ok, match).toBe(false);
      expect(r.reason).toContain("受保护路径");
    }
    // 拒绝的规则不应进内存，也不应落盘
    expect(h.memory.list()).toEqual([]);
    expect(h.fileRules()).toEqual([]);

    // deny / ask 规则不受此限制（只会收紧）
    expect(h.memory.add({ tool: "terminal_exec", action: "deny" }, "project").ok).toBe(true);
  });

  it("deny 规则不被后来添加的 allow 覆盖（deny 始终优先）", () => {
    const h = makeHarness();
    h.memory.add({ tool: "fs_write", match: "*secret*", action: "deny" }, "project");
    h.memory.add({ tool: "fs_write", match: "*secret*", action: "allow" }, "project");
    const evaluated = h.model.evaluateRules("fs_write", "/p/secret.txt");
    expect(evaluated?.action).toBe("deny");
  });

  it("文件里无法识别的 rules 条目在写回时原样保留", () => {
    writeConfig([{ tool: "fs_write", action: "denyy" }, { tool: "fs_write", action: "allow" }]);
    const h = makeHarness();
    expect(h.memory.list()).toHaveLength(1); // 无效条目不进内存
    expect(h.memory.add({ tool: "fs_read", match: "*logs*", action: "allow" }, "project").ok).toBe(true);
    expect(h.fileRules()).toEqual([
      { tool: "fs_write", action: "denyy" },
      { tool: "fs_write", action: "allow" },
      { tool: "fs_read", match: "*logs*", action: "allow" },
    ]);
    // 撤销项目级规则只删匹配项，无效条目与无关规则仍在
    expect(h.memory.revoke({ tool: "fs_write", action: "allow" }).ok).toBe(true);
    expect(h.fileRules()).toEqual([
      { tool: "fs_write", action: "denyy" },
      { tool: "fs_read", match: "*logs*", action: "allow" },
    ]);
  });

  it("list 返回副本（外部修改不影响内部规则表）", () => {
    const h = makeHarness();
    h.memory.add({ tool: "fs_write", action: "allow" }, "session");
    const list = h.memory.list();
    list[0]!.tool = "hacked";
    (list[0] as { action: string }).action = "deny";
    expect(h.memory.list()[0]?.tool).toBe("fs_write");
    expect(h.memory.list()[0]?.action).toBe("allow");
  });

  it("默认审计落库：规则增删可在审计中查到（permission: 前缀）", () => {
    setupEnv(testDir);
    const model = modelFromFile(configPath);
    const memory = new PermissionMemory({ model, configPath });
    try {
      expect(memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project").ok).toBe(true);
      expect(memory.revoke({ tool: "fs_write", match: "*notes*", action: "allow" })).toMatchObject({ ok: true });
      const actions = auditLogger.queryRecent(20, "permission:").map((e) => e.action);
      expect(actions).toContain("permission:rule-added");
      expect(actions).toContain("permission:rule-removed");
    } finally {
      teardownEnv();
    }
  });

  it("重复 add 去重；撤销后盘上与内存一致（不再出现「报成功但规则仍生效」）", () => {
    const h = makeHarness();
    const rule = { tool: "fs_write", match: "*notes*", action: "allow" as const };
    const first = h.memory.add(rule, "project");
    const second = h.memory.add(rule, "project");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.warning).toContain("已存在");
    expect(h.fileRules()).toHaveLength(1);
    expect(h.memory.list()).toHaveLength(1);

    expect(h.memory.revoke(rule, "project").ok).toBe(true);
    expect(h.fileRules()).toEqual([]);
    expect(h.memory.list()).toEqual([]);
  });

  it("文件损坏/缺失时撤销与重置仍然生效：内存立即失效 + warning 说明重启后会回来", () => {
    const rule = { tool: "terminal_exec", match: "rm -rf *", action: "allow" as const };
    writeConfig([rule]);
    const h = makeHarness();
    expect(h.model.evaluateRules("terminal_exec", "rm -rf /tmp/x")?.action).toBe("allow");

    // 外部把文件改坏 → 撤销仍必须让规则在当前进程失效
    writeFileSync(configPath, "{ broken", "utf-8");
    const revoked = h.memory.revoke(rule, "project");
    expect(revoked.ok).toBe(true);
    expect(revoked.warning).toContain("重启后");
    expect(h.memory.list()).toEqual([]);
    expect(h.model.evaluateRules("terminal_exec", "rm -rf /tmp/x")).toBeNull();
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken"); // 不破坏用户文件

    // 重置同样以内存失效为准
    writeConfig([rule]);
    const h2 = makeHarness();
    writeFileSync(configPath, "{ broken", "utf-8");
    const reset = h2.memory.resetProject();
    expect(reset.ok).toBe(true);
    expect(reset.warning).toContain("重启后");
    expect(h2.memory.list()).toEqual([]);
  });

  it("写回保留原文件风格：BOM / CRLF / 无尾换行 / 权限位", () => {
    const dir2 = makeTestDir("permission-memory-style");
    const path2 = join(dir2, "permissions.json");
    const body = '\uFEFF{\r\n  "custom": 1,\r\n  "rules": []\r\n}';
    writeFileSync(path2, body, "utf-8");
    chmodSync(path2, 0o600);

    const model = new PermissionModel({ defaultMode: "auto", modes: { ask: { description: "", allow_tool_calls: true, readOnly: true }, plan: { description: "", allow_tool_calls: true, require_confirmation: true }, auto: { description: "", allow_tool_calls: true, high_risk_confirm: true } }, allowedDirs: [], deniedPatterns: [] } as PermissionConfig);
    const memory = new PermissionMemory({ model, configPath: path2, log: () => {} });
    expect(memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project").ok).toBe(true);

    const after = readFileSync(path2, "utf-8");
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after.includes("\r\n")).toBe(true);
    expect(after.includes("\n\n")).toBe(false);
    expect(/(?<!\r)\n/.test(after)).toBe(false); // 全部是 CRLF，没有裸 LF
    expect(after.endsWith("\n")).toBe(false); // 原本没有尾换行，写回也不加
    if (process.platform !== "win32") expect(statSync(path2).mode & 0o777).toBe(0o600);
  });

  it("按 mtime/size 变化重载外部改动（跨进程一致性）", () => {
    const h = makeHarness();
    expect(h.memory.refresh()).toBe(false); // 无变化 → 不重载

    // 模拟另一个进程（CLI）写入一条 deny
    writeConfig([{ tool: "terminal_exec", match: "rm -rf *", action: "deny" }]);
    expect(h.memory.refresh()).toBe(true);
    expect(h.model.evaluateRules("terminal_exec", "rm -rf /tmp/x")?.action).toBe("deny");
    expect(h.memory.list().map((r) => r.source)).toEqual(["project"]);

    // 内容没变 → 不再重载
    expect(h.memory.refresh()).toBe(false);
  });

  it("审计记录归属：setActor 后写入 agentId / sessionId（可回答「谁允许的」）", () => {
    setupEnv(testDir);
    const model = modelFromFile(configPath);
    const memory = new PermissionMemory({ model, configPath });
    try {
      memory.setActor({ agentId: "coding", sessionId: "sess-42" });
      expect(memory.add({ tool: "fs_write", match: "*notes*", action: "allow" }, "project").ok).toBe(true);
      const entry = auditLogger.queryRecent(5, "permission:")[0]!;
      expect(entry.agentId).toBe("coding");
      expect(entry.sessionId).toBe("sess-42");
      expect(entry.action).toBe("permission:rule-added");
    } finally {
      teardownEnv();
    }
  });

  it("配置路径跟随 --dir：优先工作目录，其次启动目录；无关同名文件被忽略", () => {
    const base = makeTestDir("permission-path");
    const other = join(base, "other-cwd");
    const work = join(base, "work");
    mkdirSync(join(other, "config"), { recursive: true });
    mkdirSync(join(work, "config"), { recursive: true });

    // 只有启动目录有配置 → 用它
    const cwdConfig = join(other, "config", "permissions.json");
    writeFileSync(cwdConfig, `${JSON.stringify({ rules: [], protected_paths: [".env"] })}\n`, "utf-8");
    expect(resolvePermissionConfigPath(work, other)).toBe(cwdConfig);

    // 工作目录也有 → 工作目录优先（跟随 --dir）
    const workConfig = join(work, "config", "permissions.json");
    writeFileSync(workConfig, `${JSON.stringify({ rules: [] })}\n`, "utf-8");
    expect(resolvePermissionConfigPath(work, other)).toBe(workConfig);

    // 无关同名文件（不含任何权限键）→ 视为不存在，回落启动目录
    const foreign = join(base, "foreign");
    mkdirSync(join(foreign, "config"), { recursive: true });
    writeFileSync(join(foreign, "config", "permissions.json"), `${JSON.stringify({ other_tool: true })}\n`, "utf-8");
    expect(resolvePermissionConfigPath(foreign, other)).toBe(cwdConfig);

    // 两边都没有 → 返回工作目录路径（首次写入即创建）
    const empty = join(base, "empty");
    expect(resolvePermissionConfigPath(empty, join(base, "no-such-cwd"))).toBe(join(empty, "config", "permissions.json"));
  });
});

describe("写面的来源校验（Sprint 49 第二轮）", () => {
  it("isCrossSiteRequest：Sec-Fetch-Site 优先，缺失时回退 Origin 与 Host 比对", async () => {
    const { isCrossSiteRequest } = await import("../src/server.js");
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" })).toBe(true);
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", "sec-fetch-site": "same-site" })).toBe(false);
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", origin: "https://evil.example" })).toBe(true);
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" })).toBe(false);
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000", origin: "null" })).toBe(true); // 沙箱 iframe
    // 无 Origin / Sec-Fetch-Site（curl、脚本）→ 交给 token 兜底，不在这里拒
    expect(isCrossSiteRequest({ host: "127.0.0.1:3000" })).toBe(false);
  });

  it.skipIf(!existsSync(resolve(process.cwd(), "web/dist/index.html")))(
    "index.html 注入进程 token 且不带 ACAO:*（跨源页面读不到）",
    async () => {
      const h = makeHarness();
      const server = startServer(
        {
          modelRouter: {} as never,
          workingDir: testDir,
          coordinator: {} as never,
          createAgent: () => undefined,
          getAgentList: () => [],
          skillNames: [],
          dataDir: join(testDir, "html-data"),
          permissionMemory: h.memory,
        } as never,
        0,
      );
      await new Promise<void>((r) => server.once("listening", () => r()));
      const port = (server.address() as AddressInfo).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`);
        expect(resp.status).toBe(200);
        expect(resp.headers.get("access-control-allow-origin")).toBeNull();
        const html = await resp.text();
        const token = readFileSync(join(testDir, "html-data", "server-token"), "utf-8");
        expect(html).toContain("__AIWORKER_TOKEN__");
        expect(html).toContain(token);
      } finally {
        server.close();
      }
    },
  );
});

describe("HTTP 端点 /permissions（Sprint 49）", () => {
  it("列表 / 新增（项目级）/ 撤销 / 重置 / 错误码", async () => {
    rmSync(testDir, { recursive: true, force: true });
    writeConfig([]);
    const h = makeHarness();
    const server = startServer(
      {
        modelRouter: {} as never,
        workingDir: testDir,
        coordinator: {} as never,
        createAgent: () => undefined,
        getAgentList: () => [],
        skillNames: [],
        dataDir: testDir,
        permissionMemory: h.memory,
      } as never,
      0,
    );
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1/permissions`;
    // 进程 token 由 startServer 写入 <dataDir>/server-token
    const token = readFileSync(join(testDir, "server-token"), "utf-8");
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aiworker-token": token, ...headers },
        body: JSON.stringify(body),
      });

    try {
      const empty = (await (await fetch(base)).json()) as { rules: unknown[]; configPath: string };
      expect(empty.rules).toEqual([]);
      expect(empty.configPath).toBe(configPath);
      expect((await fetch(`${base}?x=1`)).status).toBe(200); // 带查询串也要命中路由

      // 写面的两道门：token 与跨站校验
      expect((await post({ action: "add", tool: "fs_read", match: "*a*", ruleAction: "allow", scope: "session" }, { "x-aiworker-token": "" })).status).toBe(401);
      expect((await post({ action: "add", tool: "fs_read", match: "*a*", ruleAction: "allow", scope: "session" }, { origin: "https://evil.example" })).status).toBe(403);
      expect(
        (await post({ action: "add", tool: "fs_read", match: "*a*", ruleAction: "allow", scope: "session" }, { "sec-fetch-site": "cross-site" })).status,
      ).toBe(403);
      expect(
        (await post({ action: "add", tool: "fs_read", match: "*a*", ruleAction: "allow", scope: "session" }, { origin: `http://127.0.0.1:${port}` })).status,
      ).toBe(200);

      const added = await post({ action: "add", tool: "fs_write", match: "*notes*", ruleAction: "allow", scope: "project" });
      expect(added.status).toBe(200);
      const addedBody = (await added.json()) as { rules: { tool: string; source: string }[]; projectCount: number };
      expect(addedBody.projectCount).toBe(1);
      expect(addedBody.rules.some((r) => r.tool === "fs_write" && r.source === "project")).toBe(true);
      expect(h.fileRules()).toEqual([{ tool: "fs_write", match: "*notes*", action: "allow" }]);

      // 被保护语义拒绝 → 400 + 原因（且带上当前清单便于前端刷新）
      const rejected = await post({ action: "add", tool: "fs_write", match: ".ssh/*", ruleAction: "allow", scope: "project" });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toContain("受保护路径");

      expect((await post({ action: "add", tool: "", ruleAction: "allow", scope: "session" })).status).toBe(400);
      expect((await post({ action: "add", tool: "fs_write", ruleAction: "grant", scope: "session" })).status).toBe(400);
      expect((await post({ action: "add", tool: "fs_write", match: "*x*", ruleAction: "allow", scope: "proj" })).status).toBe(400);
      expect((await post({ action: "wat" })).status).toBe(400);
      expect((await post({ action: "revoke", tool: "fs_read", ruleAction: "allow" })).status).toBe(404);

      const cleared = (await (await post({ action: "clear-session" })).json()) as { removed: number; rules: unknown[] };
      expect(cleared.removed).toBe(1); // 上面同源成功写入的那条会话规则
      expect(cleared.rules.every((r) => (r as { source: string }).source === "project")).toBe(true);

      const revoked = await post({ action: "revoke", tool: "fs_write", match: "*notes*", ruleAction: "allow", scope: "project" });
      expect(revoked.status).toBe(200);
      expect(h.fileRules()).toEqual([]);

      expect((await post({ action: "reset" })).status).toBe(200);
      expect((await fetch(base, { method: "DELETE" })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("未注入权限记忆时返回 503", async () => {
    const server = startServer(
      {
        modelRouter: {} as never,
        workingDir: testDir,
        coordinator: {} as never,
        createAgent: () => undefined,
        getAgentList: () => [],
        skillNames: [],
        dataDir: testDir,
      } as never,
      0,
    );
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/v1/permissions`);
      expect(resp.status).toBe(503);
    } finally {
      server.close();
    }
  });
});
