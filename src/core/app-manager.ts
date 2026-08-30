/**
 * 应用管理器（Sprint 34）— 状态机 + 持久化 + 恢复 + 插件兼容
 * 状态机: installed → starting → running → stopping → stopped；destroyed 终态
 * 持久化: data/apps/state.json（status/autostart/crashCount/lastError）
 * 恢复:   OS 启动时 installed 回到 stopped；autostart:true 的 tool/service 自动拉起
 * 兼容:   list() 合并 pluginManager 视图（现有插件展示为 tool 类应用，本体零改动）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { eventBus } from "../server/event-bus.js";
import { auditLogger } from "./audit-logger.js";
import { processManager } from "./process-manager.js";
import { validateAppManifest } from "./app-manifest.js";
import { toolRegistry } from "./tool-registry.js";
import { skillRegistry } from "./skill-registry.js";
import { pluginManager } from "./plugin-manager.js";
import type { AppRuntime } from "./app-runtime.js";
import { AppError } from "./app-runtime.js";
import type { AppInfo, AppManifest, AppStatus } from "../types.js";

export interface AppActionResult {
  ok: boolean;
  error?: string;
  app?: AppInfo;
}

interface AppStateRecord {
  status: AppStatus;
  autostart: boolean;
  crashCount: number;
  lastError?: string;
}

export class AppManager {
  private dataDir: string;
  private appsDir: string;
  private statePath: string;
  private runtime: AppRuntime;
  private manifests = new Map<string, AppManifest>();
  private states = new Map<string, AppStateRecord>();
  private initialized = false;

  constructor(dataDir: string, runtime: AppRuntime) {
    this.dataDir = dataDir;
    this.appsDir = resolve(dataDir, "apps");
    this.statePath = resolve(this.appsDir, "state.json");
    this.runtime = runtime;
  }

  /** 扫描 data/apps/ 加载 manifest + state，恢复运行状态 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    mkdirSync(this.appsDir, { recursive: true });
    this.loadState();
    for (const entry of readdirSync(this.appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "_runtime") continue;
      const manifestPath = resolve(this.appsDir, entry.name, "app.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = validateAppManifest(JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^\uFEFF/, "")));
        this.manifests.set(manifest.id, manifest);
      } catch {
        /* 损坏 manifest 跳过 */
      }
    }
    // 恢复：autostart 的 tool/service 一律拉起；webapp（app 类型）上次 running 也恢复
    //（窗口应用 start 无副作用，重启后保持可用）
    for (const [id, state] of [...this.states]) {
      const manifest = this.manifests.get(id);
      if (!manifest) {
        this.states.delete(id);
        continue;
      }
      const shouldStart =
        (state.autostart && (manifest.type === "tool" || manifest.type === "service")) ||
        (state.status === "running" && manifest.type === "app");
      if (shouldStart) {
        await this.start(id).catch(() => {});
      } else {
        state.status = "stopped";
      }
    }
    this.saveState();
  }

  list(): AppInfo[] {
    const apps = [...this.manifests.keys()].map((id) => this.toInfo(id));
    // 插件兼容视图（tool 类，进程内加载）
    for (const p of pluginManager.getPlugins()) {
      apps.push({
        id: p.name,
        type: "tool",
        name: p.name,
        version: p.version ?? "0",
        description: p.description ?? "插件应用",
        entry: p.entry,
        permissions: [],
        tools: p.registeredTools.map((t) => (t.includes(":") ? t.slice(t.indexOf(":") + 1) : t)),
        status: p.status === "loaded" ? "running" : "failed",
        autostart: false,
        plugin: true,
        lastError: p.error,
      });
    }
    return apps;
  }

  get(id: string): AppInfo | undefined {
    if (this.manifests.has(id)) return this.toInfo(id);
    return undefined;
  }

  /** 从目录安装应用（主路径；.aw 打包 Sprint 35） */
  installFromDir(dir: string, opts?: { force?: boolean; originSessionId?: string }): AppActionResult {
    const manifestPath = resolve(dir, "app.json");
    if (!existsSync(manifestPath)) {
      return { ok: false, error: `缺少 app.json: ${dir}` };
    }
    let manifest: AppManifest;
    try {
      manifest = validateAppManifest(JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^\uFEFF/, "")));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (opts?.originSessionId) manifest = { ...manifest, originSessionId: opts.originSessionId };

    const targetDir = resolve(this.appsDir, manifest.id);
    const srcResolved = resolve(dir);
    if (srcResolved !== targetDir) {
      if (existsSync(targetDir) && !opts?.force) {
        return { ok: false, error: `应用已存在: ${manifest.id}（使用 force 覆盖或先 destroy）` };
      }
      try {
        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
        cpSync(srcResolved, targetDir, { recursive: true });
      } catch (err) {
        return { ok: false, error: `复制失败: ${(err as Error).message}` };
      }
    }

    this.manifests.set(manifest.id, manifest);
    this.states.set(manifest.id, {
      status: "installed",
      autostart: manifest.autostart ?? false,
      crashCount: 0,
    });
    this.saveState();
    auditLogger.log({
      timestamp: Date.now(),
      agentId: manifest.id,
      sessionId: manifest.originSessionId ?? "",
      action: "app:install",
      target: manifest.id,
      result: "success",
      detail: `type=${manifest.type}, v${manifest.version}`,
    });
    this.emit("app/installed", manifest.id);
    return { ok: true, app: this.toInfo(manifest.id) };
  }

  async start(id: string): Promise<AppActionResult> {
    const manifest = this.manifests.get(id);
    if (!manifest) return { ok: false, error: `应用不存在: ${id}` };
    const state = this.states.get(id) ?? { status: "installed" as AppStatus, autostart: false, crashCount: 0 };
    if (state.status === "running") {
      // 幂等：确保进程已注册（服务器重启恢复的 running 应用走不到下方注册分支，否则进程列表漏报）
      this.registerAppProcess(id);
      return { ok: true, app: this.toInfo(id) };
    }

    const dir = resolve(this.appsDir, id);
    const app = this.toInfo(id);
    try {
      if (manifest.type === "tool" || manifest.type === "service") {
        state.status = "starting";
        this.saveState();
        await this.runtime.start({ ...app, dir });
        this.registerTools(manifest);
        state.status = "running";
        this.registerAppProcess(id);
      } else if (manifest.type === "skill") {
        const skillPath = resolve(dir, "SKILL.md");
        if (existsSync(skillPath)) {
          skillRegistry.reloadSkill(skillPath);
        }
        state.status = "running";
        this.registerAppProcess(id);
      } else {
        // webapp/agent：无子进程（iframe 渲染 / 状态机），仍注册进程视图
        state.status = "running";
        this.registerAppProcess(id);
      }
      state.lastError = undefined;
    } catch (err) {
      state.status = "failed";
      state.lastError = (err as Error).message;
      this.saveState();
      auditLogger.log({
        timestamp: Date.now(),
        agentId: id,
        sessionId: manifest.originSessionId ?? "",
        action: "app:start-failed",
        target: id,
        result: "error",
        detail: (err as Error).message,
      });
      this.emit("app/failed", id);
      return { ok: false, error: (err as Error).message, app: this.toInfo(id) };
    }
    this.saveState();
    auditLogger.log({
      timestamp: Date.now(),
      agentId: id,
      sessionId: manifest.originSessionId ?? "",
      action: "app:start",
      target: id,
      result: "success",
      detail: `type=${manifest.type}`,
    });
    this.emit("app/started", id);
    return { ok: true, app: this.toInfo(id) };
  }

  async stop(id: string): Promise<AppActionResult> {
    const manifest = this.manifests.get(id);
    if (!manifest) return { ok: false, error: `应用不存在: ${id}` };
    const state = this.states.get(id);
    if (!state || state.status === "stopped" || state.status === "installed") {
      return { ok: true, app: this.toInfo(id) };
    }
    if (manifest.type === "tool" || manifest.type === "service") {
      await this.runtime.stop(id);
    }
    processManager.unregister(`app:${id}`);
    this.unregisterTools(manifest);
    state.status = "stopped";
    this.saveState();
    auditLogger.log({
      timestamp: Date.now(),
      agentId: id,
      sessionId: manifest.originSessionId ?? "",
      action: "app:stop",
      target: id,
      result: "success",
    });
    this.emit("app/stopped", id);
    return { ok: true, app: this.toInfo(id) };
  }

  /** 销毁：stop + 卸载注册 + 删除沙箱 + 审计；幂等 */
  async destroy(id: string): Promise<AppActionResult> {
    const existed = this.manifests.has(id) || this.states.has(id);
    if (!existed) return { ok: true };
    const manifest = this.manifests.get(id);
    const state = this.states.get(id);
    if (state && (state.status === "running" || state.status === "starting" || state.status === "failed")) {
      if (manifest && (manifest.type === "tool" || manifest.type === "service")) {
        await this.runtime.stop(id).catch(() => this.runtime.kill(id));
      }
    }
    processManager.unregister(`app:${id}`);
    if (manifest) this.unregisterTools(manifest);
    this.manifests.delete(id);
    this.states.delete(id);
    const dir = resolve(this.appsDir, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.saveState();
    auditLogger.log({
      timestamp: Date.now(),
      agentId: id,
      sessionId: manifest?.originSessionId ?? "",
      action: "app:destroy",
      target: id,
      result: "success",
    });
    this.emit("app/destroyed", id);
    return { ok: true };
  }

  /** 崩溃重启耗尽回调（app-runtime onCrashed） */
  onCrashed(appId: string, crashCount: number): void {
    const state = this.states.get(appId);
    if (state) {
      state.status = "failed";
      state.crashCount = crashCount;
      state.lastError = `进程崩溃 ${crashCount} 次，停止重启`;
      this.saveState();
    }
    auditLogger.log({
      timestamp: Date.now(),
      agentId: appId,
      sessionId: "",
      action: "app:crashed-permanent",
      target: appId,
      result: "error",
      detail: `crashCount=${crashCount}`,
    });
    this.emit("app/failed", appId);
  }

  /** 注册 AppProcess（统一入口：tool/service 子进程 + webapp/skill/agent 视图） */
  private registerAppProcess(id: string): void {
    processManager.register({
      kind: "app",
      pid: `app:${id}`,
      appId: id,
      status: "running",
      startedAt: Date.now(),
    });
  }

  /** 能力桥统一入口（webapp iframe / 子进程共用；Sprint 35 bridge 端点） */
  async handleBridge(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const app = this.get(id);
    if (!app) throw new AppError("ERR_NOT_FOUND", `应用不存在: ${id}`);
    const dir = resolve(this.appsDir, id);
    return this.runtime.handleCapability({ ...app, dir }, method, params);
  }

  /** 重载应用 manifest（update 后同步内存；Sprint 35） */
  reload(id: string): boolean {
    const manifestPath = resolve(this.appsDir, id, "app.json");
    if (!existsSync(manifestPath)) return false;
    try {
      const manifest = validateAppManifest(JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^\uFEFF/, "")));
      this.manifests.set(id, manifest);
      return true;
    } catch {
      return false;
    }
  }

  // ===== 内部 =====

  private loadState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as Record<string, AppStateRecord>;
      for (const [id, s] of Object.entries(parsed)) {
        this.states.set(id, {
          status: s.status ?? "installed",
          autostart: s.autostart ?? false,
          crashCount: s.crashCount ?? 0,
          lastError: s.lastError,
        });
      }
    } catch {
      /* 损坏则忽略 */
    }
  }

  private saveState(): void {
    const out: Record<string, AppStateRecord> = {};
    for (const [id, s] of this.states) out[id] = s;
    try {
      writeFileSync(this.statePath, JSON.stringify(out, null, 2) + "\n", "utf-8");
    } catch {
      /* 持久化失败静默 */
    }
  }

  private registerTools(manifest: AppManifest): void {
    for (const t of manifest.tools ?? []) {
      toolRegistry.register(
        t.name,
        { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } },
        (args) => this.runtime.callTool(manifest.id, t.name, args),
        { plugin: `app:${manifest.id}` },
      );
    }
  }

  private unregisterTools(manifest: AppManifest): void {
    for (const t of manifest.tools ?? []) {
      toolRegistry.unregister(t.name);
    }
  }

  private toInfo(id: string): AppInfo {
    const manifest = this.manifests.get(id)!;
    const state = this.states.get(id) ?? { status: "installed" as AppStatus, autostart: false, crashCount: 0 };
    return {
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      entry: manifest.entry,
      permissions: manifest.permissions ?? [],
      tools: (manifest.tools ?? []).map((t) => t.name),
      status: state.status,
      autostart: state.autostart,
      originSessionId: manifest.originSessionId,
      lastError: state.lastError,
      crashCount: state.crashCount,
      ui: manifest.ui,
    };
  }

  private emit(type: string, id: string): void {
    eventBus.broadcast({ type, app: this.get(id) ?? null });
  }
}
