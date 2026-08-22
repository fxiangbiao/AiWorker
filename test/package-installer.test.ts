/**
 * .aw 包安装器测试 — zip 解析 + manifest 校验 + 安装落盘 + 安全防护
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { deflateRawSync } from "node:zlib";
import { makeTestDir, teardownEnv } from "./helpers.js";
import { PackageInstaller } from "../src/core/package-installer.js";
import { parseZip, readZipEntry, packZip } from "../src/core/zip.js";

let testRoot: string;
let installer: PackageInstaller;

beforeEach(() => {
  // 每个用例独立目录，避免跨用例"已存在"误判
  testRoot = makeTestDir("package-installer");
  installer = new PackageInstaller({
    pluginsDir: join(testRoot, "plugins"),
    skillsDir: join(testRoot, "skills"),
  });
});

afterAll(() => {
  teardownEnv();
});

// ===== 测试用 zip 构造工具（复刻 pack-aw.mjs 结构） =====
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { table?: Int32Array }).table;
  if (!table) {
    table = (crc32 as unknown as { table?: Int32Array }).table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

interface TestFile {
  name: string;
  data: Buffer;
}

function buildZip(files: TestFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf-8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(8, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const localSize = localParts.reduce((a, p) => a + p.length, 0);
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function writePkg(name: string, files: TestFile[]): string {
  const path = join(testRoot, `${name}.aw`);
  writeFileSync(path, buildZip(files));
  return path;
}

const skillManifest = Buffer.from(
  JSON.stringify({ formatVersion: 1, type: "skill", name: "test-skill", version: "1.2.0", description: "t" }),
);
const skillMd = Buffer.from("---\nname: test-skill\nversion: 1.2.0\nexpert: common\n---\n# Test Skill\nbody");

const pluginManifest = Buffer.from(
  JSON.stringify({ formatVersion: 1, type: "plugin", name: "test-plugin", version: "0.1.0", entry: "plugin.ts" }),
);
const pluginTs = Buffer.from('export default { setup: async () => {} };\n');

describe("zip.ts", () => {
  it("解析 deflate 条目", () => {
    const buf = buildZip([
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const entries = parseZip(buf);
    expect(entries.map((e) => e.name).sort()).toEqual(["SKILL.md", "manifest.json"]);
    expect(readZipEntry(buf, "manifest.json")?.toString("utf-8")).toContain('"type":"skill"');
  });

  it("拒绝非 zip 输入", () => {
    expect(() => parseZip(Buffer.from("not a zip file at all"))).toThrow();
  });

  it("packZip 打包可被 parseZip 读回（round-trip，含 deflate）", () => {
    const buf = packZip([
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const entries = parseZip(buf);
    expect(entries.map((e) => e.name).sort()).toEqual(["SKILL.md", "manifest.json"]);
    expect(readZipEntry(buf, "SKILL.md")?.toString("utf-8")).toContain("# Test Skill");
  });
});

describe("PackageInstaller.readManifest", () => {
  it("接受合法 skill 包", () => {
    const p = writePkg("p1", [
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const m = installer.readManifest(p);
    expect(m.type).toBe("skill");
    expect(m.name).toBe("test-skill");
    expect(m.version).toBe("1.2.0");
  });

  it("拒绝非 .aw 后缀", () => {
    const p = join(testRoot, "p2.zip");
    writeFileSync(p, buildZip([{ name: "manifest.json", data: skillManifest }]));
    expect(() => installer.readManifest(p)).toThrow(/\.aw/);
  });

  it("拒绝缺 manifest", () => {
    const p = writePkg("p3", [{ name: "SKILL.md", data: skillMd }]);
    expect(() => installer.readManifest(p)).toThrow(/manifest/);
  });

  it("拒绝非法包名", () => {
    const bad = Buffer.from(JSON.stringify({ formatVersion: 1, type: "skill", name: "../evil", version: "1.0" }));
    const p = writePkg("p4", [{ name: "manifest.json", data: bad }]);
    expect(() => installer.readManifest(p)).toThrow(/包名/);
  });

  it("拒绝未知类型", () => {
    const bad = Buffer.from(JSON.stringify({ formatVersion: 1, type: "robot", name: "x", version: "1.0" }));
    const p = writePkg("p5", [{ name: "manifest.json", data: bad }]);
    expect(() => installer.readManifest(p)).toThrow(/类型/);
  });

  it("拒绝非法版本号", () => {
    const bad = Buffer.from(JSON.stringify({ formatVersion: 1, type: "skill", name: "x", version: "abc" }));
    const p = writePkg("p6", [{ name: "manifest.json", data: bad }]);
    expect(() => installer.readManifest(p)).toThrow(/版本/);
  });

  it("minAppVersion 校验", () => {
    const withMin = Buffer.from(
      JSON.stringify({ formatVersion: 1, type: "skill", name: "x", version: "1.0", minAppVersion: "9.0.0" }),
    );
    const p = writePkg("p7", [{ name: "manifest.json", data: withMin }]);
    const strict = new PackageInstaller({
      pluginsDir: join(testRoot, "plugins"),
      skillsDir: join(testRoot, "skills"),
      appVersion: "0.5.1",
    });
    expect(() => strict.readManifest(p)).toThrow(/版本过低/);
  });
});

describe("PackageInstaller.install", () => {
  it("安装 skill 包并落盘 SKILL.md", () => {
    const p = writePkg("s1", [
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const r = installer.install(p);
    expect(r.success).toBe(true);
    expect(r.type).toBe("skill");
    expect(existsSync(join(testRoot, "skills", "test-skill", "SKILL.md"))).toBe(true);
  });

  it("同名冲突默认拒绝，force 覆盖", () => {
    const p = writePkg("s2", [
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const first = installer.install(p);
    expect(first.success).toBe(true);
    const dup = installer.install(p);
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/已存在/);
    const forced = installer.install(p, { force: true });
    expect(forced.success).toBe(true);
  });

  it("安装 plugin 包（校验入口）", () => {
    const p = writePkg("pl1", [
      { name: "manifest.json", data: pluginManifest },
      { name: "plugin.ts", data: pluginTs },
    ]);
    const r = installer.install(p);
    expect(r.success).toBe(true);
    expect(existsSync(join(testRoot, "plugins", "test-plugin", "plugin.ts"))).toBe(true);
  });

  it("插件包缺入口拒绝并回滚", () => {
    const p = writePkg("pl2", [{ name: "manifest.json", data: pluginManifest }]);
    const r = installer.install(p);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/入口/);
    expect(existsSync(join(testRoot, "plugins", "test-plugin"))).toBe(false);
  });

  it("技能包缺 SKILL.md 拒绝并回滚", () => {
    const p = writePkg("s3", [{ name: "manifest.json", data: skillManifest }]);
    const r = installer.install(p);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/SKILL\.md/);
    expect(existsSync(join(testRoot, "skills", "test-skill"))).toBe(false);
  });

  it("路径穿越条目被拒绝", () => {
    const evil = Buffer.from("pwned");
    const p = writePkg("evil1", [
      { name: "manifest.json", data: skillManifest },
      { name: "../pwned.txt", data: evil },
    ]);
    // parseZip 能解析出穿越条目
    const entries = parseZip(readFileSync(p));
    expect(entries.some((e) => e.name === "../pwned.txt")).toBe(true);
    // install 应整体失败（extract 抛错 → catch → 失败）
    const r = installer.install(p, { force: true });
    expect(r.success).toBe(false);
    // 且穿越文件未落盘
    expect(existsSync(join(testRoot, "..", "pwned.txt"))).toBe(false);
    expect(existsSync(join(testRoot, "pwned.txt"))).toBe(false);
  });

  it("绝对路径条目被拒绝", () => {
    const p = writePkg("evil2", [
      { name: "manifest.json", data: skillManifest },
      { name: "C:\\pwned.txt", data: Buffer.from("x") },
    ]);
    const r = installer.install(p, { force: true });
    expect(r.success).toBe(false);
  });
});

describe("PackageInstaller MCP 支持", () => {
  const mcpManifest = Buffer.from(
    JSON.stringify({ formatVersion: 1, type: "mcp", name: "test-mcp", version: "1.0.0" }),
  );
  const mcpJson = Buffer.from(
    JSON.stringify({ transport: "stdio", command: "node", args: ["server.js"], enabled: true }),
  );

  it("安装 mcp 包：合并条目到 config/mcp.json 并保留原有", () => {
    const mcpConfigPath = join(testRoot, "config", "mcp.json");
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify({ servers: { builtin: { transport: "stdio" } } }), "utf-8");
    const mcpInstaller = new PackageInstaller({
      pluginsDir: join(testRoot, "plugins"),
      skillsDir: join(testRoot, "skills"),
      mcpConfigPath,
    });
    const p = writePkg("m1", [
      { name: "manifest.json", data: mcpManifest },
      { name: "mcp.json", data: mcpJson },
    ]);
    const r = mcpInstaller.install(p);
    expect(r.success).toBe(true);
    expect(r.type).toBe("mcp");
    const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as { servers: Record<string, unknown> };
    expect(cfg.servers["test-mcp"]).toMatchObject({ command: "node" });
    expect(cfg.servers["builtin"]).toBeDefined(); // 原有保留
  });

  it("mcp 包同名冲突：默认拒绝，force 覆盖", () => {
    const mcpConfigPath = join(testRoot, "config", "mcp.json");
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    writeFileSync(mcpConfigPath, JSON.stringify({ servers: { "test-mcp": { transport: "stdio" } } }), "utf-8");
    const mcpInstaller = new PackageInstaller({
      pluginsDir: join(testRoot, "plugins"),
      skillsDir: join(testRoot, "skills"),
      mcpConfigPath,
    });
    const p = writePkg("m2", [
      { name: "manifest.json", data: mcpManifest },
      { name: "mcp.json", data: mcpJson },
    ]);
    const conflict = mcpInstaller.install(p);
    expect(conflict.success).toBe(false);
    expect(conflict.error).toMatch(/已存在/);
    const forced = mcpInstaller.install(p, { force: true });
    expect(forced.success).toBe(true);
  });

  it("mcp 包缺 mcp.json 拒绝", () => {
    const mcpConfigPath = join(testRoot, "config", "mcp.json");
    const mcpInstaller = new PackageInstaller({
      pluginsDir: join(testRoot, "plugins"),
      skillsDir: join(testRoot, "skills"),
      mcpConfigPath,
    });
    const p = writePkg("m3", [{ name: "manifest.json", data: mcpManifest }]);
    const r = mcpInstaller.install(p);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mcp\.json/);
  });

  it("exportPackage 导出 mcp 为 .aw（round-trip 可安装）", () => {
    const mcpConfigPath = join(testRoot, "config", "mcp.json");
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ servers: { "test-mcp": { transport: "stdio", command: "node", args: ["s.js"] } } }),
      "utf-8",
    );
    const exporter = new PackageInstaller({
      pluginsDir: join(testRoot, "plugins"),
      skillsDir: join(testRoot, "skills"),
      mcpConfigPath,
    });
    const out = exporter.exportPackage("mcp", "test-mcp");
    expect(out).not.toBeNull();
    const entries = parseZip(out!.data);
    expect(entries.some((e) => e.name === "manifest.json")).toBe(true);
    expect(entries.some((e) => e.name === "mcp.json")).toBe(true);
    // round-trip：导出包可被安装器解析（同名已存在 → force 覆盖）
    const p = join(testRoot, "roundtrip.aw");
    writeFileSync(p, out!.data);
    const r = exporter.install(p, { force: true });
    expect(r.success).toBe(true);
  });
});

describe("PackageInstaller.listInstalled", () => {
  it("列出已安装包（含版本）", () => {
    const s = writePkg("li1", [
      { name: "manifest.json", data: skillManifest },
      { name: "SKILL.md", data: skillMd },
    ]);
    const pl = writePkg("li2", [
      { name: "manifest.json", data: pluginManifest },
      { name: "plugin.ts", data: pluginTs },
    ]);
    installer.install(s);
    installer.install(pl);
    const list = installer.listInstalled();
    const skill = list.find((x) => x.name === "test-skill");
    expect(skill?.type).toBe("skill");
    expect(skill?.version).toBe("1.2.0");
    const plugin = list.find((x) => x.name === "test-plugin");
    expect(plugin?.type).toBe("plugin");
    expect(plugin?.version).toBe("0.1.0");
  });
});
