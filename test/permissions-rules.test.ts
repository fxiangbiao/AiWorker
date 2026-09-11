/**
 * 权限规则引擎测试（Sprint 47）
 * 覆盖：Tool(specifier) 级 deny → ask → allow 求值、通配、永不自动批准清单、
 *       受保护路径、fail-closed、与权限模式的交互（allow 不绕过只读模式）
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { ApprovalService, extractTarget } from "../src/security/approval-service.js";
import { PermissionModel } from "../src/security/permission-model.js";
import { DangerDetector } from "../src/security/danger-detector.js";
import type { PermissionConfig, PermissionRule } from "../src/types.js";

const BASE = resolve("D:/proj");

function makeModel(opts: {
  rules?: PermissionRule[];
  never?: string[];
  protectedPaths?: string[];
  mode?: "ask" | "plan" | "auto";
} = {}): PermissionModel {
  const modes: PermissionConfig["modes"] = {
    ask: { description: "只读", allow_tool_calls: true, readOnly: true },
    plan: { description: "计划", allow_tool_calls: true, require_confirmation: true },
    auto: { description: "自动", allow_tool_calls: true, high_risk_confirm: true },
  };
  return new PermissionModel({
    defaultMode: opts.mode ?? "auto",
    modes,
    allowedDirs: [],
    deniedPatterns: [],
    rules: opts.rules ?? [],
    neverAutoApprove: opts.never ?? [],
    protectedPaths: opts.protectedPaths ?? [],
  });
}

describe("PermissionModel 规则引擎", () => {
  it("glob 匹配：* 通配、大小写不敏感、mcp_* 前缀", () => {
    expect(PermissionModel.globMatch("*", "anything")).toBe(true);
    expect(PermissionModel.globMatch("fs_*", "fs_write")).toBe(true);
    expect(PermissionModel.globMatch("fs_*", "terminal_exec")).toBe(false);
    expect(PermissionModel.globMatch("mcp_*", "mcp_github_create_issue")).toBe(true);
    expect(PermissionModel.globMatch("*.GIT/*", "C:/proj/.git/config")).toBe(true);
  });

  it("deny > ask > allow 优先级（同类取首条）", () => {
    const model = makeModel({
      rules: [
        { tool: "fs_write", action: "allow" },
        { tool: "fs_write", match: "*secret*", action: "ask" },
        { tool: "fs_write", match: "*.git/*", action: "deny" },
      ],
    });
    expect(model.evaluateRules("fs_write", `${BASE}/.git/config`)?.action).toBe("deny");
    expect(model.evaluateRules("fs_write", `${BASE}/secret.txt`)?.action).toBe("ask");
    expect(model.evaluateRules("fs_write", `${BASE}/readme.md`)?.action).toBe("allow");
    expect(model.evaluateRules("fs_edit", `${BASE}/readme.md`)).toBeNull();
  });

  it("match 缺省表示该工具全部命中；never/protected 查询可用", () => {
    const model = makeModel({
      rules: [{ tool: "terminal_exec", action: "ask" }],
      never: ["fs_write"],
      protectedPaths: [".git", ".env"],
    });
    expect(model.evaluateRules("terminal_exec", "echo hi")?.action).toBe("ask");
    expect(model.isNeverAutoApprove("fs_write")).toBe(true);
    expect(model.isNeverAutoApprove("fs_read")).toBe(false);
    expect(model.isProtectedTarget("C:/proj/.env.local")).toBe(true);
    expect(model.isProtectedTarget("C:/proj/readme.md")).toBe(false);
  });

  it("受保护路径按路径段匹配：.git 不误伤 .gitignore / .github，命令文本也能识别", () => {
    const model = makeModel({ protectedPaths: [".git", ".env", "id_rsa"] });
    // 命中：真正的受保护目录 / 文件
    expect(model.isProtectedTarget("C:/proj/.git/config")).toBe(true);
    expect(model.isProtectedTarget("/home/me/.git")).toBe(true);
    expect(model.isProtectedTarget("git config --file .git/config user.name x")).toBe(true);
    expect(model.isProtectedTarget('Set-Content -Path "C:\\proj\\.env" -Value 1')).toBe(true);
    expect(model.isProtectedTarget("C:/keys/id_rsa.pub")).toBe(true);
    // 不命中：同前缀的普通项目文件（回归防护）
    expect(model.isProtectedTarget("C:/proj/.gitignore")).toBe(false);
    expect(model.isProtectedTarget("C:/proj/.gitattributes")).toBe(false);
    expect(model.isProtectedTarget("C:/proj/.github/workflows/ci.yml")).toBe(false);
    expect(model.isProtectedTarget("git add .gitignore")).toBe(false);
    expect(model.isProtectedTarget("C:/proj/environment.md")).toBe(false);
  });

  it("无效规则被丢弃且不静默（action 拼写错误 = deny 失效的 fail-open 风险）", () => {
    const model = makeModel({
      rules: [
        { tool: "fs_write", action: "denyy" } as never,
        { tool: "", action: "deny" } as never,
        { tool: "fs_write", match: 5 } as never,
        { tool: "fs_write", match: "*secret*", action: "deny" },
      ],
    });
    expect(model.describeRules()).toEqual(["DENY fs_write(*secret*)"]);
    expect(model.evaluateRules("fs_write", "C:/proj/secret.txt")?.action).toBe("deny");
  });

  it("extractTarget：fs 类取绝对路径、terminal_exec 取命令文本、其它取 JSON", () => {
    const absOutside = resolve(BASE, "..", "outside.txt");
    expect(extractTarget("fs_write", { path: absOutside }, BASE)).toBe(absOutside);
    expect(extractTarget("fs_write", { path: "src/a.ts" }, BASE)).toBe(resolve(BASE, "src/a.ts"));
    // 盘符路径：win32 下为绝对路径（忽略 baseDir），POSIX 下退化为相对 baseDir —— 两种口径都按 resolve 断言
    expect(extractTarget("fs_write", JSON.stringify({ path: "C:/tmp/b.txt" }), BASE)).toBe(resolve(BASE, "C:/tmp/b.txt"));
    expect(extractTarget("terminal_exec", { command: "npm test" }, BASE)).toBe("npm test");
    expect(extractTarget("web_fetch", { url: "https://x" }, BASE)).toContain("https://x");
  });
});

describe("ApprovalService 规则接入", () => {
  it("deny 规则在 auto 模式下直接拒绝（checkPermission）", () => {
    const svc = new ApprovalService({
      permissionModel: makeModel({ rules: [{ tool: "terminal_exec", match: "*rm -rf*", action: "deny" }] }),
      workingDir: BASE,
    });
    const blocked = svc.checkPermission("terminal_exec", "auto", { command: "rm -rf build" });
    expect(blocked.proceed).toBe(false);
    expect(blocked.message).toContain("规则拒绝");
    expect(svc.checkPermission("terminal_exec", "auto", { command: "echo hi" }).proceed).toBe(true);
  });

  it("deny 规则不绕过只读模式判断顺序（ask 模式写工具仍被拦）", () => {
    const svc = new ApprovalService({ permissionModel: makeModel({ mode: "ask" }), workingDir: BASE });
    expect(svc.checkPermission("fs_write", "ask", { path: "a.txt" }).proceed).toBe(false);
  });

  it("ask 规则在 auto 模式强制确认，拒绝则拦截", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel({ rules: [{ tool: "fs_write", match: "*secret*", action: "ask" }] }),
      workingDir: BASE,
      confirm: async () => {
        asked++;
        return "deny";
      },
    });
    const r = await svc.checkConfirmation("fs_write", { path: "secret.txt" }, "auto");
    expect(asked).toBe(1);
    expect(r.proceed).toBe(false);
  });

  it("allow 规则免确认；但不可覆盖 never_auto_approve 与受保护路径", async () => {
    const allowAll: PermissionRule = { tool: "fs_write", action: "allow" };
    const makeConfirm = (counter: { n: number }) => async () => {
      counter.n++;
      return "allow" as const;
    };
    const plainAsked = { n: 0 };
    const plain = new ApprovalService({
      permissionModel: makeModel({ rules: [allowAll] }),
      workingDir: BASE,
      confirm: makeConfirm(plainAsked),
    });
    expect((await plain.checkConfirmation("fs_write", { path: "src/a.ts" }, "auto")).proceed).toBe(true);
    expect(plainAsked.n).toBe(0);

    const neverAsked = { n: 0 };
    const never = new ApprovalService({
      permissionModel: makeModel({ rules: [allowAll], never: ["fs_write"] }),
      workingDir: BASE,
      confirm: makeConfirm(neverAsked),
    });
    expect((await never.checkConfirmation("fs_write", { path: "src/a.ts" }, "auto")).proceed).toBe(true);
    expect(neverAsked.n).toBe(1);

    const protectedAsked = { n: 0 };
    const protectedPath = new ApprovalService({
      permissionModel: makeModel({ rules: [allowAll], protectedPaths: [".git"] }),
      workingDir: BASE,
      confirm: makeConfirm(protectedAsked),
    });
    expect((await protectedPath.checkConfirmation("fs_write", { path: ".git/config" }, "auto")).proceed).toBe(true);
    expect(protectedAsked.n).toBe(1);
  });

  it("never_auto_approve：无确认通道时 fail-closed", async () => {
    const svc = new ApprovalService({ permissionModel: makeModel({ never: ["terminal_exec"] }), workingDir: BASE });
    const r = await svc.checkConfirmation("terminal_exec", { command: "echo hi" }, "auto");
    expect(r.proceed).toBe(false);
    expect(r.message).toBe("用户取消操作");
  });

  it("受保护路径（.env）在 auto 模式下强制确认，普通路径不确认", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel({ protectedPaths: [".env"] }),
      workingDir: BASE,
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("fs_edit", { path: ".env" }, "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
    expect((await svc.checkConfirmation("fs_write", { path: "notes.md" }, "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
  });

  it("plan 模式仍然全确认（规则 allow 不改变 plan 语义）", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel({ mode: "plan", rules: [{ tool: "*", action: "allow" }] }),
      workingDir: BASE,
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("web_search", { query: "x" }, "plan")).proceed).toBe(true);
    expect(asked).toBe(1);
  });

  it("既有语义不变：auto 模式高危命令确认、安全命令免确认", async () => {
    let asked = 0;
    const svc = new ApprovalService({
      permissionModel: makeModel(),
      dangerDetector: new DangerDetector(),
      workingDir: BASE,
      confirm: async () => {
        asked++;
        return "allow";
      },
    });
    expect((await svc.checkConfirmation("terminal_exec", { command: "echo hi" }, "auto")).proceed).toBe(true);
    expect(asked).toBe(0);
    expect((await svc.checkConfirmation("terminal_exec", { command: "rm -rf /" }, "auto")).proceed).toBe(true);
    expect(asked).toBe(1);
  });
});
