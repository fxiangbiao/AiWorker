/**
 * AiWorker HTTP Server — API 模式
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { WebSocketServer, type WebSocket } from "ws";
import { createAudioWs } from "./media/media-server.js";
import { getDeviceStatus } from "./media/status.js";
import { getAsrProvider } from "./media/asr.js";
import { downloadModel } from "./media/model-manager.js";
import type { ModelRouter } from "./core/model-router.js";
import { toolRegistry } from "./core/tool-registry.js";
import { TeamCoordinator, pickDebateAgents } from "./core/team-coordinator.js";
import { projectTrace, computeSessionStats } from "./core/trace.js";
import { getAppVersion } from "./core/version.js";
import { readTelemetryFile } from "./memory/telemetry.js";
import { setConfirmProvider, createHttpConfirmProvider, confirmResponse } from "./hooks/confirm-channel.js";
import { setAskProvider, createHttpAskProvider, askResponse } from "./tools/ask-channel.js";
import { eventBus } from "./server/event-bus.js";
import { auditLogger } from "./core/audit-logger.js";
import { jobRunner } from "./core/job-runner.js";
import { scheduler } from "./core/scheduler.js";
import { parseNaturalSchedule } from "./core/nl-schedule.js";
import { packageInstaller, parseSkillMeta } from "./core/package-installer.js";
import { renderSessionMarkdown } from "./memory/session-export.js";
import { processManager } from "./core/process-manager.js";
import { APP_BRIDGE_SNIPPET } from "./core/app-bridge.js";
import type { StreamCallbacks, Task, AgentRunResult, PermissionMode, PluginInfo, AgentConfig } from "./types.js";
import { VALID_MODELS } from "./core/agent-config-loader.js";
import type { SessionStore } from "./memory/session-store.js";
import type { AppManager, AppActionResult } from "./core/app-manager.js";
import type { AppFactory } from "./core/app-factory.js";
import type { GeneratorQueue } from "./core/generator-queue.js";
import type { EvolutionEngine } from "./core/evolution-engine.js";

interface DelegateAgent {
  runStream(
    task: Task,
    workingDir: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
}

interface ServerDeps {
  modelRouter: ModelRouter;
  workingDir: string;
  coordinator: TeamCoordinator;
  createAgent: (agentId: string) => DelegateAgent | undefined;
  getAgentList: () => {
    id: string;
    name: string;
    displayName: string;
    type: string;
    modelPreference: string;
    maxIterations: number;
    tools: string[];
    skills: string[];
    mcpServers: string[];
    plugins: string[];
    strictTools: boolean;
    permissions: { defaultMode: string; allowedTools: string[]; deniedTools: string[] };
    systemPrompt: string;
    isCustom: boolean;
    hasConfig: boolean;
  }[];
  /** 保存智能体配置（写 YAML + 热重载；index.ts 注入） */
  saveAgentConfig?: (id: string, cfg: AgentConfig) => { ok: boolean; error?: string };
  /** 删除智能体配置（内置回默认 / 自定义移除；index.ts 注入） */
  deleteAgentConfig?: (id: string) => { ok: boolean };
  isBuiltinAgent?: (id: string) => boolean;
  /** 智能体表单选项（工具/技能/MCP/插件） */
  getAgentMeta?: () => {
    tools: { name: string; description: string }[];
    skills: { name: string; expert: string; description: string }[];
    mcp: { name: string; connected: boolean; toolCount: number }[];
    plugins: { name: string; tools: string[]; status: string }[];
  };
  skillNames: string[];
  sessionStore?: SessionStore;
  getSkills?: () => {
    name: string;
    version?: string;
    description: string;
    expert: string;
    triggers?: string[];
    body?: string;
    raw?: string;
  }[];
  getContextBreakdown?: (systemPrompt: string, sessionId: string, userMessage: string, agentId?: string) => unknown;
  getSystemPrompt?: () => string;
  getMcpStatuses?: () => Record<
    string,
    { name: string; transport: string; connected: boolean; toolCount: number; state?: string; error?: string; tools?: { name: string; description: string }[] }
  >;
  getPlugins?: () => PluginInfo[];
  /** 应用管理器（AI OS：/apps 端点，Sprint 34） */
  appManager?: AppManager;
  /** 应用工厂（AI OS：/apps/generate，Sprint 35） */
  appFactory?: AppFactory;
  /** 生成任务队列（AI OS：异步生成，Sprint 35 补丁） */
  generatorQueue?: GeneratorQueue;
  /** 进化引擎（Sprint 39：观察/提议/采纳，未注入则进化端点 503） */
  evolutionEngine?: EvolutionEngine;
  dataDir?: string;
  /** Web 配置：读取当前系统配置状态（model/迭代上限/thinking/skill-evo 等） */
  getConfigState?: () => Record<string, unknown>;
  /** Web 配置：应用并持久化单个配置项（index.ts 注入） */
  setConfigField?: (field: string, value: unknown) => { ok: boolean; error?: string };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "web", "dist");
const oldWebDir = resolve(__dirname, "..", "web");

/** API 统一前缀（与静态资源托管区分，静态托管只需排除该前缀） */
const API_PREFIX = "/api/v1";

const apiUrl = (path: string) => `${API_PREFIX}${path}`;

interface ChatRequest {
  message: string;
  agentId?: string;
  mode?: string;
  sessionId?: string;
  /** 多模态图片（data URL/https；Sprint 36），需当前模型支持视觉 */
  images?: string[];
}

interface PlanRequest {
  instruction: string;
}

interface DebateRequest {
  topic: string;
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

interface SkillLite {
  name: string;
  body?: string;
  description?: string;
}

/** 技能模式解析：/技能名 [任务] 或 /skill 技能名 [任务]（等价 CLI）；返回激活技能 / 未找到标记 / 非技能指令 */
function resolveSkillInstruction(message: string, skills: SkillLite[]): { skill: SkillLite } | "not_found" | null {
  const m = message.match(/^\/([a-zA-Z0-9][\w-]*)(?:\s+|$)/);
  if (!m) return null;
  let name = m[1];
  if (name.toLowerCase() === "skill") {
    const sub = message.slice(m[0].length).match(/^([a-zA-Z0-9][\w-]*)(?:\s+|$)/);
    if (!sub) return null;
    name = sub[1];
  }
  const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return skill ? { skill } : "not_found";
}

/** 智能体配置校验（POST /agents/<id>/config；type 内置沿用 id，自定义默认 custom） */
function validateAgentPayload(
  id: string,
  body: Record<string, unknown>,
  isBuiltin: boolean,
): { ok: true; cfg: AgentConfig } | { ok: false; error: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    return { ok: false, error: "id 需为小写字母/数字/连字符，且不超过 32 字符" };
  }
  const displayName = String(body.displayName ?? "").trim();
  if (!displayName || displayName.length > 32) {
    return { ok: false, error: "显示名必填（≤32 字符）" };
  }
  const systemPrompt = String(body.systemPrompt ?? "").trim();
  if (!systemPrompt) {
    return { ok: false, error: "systemPrompt 必填" };
  }
  if (systemPrompt.length > 20_000) {
    return { ok: false, error: "systemPrompt 过长（≤20000 字符）" };
  }
  const modelPreference = String(body.modelPreference ?? "default");
  if (!VALID_MODELS.has(modelPreference)) {
    return { ok: false, error: `modelPreference 非法（可选: ${[...VALID_MODELS].join(" / ")}）` };
  }
  const maxIterations = Number(body.maxIterations ?? 30);
  if (!Number.isFinite(maxIterations) || maxIterations < 1 || maxIterations > 200) {
    return { ok: false, error: "maxIterations 需在 1-200 之间" };
  }
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  const mode = String((body.permissions as Record<string, unknown> | undefined)?.defaultMode ?? "ask");
  if (mode !== "ask" && mode !== "plan" && mode !== "auto") {
    return { ok: false, error: "defaultMode 非法（ask / plan / auto）" };
  }
  return {
    ok: true,
    cfg: {
      id,
      name: id,
      displayName,
      type: isBuiltin ? id : "custom",
      systemPrompt,
      modelPreference,
      maxIterations,
      sandbox: false,
      tools: strArr(body.tools),
      mcpServers: strArr(body.mcpServers),
      skills: strArr(body.skills),
      plugins: strArr(body.plugins),
      strictTools: body.strictTools === true,
      permissions: {
        defaultMode: mode as PermissionMode,
        allowedTools: strArr(body.allowedTools),
        deniedTools: strArr(body.deniedTools),
      },
    },
  };
}

function sendSSE(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** 无行级 diff（指纹监控）时附带的当前内容全文 */
  currentContent?: string;
  /** 二进制/不可展示内容文件（指纹监控降级快照，仅元信息） */
  binary?: boolean;
  /** 变更前文件已存在但无旧内容（指纹监控），行级 diff 不可得 */
  modified?: boolean;
  /** 文件被删除（指纹反向对比发现） */
  deleted?: boolean;
}

interface DiffSession {
  sessionId: string;
  /** 会话摘要（标题），无则 undefined */
  summary?: string | null;
  files: DiffFile[];
  createdAt: number;
  updatedAt: number;
}

/** 解析快照 .diff 文件为结构化行 */
function parseDiffFile(content: string): {
  lines: DiffLine[];
  path?: string;
  currentContent?: string;
  binary?: boolean;
  modified?: boolean;
  deleted?: boolean;
} {
  const lines: DiffLine[] = [];
  let path: string | undefined;
  let currentContent: string | undefined;
  let binary: boolean | undefined;
  let modified: boolean | undefined;
  let deleted: boolean | undefined;
  let inMeta = false;
  for (const rawLine of content.split("\n")) {
    if (inMeta) {
      // 分隔符之后的元信息块（old/new 字符数 + 指纹监控附的 new_b64 / binary / modified / deleted 标记）
      if (rawLine.startsWith("new_b64: ")) {
        try {
          currentContent = Buffer.from(rawLine.slice(9).trim(), "base64").toString("utf-8");
        } catch {
          currentContent = undefined;
        }
      } else if (rawLine.startsWith("binary: ")) {
        binary = rawLine.slice(8).trim() === "1";
      } else if (rawLine.startsWith("modified: ")) {
        modified = rawLine.slice(10).trim() === "1";
      } else if (rawLine.startsWith("deleted: ")) {
        deleted = rawLine.slice(9).trim() === "1";
      }
      continue;
    }
    if (rawLine.startsWith("# path: ")) {
      path = rawLine.slice(8).trim();
      continue;
    }
    if (rawLine.startsWith("+ ") || rawLine === "+") {
      lines.push({ type: "add", text: rawLine.slice(2) });
    } else if (rawLine.startsWith("- ") || rawLine === "-") {
      lines.push({ type: "del", text: rawLine.slice(2) });
    } else if (rawLine.startsWith("---")) {
      inMeta = true; // diff 内容结束，进入元信息块
    } else if (rawLine.trim()) {
      lines.push({ type: "ctx", text: rawLine });
    }
  }
  return { lines, path, currentContent, binary, modified, deleted };
}

/**
 * 旧格式快照兼容推断（binary/modified/deleted 标记上线前生成的快照）：
 * - diff 文本为"文件已删除" → deleted
 * - diff 文本为"内容已变化（旧内容不可恢复）" → modified
 * - diff 文本为"新增文件（N 行）"且文件当前不存在 → deleted（该文件已被删除）
 * - 否则按文件当前是否存在：不存在 → deleted，存在 → modified
 * 仅用于无显式标记的快照，避免 Web 列表显示误导性的 +0 -0。
 */
function inferLegacyFlags(
  parsed: { lines: DiffLine[]; path?: string; binary?: boolean; modified?: boolean; deleted?: boolean },
  entry: string,
): { binary?: boolean; modified?: boolean; deleted?: boolean; addedFromText?: number } {
  if (parsed.binary || parsed.modified || parsed.deleted) return {};
  const firstCtx = parsed.lines.find((l) => l.type === "ctx")?.text ?? "";
  const filePath = parsed.path ?? decodeDiffPath(entry);
  const exists = existsSync(filePath);

  if (firstCtx.includes("文件已删除")) return { deleted: true };
  if (firstCtx.includes("内容已变化") || firstCtx.includes("旧内容不可恢复")) {
    return { modified: true };
  }
  // 新增文件（N 行）：旧格式未解析出 + 行，从文本提取行数
  const addMatch = firstCtx.match(/新增文件（(\d+) 行）|新增文件\((\d+) 行\)/);
  if (addMatch) {
    const addedFromText = Number(addMatch[1] ?? addMatch[2] ?? 0);
    return exists ? { addedFromText } : { deleted: true, addedFromText };
  }
  // 兜底：无特征文本，按当前文件是否存在推断
  return exists ? { modified: true } : { deleted: true };
}

/** 把安全化的文件名还原为可读路径（D_前缀 + 分隔符 _ → /） */
function decodeDiffPath(fileName: string): string {
  return fileName.replace(/\.diff$/, "").replace(/^D_/, "").replace(/_/g, "/");
}

/** 在确认+提问通道上下文中执行异步操作（hook 内 requestConfirm / ask_user 的 requestAsk 走 SSE 挂起） */
async function runWithChannels<T>(write: (data: object) => void, fn: () => Promise<T>): Promise<T> {
  const previousConfirm = setConfirmProvider(
    createHttpConfirmProvider((req) => {
      write({ type: "confirm_request", confirmId: req.id, title: req.title, message: req.message, options: req.options });
    }),
  );
  const previousAsk = setAskProvider(
    createHttpAskProvider((req) => {
      write({ type: "ask_user", askId: req.id, question: req.question, options: req.options, multiple: req.multiple === true });
    }),
  );
  try {
    return await fn();
  } finally {
    setConfirmProvider(previousConfirm);
    setAskProvider(previousAsk);
  }
}

/** 扫描 data/snapshots 目录，返回全部会话的文件变更（含会话摘要） */
function scanDiffs(snapshotsDir: string, sessionStore?: SessionStore): DiffSession[] {
  try {
    if (!existsSync(snapshotsDir)) return [];
    // 会话摘要索引（会话标题）
    const summaryBySession = new Map<string, string>();
    if (sessionStore) {
      for (const s of sessionStore.listSessions(1000)) {
        if (s.summary) summaryBySession.set(s.id, s.summary);
      }
    }
    const sessions: DiffSession[] = [];
    const sessionDirs = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      // 单测产生的会话（hooks 测试快照）不展示
      .filter((name) => name !== "test-session");

    for (const sessionId of sessionDirs) {
      const dir = resolve(snapshotsDir, sessionId);
      const files: DiffFile[] = [];
      let updatedAt = 0;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".diff")) continue;
        const stat = statSync(resolve(dir, entry));
        if (!stat.isFile()) continue;
        updatedAt = Math.max(updatedAt, stat.mtimeMs);
        const content = readFileSync(resolve(dir, entry), "utf-8");
        const parsed = parseDiffFile(content);
        // 旧格式快照兼容推断：无 binary/modified/deleted 显式标记时，
        // 按 diff 文本 + 文件当前是否存在推断（避免历史快照显示误导性的 +0 -0）
        const inferred = inferLegacyFlags(parsed, entry);
        // 指纹监控"新增文件"快照无行级 diff（只有一行 ctx 文本 + 当前内容全文）：
        // 把当前内容展开为全新增行（+ 前缀），前端才能显示行号与新增颜色标识。
        // 必须在 inferLegacyFlags 之后（其依赖原始 ctx 文本提取行数）。
        if (
          !parsed.binary &&
          parsed.currentContent &&
          parsed.lines.length === 1 &&
          parsed.lines[0]!.type === "ctx" &&
          /新增文件[（(]\d+\s*行[）)]/.test(parsed.lines[0]!.text)
        ) {
          parsed.lines = parsed.currentContent.split("\n").map((l) => ({ type: "add" as const, text: l }));
        }
        const added =
          parsed.lines.filter((l) => l.type === "add").length ||
          (inferred.addedFromText ?? 0);
        files.push({
          path: parsed.path ?? decodeDiffPath(entry),
          added,
          removed: parsed.lines.filter((l) => l.type === "del").length,
          lines: parsed.lines,
          currentContent: parsed.currentContent,
          binary: parsed.binary ?? inferred.binary,
          modified: parsed.modified ?? inferred.modified,
          deleted: parsed.deleted ?? inferred.deleted,
        });
      }
      if (files.length > 0) {
        sessions.push({ sessionId, summary: summaryBySession.get(sessionId), files, createdAt: updatedAt, updatedAt });
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

// ── /diffs 快照目录签名缓存：文件数 + 目录 mtime 未变则复用上次解析结果 ──
let diffsCache: { signature: string; sessions: DiffSession[]; cachedAt: number } | null = null;

/** 快照目录签名（文件总数 + 最新 mtime + 会话目录数），变化才触发重新解析 */
function snapshotsSignature(snapshotsDir: string): string {
  try {
    if (!existsSync(snapshotsDir)) return "empty";
    let fileCount = 0;
    let maxMtime = 0;
    let dirCount = 0;
    for (const d of readdirSync(snapshotsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      dirCount++;
      const dir = resolve(snapshotsDir, d.name);
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".diff")) continue;
        fileCount++;
        const st = statSync(resolve(dir, entry));
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      }
    }
    return `${dirCount}:${fileCount}:${maxMtime}`;
  } catch {
    return "empty";
  }
}

/** 带签名的 /diffs 结果（TTL 30s 兜底），避免每次请求全量解析所有快照 */
function getDiffsCached(snapshotsDir: string, sessionStore?: SessionStore): DiffSession[] {
  const now = Date.now();
  if (diffsCache && now - diffsCache.cachedAt < 30000) {
    const sig = snapshotsSignature(snapshotsDir);
    if (sig === diffsCache.signature) return diffsCache.sessions;
  }
  const sessions = scanDiffs(snapshotsDir, sessionStore);
  diffsCache = { signature: snapshotsSignature(snapshotsDir), sessions, cachedAt: now };
  return sessions;
}

/** 将会话消息渲染为 Markdown 导出内容（TUI /export 共用） */

export function startServer(deps: ServerDeps, port: number) {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url === "/" && req.method === "GET") {
      try {
        const html = readFileSync(resolve(distDir, "index.html"), "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache", // index.html 每次校验，确保拿到最新 hash 的 bundle
        });
        res.end(html);
      } catch {
        try {
          const html = readFileSync(resolve(oldWebDir, "index.html"), "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end("index.html not found");
        }
      }
      return;
    }

    // ─── 应用沙箱静态资源（Sprint 35：/apps/<id>/index.html 等） ───
    if (req.method === "GET" && url.startsWith("/apps/")) {
      const rawRel = url.slice("/apps/".length);
      const qIdx = rawRel.indexOf("?");
      const relPath = qIdx >= 0 ? rawRel.slice(0, qIdx) : rawRel;
      // widget 形态（iframe 带 ?surface=widget）：框架注入透明背景（小部件透明由宿主负责）
      const isWidget = qIdx >= 0 && rawRel.slice(qIdx + 1).includes("surface=widget");
      const slash = relPath.indexOf("/");
      const appId = slash > 0 ? decodeURIComponent(relPath.slice(0, slash)) : "";
      const filePath = slash > 0 ? relPath.slice(slash + 1) : "index.html";
      if (appId && deps.appManager) {
        const app = deps.appManager.get(appId);
        if (app && deps.dataDir) {
          const appRoot = resolve(deps.dataDir, "apps", appId);
          const target = resolve(appRoot, filePath);
          // 路径穿越防护：解析结果必须仍在沙箱目录内
          const rel = relative(appRoot, target);
          // style.css 为可选文件（模型可不生成）：缺失时返回空 CSS，避免 index.html 引用产生 404 噪音
          if (!rel.startsWith("..") && !isAbsolute(rel) && filePath.split(".").pop() === "css" && !existsSync(target)) {
            res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
            res.end("");
            return;
          }
          if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(target) && statSync(target).isFile()) {
            const ext = filePath.split(".").pop() || "";
            const mime: Record<string, string> = {
              html: "text/html; charset=utf-8",
              js: "application/javascript",
              mjs: "application/javascript",
              css: "text/css",
              json: "application/json",
              svg: "image/svg+xml",
              png: "image/png",
            };
            res.writeHead(200, {
              "Content-Type": mime[ext] || "application/octet-stream",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache",
            });
            // webapp 应用：注入宿主能力桥 + 全局 reset 样式（消 body margin/滚动，UI 填满窗口）；
            // widget 形态额外强制 html/body 透明（小部件透明背景由框架保证）
            if (filePath === "index.html" && app.type === "app") {
              const raw = readFileSync(target, "utf-8");
              const widgetCss = isWidget ? "html,body,#app{background:transparent!important}" : "";
              const inject = `<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}#app{width:100%;height:100%}${widgetCss}</style><script>${APP_BRIDGE_SNIPPET}</script>`;
              const injected = raw.includes("</head>")
                ? raw.replace("</head>", `${inject}</head>`)
                : `${inject}${raw}`;
              res.end(injected);
              return;
            }
            res.end(readFileSync(target));
            return;
          }
        }
      }
      sendJSON(res, 404, { error: "App file not found" });
      return;
    }

    if (req.method === "GET" && !url.startsWith(API_PREFIX)) {
      const distPath = resolve(distDir, url.slice(1));
      // 路径穿越防护：解析结果必须仍在 distDir 内（防 GET /../../config/hooks.json）
      const rel = relative(distDir, distPath);
      if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(distPath)) {
        const ext = url.split(".").pop() || "";
        const mime: Record<string, string> = { js: "application/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2" };
        // 缓存策略：html no-cache（拿最新 hash）；assets（hash 文件名）强缓存 immutable
        const isHtml = url.endsWith(".html");
        res.writeHead(200, {
          "Content-Type": mime[ext] || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
        });
        res.end(readFileSync(distPath));
        return;
      } else if (url === "/favicon.ico") {
        // 无 favicon：返回 204，消除浏览器自动请求 /favicon.ico 的 404 告警
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url === apiUrl("/agents") && req.method === "GET") {
      sendJSON(res, 200, { agents: deps.getAgentList() });
      return;
    }

    if (url === apiUrl("/agents/meta") && req.method === "GET") {
      if (!deps.getAgentMeta) {
        sendJSON(res, 503, { error: "Agent meta not available" });
        return;
      }
      sendJSON(res, 200, deps.getAgentMeta());
      return;
    }

    if (url.startsWith(apiUrl("/agents/")) && req.method === "POST") {
      if (!deps.saveAgentConfig || !deps.deleteAgentConfig || !deps.isBuiltinAgent) {
        sendJSON(res, 503, { error: "Agent config not available" });
        return;
      }
      const rest = decodeURIComponent(url.slice(apiUrl("/agents/").length));
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (rest.endsWith("/reset")) {
        const id = rest.slice(0, -"/reset".length);
        if (!deps.isBuiltinAgent(id)) {
          sendJSON(res, 400, { error: "仅内置智能体可恢复默认" });
          return;
        }
        deps.deleteAgentConfig(id);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (rest.endsWith("/delete")) {
        const id = rest.slice(0, -"/delete".length);
        if (deps.isBuiltinAgent(id)) {
          sendJSON(res, 400, { error: "内置智能体不可删除（可恢复默认）" });
          return;
        }
        deps.deleteAgentConfig(id);
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (rest.endsWith("/config")) {
        const id = rest.slice(0, -"/config".length);
        const v = validateAgentPayload(id, payload, deps.isBuiltinAgent(id));
        if (!v.ok) {
          sendJSON(res, 400, { error: v.error });
          return;
        }
        const r = deps.saveAgentConfig(id, v.cfg);
        if (!r.ok) {
          sendJSON(res, 400, { error: r.error ?? "保存失败" });
          return;
        }
        sendJSON(res, 200, { ok: true });
        return;
      }
      sendJSON(res, 404, { error: "Unknown agent action" });
      return;
    }

    if (url === apiUrl("/status") && req.method === "GET") {
      sendJSON(res, 200, {
        status: "ok",
        uptime: Date.now() - startTime,
        version: getAppVersion(),
        model: deps.modelRouter.getCurrentModel(),
        tokenUsage: {
          total: deps.modelRouter.getTokenUsage(),
          prompt: deps.modelRouter.getPromptTokens(),
          completion: deps.modelRouter.getCompletionTokens(),
        },
        workingDir: deps.workingDir,
        skills: deps.skillNames,
      });
      return;
    }

    if (url === apiUrl("/tools") && req.method === "GET") {
      const all = toolRegistry.getAll();
      const tools = all.map((t) => ({ name: t.definition.function.name, description: t.definition.function.description }));
      sendJSON(res, 200, { tools });
      return;
    }

    if (url === apiUrl("/mcp") && req.method === "GET") {
      if (!deps.getMcpStatuses) { sendJSON(res, 200, { servers: [] }); return; }
      const statuses = deps.getMcpStatuses();
      sendJSON(res, 200, { servers: Object.values(statuses) });
      return;
    }

    if (url === apiUrl("/sessions") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessions = deps.sessionStore.listSessions(50);
      sendJSON(res, 200, { sessions });
      return;
    }

    // 导出会话 Markdown（必须在 /sessions/:id GET 之前，避免被 startsWith 捕获）
    if (url.startsWith(apiUrl("/sessions/")) && url.endsWith("/export") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length).replace(/\/export$/, "");
      const messages = deps.sessionStore.getSessionMessages(sessionId);
      const sessions = deps.sessionStore.listSessions(1000);
      const meta = sessions.find((s) => s.id === sessionId);
      const title = meta?.summary ?? sessionId.slice(0, 12);
      const md = renderSessionMarkdown(title, sessionId, messages);
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}.md"`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(md);
      return;
    }

    if (url.startsWith(apiUrl("/sessions/")) && req.method === "GET" && !url.endsWith("/export") && !url.endsWith("/working-dir")) {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length);
      // 事件回放（含 tool_calls + tool 结果，TUI/Web 会话完整消息序列）；
      // 事件日志为空（Sprint 24 之前创建的旧会话）时回退投影表
      let messages = deps.sessionStore.replayEvents(sessionId);
      if (messages.length === 0) messages = deps.sessionStore.getMessages(sessionId);
      sendJSON(res, 200, { sessionId, messages });
      return;
    }

    // 删除会话
    if (url.startsWith(apiUrl("/sessions/")) && req.method === "DELETE") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length);
      const ok = deps.sessionStore.deleteSession(sessionId);
      if (ok) eventBus.broadcast({ type: "session/update", sessionId, kind: "delete" });
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Session not found" });
      return;
    }

    // 重命名会话
    if (url.startsWith(apiUrl("/sessions/")) && url.endsWith("/rename") && req.method === "POST") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length).replace(/\/rename$/, "");
      let parsedTitle: string;
      try {
        const body = JSON.parse(await parseBody(req)) as { title?: string };
        parsedTitle = (body.title ?? "").trim();
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!parsedTitle) { sendJSON(res, 400, { error: "Missing 'title' field" }); return; }
      const ok = deps.sessionStore.renameSession(sessionId, parsedTitle);
      if (ok) eventBus.broadcast({ type: "session/update", sessionId, kind: "rename", title: parsedTitle });
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Session not found" });
      return;
    }

    // 会话项目目录（Sprint 42：每会话选择项目目录）
    if (url.startsWith(apiUrl("/sessions/")) && url.endsWith("/working-dir") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length).replace(/\/working-dir$/, "");
      sendJSON(res, 200, { workingDir: deps.sessionStore.getWorkingDir(sessionId) });
      return;
    }
    if (url.startsWith(apiUrl("/sessions/")) && url.endsWith("/working-dir") && req.method === "POST") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length).replace(/\/working-dir$/, "");
      let dir: unknown;
      let agentId: unknown;
      try {
        const body = JSON.parse(await parseBody(req)) as { dir?: unknown; agentId?: unknown };
        dir = body.dir;
        agentId = body.agentId;
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON body" });
        return;
      }
      // null/空串 = 恢复默认；否则校验绝对路径 + 存在 + 目录 + 不指向 dataDir
      let resolvedDir: string | null = null;
      if (dir !== null && dir !== undefined && dir !== "") {
        if (typeof dir !== "string" || !isAbsolute(dir)) {
          sendJSON(res, 400, { error: "目录必须为绝对路径" });
          return;
        }
        if (!existsSync(dir)) {
          sendJSON(res, 400, { error: `目录不存在: ${dir}` });
          return;
        }
        if (!statSync(dir).isDirectory()) {
          sendJSON(res, 400, { error: "路径不是目录" });
          return;
        }
        const dataDirAbs = deps.dataDir ? resolve(deps.dataDir) : resolve(process.cwd(), "data");
        if (resolve(dir) === dataDirAbs) {
          sendJSON(res, 400, { error: "不能指向数据目录（dataDir）" });
          return;
        }
        resolvedDir = resolve(dir);
      }
      // 新会话（Web 本地草稿）服务端可能尚无行：与 /chat 同策略自动补建，避免 "Session not found"
      deps.sessionStore.ensureSession(sessionId, typeof agentId === "string" && agentId ? agentId : "default");
      const ok = deps.sessionStore.setWorkingDir(sessionId, resolvedDir);
      if (!ok) { sendJSON(res, 404, { error: "Session not found" }); return; }
      auditLogger.log({
        timestamp: Date.now(),
        agentId: "server",
        sessionId,
        action: "session:working-dir",
        target: sessionId,
        result: "success",
        detail: resolvedDir ?? "（恢复默认）",
      });
      eventBus.broadcast({ type: "session/update", sessionId, kind: "working-dir", workingDir: resolvedDir });
      sendJSON(res, 200, { ok: true, workingDir: resolvedDir });
      return;
    }

    // 目录浏览（Sprint 42 补：项目目录弹窗选择的数据源；只读列出子目录名，不读内容）
    if (req.method === "GET" && (url === apiUrl("/dirs") || url.startsWith(apiUrl("/dirs") + "?"))) {
      const u = new URL(req.url ?? "", "http://localhost");
      const raw = u.searchParams.get("path");
      if (raw && !isAbsolute(raw)) {
        sendJSON(res, 400, { error: "必须为绝对路径" });
        return;
      }
      const start = raw ? resolve(raw) : deps.workingDir;
      if (!existsSync(start) || !statSync(start).isDirectory()) {
        sendJSON(res, 400, { error: `目录不存在或不是目录: ${start}` });
        return;
      }
      const parent = dirname(start) === start ? null : dirname(start);
      let dirs: string[] = [];
      try {
        dirs = readdirSync(start, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 300);
      } catch {
        /* 无权限目录返回空列表 */
      }
      sendJSON(res, 200, { path: start, parent, dirs });
      return;
    }

    // 语音模型下载（Sprint 43：Web 设备 Tab 一键下载；异步长任务，本地 fetch 等待完成）
    if (url === apiUrl("/media/download") && req.method === "POST") {
      const dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
      let kind: string;
      try {
        const body = JSON.parse(await parseBody(req)) as { kind?: string };
        kind = body.kind ?? "";
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (kind !== "asr" && kind !== "tts") {
        sendJSON(res, 400, { error: "kind 必须为 asr|tts" });
        return;
      }
      const result = await downloadModel(dataDir, kind);
      auditLogger.log({
        timestamp: Date.now(),
        agentId: "server",
        sessionId: "",
        action: "media:download",
        target: kind,
        result: result.ok ? "success" : "error",
        detail: result.ok ? `新增 ${result.downloaded.length} · 跳过 ${result.skipped.length}` : (result.error ?? "下载失败"),
      });
      sendJSON(res, 200, result);
      return;
    }

    // 设备状态（Sprint 42 A2：媒体通道 + 模型能力，只读）
    if (url === apiUrl("/devices") && req.method === "GET") {
      const dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
      sendJSON(res, 200, getDeviceStatus(dataDir, deps.modelRouter));
      return;
    }

    // 审计查询（Sprint 42 A1：审计 Tab；?limit=&action= 前缀过滤，最新在前）
    if (url.startsWith(apiUrl("/audit")) && req.method === "GET") {
      const u = new URL(req.url ?? "", "http://localhost");
      const limit = Number(u.searchParams.get("limit") ?? "100");
      const action = u.searchParams.get("action") ?? undefined;
      sendJSON(res, 200, {
        entries: auditLogger.queryRecent(Number.isFinite(limit) ? limit : 100, action || undefined),
      });
      return;
    }

    if (url === apiUrl("/context") && req.method === "GET") {
      if (!deps.getContextBreakdown) { sendJSON(res, 500, { error: "Context breakdown not available" }); return; }
      const breakdown = deps.getContextBreakdown(deps.getSystemPrompt?.() ?? "", "", "", "default");
      sendJSON(res, 200, { breakdown });
      return;
    }

    if (url === apiUrl("/logs") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const logs = deps.sessionStore.getRecentTurnLogs(50);
      sendJSON(res, 200, { logs });
      return;
    }

    if (url.startsWith(apiUrl("/trace/")) && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/trace/").length);
      const events = deps.sessionStore.getEvents(sessionId);
      if (events.length === 0) { sendJSON(res, 404, { error: "No events for session" }); return; }
      sendJSON(res, 200, {
        sessionId,
        items: projectTrace(events),
        stats: computeSessionStats(sessionId, events),
      });
      return;
    }

    if (url === apiUrl("/stats") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessions = deps.sessionStore.listSessions(20);
      const stats = sessions.map((s) => {
        const events = deps.sessionStore!.getEvents(s.id);
        return computeSessionStats(s.id, events);
      });
      sendJSON(res, 200, { stats });
      return;
    }

    if (url.startsWith(apiUrl("/telemetry/")) && req.method === "GET") {
      if (!deps.dataDir) { sendJSON(res, 500, { error: "Data dir not available" }); return; }
      const sessionId = url.slice(apiUrl("/telemetry/").length);
      // 路径穿越防护：sessionId 仅允许安全字符（UUID / http-xxx 等），禁止路径分隔符与 ..
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        sendJSON(res, 400, { error: "Invalid session id" });
        return;
      }
      sendJSON(res, 200, { sessionId, records: readTelemetryFile(deps.dataDir, sessionId) });
      return;
    }

    if (url === apiUrl("/skills") && req.method === "GET") {
      const skills = deps.getSkills?.() ?? deps.skillNames.map((n) => ({ name: n, description: "", expert: "" }));
      sendJSON(res, 200, { skills });
      return;
    }

    if (url === apiUrl("/plugins") && req.method === "GET") {
      const plugins = deps.getPlugins?.() ?? [];
      sendJSON(res, 200, { plugins });
      return;
    }

    // ─── AI OS 应用与进程（Sprint 34） ───
    if (url === apiUrl("/apps") && req.method === "GET") {
      const apps = deps.appManager ? deps.appManager.list() : [];
      sendJSON(res, 200, { apps });
      return;
    }
    if (url === apiUrl("/apps/generate") && req.method === "POST") {
      const queue = deps.generatorQueue;
      if (!queue || !deps.appFactory) {
        sendJSON(res, 503, { error: "Generator not available" });
        return;
      }
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let payload: { description?: string; type?: string; surface?: string; sessionId?: string };
      try {
        payload = JSON.parse(body) as { description?: string; type?: string; surface?: string; sessionId?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!payload.description || typeof payload.description !== "string") {
        sendJSON(res, 400, { error: "Missing 'description'" });
        return;
      }
      // 异步：入队即返 jobId，生成在后台跑，前端经 gen/* 事件 + 查询追踪
      const jobId = queue.submit({
        description: payload.description,
        type: (payload.type as never) ?? "app",
        surface: payload.surface as never,
        sessionId: payload.sessionId,
      });
      sendJSON(res, 200, { ok: true, jobId });
      return;
    }
    if (url === apiUrl("/apps/gen") && req.method === "GET") {
      const q = deps.generatorQueue;
      if (!q) {
        sendJSON(res, 503, { error: "Generator not available" });
        return;
      }
      sendJSON(res, 200, { jobs: q.list() });
      return;
    }
    if (url.startsWith(apiUrl("/apps/gen/")) && req.method === "GET") {
      const q = deps.generatorQueue;
      if (!q) {
        sendJSON(res, 503, { error: "Generator not available" });
        return;
      }
      const jobId = decodeURIComponent(url.slice(apiUrl("/apps/gen/").length));
      const job = q.get(jobId);
      if (!job) {
        sendJSON(res, 404, { error: "Job not found" });
        return;
      }
      sendJSON(res, 200, { job });
      return;
    }
    if (url.startsWith(apiUrl("/apps/gen/")) && url.endsWith("/cancel") && req.method === "POST") {
      const q = deps.generatorQueue;
      if (!q) {
        sendJSON(res, 503, { error: "Generator not available" });
        return;
      }
      const jobId = decodeURIComponent(url.slice(apiUrl("/apps/gen/").length).replace(/\/cancel$/, ""));
      const ok = q.cancel(jobId);
      sendJSON(res, ok ? 200 : 400, ok ? { ok: true } : { error: "仅可取消排队中任务" });
      return;
    }
    if (url.startsWith(apiUrl("/apps/")) && url.endsWith("/update") && req.method === "POST") {
      if (!deps.appFactory) {
        sendJSON(res, 503, { error: "App factory not available" });
        return;
      }
      const appId = decodeURIComponent(url.slice(apiUrl("/apps/").length).replace(/\/update$/, ""));
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let payload: { description?: string; sessionId?: string };
      try {
        payload = JSON.parse(body) as { description?: string; sessionId?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!payload.description || typeof payload.description !== "string") {
        sendJSON(res, 400, { error: "Missing 'description'" });
        return;
      }
      // 异步队列优先（立即返回 jobId，进度经 gen/* WS 事件推送）；队列不可用时回退同步执行
      if (deps.generatorQueue && typeof deps.generatorQueue.submitUpdate === "function") {
        const jobId = deps.generatorQueue.submitUpdate(appId, payload.description, payload.sessionId);
        sendJSON(res, 200, { ok: true, jobId });
        return;
      }
      try {
        const result = await deps.appFactory.update(appId, payload.description, payload.sessionId);
        sendJSON(res, result.ok ? 200 : 400, result);
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message });
      }
      return;
    }
    if (url.startsWith(apiUrl("/apps/")) && url.endsWith("/bridge") && req.method === "POST") {
      if (!deps.appManager) {
        sendJSON(res, 503, { error: "App manager not available" });
        return;
      }
      const appId = decodeURIComponent(url.slice(apiUrl("/apps/").length).replace(/\/bridge$/, ""));
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let payload: { method?: string; params?: Record<string, unknown> };
      try {
        payload = JSON.parse(body) as { method?: string; params?: Record<string, unknown> };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!payload.method || typeof payload.method !== "string") {
        sendJSON(res, 400, { error: "Missing 'method'" });
        return;
      }
      try {
        const result = await deps.appManager.handleBridge(appId, payload.method, payload.params ?? {});
        sendJSON(res, 200, { ok: true, result });
      } catch (err) {
        sendJSON(res, 400, { ok: false, error: (err as Error).message });
      }
      return;
    }
    if (url === apiUrl("/apps/install") && req.method === "POST") {
      if (!deps.appManager) {
        sendJSON(res, 503, { error: "App manager not available" });
        return;
      }
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let payload: { path?: string; force?: boolean; originSessionId?: string };
      try {
        payload = JSON.parse(body) as { path?: string; force?: boolean; originSessionId?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!payload.path || typeof payload.path !== "string") {
        sendJSON(res, 400, { error: "Missing 'path'" });
        return;
      }
      const abs = isAbsolute(payload.path) ? payload.path : resolve(deps.workingDir, payload.path);
      const result = deps.appManager.installFromDir(abs, {
        force: payload.force === true,
        originSessionId: payload.originSessionId,
      });
      sendJSON(res, result.ok ? 200 : 400, result.ok ? { ok: true, app: result.app } : { error: result.error });
      return;
    }
    if (url.startsWith(apiUrl("/apps/")) && req.method === "POST") {
      if (!deps.appManager) {
        sendJSON(res, 503, { error: "App manager not available" });
        return;
      }
      const rest = url.slice(apiUrl("/apps/").length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0) {
        sendJSON(res, 400, { error: "Invalid path" });
        return;
      }
      const id = decodeURIComponent(rest.slice(0, slash));
      const action = rest.slice(slash + 1);
      let result: AppActionResult;
      if (action === "start") result = await deps.appManager.start(id);
      else if (action === "stop") result = await deps.appManager.stop(id);
      else if (action === "destroy") result = await deps.appManager.destroy(id);
      else {
        sendJSON(res, 400, { error: `Unknown action: ${action}` });
        return;
      }
      sendJSON(res, result.ok ? 200 : 400, result.ok ? { ok: true, app: result.app } : { error: result.error });
      return;
    }
    if (url === apiUrl("/processes") && req.method === "GET") {
      // 资源仪表（Sprint 42 A3）：全局 token 占用（进程级精确归因未做——模型 token 全局累计）
      sendJSON(res, 200, {
        processes: processManager.list(),
        stats: processManager.stats(),
        resources: {
          tokens: {
            total: deps.modelRouter?.getTokenUsage() ?? 0,
            prompt: deps.modelRouter?.getPromptTokens?.() ?? 0,
            completion: deps.modelRouter?.getCompletionTokens?.() ?? 0,
          },
        },
      });
      return;
    }

    // ─── 系统配置（Web 端 /config 等价能力） ───
    if (url === apiUrl("/config") && req.method === "GET") {
      if (!deps.getConfigState) {
        sendJSON(res, 503, { error: "Config not available" });
        return;
      }
      sendJSON(res, 200, deps.getConfigState());
      return;
    }
    if (url === apiUrl("/config") && req.method === "POST") {
      if (!deps.setConfigField) {
        sendJSON(res, 503, { error: "Config not available" });
        return;
      }
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let cfg: { field?: string; value?: unknown };
      try {
        cfg = JSON.parse(body) as { field?: string; value?: unknown };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!cfg.field || typeof cfg.field !== "string") {
        sendJSON(res, 400, { error: "Missing 'field'" });
        return;
      }
      const result = deps.setConfigField(cfg.field, cfg.value);
      sendJSON(res, result.ok ? 200 : 400, result.ok ? { ok: true, state: deps.getConfigState?.() } : result);
      return;
    }

    // ─── .aw 资产包导出/导入/列表（含裸格式） ───
    if (url.startsWith(apiUrl("/packages/export")) && req.method === "GET") {
      const u = new URL(req.url ?? "", "http://localhost");
      const type = u.searchParams.get("type") ?? "";
      const name = u.searchParams.get("name") ?? "";
      const raw = u.searchParams.get("raw") === "1";
      if (!["skill", "mcp", "plugin"].includes(type) || !name) {
        sendJSON(res, 400, { error: "Missing type/name" });
        return;
      }
      if (raw) {
        if (type === "plugin") {
          sendJSON(res, 400, { error: "插件裸导出请用 CLI: /pkg export plugin <名称> <目录> --raw" });
          return;
        }
        const out = packageInstaller.exportRaw(type as "skill" | "mcp", name);
        if (!out) {
          sendJSON(res, 404, { error: `未找到 ${type}: ${name}` });
          return;
        }
        res.writeHead(200, {
          "Content-Type": type === "skill" ? "text/markdown; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(out.filename)}"`,
          "Access-Control-Allow-Origin": "*",
        });
        res.end(out.data);
        return;
      }
      const out = packageInstaller.exportPackage(type as "skill" | "mcp" | "plugin", name);
      if (!out) {
        sendJSON(res, 404, { error: `未找到 ${type}: ${name}` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`${out.manifest.name}-${out.manifest.version}.aw`)}"`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(out.data);
      return;
    }
    // 导入前预览 manifest（Web 安全确认用；不落盘）
    if (url === apiUrl("/packages/peek") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let peek: { data?: string; filename?: string };
      try {
        peek = JSON.parse(body) as { data?: string; filename?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!peek.data || typeof peek.data !== "string") {
        sendJSON(res, 400, { error: "Missing 'data' (base64)" });
        return;
      }
      const tmpDir = deps.dataDir ?? resolve(process.cwd(), "data");
      mkdirSync(tmpDir, { recursive: true });
      const ext = (peek.filename ?? "pkg.aw").toLowerCase().endsWith(".md")
        ? ".md"
        : (peek.filename ?? "pkg.aw").toLowerCase().endsWith(".json")
          ? ".json"
          : ".aw";
      const tmp = resolve(tmpDir, `peek-${Date.now().toString(36)}${ext}`);
      writeFileSync(tmp, Buffer.from(peek.data, "base64"));
      try {
        if (ext === ".md") {
          const raw = readFileSync(tmp, "utf-8");
          const meta = parseSkillMeta(raw);
          const name = meta.name;
          if (!name) {
            sendJSON(res, 400, { ok: false, error: "SKILL.md 缺少 name frontmatter" });
          } else {
            sendJSON(res, 200, { ok: true, type: "skill", name, version: meta.version ?? "1.0.0", description: meta.description });
          }
        } else if (ext === ".json") {
          const base = basename(peek.filename ?? "server").replace(/\.json$/i, "");
          sendJSON(res, 200, { ok: true, type: "mcp", name: base, version: "1.0.0" });
        } else {
          const manifest = packageInstaller.readManifest(tmp);
          sendJSON(res, 200, { ok: true, type: manifest.type, name: manifest.name, version: manifest.version, description: manifest.description });
        }
      } catch (err) {
        sendJSON(res, 400, { ok: false, error: (err as Error).message });
      } finally {
        rmSync(tmp, { force: true });
      }
      return;
    }
    if (url === apiUrl("/packages/import") && req.method === "POST") {      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let req3: { data?: string; filename?: string; force?: boolean };
      try {
        req3 = JSON.parse(body) as { data?: string; filename?: string; force?: boolean };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!req3.data || typeof req3.data !== "string") {
        sendJSON(res, 400, { error: "Missing 'data' (base64)" });
        return;
      }
      // 按文件名扩展名分发：.aw 标准包 / .md 技能 / .json MCP
      const lower = (req3.filename ?? "pkg.aw").toLowerCase();
      const ext = lower.endsWith(".md") ? ".md" : lower.endsWith(".json") ? ".json" : ".aw";
      const tmpDir = deps.dataDir ?? resolve(process.cwd(), "data");
      mkdirSync(tmpDir, { recursive: true });
      const tmp = resolve(tmpDir, `import-${Date.now().toString(36)}${ext}`);
      writeFileSync(tmp, Buffer.from(req3.data, "base64"));
      const result = packageInstaller.installAny(tmp, { force: req3.force === true });
      rmSync(tmp, { force: true });
      sendJSON(res, result.success ? 200 : 400, result);
      return;
    }
    if (url === apiUrl("/packages/list") && req.method === "GET") {
      sendJSON(res, 200, { exportable: packageInstaller.listExportable(), installed: packageInstaller.listInstalled() });
      return;
    }

    // ─── 后台任务 ───
    if (url === apiUrl("/jobs") && req.method === "GET") {
      sendJSON(res, 200, { jobs: jobRunner.isInitialized() ? jobRunner.list() : [] });
      return;
    }
    if (url === apiUrl("/jobs") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let req2: { agentId?: string; prompt?: string };
      try {
        req2 = JSON.parse(body) as { agentId?: string; prompt?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!req2.prompt || typeof req2.prompt !== "string") {
        sendJSON(res, 400, { error: "Missing 'prompt' field" });
        return;
      }
      if (!jobRunner.isInitialized()) {
        sendJSON(res, 503, { error: "Job runner not initialized" });
        return;
      }
      const id = jobRunner.submit(req2.agentId ?? "default", req2.prompt);
      sendJSON(res, 200, { id });
      return;
    }
    if (url.startsWith(apiUrl("/jobs/")) && req.method === "DELETE") {
      const jobId = url.slice(apiUrl("/jobs/").length);
      const ok = jobRunner.cancel(jobId);
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "无法取消（仅排队中任务可取消）" });
      return;
    }

    // ─── 定时调度 ───
    if (url === apiUrl("/schedule") && req.method === "GET") {
      sendJSON(res, 200, { jobs: scheduler.getJobs() });
      return;
    }
    if (url === apiUrl("/schedule") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }
      let sched: { cron?: string; prompt?: string; agentId?: string };
      try {
        sched = JSON.parse(body) as { cron?: string; prompt?: string; agentId?: string };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!sched.prompt || typeof sched.prompt !== "string") {
        sendJSON(res, 400, { error: "Missing 'cron' or 'prompt' field" });
        return;
      }
      // 未提供 cron → 自然语言解析（规则；失败提示手填 cron）
      let cron = sched.cron;
      if (!cron || !cron.trim()) {
        const parsed = parseNaturalSchedule(sched.prompt);
        if (!parsed) {
          sendJSON(res, 400, { error: "无法解析调度需求，请提供 cron 表达式（如 0 8 * * *）" });
          return;
        }
        cron = parsed.cron;
        sched.prompt = parsed.prompt;
      }
      const ok = scheduler.addJob({
        id: `sched-${Date.now().toString(36)}`,
        cron,
        prompt: sched.prompt,
        agentId: sched.agentId ?? "default",
      });
      sendJSON(res, ok ? 200 : 400, ok ? { ok: true } : { error: "无效的 cron 表达式" });
      return;
    }
    if (url.startsWith(apiUrl("/schedule/")) && req.method === "DELETE") {
      const schedId = url.slice(apiUrl("/schedule/").length);
      const ok = scheduler.removeJob(schedId);
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "未找到该定时任务" });
      return;
    }

    if (url === apiUrl("/plan") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }

      let planReq: PlanRequest;
      try {
        planReq = JSON.parse(body) as PlanRequest;
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!planReq.instruction || typeof planReq.instruction !== "string") {
        sendJSON(res, 400, { error: "Missing 'instruction' field" });
        return;
      }

      const abort = new AbortController();
      req.on("close", () => abort.abort());
      req.on("error", () => abort.abort());

      sendSSE(res);

      const write = (data: object) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        eventBus.broadcast(data);
      };

      try {
        const planResult = await deps.coordinator.plan(planReq.instruction);
        write({
          type: "plan",
          source: planResult.source,
          steps: planResult.plan.steps.map((s) => ({
            id: s.id,
            description: s.description,
            expertId: s.expertId,
            dependsOn: s.dependsOn,
            critical: s.critical,
          })),
        });

        const callbacks: StreamCallbacks = {
          onStepStart: (stepId, expertId, desc) => write({ type: "step_start", stepId, expertId, desc }),
          onStepEnd: (stepId, success) => write({ type: "step_end", stepId, success }),
          onToolCall: (name, args, id) => write({ type: "tool_call", name, args, id }),
          onToolResult: (name, success, summary) =>
            write({ type: "tool_result", name, success, summary: summary.slice(0, 500) }),
        };

        const result = await runWithChannels(write, () =>
          deps.coordinator.execute(
            planResult.plan,
            deps.workingDir,
            callbacks,
            abort.signal,
          ),
        );

        write({
          type: "done",
          content: result.text,
          failedSteps: result.failedSteps,
          model: deps.modelRouter.getCurrentModel(),
          tokenUsage: {
            total: deps.modelRouter.getTokenUsage(),
            prompt: deps.modelRouter.getPromptTokens(),
            completion: deps.modelRouter.getCompletionTokens(),
          },
        });
      } catch (err) {
        write({ type: "error", message: (err as Error).message });
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (url === apiUrl("/debate") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }

      let debateReq: DebateRequest;
      try {
        debateReq = JSON.parse(body) as DebateRequest;
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!debateReq.topic || typeof debateReq.topic !== "string") {
        sendJSON(res, 400, { error: "Missing 'topic' field" });
        return;
      }

      const available = deps.coordinator.getAvailableAgents();
      const { agentA, agentB } = pickDebateAgents(debateReq.topic, available);

      const abort = new AbortController();
      req.on("close", () => abort.abort());
      req.on("error", () => abort.abort());

      sendSSE(res);

      const write = (data: object) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        eventBus.broadcast(data);
      };

      try {
        write({ type: "debate_start", agentA, agentB });

        const callbacks: StreamCallbacks = {
          onToolCall: (expertId, desc) =>
            write({ type: "tool_call", name: expertId, args: desc, expertId, phase: desc }),
          onToolResult: (name, success, summary) =>
            write({ type: "tool_result", name, success, summary: summary.slice(0, 500) }),
        };

        const result = await runWithChannels(write, () =>
          deps.coordinator.debate(
            debateReq.topic,
            agentA,
            agentB,
            deps.workingDir,
            callbacks,
            abort.signal,
          ),
        );

        write({
          type: "done",
          content: result.text,
          agentA,
          agentB,
          model: deps.modelRouter.getCurrentModel(),
          tokenUsage: {
            total: deps.modelRouter.getTokenUsage(),
            prompt: deps.modelRouter.getPromptTokens(),
            completion: deps.modelRouter.getCompletionTokens(),
          },
        });
      } catch (err) {
        write({ type: "error", message: (err as Error).message });
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (url === apiUrl("/confirm") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }

      let confirmReq: { id?: string; value?: string | null };
      try {
        confirmReq = JSON.parse(body) as { id?: string; value?: string | null };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!confirmReq.id || typeof confirmReq.id !== "string") {
        sendJSON(res, 400, { error: "Missing 'id' field" });
        return;
      }

      const ok = confirmResponse(confirmReq.id, confirmReq.value ?? null);
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Unknown confirm id" });
      return;
    }

    if (url === apiUrl("/ask") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }

      let askReq: { id?: string; answer?: string | null };
      try {
        askReq = JSON.parse(body) as { id?: string; answer?: string | null };
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!askReq.id || typeof askReq.id !== "string") {
        sendJSON(res, 400, { error: "Missing 'id' field" });
        return;
      }

      const ok = askResponse(askReq.id, askReq.answer ?? null);
      sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Unknown ask id" });
      return;
    }

    if (url === apiUrl("/diffs") && req.method === "GET") {
      const snapshotsDir = deps.dataDir ? resolve(deps.dataDir, "snapshots") : resolve(process.cwd(), "data", "snapshots");
      sendJSON(res, 200, { sessions: getDiffsCached(snapshotsDir, deps.sessionStore) });
      return;
    }

    // ─── 文档工作台（Sprint 35：data/docs/ 会话资产；Sprint 38：+ 工作目录项目文档） ───
    if (req.method === "GET" && (url === apiUrl("/docs") || url.startsWith(apiUrl("/docs") + "?"))) {
      const dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
      const docsDir = resolve(dataDir, "docs");
      // 项目文档根：?sessionId= 时跟随会话项目目录（未设置回退全局）
      const u = new URL(req.url ?? "", "http://localhost");
      const sessionIdParam = u.searchParams.get("sessionId");
      const projectDir =
        sessionIdParam && deps.sessionStore
          ? deps.sessionStore.getWorkingDir(sessionIdParam) ?? deps.workingDir
          : deps.workingDir;
      const docs: { root: string; path: string; title: string; size: number; mtime: number }[] = [];
      // 会话资产：data/docs/ 全量递归（数量小，无上限）
      const walkSession = (dir: string, base: string): void => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = resolve(dir, e.name);
          if (e.isDirectory()) walkSession(full, join(base, e.name));
          else if (e.name.endsWith(".md")) {
            const st = statSync(full);
            docs.push({ root: "session", path: join(base, e.name).replace(/\\/g, "/"), title: e.name.replace(/\.md$/, ""), size: st.size, mtime: st.mtimeMs });
          }
        }
      };
      walkSession(docsDir, "");
      // 项目文档：workingDir 递归（排除系统目录 + 应用自身 dataDir；深度/数量/大小上限；mtime 降序）
      const excludedDirNames = new Set([
        "node_modules",
        ".git",
        "dist",
        "build",
        ".venv",
        "venv",
        "__pycache__",
        ".next",
        "coverage",
        "out",
      ]);
      const projectAbs = resolve(projectDir);
      const dataDirAbs = resolve(dataDir);
      const relData = relative(projectAbs, dataDirAbs);
      const excludeDataAbs =
        projectAbs !== dataDirAbs && relData !== "" && !relData.startsWith("..") && !isAbsolute(relData) ? dataDirAbs : null;
      const projectDocs: typeof docs = [];
      let scanStopped = false;
      const walkProject = (dir: string, base: string, depth: number): void => {
        if (scanStopped || depth > 4 || !existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (scanStopped) return;
          const full = resolve(dir, e.name);
          if (e.isDirectory()) {
            if (excludedDirNames.has(e.name)) continue;
            if (excludeDataAbs && full === excludeDataAbs) continue;
            walkProject(full, join(base, e.name), depth + 1);
          } else if (e.name.endsWith(".md")) {
            let st;
            try {
              st = statSync(full);
            } catch {
              continue;
            }
            if (st.size > 1_000_000) continue;
            projectDocs.push({ root: "project", path: join(base, e.name).replace(/\\/g, "/"), title: e.name.replace(/\.md$/, ""), size: st.size, mtime: st.mtimeMs });
            if (projectDocs.length >= 200) {
              scanStopped = true;
              return;
            }
          }
        }
      };
      walkProject(projectDir, "", 0);
      projectDocs.sort((a, b) => b.mtime - a.mtime);
      docs.push(...projectDocs);
      sendJSON(res, 200, {
        roots: [
          { root: "session", dir: docsDir },
          { root: "project", dir: projectDir },
        ],
        docs,
      });
      return;
    }
    if (url.startsWith(apiUrl("/docs/content")) && req.method === "GET") {
      const u = new URL(req.url ?? "", "http://localhost");
      const root = u.searchParams.get("root") ?? "session";
      const rel = u.searchParams.get("path") ?? "";
      const sessionIdParam = u.searchParams.get("sessionId");
      const dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
      const projectDir =
        sessionIdParam && deps.sessionStore
          ? deps.sessionStore.getWorkingDir(sessionIdParam) ?? deps.workingDir
          : deps.workingDir;
      const baseDir = root === "project" ? projectDir : resolve(dataDir, "docs");
      const abs = resolve(baseDir, rel);
      const relCheck = relative(baseDir, abs);
      if (!relCheck.startsWith("..") && !isAbsolute(relCheck) && existsSync(abs) && statSync(abs).isFile()) {
        sendJSON(res, 200, { root, path: rel, content: readFileSync(abs, "utf-8") });
      } else {
        sendJSON(res, 404, { error: "Doc not found" });
      }
      return;
    }

    // ─── 进化引擎（Sprint 39/40：观察/提议/两段式确认/回滚/台账） ───
    if (deps.evolutionEngine && url.startsWith(apiUrl("/evolution"))) {
      const evo = deps.evolutionEngine;
      if (url === apiUrl("/evolution/observe") && req.method === "GET") {
        sendJSON(res, 200, evo.observe());
        return;
      }
      if (url === apiUrl("/evolution/propose") && req.method === "POST") {
        const result = await evo.propose();
        sendJSON(res, 200, result);
        return;
      }
      if (url === apiUrl("/evolution/proposals") && req.method === "GET") {
        sendJSON(res, 200, { proposals: evo.list() });
        return;
      }
      if (url.startsWith(apiUrl("/evolution/ledger")) && req.method === "GET") {
        const u = new URL(req.url ?? "", "http://localhost");
        const limit = Number(u.searchParams.get("limit") ?? "20");
        sendJSON(res, 200, { entries: evo.ledger(Number.isFinite(limit) ? limit : 20) });
        return;
      }
      // 黄金用例库（Sprint 41 第三期：评测集）
      if (req.method === "GET" && (url === apiUrl("/evolution/cases") || url.startsWith(apiUrl("/evolution/cases") + "?"))) {
        sendJSON(res, 200, { cases: evo.listCases() });
        return;
      }
      if (url === apiUrl("/evolution/cases") && req.method === "POST") {
        let body: string;
        try {
          body = await parseBody(req);
        } catch {
          sendJSON(res, 413, { error: "Body too large" });
          return;
        }
        let input = "";
        let expected: string | undefined;
        try {
          const parsed = JSON.parse(body) as { input?: unknown; expected?: unknown };
          if (typeof parsed.input === "string") input = parsed.input;
          if (typeof parsed.expected === "string") expected = parsed.expected;
        } catch {
          sendJSON(res, 400, { error: "Invalid JSON" });
          return;
        }
        sendJSON(res, 200, evo.addCase(input, expected));
        return;
      }
      if (url === apiUrl("/evolution/cases/extract") && req.method === "POST") {
        sendJSON(res, 200, evo.extractCases());
        return;
      }
      if (url.startsWith(apiUrl("/evolution/cases/")) && req.method === "DELETE") {
        const cid = decodeURIComponent(url.slice(apiUrl("/evolution/cases/").length));
        sendJSON(res, 200, evo.deleteCase(cid));
        return;
      }
      if (url.startsWith(apiUrl("/evolution/proposals/"))) {
        const rest = url.slice(apiUrl("/evolution/proposals/").length);
        const id = decodeURIComponent(rest.split("/")[0] ?? "");
        if (!id) {
          sendJSON(res, 400, { error: "缺少提案 id" });
          return;
        }
        if (rest.endsWith("/change")) {
          if (req.method === "GET") {
            sendJSON(res, 200, evo.change(id));
          } else {
            sendJSON(res, 405, { error: "Method Not Allowed" });
          }
          return;
        }
        if (req.method !== "POST") {
          sendJSON(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (rest.endsWith("/adopt")) {
          sendJSON(res, 200, evo.adopt(id));
          return;
        }
        if (rest.endsWith("/apply")) {
          sendJSON(res, 200, await evo.apply(id));
          return;
        }
        if (rest.endsWith("/rollback")) {
          sendJSON(res, 200, evo.rollback(id));
          return;
        }
        if (rest.endsWith("/eval")) {
          sendJSON(res, 200, await evo.eval(id));
          return;
        }
        if (rest.endsWith("/verify")) {
          sendJSON(res, 200, await evo.verify(id));
          return;
        }
        if (rest.endsWith("/reject")) {
          sendJSON(res, 200, evo.reject(id));
          return;
        }
        sendJSON(res, 404, { error: "未知操作（change|adopt|apply|rollback|reject|eval|verify）" });
        return;
      }
    }

    if (url === apiUrl("/chat") && req.method === "POST") {
      let body: string;
      try {
        body = await parseBody(req);
      } catch {
        sendJSON(res, 413, { error: "Body too large" });
        return;
      }

      let chatReq: ChatRequest;
      try {
        chatReq = JSON.parse(body) as ChatRequest;
      } catch {
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!chatReq.message || typeof chatReq.message !== "string") {
        sendJSON(res, 400, { error: "Missing 'message' field" });
        return;
      }

      // 多模态：图片请求需当前模型支持视觉（models.json 当前 profile 配 vision:true）
      const images = Array.isArray(chatReq.images) ? chatReq.images.filter((u) => typeof u === "string") : undefined;
      if (images && images.length > 0 && !deps.modelRouter.supportsVision()) {
        sendJSON(res, 400, {
          error: "当前模型不支持视觉输入（图片）。请在 config/models.json 的模型 profile（default 或当前使用）配置 vision:true（如 deepseek-vl 等视觉模型）后重试。",
        });
        return;
      }

      const agentId = chatReq.agentId ?? "default";
      const agent = deps.createAgent(agentId);
      if (!agent) {
        sendJSON(res, 400, { error: `Unknown agent: ${agentId}` });
        return;
      }

      // 技能模式：/技能名 [任务] 或 /skill 技能名 [任务]（等价 CLI；未知技能不建会话、不跑智能体）
      const skillAction = resolveSkillInstruction(chatReq.message, deps.getSkills?.() ?? []);

      let sessionId = chatReq.sessionId;
      if (skillAction !== "not_found" && !sessionId && deps.sessionStore) {
        sessionId = deps.sessionStore.createSession(agentId).id;
        eventBus.broadcast({ type: "session/update", sessionId, kind: "create" });
      }

      const abort = new AbortController();
      req.on("close", () => abort.abort());
      req.on("error", () => abort.abort());

      sendSSE(res);

      const write = (data: object) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        eventBus.broadcast(data);
      };

      try {
        if (skillAction === "not_found") {
          const name = chatReq.message.match(/^\/([a-zA-Z0-9][\w-]*)/)?.[1] ?? "";
          write({ type: "skill_not_found", name, available: (deps.getSkills?.() ?? []).map((s) => s.name) });
          return;
        }

        if (deps.sessionStore && sessionId) {
          deps.sessionStore.ensureSession(sessionId, agentId);
          // 用户消息持久化由 base-agent.runStream 统一负责（此处不 append，避免双写）
          eventBus.broadcast({ type: "session/update", sessionId, kind: "message" });
        }

        if (skillAction) {
          write({ type: "skill_activated", name: skillAction.skill.name, description: skillAction.skill.description ?? "" });
        }

        // 确认+提问通道：hook 内 requestConfirm / ask_user 时发 SSE 事件并挂起等待前端响应
        await runWithChannels(write, async () => {
          const callbacks: StreamCallbacks = {
            onTextDelta: (text) => write({ type: "text", content: text }),
            onToolCall: (name, args, id) => write({ type: "tool_call", name, args, id }),
            onToolResult: (name, success, summary) => {
              write({ type: "tool_result", name, success, summary: summary.slice(0, 500) });
              if (!success && /拦截|禁止|不允许/.test(summary)) {
                write({ type: "tool_blocked", name, message: summary.slice(0, 200) });
              }
            },
            onThinkingDelta: (text) => write({ type: "thinking", content: text }),
            onThinkingStart: () => write({ type: "thinking_start" }),
            onIterationStart: () => {},
          };

          const task: Task = {
            instruction: chatReq.message,
            sessionId: sessionId ?? `http-${Date.now().toString(36)}`,
            mode: chatReq.mode as PermissionMode | undefined,
            images,
            // 每会话项目目录：优先会话自定义，回退全局（base-agent 已 task.workingDir ?? workingDir）
            ...(sessionId && deps.sessionStore?.getWorkingDir(sessionId) ? { workingDir: deps.sessionStore.getWorkingDir(sessionId)! } : {}),
            ...(skillAction ? { explicitSkill: { name: skillAction.skill.name, body: skillAction.skill.body ?? "" } } : {}),
          };

          await agent.runStream(task, deps.workingDir, callbacks, abort.signal);
        });

        write({
          type: "done",
          sessionId,
          model: deps.modelRouter.getCurrentModel(),
          tokenUsage: {
            total: deps.modelRouter.getTokenUsage(),
            prompt: deps.modelRouter.getPromptTokens(),
            completion: deps.modelRouter.getCompletionTokens(),
          },
        });
      } catch (err) {
        write({ type: "error", message: (err as Error).message });
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    sendJSON(res, 404, { error: "Not found" });
  });

  // ===== WebSocket 全局实时总线（/api/v1/ws）=====
  // SSE 是单次任务（chat/plan/debate）的请求-响应事件流；WS 是全局下行通道，
  // 服务端主动推送（会话元数据变更 / 任务事件广播），支持多端同步。
  const wss = new WebSocketServer({ noServer: true });
  // 音频通道（Sprint 36：/api/v1/audio，TTS 请求/响应）
  const audioWs = createAudioWs(
    deps.dataDir ?? resolve(process.cwd(), "data"),
    undefined,
    getAsrProvider(deps.dataDir ?? resolve(process.cwd(), "data")),
  );
  server.on("upgrade", (req, socket, head) => {
    if (req.url === apiUrl("/ws")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else if (req.url === audioWs.path) {
      audioWs.wss.handleUpgrade(req, socket, head, (ws) => {
        audioWs.wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  interface AliveSocket extends WebSocket {
    isAlive?: boolean;
  }

  wss.on("connection", (raw) => {
    const ws = raw as AliveSocket;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    const unsubscribe = eventBus.subscribe((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    });
    ws.on("close", unsubscribe);
    ws.on("error", () => {});
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as AliveSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  server.on("close", () => clearInterval(heartbeat));

  server.listen(port, () => {
    stdout.write(chalk.green(`\n✓ HTTP Server 已启动: http://localhost:${port}\n`));
  });

  return server;
}
