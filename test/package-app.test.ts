/**
 * 示例应用包单测（Sprint 42 A4）
 * 覆盖：.aw app 类型导出/安装全链路（mock appManager）、缺 app.json 拒绝、appManager 未注入拒绝、
 *       3 个示例 manifest 通过校验 + webapp 结构/JS 语法
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDir, setupEnv, teardownEnv } from "./helpers.js";
import { PackageInstaller, AW_EXTENSION } from "../src/core/package-installer.js";
import { packZip, readZipEntry } from "../src/core/zip.js";
import { validateAppManifest } from "../src/core/app-manifest.js";
import { checkJsSyntax } from "../src/core/app-factory.js";
import type { AppManifest } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = makeTestDir("package-app");
  setupEnv(dir);
});

afterEach(() => {
  teardownEnv();
});

function makeInstaller(overrides: { appManager?: unknown } = {}) {
  const installer = new PackageInstaller({
    pluginsDir: resolve(dir, "plugins"),
    skillsDir: resolve(dir, "skills"),
    appsDir: resolve(dir, "apps"),
  });
  if (overrides.appManager) installer.appManager = overrides.appManager as never;
  return installer;
}

/** 在 appsDir 下造一个最小应用目录（app.json + 入口） */
function seedApp(id: string, extra: Record<string, string> = {}): string {
  const appDir = resolve(dir, "apps", id);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    resolve(appDir, "app.json"),
    JSON.stringify({
      id,
      type: "tool",
      name: "测试工具",
      version: "1.0.0",
      description: "测试",
      entry: "index.js",
      permissions: ["fs:data"],
      tools: [{ name: "test_tool", description: "测试工具", parameters: { type: "object", properties: {} } }],
    }),
    "utf-8",
  );
  writeFileSync(resolve(appDir, "index.js"), "export default async function h(){ return { ok: true }; }", "utf-8");
  for (const [rel, content] of Object.entries(extra)) {
    const full = resolve(appDir, rel);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return appDir;
}

describe("示例应用包（Sprint 42 A4）", () => {
  it("导出 app .aw：含 manifest.json + 全目录文件；安装走 appManager.installFromDir", () => {
    seedApp("test-app", { "data/note.txt": "hello" });
    const installer = makeInstaller();
    const out = installer.exportPackage("app", "test-app");
    expect(out).not.toBeNull();
    const manifestRaw = readZipEntry(out!.data, "manifest.json");
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(manifestRaw!.toString("utf-8")) as { type: string; name: string; version: string };
    expect(manifest.type).toBe("app");
    expect(manifest.name).toBe("test-app");
    expect(manifest.version).toBe("1.0.0");
    expect(readZipEntry(out!.data, "app.json")).toBeTruthy();
    expect(readZipEntry(out!.data, "data/note.txt")?.toString("utf-8")).toBe("hello");

    // 写盘后安装（另一个 installer + mock appManager）
    const awPath = resolve(dir, "test-app.aw");
    writeFileSync(awPath, out!.data);
    let capturedDir = "";
    const installFromDir = vi.fn((d: string) => {
      capturedDir = d;
      // 调用期临时目录已解压好（含 app.json）；断言在清理前进行
      expect(existsSync(resolve(d, "app.json"))).toBe(true);
      return { ok: true };
    });
    const installer2 = makeInstaller({ appManager: { installFromDir } });
    const result = installer2.install(awPath);
    expect(result.success).toBe(true);
    expect(result.type).toBe("app");
    expect(installFromDir).toHaveBeenCalledTimes(1);
    // 临时目录已清理
    expect(existsSync(capturedDir)).toBe(false);
  });

  it("app .aw 缺少 app.json 拒绝安装", () => {
    const awPath = resolve(dir, "bad.aw");
    const data = packZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ formatVersion: 1, type: "app", name: "bad-app", version: "1.0.0" })) },
      { name: "index.js", data: Buffer.from("x") },
    ]);
    writeFileSync(awPath, data);
    const installer = makeInstaller({ appManager: { installFromDir: vi.fn(() => ({ ok: true })) } });
    const result = installer.install(awPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain("app.json");
  });

  it("appManager 未注入拒绝安装 app 包（明确报错）", () => {
    seedApp("test-app2");
    const installer = makeInstaller(); // 无 appManager
    const out = installer.exportPackage("app", "test-app2")!;
    const awPath = resolve(dir, "test-app2.aw");
    writeFileSync(awPath, out.data);
    const result = installer.install(awPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain("appManager");
  });

  it("3 个示例 app.json 全部通过 validateAppManifest", () => {
    const examples = ["tomato-webapp", "batch-replace-tool", "todo-service"];
    for (const name of examples) {
      const raw = JSON.parse(readFileSync(resolve(dir, "..", "..", "examples", name, "app.json"), "utf-8")) as unknown;
      const manifest = validateAppManifest(raw) as AppManifest;
      expect(manifest.id).toBeTruthy();
    }
  });

  it("tomato-webapp 结构完整（index.html/app.js/style.css）且 JS 语法合法", () => {
    const base = resolve(dir, "..", "..", "examples", "tomato-webapp");
    expect(existsSync(resolve(base, "index.html"))).toBe(true);
    expect(existsSync(resolve(base, "style.css"))).toBe(true);
    const js = readFileSync(resolve(base, "app.js"), "utf-8");
    expect(checkJsSyntax(js)).toBeNull();
    // 入口引用一致性
    const html = readFileSync(resolve(base, "index.html"), "utf-8");
    expect(html).toContain("app.js");
    expect(html).toContain("style.css");
  });

  it("batch-replace/todo-service 入口文件存在且非空（ESM 入口；new Function 不适用）", () => {
    for (const [name, entry] of [["batch-replace-tool", "index.js"], ["todo-service", "index.js"]] as const) {
      const base = resolve(dir, "..", "..", "examples", name);
      const src = readFileSync(resolve(base, entry), "utf-8");
      expect(src.trim().length).toBeGreaterThan(0);
      expect(src).toContain("export default");
    }
  });
});
