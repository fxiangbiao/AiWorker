/**
 * 应用运行时 — 子进程能力桥（Sprint 34）
 * 隔离：tool/service 应用以独立子进程运行（不进程内加载）
 *   spawn(process.execPath, [--max-old-space-size=256, bootstrap.mjs, entry])
 * 协议：stdin/stdout 行分隔 JSON-RPC（每行一个 JSON，防粘包）
 * 能力：storage / notify / llm / fs / http（无 terminal，权限检查后放行）
 * 可靠性：工具调用 60s 超时、输出截断、15s 心跳、崩溃指数退避重启（1s/2s/4s ≤3 次）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { eventBus } from "../server/event-bus.js";
import { auditLogger } from "./audit-logger.js";
import { sanitizeEnv, checkAppCapability } from "../security/sandbox.js";
import type { AppInfo, ToolResult, ModelCompleteOptions, ModelResponse } from "../types.js";

export interface AppRuntimeDeps {
  dataDir: string;
  /** llm.call 能力的后端（未注入则该能力不可用） */
  modelRouter?: {
    complete(options: ModelCompleteOptions): Promise<ModelResponse>;
  };
  /** 运行时权限申请通道（未注入 → 未声明权限直接拒绝 fail-closed） */
  requestAsk?: (question: string, options?: string[]) => Promise<string | null>;
  /** 心跳间隔 ms（0 禁用，测试用）；默认 15000 */
  heartbeatMs?: number;
  /** 子进程可用性等待 ms；默认 5000 */
  readyTimeoutMs?: number;
  /** 崩溃退避间隔 ms（默认 [1000, 2000, 4000]；测试可缩短） */
  crashDelaysMs?: number[];
  /** 崩溃重启耗尽（>3 次）回调，供 appManager 置 failed */
  onCrashed?: (appId: string, crashCount: number) => void;
}

export class AppError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface AppSnapshot extends AppInfo {
  dir: string;
}

interface PendingReq {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppProc {
  child: ChildProcess;
  ready: boolean;
  pending: Map<number, PendingReq>;
  nextId: number;
  crashCount: number;
  stopped: boolean;
  /** 该次退出按"崩溃"处理（心跳无响应 / 启动未就绪），区别于用户主动 stop */
  crashPending?: boolean;
  restartTimer?: NodeJS.Timeout;
  buffer: string;
}

const BOOTSTRAP = `/**
 * 应用运行时引导（由 AiWorker 生成，勿手动修改）
 * 行分隔 JSON-RPC 客户端 + 能力 ctx
 */
import { readFileSync } from "node:fs";
const stdin = process.stdin;
const stdout = process.stdout;
let buf = "";
const pending = new Map();
let nextId = 1;
function send(obj) { stdout.write(JSON.stringify(obj) + "\\n"); }
function request(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("bridge timeout")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
const capability = {
  storage: {
    get: (key) => request("storage.get", { key }),
    set: (key, value) => request("storage.set", { key, value }),
  },
  notify: (title, body) => request("notify", { title, body }),
  llm: { call: (opts) => request("llm.call", opts) },
  fs: {
    read: (p) => request("fs.read", { path: p }),
    write: (p, content) => request("fs.write", { path: p, content }),
    list: (p) => request("fs.list", { path: p }),
  },
  http: { fetch: (url, opts) => request("http.fetch", { url, opts }) },
};
let handler = null;
stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "bridge error"));
      else p.resolve(msg.result);
    } else if (msg.method === "app.stop") {
      process.exit(0);
    } else if (msg.method === "ping") {
      send({ id: msg.id, result: {} });
    } else if (msg.method === "tool.call") {
      const { name, args } = msg.params || {};
      Promise.resolve()
        .then(() => {
          if (typeof handler === "function") return handler(name, args, capability);
          if (handler && typeof handler.handleTool === "function") return handler.handleTool(name, args, capability);
          throw new Error("入口未实现 handleTool(name, args, ctx)");
        })
        .then((result) => send({ id: msg.id, result: result === undefined ? {} : result }))
        .catch((err) =>
          send({ id: msg.id, error: { code: "ERR_INTERNAL", message: String((err && err.message) || err) } }),
        );
    }
  }
});
const entryPath = process.argv[2];
const mod = await import(new URL("file://" + entryPath).href);
handler = mod.default ?? mod;
send({ method: "app.ready", params: {} });
`;

const MAX_STDIO_BUFFER = 1_000_000;
const TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const CRASH_DELAYS = [1000, 2000, 4000];

type AppCapabilityInner = "storage" | "notify" | "llm" | "fs" | "http";

function capabilityOf(method: string): AppCapabilityInner {
  if (method.startsWith("storage.")) return "storage";
  if (method === "notify") return "notify";
  if (method === "llm.call") return "llm";
  if (method.startsWith("fs.")) return "fs";
  if (method === "http.fetch") return "http";
  return "storage";
}

function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export class AppRuntime {
  /** 初始化后使用（init 先于一切调用，测试注入独立目录） */
  private deps!: AppRuntimeDeps;
  private runtimeDir = "";
  private procs = new Map<string, AppProc>();
  private snapshots = new Map<string, AppSnapshot>();
  /** 崩溃计数跨重启保留（proc 每次重启都是新对象，计数放在运行时上） */
  private crashCounts = new Map<string, number>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(deps?: AppRuntimeDeps) {
    if (deps) this.init(deps);
  }

  /** 初始化（单例模式：index.ts 注入真实 dataDir；测试注入独立目录） */
  init(deps: AppRuntimeDeps): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.deps = deps;
    this.runtimeDir = resolve(deps.dataDir, "apps", "_runtime");
    mkdirSync(this.runtimeDir, { recursive: true });
    writeFileSync(resolve(this.runtimeDir, "bootstrap.mjs"), BOOTSTRAP, "utf-8");
    const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  /** 启动应用子进程并等待 app.ready（opts.retry 为崩溃退避重启，不计入"用户显式启动"） */
  start(app: AppInfo & { dir: string }, opts?: { retry?: boolean }): Promise<void> {
    const existing = this.procs.get(app.id);
    if (existing) return Promise.resolve();
    if (!opts?.retry) this.crashCounts.delete(app.id);

    const entryAbs = resolve(app.dir, app.entry);
    if (!existsSync(entryAbs)) {
      throw new AppError("ERR_NOT_FOUND", `入口文件不存在: ${app.entry}`);
    }
    const bootstrapPath = resolve(this.runtimeDir, "bootstrap.mjs");
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", bootstrapPath, entryAbs],
      {
        cwd: app.dir,
        env: sanitizeEnv(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const proc: AppProc = {
      child,
      ready: false,
      pending: new Map(),
      nextId: 1,
      crashCount: 0,
      stopped: false,
      buffer: "",
    };
    this.procs.set(app.id, proc);
    this.snapshots.set(app.id, { ...app });

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(app.id, chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.toString().slice(-2000);
      if (text.trim()) {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: app.id,
          sessionId: "",
          action: "app:stderr",
          target: app.id,
          result: "success",
          detail: text.slice(-500),
        });
      }
    });
    child.on("error", (err) => {
      auditLogger.log({
        timestamp: Date.now(),
        agentId: app.id,
        sessionId: "",
        action: "app:spawn-error",
        target: app.id,
        result: "error",
        detail: err.message,
      });
    });
    child.on("exit", (code) => this.onExit(app.id, code));

    return this.waitReady(app.id, this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  }

  private waitReady(appId: string, timeoutMs: number): Promise<void> {
    const proc = this.procs.get(appId);
    if (!proc) return Promise.reject(new AppError("ERR_INTERNAL", "应用进程不存在"));
    if (proc.ready) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      const started = Date.now();
      const check = () => {
        const p = this.procs.get(appId);
        if (!p) return reject(new AppError("ERR_INTERNAL", "应用进程已退出"));
        if (p.ready) return resolvePromise();
        if (Date.now() - started > timeoutMs) {
          this.killAsCrash(appId);
          return reject(new AppError("ERR_TIMEOUT", "应用启动超时（未收到 app.ready）"));
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  private onStdout(appId: string, chunk: string): void {
    const proc = this.procs.get(appId);
    if (!proc) return;
    proc.buffer += chunk;
    if (proc.buffer.length > MAX_STDIO_BUFFER) proc.buffer = proc.buffer.slice(-MAX_STDIO_BUFFER);
    let idx: number;
    while ((idx = proc.buffer.indexOf("\n")) >= 0) {
      const line = proc.buffer.slice(0, idx);
      proc.buffer = proc.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: string; message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === "app.ready") {
        proc.ready = true;
        continue;
      }
      if (msg.method === "app.log") {
        auditLogger.log({
          timestamp: Date.now(),
          agentId: appId,
          sessionId: "",
          action: "app:log",
          target: appId,
          result: "success",
          detail: String(msg.params?.msg ?? "").slice(-500),
        });
        continue;
      }
      if (msg.id !== undefined) {
        const pending = proc.pending.get(msg.id);
        if (pending) {
          proc.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new AppError(msg.error.code ?? "ERR_INTERNAL", msg.error.message ?? "bridge error"));
          } else {
            pending.resolve(msg.result);
          }
          continue;
        }
        // 子进程能力请求（storage/notify/llm/fs/http）— 权限检查后响应
        const snap = this.snapshots.get(appId);
        if (snap && msg.method) {
          this.handleCapability(snap, msg.method, (msg.params ?? {}) as Record<string, unknown>)
            .then((result) => proc.child.stdin?.write(JSON.stringify({ id: msg.id, result }) + "\n"))
            .catch((err) => {
              const code = err instanceof AppError ? err.code : "ERR_INTERNAL";
              proc.child.stdin?.write(
                JSON.stringify({ id: msg.id, error: { code, message: (err as Error).message } }) + "\n",
              );
            });
        } else {
          proc.child.stdin?.write(
            JSON.stringify({ id: msg.id, error: { code: "ERR_NOT_FOUND", message: "应用未找到" } }) + "\n",
          );
        }
        continue;
      }
    }
  }

  /** 调用应用工具（60s 超时） */
  callTool(appId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const proc = this.procs.get(appId);
    if (!proc || !proc.ready) {
      return Promise.resolve({ tool_call_id: "", success: false, content: "", error: `应用未运行: ${appId}` });
    }
    return new Promise((resolve) => {
      const id = proc.nextId++;
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        resolve({ tool_call_id: "", success: false, content: "", error: `工具调用超时(>${TOOL_TIMEOUT_MS}ms)` });
      }, TOOL_TIMEOUT_MS);
      proc.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          const v = value as { success?: boolean; content?: unknown; error?: string };
          if (v && typeof v === "object" && typeof v.success === "boolean") {
            resolve({
              tool_call_id: "",
              success: v.success,
              content: typeof v.content === "string" ? v.content : JSON.stringify(v.content ?? ""),
              error: v.error,
            });
          } else {
            resolve({
              tool_call_id: "",
              success: true,
              content: typeof value === "string" ? value : JSON.stringify(value),
            });
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          resolve({ tool_call_id: "", success: false, content: "", error: (err as Error).message });
        },
        timer,
      });
      proc.child.stdin?.write(JSON.stringify({ id, method: "tool.call", params: { name, args } }) + "\n");
    });
  }

  /** 停止应用子进程（优雅 app.stop → 3s 兜底 kill） */
  async stop(appId: string): Promise<void> {
    const proc = this.procs.get(appId);
    if (!proc) return;
    proc.stopped = true;
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
    try {
      const id = proc.nextId++;
      const done = new Promise<void>((resolve) => {
        proc.pending.set(id, {
          resolve: () => resolve(),
          reject: () => resolve(),
          timer: setTimeout(() => resolve(), 3000),
        });
        proc.child.stdin?.write(JSON.stringify({ id, method: "app.stop", params: {} }) + "\n");
      });
      await done;
    } catch {
      /* 忽略 */
    }
    this.kill(appId);
    this.procs.delete(appId);
    this.snapshots.delete(appId);
    this.crashCounts.delete(appId);
  }

  /** 终止进程但按"崩溃"处理：计入退避计数并触发重启（心跳无响应 / 启动未就绪） */
  private killAsCrash(appId: string): void {
    const proc = this.procs.get(appId);
    if (proc) proc.crashPending = true;
    this.kill(appId);
  }

  /** 强制终止（destroy/超时/崩溃处理用） */
  kill(appId: string): void {
    const proc = this.procs.get(appId);
    if (!proc) return;
    proc.stopped = true;
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
    for (const p of proc.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AppError("ERR_INTERNAL", "应用进程已终止"));
    }
    proc.pending.clear();
    try {
      proc.child.kill();
    } catch {
      /* 已退出 */
    }
  }

  /** 强制停止所有（destroy 全部 / 测试清理） */
  stopAll(): void {
    for (const id of [...this.procs.keys()]) {
      this.kill(id);
      this.procs.delete(id);
      this.snapshots.delete(id);
      this.crashCounts.delete(id);
    }
  }

  isRunning(appId: string): boolean {
    const proc = this.procs.get(appId);
    return !!proc && proc.ready && !proc.stopped;
  }

  /** 崩溃处理：指数退避重启 ≤3 次（计数跨重启保留，用户显式 start 时重置） */
  private onExit(appId: string, _code: number | null): void {
    const proc = this.procs.get(appId);
    if (!proc) return;
    this.procs.delete(appId);
    if (proc.stopped && !proc.crashPending) return;
    const crashCount = (this.crashCounts.get(appId) ?? 0) + 1;
    this.crashCounts.set(appId, crashCount);
    proc.crashCount = crashCount;
    auditLogger.log({
      timestamp: Date.now(),
      agentId: appId,
      sessionId: "",
      action: "app:crash",
      target: appId,
      result: "error",
      detail: `crashCount=${crashCount}`,
    });
    eventBus.broadcast({ type: "app/crashed", appId, crashCount });
    const snap = this.snapshots.get(appId);
    if (!snap) return;
    if (crashCount > CRASH_DELAYS.length) {
      this.deps?.onCrashed?.(appId, crashCount);
      this.crashCounts.delete(appId);
      this.snapshots.delete(appId);
      return;
    }
    const delays = this.deps.crashDelaysMs?.length ? this.deps.crashDelaysMs : CRASH_DELAYS;
    const delay = delays[Math.min(crashCount, delays.length) - 1] ?? delays[delays.length - 1];
    proc.restartTimer = setTimeout(() => {
      if (this.procs.has(appId)) return;
      const snapNow = this.snapshots.get(appId);
      if (!snapNow) return;
      this.start(snapNow, { retry: true }).catch(() => {
        /* 重启失败：appManager 置 failed 或下次心跳兜底 */
      });
    }, delay);
  }

  /** 心跳：15s ping，无响应（5s）kill 触发崩溃路径 */
  private heartbeat(): void {
    for (const [appId, proc] of this.procs) {
      if (!proc.ready || proc.stopped) continue;
      const id = proc.nextId++;
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        this.killAsCrash(appId);
      }, 5000);
      proc.pending.set(id, {
        resolve: () => clearTimeout(timer),
        reject: () => clearTimeout(timer),
        timer,
      });
      proc.child.stdin?.write(JSON.stringify({ id, method: "ping", params: {} }) + "\n");
    }
  }

  // ===== 能力桥处理（子进程请求 → 权限检查 → 分派） =====

  async handleCapability(app: AppInfo & { dir: string }, method: string, params: Record<string, unknown>): Promise<unknown> {
    const cap = capabilityOf(method);
    const allowed = await this.checkPermission(app, cap);
    if (!allowed) {
      throw new AppError("ERR_PERMISSION", `权限未授予: ${cap}`);
    }
    switch (method) {
      case "storage.get":
        return this.storageRead(app, String(params.key ?? ""));
      case "storage.set":
        this.storageWrite(app, String(params.key ?? ""), params.value);
        return {};
      case "notify":
        eventBus.broadcast({ type: "app/notify", appId: app.id, title: String(params.title ?? ""), body: String(params.body ?? "") });
        return {};
      case "llm.call":
        return this.llmCall(params);
      case "fs.read":
        return this.fsRead(app, String(params.path ?? ""));
      case "fs.write":
        this.fsWrite(app, String(params.path ?? ""), String(params.content ?? ""));
        return {};
      case "fs.list":
        return this.fsList(app, String(params.path ?? ""));
      case "http.fetch":
        return this.httpFetch(params);
      default:
        throw new AppError("ERR_NOT_FOUND", `未知能力: ${method}`);
    }
  }

  private async checkPermission(app: AppInfo & { dir: string }, cap: AppCapabilityInner): Promise<boolean> {
    // 强制层：storage 自动允许，其余须静态声明命中（先于 ask 权限层）
    const forced = checkAppCapability(app.id, cap, app.permissions);
    if (forced.allowed) return true;
    if (this.deps.requestAsk) {
      const answer = await this.deps.requestAsk(
        `应用「${app.name}」请求权限 ${forced.reason?.split(": ")[1] ?? cap}（${cap}），是否允许本次调用？`,
        ["允许", "拒绝"],
      );
      const ok = answer !== null && answer !== "拒绝";
      auditLogger.log({
        timestamp: Date.now(),
        agentId: app.id,
        sessionId: "",
        action: "app:permission",
        target: app.id,
        result: ok ? "success" : "blocked",
        detail: `cap=${cap}`,
      });
      return ok;
    }
    return false; // 无确认通道 fail-closed
  }

  private storagePath(app: AppInfo & { dir: string }, key: string): string {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) {
      throw new AppError("ERR_PERMISSION", `storage key 非法: ${key}`);
    }
    const dir = resolve(app.dir, "data", "storage");
    mkdirSync(dir, { recursive: true });
    return resolve(dir, `${key}.json`);
  }

  private storageRead(app: AppInfo & { dir: string }, key: string): unknown {
    const file = this.storagePath(app, key);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  private storageWrite(app: AppInfo & { dir: string }, key: string, value: unknown): void {
    const file = this.storagePath(app, key);
    writeFileSync(file, JSON.stringify(value ?? null), "utf-8");
  }

  private async llmCall(params: Record<string, unknown>): Promise<unknown> {
    if (!this.deps.modelRouter) {
      throw new AppError("ERR_NOT_FOUND", "llm 能力未启用（服务未注入模型路由）");
    }
    const messages = params.messages;
    if (!Array.isArray(messages)) throw new AppError("ERR_INTERNAL", "llm.call 需要 messages");
    const resp = await this.deps.modelRouter.complete({
      model: String(params.model ?? "default"),
      messages: messages as ModelCompleteOptions["messages"],
      maxTokens: typeof params.maxTokens === "number" ? params.maxTokens : undefined,
    });
    return { text: resp.text, usage: resp.usage };
  }

  private fsPath(app: AppInfo & { dir: string }, path: string): string {
    const abs = resolve(app.dir, path);
    if (!isInsideDir(app.dir, abs)) {
      throw new AppError("ERR_PERMISSION", `fs 越界: ${path}`);
    }
    return abs;
  }

  private fsRead(app: AppInfo & { dir: string }, path: string): unknown {
    const abs = this.fsPath(app, path);
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, "utf-8");
    return raw.length > 100_000 ? raw.slice(0, 100_000) : raw;
  }

  private fsWrite(app: AppInfo & { dir: string }, path: string, content: string): void {
    const abs = this.fsPath(app, path);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  private fsList(app: AppInfo & { dir: string }, path: string): unknown {
    const abs = this.fsPath(app, path);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  }

  private async httpFetch(params: Record<string, unknown>): Promise<unknown> {
    const url = String(params.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new AppError("ERR_INTERNAL", `http.fetch url 非法: ${url}`);
    const opts = (params.opts ?? {}) as RequestInit;
    // 第三方 API 不可达/慢时快速失败，避免宿主桥接 30s 超时被误报为"宿主无响应"
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(url, { ...opts, signal: ac.signal });
    } catch (err) {
      const reason = (err as Error).name === "AbortError" ? "超时（10s）" : (err as Error).message;
      throw new AppError("ERR_NETWORK", `http.fetch 网络请求失败: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      headers: Object.fromEntries(resp.headers.entries()),
      text: text.slice(0, 1_000_000),
    };
  }
}

export const appRuntime = new AppRuntime();
