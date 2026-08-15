/**
 * 轻量插件契约（Sprint 27，报告 #1）
 * config/plugins/<name>/ 下每个子目录一个插件：
 *   plugin.ts|js 或 index.ts|js — 默认导出 setup(ctx) 函数（零框架依赖，不上 Cordis）
 *   config.json — 可选，注入 ctx.config
 * fail-soft：单个插件失败记录 error，不阻断启动（启动横幅 ⚠ 告警）
 * 安全：插件 = 任意进程权限代码，仅加载可信插件（README 注明）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toolRegistry } from "./tool-registry.js";
import { hookManager } from "../hooks/hook-manager.js";
import type {
  PluginContext,
  PluginInfo,
  PluginRegisterToolOptions,
  ToolDefinition,
  ToolHandler,
  HookEvent,
  HookHandler,
} from "../types.js";

/** 入口文件探测顺序（.ts 优先：dev 用 tsx 可加载；编译后仅 .js 可用） */
const ENTRY_CANDIDATES = ["plugin.ts", "plugin.js", "index.ts", "index.js"];

/** 插件默认导出形态：setup 函数 或 { setup, version?, description? } */
type PluginSetup = (ctx: PluginContext) => void | Promise<void>;

export class PluginManager {
  private plugins = new Map<string, PluginInfo>();
  /** 已加载入口路径 → 插件名（幂等防重复加载） */
  private loadedEntries = new Map<string, string>();

  /** 扫描目录加载全部插件；单个失败不抛（fail-soft） */
  async loadFromDir(dir: string, opts?: { dataDir?: string }): Promise<{ loaded: number; failed: number }> {
    if (!existsSync(dir)) return { loaded: 0, failed: 0 };
    const dataDir = opts?.dataDir ?? resolve(process.cwd(), "data");
    let loaded = 0;
    let failed = 0;

    for (const entry of readdirSync(dir)) {
      const pluginDir = resolve(dir, entry);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const entryFile = ENTRY_CANDIDATES.map((f) => resolve(pluginDir, f)).find((p) => existsSync(p));
      if (!entryFile) {
        this.setError(entry, pluginDir, "缺少入口文件（plugin.ts|js 或 index.ts|js）");
        failed++;
        continue;
      }
      try {
        await this.loadPlugin(entry, entryFile, pluginDir, dataDir);
        loaded++;
      } catch (err) {
        this.setError(entry, entryFile, (err as Error).message);
        failed++;
      }
    }
    return { loaded, failed };
  }

  getPlugins(): PluginInfo[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(name: string): PluginInfo | undefined {
    return this.plugins.get(name);
  }

  /** 清空记录（测试/重载用） */
  clear(): void {
    this.plugins.clear();
    this.loadedEntries.clear();
  }

  private setError(name: string, entry: string, error: string): void {
    this.plugins.set(name, {
      name,
      entry,
      status: "error",
      error,
      registeredTools: [],
      registeredHooks: 0,
    });
  }

  private async loadPlugin(name: string, entryFile: string, pluginDir: string, dataDir: string): Promise<void> {
    if (this.loadedEntries.has(entryFile)) return;

    // config.json（可选；BOM 清理对齐 permissions.json）
    let config: Record<string, unknown> = {};
    const configPath = resolve(pluginDir, "config.json");
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8").replace(/^\uFEFF/, ""));
      } catch {
        /* 损坏则忽略 */
      }
    }

    const mod = (await import(pathToFileURL(entryFile).href)) as Record<string, unknown>;
    const exported = mod.default ?? mod.setup;
    let setup: PluginSetup;
    let version: string | undefined;
    let description: string | undefined;
    if (typeof exported === "function") {
      setup = exported as PluginSetup;
    } else if (exported && typeof exported === "object" && typeof (exported as { setup?: unknown }).setup === "function") {
      const obj = exported as { setup: PluginSetup; version?: string; description?: string };
      setup = obj.setup;
      version = obj.version;
      description = obj.description;
    } else {
      throw new Error("插件入口必须默认导出或导出 setup(ctx) 函数");
    }

    const registeredTools: string[] = [];
    const registeredHooks: string[] = [];
    const ctx: PluginContext = {
      name,
      dataDir,
      config,
      registerTool: (
        toolName: string,
        definition: ToolDefinition,
        handler: ToolHandler,
        options?: PluginRegisterToolOptions,
      ) => {
        const { scope, ...regOptions } = options ?? {};
        if (scope) {
          toolRegistry.getScope(scope).register(toolName, definition, handler, { ...regOptions, plugin: name });
          registeredTools.push(`${scope}:${toolName}`);
        } else {
          toolRegistry.register(toolName, definition, handler, { ...regOptions, plugin: name });
          registeredTools.push(toolName);
        }
      },
      registerHook: (event: HookEvent, handler: HookHandler, options?: { id?: string; priority?: number }) => {
        const id = hookManager.on(event, handler, options);
        registeredHooks.push(id);
        return id;
      },
    };

    await setup(ctx);

    this.plugins.set(name, {
      name,
      version,
      description,
      entry: entryFile,
      status: "loaded",
      registeredTools,
      registeredHooks: registeredHooks.length,
    });
    this.loadedEntries.set(entryFile, name);
  }
}

export const pluginManager = new PluginManager();
