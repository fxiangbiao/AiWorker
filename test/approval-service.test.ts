/**
 * 审批服务单测（Sprint 26）
 * 覆盖：权限决策矩阵（ask/plan/auto）、fail-closed（无确认通道默认拒绝）、危险命令拦截
 */

import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { ApprovalService } from "../src/security/approval-service.js";
import { PermissionModel } from "../src/security/permission-model.js";
import { PermissionMemory } from "../src/security/permission-memory.js";
import { DangerDetector } from "../src/security/danger-detector.js";
import { auditLogger } from "../src/core/audit-logger.js";
import { makeTestDir, setupEnv, teardownEnv, makeDirLink, DIR_LINK_SUPPORTED } from "./helpers.js";
import type { PermissionConfig } from "../src/types.js";

function makeModel(defaultMode: "ask" | "plan" | "auto" = "auto"): PermissionModel {
  const modes: PermissionConfig["modes"] = {
    ask: { description: "只读", allow_tool_calls: true, readOnly: true },
    plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
    auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
  };
  return new PermissionModel({ defaultMode, modes, allowedDirs: [], deniedPatterns: [] });
}

describe("ApprovalService.checkPermission", () => {
  it("ask 模式：只读工具放行，写工具拦截", () => {
    const svc = new ApprovalService({ permissionModel: makeModel("ask") });
    expect(svc.checkPermission("fs_read", "ask").proceed).toBe(true);
    expect(svc.checkPermission("ask_user", "ask").proceed).toBe(true);
    expect(svc.checkPermission("fs_write", "ask").proceed).toBe(false);
    expect(svc.checkPermission("terminal_exec", "ask").proceed).toBe(false);
  });

  it("auto/plan 模式：工具调用放行（确认逻辑另测）", () => {
    const svc = new ApprovalService({ permissionModel: makeModel("auto") });
    expect(svc.checkPermission("fs_write", "auto").proceed).toBe(true);
    expect(svc.checkPermission("terminal_exec", "plan").proceed).toBe(true);
  });

  it("无 permissionModel 时默认放行（hook 兼容）", () => {
    const svc = new ApprovalService({});
    expect(svc.checkPermission("anything", "ask").proceed).toBe(true);
  });
});

describe("ApprovalService.checkCommandBlock", () => {
  it("ask 模式危险命令拦截", () => {
    const svc = new ApprovalService({ dangerDetector: new DangerDetector() });
    const r = svc.checkCommandBlock("rm -rf /", "ask");
    expect(r.proceed).toBe(false);
    expect(r.message).toContain("高危");
  });

  it("ask 模式安全命令放行；plan/auto 危险命令放行（交给确认）", () => {
    const svc = new ApprovalService({ dangerDetector: new DangerDetector() });
    expect(svc.checkCommandBlock("echo hi", "ask").proceed).toBe(true);
    expect(svc.checkCommandBlock("rm -rf /", "auto").proceed).toBe(true);
    expect(svc.checkCommandBlock("rm -rf /", "plan").proceed).toBe(true);
  });
});

describe("ApprovalService.checkConfirmation", () => {
  it("plan 模式：所有工具调用需确认，拒绝则拦截", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel("plan"),
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("web_search", '{"query":"x"}', "plan")).proceed).toBe(true);
    expect(asked).toBe(1);

    const deny = new ApprovalService({
      permissionModel: makeModel("plan"),
      confirm: async () => "deny",
    });
    const r = await deny.checkConfirmation("web_search", '{"query":"x"}', "plan");
    expect(r.proceed).toBe(false);
    expect(r.message).toBe("用户取消操作");
  });

  it("plan 模式 fs_write 展示目标路径", async () => {
    const messages: string[] = [];
    const svc = new ApprovalService({
      permissionModel: makeModel("plan"),
      workingDir: process.cwd(),
      confirm: async (req) => {
        messages.push(req.message);
        return "allow";
      },
    });
    await svc.checkConfirmation("fs_write", JSON.stringify({ path: "src/a.ts" }), "plan");
    expect(messages[0]).toContain("a.ts");
  });

  it("auto 模式：安全操作不确认，高危操作确认", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel("auto"),
      dangerDetector: new DangerDetector(),
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    // 安全命令 → 直接放行
    expect((await svc.checkConfirmation("terminal_exec", "echo hi", "auto")).proceed).toBe(true);
    expect(asked).toBe(0);
    // 高危命令 → 确认
    expect((await svc.checkConfirmation("terminal_exec", "rm -rf /", "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
    // fs_write 内容含危险词不误报（只检测路径）
    expect((await svc.checkConfirmation("fs_write", JSON.stringify({ path: "src/notes.md", content: "rm 命令" }), "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
  });

  it("fail-closed：无确认通道时确认类决策默认拒绝", async () => {
    const svc = new ApprovalService({ permissionModel: makeModel("plan") });
    const r = await svc.checkConfirmation("web_search", "{}", "plan");
    expect(r.proceed).toBe(false);
    expect(r.message).toBe("用户取消操作");
  });

  it("auto 模式非高危工具不触发确认（fs_read 等）", async () => {
    const svc = new ApprovalService({
      permissionModel: makeModel("auto"),
      confirm: async () => {
        throw new Error("不应触发确认");
      },
    });
    expect((await svc.checkConfirmation("fs_read", '{"path":"a"}' as never, "auto")).proceed).toBe(true);
  });
});

describe("受保护路径：读与写同等对待（Sprint 49）", () => {
  function protectedModel(defaultMode: "ask" | "plan" | "auto" = "auto"): PermissionModel {
    const modes: PermissionConfig["modes"] = {
      ask: { description: "只读", allow_tool_calls: true, readOnly: true },
      plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
      auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
    };
    return new PermissionModel({
      defaultMode,
      modes,
      allowedDirs: [],
      deniedPatterns: [],
      protectedPaths: [".ssh", ".env", "id_rsa"],
    } as PermissionConfig);
  }

  const secret = resolve(process.cwd(), ".ssh", "id_rsa");
  const normal = resolve(process.cwd(), "src", "a.ts");

  it("auto 模式：读受保护路径触发确认，确认后放行；普通路径不确认", async () => {
    const asked: string[] = [];
    const svc = new ApprovalService({
      permissionModel: protectedModel("auto"),
      workingDir: process.cwd(),
      confirm: async (req) => {
        asked.push(req.message);
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("fs_read", { path: secret }, "auto")).proceed).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("受保护路径");

    expect((await svc.checkConfirmation("fs_read", { path: normal }, "auto")).proceed).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("auto 模式：拒绝读受保护路径则拦截", async () => {
    const svc = new ApprovalService({
      permissionModel: protectedModel("auto"),
      workingDir: process.cwd(),
      confirm: async () => "deny",
    });
    const r = await svc.checkConfirmation("fs_read", { path: secret }, "auto");
    expect(r.proceed).toBe(false);
    expect(r.message).toBe("用户取消操作");
  });

  it("ask 模式：读受保护路径同样要确认（此前静默放行）；fs_list 受保护目录亦然", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: protectedModel("ask"),
      workingDir: process.cwd(),
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("fs_read", { path: secret }, "ask")).proceed).toBe(true);
    expect(asked).toBe(1);
    expect((await svc.checkConfirmation("fs_list", { path: resolve(process.cwd(), ".ssh") }, "ask")).proceed).toBe(true);
    expect(asked).toBe(2);
    expect((await svc.checkConfirmation("fs_read", { path: normal }, "ask")).proceed).toBe(true);
    expect(asked).toBe(2);
  });

  it("fail-closed：无确认通道时读受保护路径被拒（不再静默放行）", async () => {
    const svc = new ApprovalService({ permissionModel: protectedModel("auto"), workingDir: process.cwd() });
    const r = await svc.checkConfirmation("fs_read", { path: secret }, "auto");
    expect(r.proceed).toBe(false);
  });
});

describe("确认通道「始终允许」与权限记忆（Sprint 49）", () => {
  const dir = makeTestDir("approval-memory");
  const configPath = join(dir, "config", "permissions.json");
  const DANGEROUS = "rm -rf build";

  function makeHarness(opts: { choose?: string | string[]; withMemory?: boolean; configPath?: string } = {}) {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ custom: 1, rules: [] }, null, 2)}\n`, "utf-8");
    const queue = Array.isArray(opts.choose) ? [...opts.choose] : null;
    const model = new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { description: "只读", allow_tool_calls: true, readOnly: true },
        plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
        auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [],
      deniedPatterns: [],
      neverAutoApprove: ["fs_edit"],
      protectedPaths: [".env"],
    } as PermissionConfig);
    const memory = new PermissionMemory({ model, configPath: opts.configPath ?? configPath, log: () => {} });
    const seen: { value: string; label: string }[][] = [];
    const svc = new ApprovalService({
      permissionModel: model,
      dangerDetector: new DangerDetector(),
      workingDir: dir,
      permissionMemory: opts.withMemory === false ? undefined : memory,
      confirm: async (req) => {
        seen.push(req.options);
        return queue ? (queue.shift() ?? "deny") : (opts.choose ?? "allow");
      },
    });
    return { model, memory, svc, seen };
  }

  it("auto 模式高危确认提供四个选项，且前两位保持 允许/拒绝（老习惯不被重排）", async () => {
    const h = makeHarness();
    expect((await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto")).proceed).toBe(true);
    expect(h.seen[0]?.map((o) => o.value)).toEqual(["allow", "deny", "allow_project", "allow_session"]);
  });

  it("无权限记忆时只有两个选项（不承诺记忆能力）", async () => {
    const h = makeHarness({ withMemory: false });
    await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(h.seen[0]?.map((o) => o.value)).toEqual(["allow", "deny"]);
  });

  it("「本会话始终允许」：规则只进内存、同命令不再确认、**含通配的近似命令仍要确认**", async () => {
    // 第一次选「本会话始终允许」，后续危险确认一律拒绝
    const h = makeHarness({ choose: ["allow_session", "deny", "deny"] });
    expect((await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto")).proceed).toBe(true);
    expect(h.seen).toHaveLength(1);
    expect(h.memory.list()).toHaveLength(1);
    expect(h.memory.list()[0]).toMatchObject({ tool: "terminal_exec", match: DANGEROUS, action: "allow", source: "session", exact: true });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).rules).toEqual([]);

    // 同命令：精确规则命中 → 不再确认
    expect((await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto")).proceed).toBe(true);
    expect(h.seen).toHaveLength(1);

    // 其他危险命令：仍要确认
    expect((await h.svc.checkConfirmation("terminal_exec", { command: "rm -rf dist" }, "auto")).proceed).toBe(false);
    expect(h.seen).toHaveLength(2);

    // 把 * 当通配的近似命令不得命中（否则授权范围被悄悄放大到 build/ 之外）
    expect((await h.svc.checkConfirmation("terminal_exec", { command: "rm -rf build/../../../important" }, "auto")).proceed).toBe(false);
    expect(h.seen).toHaveLength(3);
    expect(h.memory.list()).toHaveLength(1);
  });

  it("「始终允许（写入项目配置）」：落盘为**精确**规则且保留其他字段", async () => {
    const h = makeHarness({ choose: "allow_project" });
    expect((await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto")).proceed).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(raw.custom).toBe(1);
    expect(raw.rules).toEqual([{ tool: "terminal_exec", match: DANGEROUS, action: "allow", exact: true }]);
    expect(h.memory.list()[0]?.source).toBe("project");
  });

  it("强制类确认不提供记忆选项：never 清单 / 受保护路径 / plan 模式", async () => {
    const h = makeHarness();
    await h.svc.checkConfirmation("fs_edit", { path: join(dir, "a.txt") }, "auto");
    expect(h.seen[0]?.map((o) => o.value)).toEqual(["allow", "deny"]);

    await h.svc.checkConfirmation("fs_write", { path: join(dir, ".env"), content: "x" }, "auto");
    expect(h.seen[1]?.map((o) => o.value)).toEqual(["allow", "deny"]);

    await h.svc.checkConfirmation("web_search", "{}", "plan");
    expect(h.seen[2]?.map((o) => o.value)).toEqual(["allow", "deny"]);

    // 规则 allow 也不会让受保护路径与 never 清单免确认
    h.memory.add({ tool: "fs_write", match: "*", action: "ask" }, "session");
    expect((await h.svc.checkConfirmation("fs_write", { path: join(dir, ".env"), content: "x" }, "auto")).proceed).toBe(true);
    expect(h.seen).toHaveLength(4);
  });

  it("记忆失败时仍放行本次，并把原因带回 message", async () => {
    const h = makeHarness({ choose: "allow_project" });
    writeFileSync(configPath, "{ broken", "utf-8"); // 配置损坏 → 落盘失败（缺失则会新建，不算失败）
    const r = await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(r.proceed).toBe(true);
    expect(r.message).toContain("记住规则失败");
    expect(h.memory.list()).toEqual([]);
  });

  it("撤销后恢复询问（记忆可逆）", async () => {
    const h = makeHarness({ choose: "allow_session" });
    await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(h.seen).toHaveLength(1);
    await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(h.seen).toHaveLength(1); // 规则命中，不再确认

    expect(h.memory.revoke({ tool: "terminal_exec", match: DANGEROUS, action: "allow" }).ok).toBe(true);
    await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(h.seen).toHaveLength(2); // 撤销后重新确认
  });

  it("无确认通道时既不确认也不产生规则（fail-closed）", async () => {
    const h = makeHarness();
    const noChannel = new ApprovalService({
      permissionModel: h.model,
      dangerDetector: new DangerDetector(),
      workingDir: dir,
      permissionMemory: h.memory,
    });
    const r = await noChannel.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(r.proceed).toBe(false);
    expect(h.memory.list()).toEqual([]);
  });

  it("伪造的 allow_project（该确认点未提供记忆选项）→ 拒绝且不崩溃", async () => {
    const h = makeHarness({ choose: "allow_project" });
    for (const [tool, args, mode] of [
      ["fs_write", { path: join(dir, "a.txt"), content: "x" }, "plan"],
      ["web_search", "{}", "plan"],
    ] as const) {
      const r = await h.svc.checkConfirmation(tool, args, mode as "plan");
      expect(r.proceed, `${tool}/${mode}`).toBe(false);
    }
    expect(h.memory.list()).toEqual([]);
  });

  it("快照内策略拒写的记忆失败会写审计（proceed=true 时 hook 会丢弃 message）", async () => {
    setupEnv(dir);
    const h = makeHarness({ choose: "allow_project" });
    writeFileSync(configPath, "{ broken", "utf-8"); // 配置损坏 → 落盘失败
    const r = await h.svc.checkConfirmation("terminal_exec", { command: DANGEROUS }, "auto");
    expect(r.proceed).toBe(true);
    const actions = auditLogger.queryRecent(20, "permission:").map((e) => e.action);
    expect(actions).toContain("permission:rule-add-failed");
    teardownEnv();
  });
});

describe("审批层的路径/工具覆盖（Sprint 49 审查修复）", () => {
  const dir = makeTestDir("approval-paths");
  const root = join(dir, "root");
  const vault = join(dir, "vault");

  function makePathModel(extra: Partial<PermissionConfig> = {}): PermissionModel {
    return new PermissionModel({
      defaultMode: "auto",
      modes: {
        ask: { description: "", allow_tool_calls: true, readOnly: true },
        plan: { description: "", allow_tool_calls: true, require_confirmation: true },
        auto: { description: "", allow_tool_calls: true, high_risk_confirm: true },
      },
      allowedDirs: [],
      deniedPatterns: [],
      protectedPaths: [".git", ".ssh", ".env"],
      ...extra,
    } as PermissionConfig);
  }

  beforeAll(() => {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(vault, ".ssh"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n", "utf-8");
    writeFileSync(join(vault, ".ssh", "id_rsa"), "PRIVATE", "utf-8");
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("工作目录内的 junction 不能绕过 deny 规则（按真实路径判定）", async () => {
    const link = join(root, "shortcut");
    rmSync(link, { recursive: true, force: true });
    expect(makeDirLink(link, join(root, ".git"))).toBe(true);

    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makePathModel({ rules: [{ tool: "fs_write", match: "*.git*", action: "deny" }] }),
      workingDir: root,
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    // 直接写：规则拒绝；经链接写：同样必须拒绝（此前会放行且不确认）
    expect(svc.checkPermission("fs_write", "auto", { path: join(root, ".git", "config") }).proceed).toBe(false);
    const viaLink = svc.checkPermission("fs_write", "auto", { path: join(link, "config") });
    expect(viaLink.proceed).toBe(false);
    expect(viaLink.message).toContain("规则拒绝");
    expect((await svc.checkConfirmation("fs_write", { path: join(link, "config"), content: "x" }, "auto")).proceed).toBe(false);
    expect(asked).toBe(0);
  });

  it.skipIf(!DIR_LINK_SUPPORTED)("junction 指向的受保护目录同样触发确认", async () => {
    const link = join(root, "vaultlink");
    rmSync(link, { recursive: true, force: true });
    expect(makeDirLink(link, vault)).toBe(true);

    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makePathModel(),
      workingDir: root,
      confirm: async () => {
        asked++;
        return "deny";
      },
    });
    const r = await svc.checkConfirmation("fs_read", { path: join(link, ".ssh", "id_rsa") }, "auto");
    expect(asked).toBe(1);
    expect(r.proceed).toBe(false);
  });

  it("terminal_session 纳入受保护路径与危险检测（此前零确认）", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makePathModel(),
      dangerDetector: new DangerDetector(),
      workingDir: root,
      confirm: async () => {
        asked++;
        return "deny";
      },
    });
    expect((await svc.checkConfirmation("terminal_session", { command: "type C:/Users/me/.ssh/id_rsa" }, "auto")).proceed).toBe(false);
    expect(asked).toBe(1);
    expect((await svc.checkConfirmation("terminal_session", { command: "rm -rf /" }, "auto")).proceed).toBe(false);
    expect(asked).toBe(2);
  });

  it("非精确的 allow 规则不再短路危险检测；--yes 全量开关仍可放行", async () => {
    const dangerous = "rm -rf build";
    let asked = 0;
    const model = makePathModel({ rules: [{ tool: "terminal_exec", action: "allow" }] });
    const svc = new ApprovalService({
      permissionModel: model,
      dangerDetector: new DangerDetector(),
      workingDir: root,
      confirm: async () => {
        asked++;
        return "deny";
      },
    });
    expect((await svc.checkConfirmation("terminal_exec", { command: dangerous }, "auto")).proceed).toBe(false);
    expect(asked).toBe(1);

    model.setAutoApproveAll(true); // headless --yes
    expect((await svc.checkConfirmation("terminal_exec", { command: dangerous }, "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
  });
});
