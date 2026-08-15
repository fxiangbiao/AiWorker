/**
 * AiWorker HTTP Server — API 模式
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelRouter } from "./core/model-router.js";
import { toolRegistry } from "./core/tool-registry.js";
import { TeamCoordinator, pickDebateAgents } from "./core/team-coordinator.js";
import { projectTrace, computeSessionStats } from "./core/trace.js";
import { getAppVersion } from "./core/version.js";
import { readTelemetryFile } from "./memory/telemetry.js";
import { setConfirmProvider, createHttpConfirmProvider, confirmResponse } from "./hooks/confirm-channel.js";
import { setAskProvider, createHttpAskProvider, askResponse } from "./tools/ask-channel.js";
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
}

interface DiffSession {
  sessionId: string;
  files: DiffFile[];
  createdAt: number;
  updatedAt: number;
}

/** 解析快照 .diff 文件为结构化行 */
function parseDiffFile(content: string): { lines: DiffLine[]; path?: string } {
  const lines: DiffLine[] = [];
  let path: string | undefined;
  for (const rawLine of content.split("\n")) {
    if (rawLine.startsWith("# path: ")) {
      path = rawLine.slice(8).trim();
      continue;
    }
    if (rawLine.startsWith("+ ") || rawLine === "+") {
      lines.push({ type: "add", text: rawLine.slice(2) });
    } else if (rawLine.startsWith("- ") || rawLine === "-") {
      lines.push({ type: "del", text: rawLine.slice(2) });
    } else if (rawLine.startsWith("---")) {
      break; // diff 内容在 --- 分隔之前
    } else if (rawLine.trim()) {
      lines.push({ type: "ctx", text: rawLine });
    }
  }
  return { lines, path };
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

/** 扫描 data/snapshots 目录，返回全部会话的文件变更 */
function scanDiffs(snapshotsDir: string): DiffSession[] {
  try {
    if (!existsSync(snapshotsDir)) return [];
    const sessions: DiffSession[] = [];
    const sessionDirs = readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

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
        });
      }
      if (files.length > 0) {
        sessions.push({ sessionId, files, createdAt: updatedAt, updatedAt });
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

/** 将会话消息渲染为 Markdown 导出内容 */
function renderSessionMarkdown(
  title: string,
  sessionId: string,
  messages: Array<import("./types.js").Message & { seq: number; createdAt: number }>,
): string {
  const lines: string[] = [`# ${title}`, "", `> 会话 ID: ${sessionId}`, ""];
  for (const m of messages) {
    const time = new Date(m.createdAt).toLocaleString("zh-CN", { hour12: false });
    if (m.role === "user") {
      lines.push(`## 🧑 用户 · ${time}`, "", m.content.trim(), "");
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        lines.push(`## 🤖 助手 · ${time}`, "");
        for (const tc of m.tool_calls) {
          lines.push(`- \`${tc.function.name}\` \`\`\`json\n${tc.function.arguments}\n\`\`\``);
        }
        lines.push("");
      }
      if (m.content.trim()) {
        if (!m.tool_calls || m.tool_calls.length === 0) lines.push(`## 🤖 助手 · ${time}`, "");
        lines.push(m.content.trim(), "");
      }
    } else if (m.role === "tool") {
      lines.push(`> 🔧 工具结果${m.name ? ` (${m.name})` : ""}: ${m.content.slice(0, 200)}`, "");
    }
  }
  return lines.join("\n");
}

export function startServer(deps: ServerDeps, port: number) {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "OPTIONS") {
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
      sendJSON(res, 200, { sessions: scanDiffs(snapshotsDir) });
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
      }

      const abort = new AbortController();
      req.on("close", () => abort.abort());
      req.on("error", () => abort.abort());

      sendSSE(res);

      const write = (data: object) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      try {
        if (deps.sessionStore && sessionId) {
          deps.sessionStore.ensureSession(sessionId, agentId);
          deps.sessionStore.appendMessage(sessionId, { role: "user", content: chatReq.message });
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

  server.listen(port, () => {
    stdout.write(chalk.green(`\n✓ HTTP Server 已启动: http://localhost:${port}\n`));
    stdout.write(chalk.gray(`  端点: POST ${API_PREFIX}/chat | ${API_PREFIX}/plan | ${API_PREFIX}/debate | GET ${API_PREFIX}/status | ${API_PREFIX}/tools | ${API_PREFIX}/agents\n`));
  });

  return server;
}
