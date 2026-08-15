/**
 * 审批服务单测（Sprint 26）
 * 覆盖：权限决策矩阵（ask/plan/auto）、fail-closed（无确认通道默认拒绝）、危险命令拦截
 */

import { describe, it, expect } from "vitest";
import { ApprovalService } from "../src/security/approval-service.js";
import { PermissionModel } from "../src/security/permission-model.js";
import { DangerDetector } from "../src/security/danger-detector.js";
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
