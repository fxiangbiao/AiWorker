/**
 * .aw 包安装器 — 插件/技能统一分发格式
 * 包 = zip 压缩，内含 manifest.json（type: "plugin" | "skill"）
 * 安装后解压到对应目录，复用现有 plugin-manager / skill-registry 加载逻辑：
 *   plugin → config/plugins/<name>/
 *   skill  → skills/<name>/SKILL.md
 * 校验：type 合法、包名规范、解压路径安全（防路径穿越）、入口存在、幂等
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { resolve, normalize, relative, sep, dirname, basename } from "node:path";
import { parseZip, readZipFile, readZipEntry, packZip, type ZipFileInput } from "./zip.js";
import { mcpManager } from "../mcp/mcp-manager.js";

export const AW_EXTENSION = ".aw";
export const AW_FORMAT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";

/** .aw 包 manifest 结构 */
export interface AwManifest {
  formatVersion: number;
  type: "plugin" | "skill" | "mcp";
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  entry?: string;
  scope?: string;
  minAppVersion?: string;
  tags?: string[];
  signature?: string;
}

/** 安装结果 */
export interface InstallResult {
  success: boolean;
  type: "plugin" | "skill" | "mcp" | "unknown";
  name: string;
  version: string;
  targetDir: string;
  error?: string;
}

export interface PackageInstallerOptions {
  /** 插件安装根目录（默认 config/plugins） */
  pluginsDir: string;
  /** 技能安装根目录（默认 skills） */
  skillsDir: string;
  /** MCP 配置文件路径（默认 config/mcp.json） */
  mcpConfigPath?: string;
  /** 当前应用版本（用于 minAppVersion 校验；可选） */
  appVersion?: string;
}

/** 简单 semver 比较：仅支持 x.y.z；version >= min 返回 true */
function satisfiesMin(version: string, min?: string): boolean {
  if (!min) return true;
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** 校验包名：小写字母数字开头，仅 [a-z0-9_-]，1~64 位 */
function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
}

/** 解析 SKILL.md frontmatter 的 name/version/description */
export function parseSkillMeta(raw: string): { name?: string; version?: string; description?: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; version?: string; description?: string } = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    if (kv[1] === "name") out.name = kv[2]!.trim();
    else if (kv[1] === "version") out.version = kv[2]!.trim();
    else if (kv[1] === "description") out.description = kv[2]!.trim();
  }
  return out;
}

/** 递归收集目录内文件（相对路径） */
function collectDir(dir: string, prefix = ""): { rel: string; full: string }[] {
  const out: { rel: string; full: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectDir(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function statIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class PackageInstaller {
  constructor(private opts: PackageInstallerOptions) {}

  /** 从 .aw 文件解析 manifest（不落盘） */
  readManifest(pkgPath: string): AwManifest {
    if (!pkgPath.toLowerCase().endsWith(AW_EXTENSION)) {
      throw new Error(`不是 .aw 包: ${pkgPath}`);
    }
    const buf = readZipFile(pkgPath);
    const raw = readZipEntry(buf, MANIFEST_FILE);
    if (!raw) throw new Error(`包缺少 ${MANIFEST_FILE}`);
    const manifest = JSON.parse(raw.toString("utf-8").replace(/^\uFEFF/, "")) as AwManifest;

    if (manifest.formatVersion !== AW_FORMAT_VERSION) {
      throw new Error(`不支持的包格式版本: ${manifest.formatVersion}`);
    }
    if (manifest.type !== "plugin" && manifest.type !== "skill" && manifest.type !== "mcp") {
      throw new Error(`未知包类型: ${manifest.type}`);
    }
    if (!manifest.name || !isValidName(manifest.name)) {
      throw new Error(`非法包名: ${manifest.name}`);
    }
    if (!manifest.version || !/^\d+\.\d+(\.\d+)?$/.test(manifest.version)) {
      throw new Error(`非法版本号: ${manifest.version}`);
    }
    if (manifest.minAppVersion && this.opts.appVersion && !satisfiesMin(this.opts.appVersion, manifest.minAppVersion)) {
      throw new Error(
        `应用版本过低: 需要 >= ${manifest.minAppVersion}，当前 ${this.opts.appVersion}`,
      );
    }
    return manifest;
  }

  /** 解压 zip 内容到目标目录（路径穿越防护） */
  private extract(buf: Buffer, destDir: string): void {
    const root = normalize(resolve(destDir)) + sep;
    for (const entry of parseZip(buf)) {
      if (entry.isDirectory) continue;
      const target = normalize(resolve(destDir, entry.name));
      if (relative(root, target).startsWith("..") || target === normalize(destDir)) {
        throw new Error(`非法路径: ${entry.name}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }
  }

  /** 按输入类型自动识别安装：.aw 标准包 / .md 技能 / .json MCP 配置 / 插件目录 */
  installAny(inputPath: string, opts?: { force?: boolean }): InstallResult {
    const lower = inputPath.toLowerCase();
    if (lower.endsWith(AW_EXTENSION)) return this.install(inputPath, opts);
    if (lower.endsWith(".md")) return this.installSkillRaw(inputPath, opts);
    if (lower.endsWith(".json")) return this.installMcpRaw(inputPath, opts);
    if (statIsDir(inputPath)) return this.installPluginDir(inputPath, opts);
    return {
      success: false,
      type: "unknown",
      name: "unknown",
      version: "0",
      targetDir: "",
      error: `不支持的格式: ${inputPath}（支持 .aw / .md / .json / 插件目录）`,
    };
  }

  /** 裸 SKILL.md 导入：解析 frontmatter → 写 skills/<name>/SKILL.md + manifest.json */
  private installSkillRaw(mdPath: string, opts?: { force?: boolean }): InstallResult {
    const fail = (error: string): InstallResult => ({
      success: false,
      type: "skill",
      name: "unknown",
      version: "0",
      targetDir: "",
      error,
    });
    try {
      const raw = readFileSync(mdPath, "utf-8");
      const meta = parseSkillMeta(raw);
      const name = meta.name;
      if (!name || !isValidName(name)) {
        return fail("SKILL.md frontmatter 缺少合法 name");
      }
      const target = resolve(this.opts.skillsDir, name);
      if (existsSync(target) && !opts?.force) {
        return { ...fail(`技能 ${name} 已存在，使用 force 覆盖`), name, targetDir: target };
      }
      mkdirSync(target, { recursive: true });
      writeFileSync(resolve(target, "SKILL.md"), raw, "utf-8");
      writeFileSync(
        resolve(target, MANIFEST_FILE),
        JSON.stringify(
          {
            formatVersion: AW_FORMAT_VERSION,
            type: "skill",
            name,
            version: meta.version ?? "1.0.0",
            description: meta.description,
          },
          null,
          2,
        ),
        "utf-8",
      );
      return { success: true, type: "skill", name, version: meta.version ?? "1.0.0", targetDir: target };
    } catch (err) {
      return fail(`技能导入失败: ${(err as Error).message}`);
    }
  }

  /** 裸 MCP 配置 JSON 导入：文件名为 server 名 → 合并 config/mcp.json */
  private installMcpRaw(jsonPath: string, opts?: { force?: boolean }): InstallResult {
    const fail = (error: string): InstallResult => ({
      success: false,
      type: "mcp",
      name: "unknown",
      version: "0",
      targetDir: "",
      error,
    });
    try {
      const base = basename(jsonPath).replace(/\.json$/i, "");
      if (!isValidName(base)) return fail(`MCP 服务器名非法: ${base}（用文件名命名，如 my-server.json）`);
      let entry: unknown;
      try {
        entry = JSON.parse(readFileSync(jsonPath, "utf-8").replace(/^\uFEFF/, ""));
      } catch {
        return fail("JSON 内容不是合法配置");
      }
      const cfgPath = this.opts.mcpConfigPath ?? resolve(process.cwd(), "config", "mcp.json");
      const cfg = existsSync(cfgPath)
        ? (JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "")) as { servers?: Record<string, unknown> })
        : { servers: {} as Record<string, unknown> };
      if (!cfg.servers) cfg.servers = {};
      if (cfg.servers[base] && !opts?.force) {
        return { ...fail(`MCP 服务器 ${base} 已存在，使用 force 覆盖`), name: base, targetDir: cfgPath };
      }
      cfg.servers[base] = entry;
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      void mcpManager.loadConfig(cfgPath).catch(() => {});
      return { success: true, type: "mcp", name: base, version: "1.0.0", targetDir: cfgPath };
    } catch (err) {
      return fail(`MCP 导入失败: ${(err as Error).message}`);
    }
  }

  /** 插件目录导入：入口探测 → 拷贝到 config/plugins/<name>/ + manifest.json */
  private installPluginDir(dir: string, opts?: { force?: boolean }): InstallResult {
    const name = basename(dir);
    const fail = (error: string): InstallResult => ({
      success: false,
      type: "plugin",
      name,
      version: "0",
      targetDir: "",
      error,
    });
    try {
      if (!isValidName(name)) return fail(`插件目录名非法: ${name}`);
      const entryCandidates = ["plugin.ts", "plugin.js", "index.ts", "index.js"];
      const hasEntry = entryCandidates.some((f) => existsSync(resolve(dir, f)));
      if (!hasEntry) return fail("插件目录缺少入口（plugin.ts|js 或 index.ts|js）");
      const target = resolve(this.opts.pluginsDir, name);
      if (existsSync(target) && !opts?.force) {
        return { ...fail(`插件 ${name} 已存在，使用 force 覆盖`), targetDir: target };
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      for (const f of collectDir(dir)) {
        const dest = resolve(target, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(f.full));
      }
      writeFileSync(
        resolve(target, MANIFEST_FILE),
        JSON.stringify({ formatVersion: AW_FORMAT_VERSION, type: "plugin", name, version: "1.0.0" }, null, 2),
        "utf-8",
      );
      return { success: true, type: "plugin", name, version: "1.0.0", targetDir: target };
    } catch (err) {
      return fail(`插件导入失败: ${(err as Error).message}`);
    }
  }

  /** 安装 .aw 包；返回结果（不抛异常） */
  install(pkgPath: string, opts?: { force?: boolean }): InstallResult {
    try {
      const manifest = this.readManifest(pkgPath);

      // MCP 包：合并条目到 config/mcp.json（无目录落盘）
      if (manifest.type === "mcp") {
        return this.installMcp(manifest, pkgPath, opts);
      }

      const baseDir = manifest.type === "plugin" ? this.opts.pluginsDir : this.opts.skillsDir;
      const targetDir = resolve(baseDir, manifest.name);
      const fail = (error: string): InstallResult => ({
        success: false,
        type: manifest.type,
        name: manifest.name,
        version: manifest.version,
        targetDir,
        error,
      });

      if (existsSync(targetDir)) {
        if (!opts?.force) {
          return fail("已存在同名包，使用 force 覆盖安装");
        }
        rmSync(targetDir, { recursive: true, force: true });
      }

      mkdirSync(targetDir, { recursive: true });
      this.extract(readZipFile(pkgPath), targetDir);

      // 插件入口探测（与 plugin-manager 契约一致）
      if (manifest.type === "plugin") {
        const entryCandidates = ["plugin.ts", "plugin.js", "index.ts", "index.js"];
        const hasEntry = entryCandidates.some((f) => existsSync(resolve(targetDir, f)));
        if (!hasEntry) {
          rmSync(targetDir, { recursive: true, force: true });
          return fail("插件包缺少入口文件（plugin.ts|js 或 index.ts|js）");
        }
      }
      // 技能包必须有 SKILL.md
      if (manifest.type === "skill" && !existsSync(resolve(targetDir, "SKILL.md"))) {
        rmSync(targetDir, { recursive: true, force: true });
        return fail("技能包缺少 SKILL.md");
      }

      return { success: true, type: manifest.type, name: manifest.name, version: manifest.version, targetDir };
    } catch (err) {
      return {
        success: false,
        type: "unknown",
        name: "unknown",
        version: "0",
        targetDir: "",
        error: (err as Error).message,
      };
    }
  }

  /** MCP 包安装：解压 mcp.json 条目 → 合并到 config/mcp.json（冲突需 force） */
  private installMcp(manifest: AwManifest, pkgPath: string, opts?: { force?: boolean }): InstallResult {
    const fail = (error: string): InstallResult => ({
      success: false,
      type: "mcp",
      name: manifest.name,
      version: manifest.version,
      targetDir: "",
      error,
    });
    const entryRaw = readZipEntry(readZipFile(pkgPath), "mcp.json");
    if (!entryRaw) return fail("MCP 包缺少 mcp.json（服务器定义）");
    let entry: unknown;
    try {
      entry = JSON.parse(entryRaw.toString("utf-8").replace(/^\uFEFF/, ""));
    } catch {
      return fail("mcp.json 内容不是合法 JSON");
    }
    const cfgPath = this.opts.mcpConfigPath ?? resolve(process.cwd(), "config", "mcp.json");
    const cfg = existsSync(cfgPath)
      ? (JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "")) as { servers?: Record<string, unknown> })
      : { servers: {} as Record<string, unknown> };
    if (!cfg.servers) cfg.servers = {};
    if (cfg.servers[manifest.name] && !opts?.force) {
      return fail(`MCP 服务器 ${manifest.name} 已存在，使用 force 覆盖`);
    }
    cfg.servers[manifest.name] = entry;
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    void mcpManager.loadConfig(cfgPath).catch(() => {});
    return {
      success: true,
      type: "mcp",
      name: manifest.name,
      version: manifest.version,
      targetDir: cfgPath,
    };
  }

  // ── 导出（打包 .aw） ──

  /** 从资产导出 .aw 包二进制（不落盘）；找不到返回 null */
  exportPackage(type: "plugin" | "skill" | "mcp", name: string): { data: Buffer; manifest: AwManifest } | null {
    const manifest: AwManifest = {
      formatVersion: AW_FORMAT_VERSION,
      type,
      name,
      version: "1.0.0",
    };
    const files: ZipFileInput[] = [];

    try {
      if (type === "skill") {
        const skillDir = this.findSkillDir(name);
        if (!skillDir) return null;
        const md = readFileSync(resolve(skillDir, "SKILL.md"), "utf-8");
        const meta = parseSkillMeta(md);
        if (meta.name) manifest.name = meta.name;
        if (meta.version) manifest.version = meta.version;
        if (meta.description) manifest.description = meta.description;
        files.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf-8") });
        files.push({ name: "SKILL.md", data: Buffer.from(md, "utf-8") });
        for (const f of collectDir(skillDir)) {
          if (f.rel === "SKILL.md") continue;
          files.push({ name: f.rel, data: readFileSync(f.full) });
        }
      } else if (type === "plugin") {
        const dir = resolve(this.opts.pluginsDir, name);
        if (!existsSync(dir) || !statIsDir(dir)) return null;
        manifest.entry = "plugin.ts";
        files.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf-8") });
        for (const f of collectDir(dir)) {
          files.push({ name: f.rel, data: readFileSync(f.full) });
        }
      } else {
        // mcp
        const cfgPath = this.opts.mcpConfigPath ?? resolve(process.cwd(), "config", "mcp.json");
        if (!existsSync(cfgPath)) return null;
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "")) as {
          servers?: Record<string, unknown>;
        };
        const entry = cfg.servers?.[name];
        if (!entry) return null;
        files.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf-8") });
        files.push({ name: "mcp.json", data: Buffer.from(JSON.stringify(entry, null, 2), "utf-8") });
      }
      return { data: packZip(files), manifest };
    } catch {
      return null;
    }
  }

  /** 导出裸格式（单文件）：skill → .md、mcp → .json；plugin 返回 null（用 copyPluginDir） */
  exportRaw(type: "skill" | "mcp", name: string): { data: Buffer; filename: string; ext: string } | null {
    try {
      if (type === "skill") {
        const dir = this.findSkillDir(name);
        if (!dir) return null;
        return { data: Buffer.from(readFileSync(resolve(dir, "SKILL.md"), "utf-8"), "utf-8"), filename: `${name}.md`, ext: ".md" };
      }
      // mcp
      const cfgPath = this.opts.mcpConfigPath ?? resolve(process.cwd(), "config", "mcp.json");
      if (!existsSync(cfgPath)) return null;
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "")) as {
        servers?: Record<string, unknown>;
      };
      const entry = cfg.servers?.[name];
      if (!entry) return null;
      return { data: Buffer.from(JSON.stringify(entry, null, 2) + "\n", "utf-8"), filename: `${name}.json`, ext: ".json" };
    } catch {
      return null;
    }
  }

  /** 插件裸导出：复制 config/plugins/<name>/ 目录到目标路径（返回目标目录） */
  copyPluginDir(name: string, destDir: string): string | null {
    try {
      const src = resolve(this.opts.pluginsDir, name);
      if (!existsSync(src) || !statIsDir(src)) return null;
      mkdirSync(destDir, { recursive: true });
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
      for (const f of collectDir(src)) {
        const dest = resolve(destDir, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(f.full));
      }
      return destDir;
    } catch {
      return null;
    }
  }

  /** 在 skillsDir 下查找 <name>/SKILL.md 所在目录 */
  private findSkillDir(name: string): string | null {
    const walk = (dir: string): string | null => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === name && existsSync(resolve(full, "SKILL.md"))) return full;
          const found = walk(full);
          if (found) return found;
        }
      }
      return null;
    };
    try {
      return walk(this.opts.skillsDir);
    } catch {
      return null;
    }
  }

  /** 列出可导出资产 */
  listExportable(): { skills: string[]; plugins: string[]; mcp: string[] } {
    const skills: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "pending" && existsSync(resolve(full, "SKILL.md"))) skills.push(entry.name);
          walk(full);
        }
      }
    };
    try {
      walk(this.opts.skillsDir);
    } catch {
      /* 目录不存在 */
    }
    let plugins: string[] = [];
    try {
      plugins = readdirSync(this.opts.pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      /* 无插件 */
    }
    let mcp: string[] = [];
    try {
      const cfgPath = this.opts.mcpConfigPath ?? resolve(process.cwd(), "config", "mcp.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "")) as {
          servers?: Record<string, unknown>;
        };
        mcp = Object.keys(cfg.servers ?? {});
      }
    } catch {
      /* 无配置 */
    }
    return { skills, plugins, mcp };
  }

  /** 列出已安装包（按目录内 manifest） */
  listInstalled(): { type: "plugin" | "skill"; name: string; version: string; dir: string }[] {
    const out: { type: "plugin" | "skill"; name: string; version: string; dir: string }[] = [];
    for (const [, dir] of [
      ["plugin", this.opts.pluginsDir],
      ["skill", this.opts.skillsDir],
    ] as const) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const sub = resolve(dir, entry);
        const manifestPath = resolve(sub, MANIFEST_FILE);
        if (!existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^\uFEFF/, "")) as AwManifest;
          out.push({ type: m.type === "skill" ? "skill" : "plugin", name: m.name, version: m.version, dir: sub });
        } catch {
          /* 忽略损坏 manifest */
        }
      }
    }
    return out;
  }
}

export const packageInstaller = new PackageInstaller({
  pluginsDir: resolve(process.cwd(), "config", "plugins"),
  skillsDir: resolve(process.cwd(), "skills"),
  mcpConfigPath: resolve(process.cwd(), "config", "mcp.json"),
});
