/**
 * AiWorker HTTP Server — API 模式
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { WebSocketServer, type WebSocket } from "ws";
import type { ModelRouter } from "./core/model-router.js";
import { toolRegistry } from "./core/tool-registry.js";
import { TeamCoordinator, pickDebateAgents } from "./core/team-coordinator.js";
import { projectTrace, computeSessionStats } from "./core/trace.js";
import { getAppVersion } from "./core/version.js";
import { readTelemetryFile } from "./memory/telemetry.js";
import { setConfirmProvider, createHttpConfirmProvider, confirmResponse } from "./hooks/confirm-channel.js";
import { setAskProvider, createHttpAskProvider, askResponse } from "./tools/ask-channel.js";
import { eventBus } from "./server/event-bus.js";
import { jobRunner } from "./core/job-runner.js";
import { scheduler } from "./core/scheduler.js";
import { parseNaturalSchedule } from "./core/nl-schedule.js";
import { packageInstaller, parseSkillMeta } from "./core/package-installer.js";
import { renderSessionMarkdown } from "./memory/session-export.js";
import type { StreamCallbacks, Task, AgentRunResult, PermissionMode, PluginInfo } from "./types.js";
import type { SessionStore } from "./memory/session-store.js";

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
  getAgentList: () => { id: string; name: string }[];
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
} {
  const lines: DiffLine[] = [];
  let path: string | undefined;
  let currentContent: string | undefined;
  let binary = false;
  let inMeta = false;
  for (const rawLine of content.split("\n")) {
    if (inMeta) {
      // 分隔符之后的元信息块（old/new 字符数 + 指纹监控附的 new_b64 / binary 标记）
      if (rawLine.startsWith("new_b64: ")) {
        try {
          currentContent = Buffer.from(rawLine.slice(9).trim(), "base64").toString("utf-8");
        } catch {
          currentContent = undefined;
        }
      } else if (rawLine.startsWith("binary: ")) {
        binary = rawLine.slice(8).trim() === "1";
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
  return { lines, path, currentContent, binary };
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
        files.push({
          path: parsed.path ?? decodeDiffPath(entry),
          added: parsed.lines.filter((l) => l.type === "add").length,
          removed: parsed.lines.filter((l) => l.type === "del").length,
          lines: parsed.lines,
          currentContent: parsed.currentContent,
          binary: parsed.binary,
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

    if (url.startsWith(apiUrl("/sessions/")) && req.method === "GET" && !url.endsWith("/export")) {
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

      const agentId = chatReq.agentId ?? "default";
      const agent = deps.createAgent(agentId);
      if (!agent) {
        sendJSON(res, 400, { error: `Unknown agent: ${agentId}` });
        return;
      }

      let sessionId = chatReq.sessionId;
      if (!sessionId && deps.sessionStore) {
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
        if (deps.sessionStore && sessionId) {
          deps.sessionStore.ensureSession(sessionId, agentId);
          deps.sessionStore.appendMessage(sessionId, { role: "user", content: chatReq.message });
          eventBus.broadcast({ type: "session/update", sessionId, kind: "message" });
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
  server.on("upgrade", (req, socket, head) => {
    if (req.url === apiUrl("/ws")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
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
