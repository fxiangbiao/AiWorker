/**
 * 应用工厂（Sprint 35 v2）— 一句话生成应用
 * v2 方案：复用 agent-loop + fs_write 工具生成（与智能体对话中调工具写文件无区别）
 * 管线: 类型识别 → 构造临时「生成 agent」（tools=[fs_write,fs_list,fs_read]，工作目录 _gen/<id>）
 *       → runAgentLoopStream 多轮工具调用写文件（onToolCall/onToolResult → 轨迹）
 *       → 校验器最终把关（文件存在/JS 语法/manifest/权限白名单）→ 不过关反馈 LLM 自查再修（≤2 轮）
 *       → 工厂生成 app.json + index.html（宿主骨架）→ 安装运行（或文档型落 data/docs/）
 * 生成期安全: 工具白名单仅 fs 三件套（沙箱 _gen 内，路径穿越防护已有）+ 权限上限模板硬编码 + 迭代上限
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import type {
  AgentConfig,
  AgentRunResult,
  AppManifest,
  AppPermission,
  AppSpec,
  GenFile,
  GenerateResult,
  StreamCallbacks,
} from "../types.js";
import { validateAppManifest } from "./app-manifest.js";
import { AppManager } from "./app-manager.js";
import { detectType, getTemplate, type TemplateDef } from "./app-templates/index.js";
import { webappIndexHtml } from "./app-templates/webapp.js";
import { runAgentLoopStream } from "./agent-loop.js";
import type { ModelRouter } from "./model-router.js";
import type { ContextManager } from "./context-manager.js";
import type { SessionStore } from "../memory/session-store.js";
import type { ProcessManager } from "./process-manager.js";
import { auditLogger } from "./audit-logger.js";
import { eventBus } from "../server/event-bus.js";

/** 生成 agent 迭代上限（长应用多轮 fs_write 兜底） */
export const MAX_GEN_ITERATIONS = 30;
/** 校验失败后反馈 LLM 自查再修的轮数上限 */
const MAX_FIX_ROUNDS = 2;
const GEN_DIR = "_gen";
const AGENT_ID = "appgen";
/** 生成 agent 工具白名单（fs 四件套，沙箱 _gen 内；fs_edit 支持局部修改/删除行） */
const GEN_TOOLS = ["fs_write", "fs_edit", "fs_list", "fs_read"];

export interface AppFactoryDeps {
  modelRouter: ModelRouter;
  contextManager: ContextManager;
  sessionStore: SessionStore;
  dataDir: string;
  processManager?: ProcessManager;
}

export type GenerateProgress = (step: string, index: number, total: number, detail?: string) => void;

/** JS 语法检查（webapp 的 app.js 为普通 script，无 import/export） */
export function checkJsSyntax(content: string): string | null {
  if (!content.trim()) return null;
  try {
    new Function(content);
    return null;
  } catch (err) {
    return `JS 语法错误: ${(err as Error).message}`;
  }
}

export class AppFactory {
  constructor(
    private deps: AppFactoryDeps,
    private manager: AppManager,
  ) {}

  /** 即时生成：文档型落 data/docs/，其余安装为应用（onProgress 报告轨迹） */
  async generate(spec: AppSpec, onProgress?: GenerateProgress): Promise<GenerateResult> {
    const templateId = !spec.type || spec.type === "app" ? detectType(spec.description) : spec.type;
    const def = getTemplate(templateId);
    if (!def) return { ok: false, error: `不支持的类型: ${templateId}` };
    const type = def.template.type;

    const genId = `gen-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const genDir = resolve(this.deps.dataDir, GEN_DIR, genId);
    const sessionKey = `appgen-${genId}`;
    this.deps.sessionStore.ensureSession(sessionKey, AGENT_ID);
    // 会话标题可读化（生成过程独立会话，供左侧会话列表区分展示）
    const desc = spec.description.trim().replace(/\s+/g, " ").slice(0, 24);
    this.deps.sessionStore.setSummary(sessionKey, `应用生成: ${desc || "应用"}`);
    mkdirSync(genDir, { recursive: true });

    try {
      eventBus.broadcast({ type: "app/generating", appId: genId, attempt: 1, step: "生成" });
      onProgress?.("生成", 0, MAX_GEN_ITERATIONS, "生成 agent 已启动…");

      const config = this.buildConfig(def, { ...spec, type });
      let files: GenFile[] | null = null;
      let lastError = "";
      let truncated = false;
      for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
        const feedback =
          round === 0
            ? null
            : `校验未通过：${lastError}\n请自查问题原因，用 fs_write 覆盖修复相应文件（写入完整内容），修复完成后直接输出总结。`;
        const result = await this.runGeneration(config, def, sessionKey, genDir, spec, feedback, onProgress, round);
        truncated = truncated || result.truncated;
        const collected = this.collectFiles(genDir);
        const err = this.validate(templateId, type, collected, genId);
        if (!err) {
          files = collected;
          break;
        }
        lastError = err;
        onProgress?.("生成", MAX_GEN_ITERATIONS - 1, MAX_GEN_ITERATIONS, `校验未通过：${err}（第 ${round + 1} 轮修复）`);
      }

      if (!files) {
        const reason = truncated ? "（生成 agent 达迭代上限，任务可能未完成）" : "";
        return { ok: false, error: `生成失败${reason}: ${lastError}` };
      }

      // 文档型：落 data/docs/<sessionId>/，不安装为应用
      if (templateId === "doc") {
        return this.finalizeDoc(files, spec);
      }

      // 应用型：工厂生成 manifest（框架层，LLM 不碰 id；权限按模板白名单展开，能力桥"直接用"契约成立）
      let manifest: AppManifest;
      if (type === "app") {
        manifest = {
          id: genId,
          type: "app",
          name: spec.description.trim().slice(0, 12) || "应用",
          version: "1.0.0",
          description: spec.description.trim().slice(0, 60),
          entry: "index.html",
          permissions: def.template.allowedPermissions.map((p) => p.replace("{id}", genId)) as AppPermission[],
          ui: { surface: spec.surface ?? "panel" },
        };
        files = [
          ...files,
          { path: "app.json", content: JSON.stringify(manifest, null, 2) },
          { path: "index.html", content: webappIndexHtml(manifest.name, files.some((f) => f.path === "style.css")) },
        ];
      } else {
        // tool/service/skill/agent：LLM 写 app.json，工厂覆盖 id（其余保留）
        const manifestRaw = files.find((f) => f.path === "app.json")?.content;
        if (!manifestRaw) return { ok: false, error: "生成物缺少 app.json" };
        manifest = { ...(JSON.parse(manifestRaw) as AppManifest), id: genId };
        files = files.map((f) =>
          f.path === "app.json" ? { ...f, content: JSON.stringify(manifest, null, 2) } : f,
        );
      }

      // 写最终文件集 → 安装 → 启动
      for (const f of files) {
        if (f.path.includes("..") || f.path.startsWith("/")) continue;
        const abs = resolve(genDir, f.path);
        if (abs.startsWith(genDir)) writeFileSync(abs, f.content, "utf-8");
      }
      const installed = this.manager.installFromDir(genDir, { originSessionId: spec.sessionId });
      if (!installed.ok) return { ok: false, error: installed.error ?? "安装失败" };
      const started = await this.manager.start(genId);
      if (!started.ok) {
        // 启动失败：清理已安装的失败残留，避免 failed 应用堆积
        await this.manager.destroy(genId).catch(() => {});
        return { ok: false, error: started.error ?? "启动失败" };
      }
      auditLogger.log({
        timestamp: Date.now(),
        agentId: "factory",
        sessionId: spec.sessionId ?? "",
        action: "app:generate",
        target: genId,
        result: "success",
        detail: `type=${type}`,
      });
      eventBus.broadcast({ type: "app/generated", appId: genId, app: started.app ?? null });
      return { ok: true, app: started.app, files };
    } finally {
      rmSync(genDir, { recursive: true, force: true });
    }
  }

  /** 同一应用并发更新互斥（appId → 串行链尾；防止并发 agent-loop 交错写坏文件） */
  private updateLocks = new Map<string, Promise<unknown>>();

  private async withUpdateLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.updateLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.updateLocks.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.updateLocks.get(id) === tail) this.updateLocks.delete(id);
    }
  }

  /** 迭代生成：只重生成逻辑文件，保留沙箱数据（同一应用串行化执行；onProgress 报告轨迹） */
  async update(
    id: string,
    description: string,
    sessionId?: string,
    onProgress?: GenerateProgress,
  ): Promise<GenerateResult> {
    return this.withUpdateLock(id, () => this.updateInner(id, description, sessionId, onProgress));
  }

  private async updateInner(
    id: string,
    description: string,
    sessionId?: string,
    onProgress?: GenerateProgress,
  ): Promise<GenerateResult> {
    const app = this.manager.get(id);
    if (!app) return { ok: false, error: `应用不存在: ${id}` };
    const templateId = app.type === "app" ? "webapp" : app.type;
    const def = getTemplate(templateId);
    if (!def?.buildFileTaskPrompt) return { ok: false, error: `模板 ${templateId} 不支持迭代更新` };

    const dir = resolve(this.deps.dataDir, "apps", id);
    const existing: GenFile[] = [];
    for (const name of ["app.json", "index.html", "app.js", "style.css", "index.mjs", "SKILL.md", "agent.yaml"]) {
      const p = resolve(dir, name);
      if (existsSync(p)) existing.push({ path: name, content: readFileSync(p, "utf-8") });
    }
    const targetFile = app.type === "app" ? "app.js" : "index.mjs";
    if (!existing.some((f) => f.path === targetFile)) {
      return { ok: false, error: `缺少逻辑文件 ${targetFile}，无法迭代更新` };
    }
    const before = existing.find((f) => f.path === targetFile)!.content;
    const beforeStyle = existing.find((f) => f.path === "style.css")?.content;
    const existingDesc = existing.map((f) => `${f.path}（${f.content.length} 字符）`).join("\n");
    const spec: AppSpec = { description, type: app.type, sessionId };
    const sessionKey = `appgen-upd-${id}-${Date.now().toString(36)}`;
    this.deps.sessionStore.ensureSession(sessionKey, AGENT_ID);
    const updDesc = description.trim().replace(/\s+/g, " ").slice(0, 24);
    this.deps.sessionStore.setSummary(sessionKey, `应用更新: ${updDesc || id}`);

    try {
      const config = this.buildConfig(def, { ...spec, type: app.type });
      const taskMsg = def.buildFileTaskPrompt(spec, targetFile, existingDesc);
      onProgress?.("更新", 0, MAX_GEN_ITERATIONS, "读取现有应用结构…");
      // 写入轨迹（与生成一致）：fs_write 调用实时上报 step/detail
      const pending = new Map<string, string>();
      let calls = 0;
      const emit = (detail: string, index = calls): void => {
        onProgress?.("更新", Math.min(index, MAX_GEN_ITERATIONS), MAX_GEN_ITERATIONS, detail);
      };
      const result = await runAgentLoopStream(
        config,
        taskMsg,
        {
          modelRouter: this.deps.modelRouter,
          contextManager: this.deps.contextManager,
          sessionStore: this.deps.sessionStore,
          sessionId: sessionKey,
          workingDir: dir,
          dataDir: this.deps.dataDir,
          toolScope: AGENT_ID,
          processManager: this.deps.processManager,
        },
        {
          onToolCall: (name, argsRaw, toolId) => {
            if (name !== "fs_write") return;
            let path = "";
            try {
              path = (JSON.parse(argsRaw) as { path?: string }).path ?? "";
            } catch {
              /* 参数解析失败忽略 */
            }
            pending.set(toolId, path);
            emit(path ? `正在重写 ${path}…` : "正在写入文件…");
          },
          onToolResult: (name, success, _summary, toolId) => {
            if (name !== "fs_write") return;
            calls++;
            const path = pending.get(toolId ?? "") ?? "";
            emit(success ? `${path} 已更新` : `${path || "文件"} 写入失败`);
          },
        },
      );
      onProgress?.("更新", MAX_GEN_ITERATIONS - 1, MAX_GEN_ITERATIONS, "校验语法、递增版本并重启…");
      if (result.truncated) {
        return { ok: false, error: `迭代更新未完成（agent 达迭代上限）: ${result.text.slice(0, 200)}` };
      }
      // 复核：长时运行期间应用可能已被销毁/停止
      const fresh = this.manager.get(id);
      if (!fresh) return { ok: false, error: `应用已不存在（可能被销毁）: ${id}` };
      if (app.status === "running" && fresh.status !== "running") {
        return { ok: false, error: `应用状态已变化（当前 ${fresh.status}），已中止更新` };
      }

      const after = readFileSync(resolve(dir, targetFile), "utf-8");
      // 变更检测覆盖 style.css（update 提示词允许只改 style.css）
      let styleChanged = false;
      if (app.type === "app" && beforeStyle !== undefined) {
        const stylePath = resolve(dir, "style.css");
        if (existsSync(stylePath)) styleChanged = readFileSync(stylePath, "utf-8") !== beforeStyle;
      }
      if (after === before && !styleChanged) return { ok: false, error: "未检测到文件变更（模型未写入文件）" };
      if (app.type === "app") {
        const jsErr = checkJsSyntax(after);
        if (jsErr) return { ok: false, error: `更新后 app.js 语法错误: ${jsErr}` };
      }
    } catch (err) {
      return { ok: false, error: `迭代生成失败: ${(err as Error).message}` };
    }

    // 版本 patch 递增（仅合法的 x.y.z 数字版本；畸形版本跳过避免 NaN/畸形落盘）
    const manifestPath = resolve(dir, "app.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as AppManifest;
      const parts = manifest.version.split(".");
      if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
        parts[2] = String(Number(parts[2]) + 1);
        manifest.version = parts.join(".");
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      }
    } catch {
      /* 版本递增失败不阻断 */
    }

    // 先 reload 更新内存 manifest（registerTools 用新工具声明），再重启子进程
    this.manager.reload(id);
    if (app.status === "running" && (app.type === "tool" || app.type === "service")) {
      await this.manager.stop(id);
      const started = await this.manager.start(id);
      if (!started.ok) return { ok: false, error: `更新后重启失败: ${started.error ?? "启动失败"}` };
    }
    const updated = this.manager.get(id);
    eventBus.broadcast({ type: "app/updated", appId: id, version: updated?.version });
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "factory",
      sessionId: sessionId ?? "",
      action: "app:update",
      target: id,
      result: "success",
      detail: description.slice(0, 100),
    });
    return { ok: true, app: updated };
  }

  /** 构造临时「生成 agent」配置（非 7 专家之一；modelPreference coding，白名单仅 fs 三件套） */
  private buildConfig(def: TemplateDef, spec: AppSpec): AgentConfig {
    return {
      id: AGENT_ID,
      name: "appgen",
      displayName: "应用生成器",
      type: "appgen",
      systemPrompt: def.buildSystemPrompt(spec),
      modelPreference: "coding",
      maxIterations: MAX_GEN_ITERATIONS,
      sandbox: true,
      tools: GEN_TOOLS,
      mcpServers: [],
      permissions: { defaultMode: "auto", allowedTools: GEN_TOOLS, deniedTools: [] },
    };
  }

  /** 运行一轮生成（agent-loop 流式；工具事件 → 轨迹）；复用同 sessionKey 保证反馈轮上下文连续 */
  private async runGeneration(
    config: AgentConfig,
    def: TemplateDef,
    sessionKey: string,
    genDir: string,
    spec: AppSpec,
    feedback: string | null,
    onProgress: GenerateProgress | undefined,
    round: number,
  ): Promise<AgentRunResult> {
    const userMessage = feedback ?? def.buildTaskPrompt(spec);
    const pending = new Map<string, string>();
    let calls = 0;
    const emit = (detail: string, index = calls): void => {
      onProgress?.("生成", Math.min(index, MAX_GEN_ITERATIONS), MAX_GEN_ITERATIONS, detail);
    };
    const callbacks: StreamCallbacks = {
      onToolCall: (name, argsRaw, id) => {
        if (name !== "fs_write") return;
        let path = "";
        try {
          path = (JSON.parse(argsRaw) as { path?: string }).path ?? "";
        } catch {
          /* 参数解析失败忽略 */
        }
        pending.set(id, path);
        emit(path ? `正在写入 ${path}…` : "正在写入文件…");
      },
      onToolResult: (name, success, _summary, id) => {
        if (name !== "fs_write") return;
        calls++;
        const path = pending.get(id ?? "") ?? "";
        if (success && path) {
          const lines = countFileLines(resolve(genDir, path));
          emit(`${path} 写入完成（${lines} 行）`);
        } else if (!success) {
          emit(`${path || "文件"} 写入失败`);
        }
      },
    };
    emit(feedback ? `校验反馈：第 ${round} 轮修复中…` : "生成 agent 开始工作…");
    return runAgentLoopStream(
      config,
      userMessage,
      {
        modelRouter: this.deps.modelRouter,
        contextManager: this.deps.contextManager,
        sessionStore: this.deps.sessionStore,
        sessionId: sessionKey,
        workingDir: genDir,
        dataDir: this.deps.dataDir,
        toolScope: AGENT_ID,
        processManager: this.deps.processManager,
      },
      callbacks,
    );
  }

  /** 递归收集 _gen 目录全部产出文件 */
  private collectFiles(dir: string): GenFile[] {
    const out: GenFile[] = [];
    if (!existsSync(dir)) return out;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          out.push({ path: relative(dir, full).replace(/\\/g, "/"), content: readFileSync(full, "utf-8") });
        }
      }
    };
    walk(dir);
    return out;
  }

  /** 最终把关：文件存在 + JS 语法（webapp）+ manifest 校验（tool/service/skill/agent） */
  private validate(templateId: string, type: string, files: GenFile[], genId: string): string | null {
    if (templateId === "webapp") {
      const js = files.find((f) => f.path === "app.js");
      if (!js) return "缺少 app.js";
      return checkJsSyntax(js.content);
    }
    if (templateId === "doc") {
      return files.some((f) => f.path === "report.md") ? null : "缺少 report.md";
    }
    return this.validateManifest(templateId, type, files, genId);
  }

  /** manifest 型（tool/service/skill/agent）：schema + 类型 + 权限白名单 + 入口存在 */
  private validateManifest(templateId: string, type: string, files: GenFile[], genId: string): string | null {
    const manifestRaw = files.find((f) => f.path === "app.json")?.content;
    if (!manifestRaw) return "缺少 app.json";
    let manifest: AppManifest;
    try {
      manifest = validateAppManifest(JSON.parse(manifestRaw));
    } catch (err) {
      return `app.json 非法: ${(err as Error).message}`;
    }
    if (manifest.type !== type) return `生成类型不符: ${manifest.type} ≠ ${type}`;
    const def = getTemplate(templateId);
    const whitelist = (def?.template.allowedPermissions ?? []).map((p) => p.replace("{id}", genId));
    const badPerms = (manifest.permissions ?? []).filter(
      (p) => !whitelist.some((w) => w === p || (w.startsWith("fs:") && p.startsWith("fs:"))),
    );
    if (badPerms.length > 0) return `权限越权声明（超出模板白名单）: ${badPerms.join(", ")}`;
    if (!files.some((f) => f.path === manifest.entry)) return `入口文件缺失: ${manifest.entry}`;
    return null;
  }

  /** 文档型收尾：report.md 落 data/docs/<sessionId>/（其余文件同目录保留） */
  private finalizeDoc(files: GenFile[], spec: AppSpec): GenerateResult {
    const sessionId = spec.sessionId ?? "unknown";
    const title = (spec.description.trim().slice(0, 24) || "report").replace(/[\\/:*?"<>|]/g, "");
    const docDir = resolve(this.deps.dataDir, "docs", sessionId);
    mkdirSync(docDir, { recursive: true });
    for (const f of files) {
      const target = f.path === "report.md" ? resolve(docDir, `${title}.md`) : resolve(docDir, f.path);
      if (target.startsWith(docDir)) writeFileSync(target, f.content, "utf-8");
    }
    const docPath = resolve(docDir, `${title}.md`);
    auditLogger.log({
      timestamp: Date.now(),
      agentId: "factory",
      sessionId,
      action: "app:generate-doc",
      target: title,
      result: "success",
      detail: docPath,
    });
    eventBus.broadcast({ type: "app/generated", docPath });
    return { ok: true, docPath, files };
  }
}

/** 统计文件行数（路径越出 genDir 时返回 0） */
function countFileLines(absPath: string): number {
  try {
    if (!existsSync(absPath)) return 0;
    return readFileSync(absPath, "utf-8").split("\n").length;
  } catch {
    return 0;
  }
}
