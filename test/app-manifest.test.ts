/**
 * 应用清单校验测试（Sprint 34）
 */

import { describe, it, expect } from "vitest";
import { validateAppManifest, AppManifestError, isValidPermission } from "../src/core/app-manifest.js";

const valid = {
  id: "hello-tool",
  type: "tool",
  name: "Hello 工具",
  version: "1.0.0",
  description: "测试应用",
  entry: "index.mjs",
  permissions: ["notify"],
  tools: [
    { name: "hello_tool", description: "打招呼", parameters: { type: "object", properties: {} } },
  ],
};

describe("app-manifest schema 校验", () => {
  it("合法 manifest 通过", () => {
    const m = validateAppManifest(valid);
    expect(m.id).toBe("hello-tool");
    expect(m.type).toBe("tool");
    expect(m.tools).toHaveLength(1);
    expect(m.permissions).toEqual(["notify"]);
  });

  it("缺少 id 拒绝", () => {
    expect(() => validateAppManifest({ ...valid, id: undefined })).toThrow(AppManifestError);
    expect(() => validateAppManifest({ ...valid, id: "Bad ID" })).toThrow(/id 非法/);
  });

  it("非法 type 拒绝；app（webapp）类型 Sprint 35 起可用", () => {
    expect(() => validateAppManifest({ ...valid, type: "nope" })).toThrow(/type 非法/);
    expect(() => validateAppManifest({ ...valid, type: "app" })).not.toThrow();
  });

  it("terminal 权限被禁用（schema 硬约束）", () => {
    expect(() => validateAppManifest({ ...valid, permissions: ["terminal"] })).toThrow(/terminal 被禁用/);
    expect(isValidPermission("terminal", "x")).toBe(false);
  });

  it("非法权限拒绝；fs 权限仅限沙箱内", () => {
    expect(() => validateAppManifest({ ...valid, permissions: ["root"] })).toThrow(/权限非法/);
    expect(() => validateAppManifest({ ...valid, permissions: ["fs:../secret"] })).toThrow(/权限非法/);
    expect(() => validateAppManifest({ ...valid, permissions: ["fs:data/apps/hello-tool"] })).not.toThrow();
  });

  it("工具声明校验：名非法 / 缺描述 / parameters 非 object", () => {
    expect(() =>
      validateAppManifest({
        ...valid,
        tools: [{ name: "Bad-Name", description: "x", parameters: { type: "object", properties: {} } }],
      }),
    ).toThrow(/工具名非法/);
    expect(() =>
      validateAppManifest({
        ...valid,
        tools: [{ name: "ok_tool", description: "", parameters: { type: "object", properties: {} } }],
      }),
    ).toThrow(/缺少 description/);
    expect(() =>
      validateAppManifest({
        ...valid,
        tools: [{ name: "ok_tool", description: "x", parameters: { type: "string" } }],
      }),
    ).toThrow(/parameters/);
  });

  it("entry 防穿越：.. / 绝对路径 / 盘符拒绝", () => {
    expect(() => validateAppManifest({ ...valid, entry: "../evil.js" })).toThrow(/entry 非法/);
    expect(() => validateAppManifest({ ...valid, entry: "/etc/passwd" })).toThrow(/entry 非法/);
    expect(() => validateAppManifest({ ...valid, entry: "C:\\evil.js" })).toThrow(/entry 非法/);
  });

  it("autostart 默认 false；originSessionId 可选", () => {
    const m = validateAppManifest(valid);
    expect(m.autostart).toBe(false);
    expect(m.originSessionId).toBeUndefined();
    const m2 = validateAppManifest({ ...valid, autostart: true, originSessionId: "c123" });
    expect(m2.autostart).toBe(true);
    expect(m2.originSessionId).toBe("c123");
  });
});
