/**
 * AiWorker HTTP Server — API 模式
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { ModelRouter } from "./core/model-router.js";
import { toolRegistry } from "./core/tool-registry.js";
import { TeamCoordinator, pickDebateAgents } from "./core/team-coordinator.js";
import type { StreamCallbacks, Task, AgentRunResult, PermissionMode } from "./types.js";
import type { SessionStore } from "./memory/session-store.js";

interface DelegateAgent {
  runStream(
    task: Task,
    workingDir: string,
    projectDir: string,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
}

interface ServerDeps {
  modelRouter: ModelRouter;
  workingDir: string;
  projectDir: string;
  coordinator: TeamCoordinator;
  createAgent: (agentId: string) => DelegateAgent | undefined;
  getAgentList: () => { id: string; name: string }[];
  skillNames: string[];
  sessionStore?: SessionStore;
  getSkills?: () => { name: string; description: string; expert: string }[];
  getContextBreakdown?: (systemPrompt: string, sessionId: string, userMessage: string, agentId?: string) => unknown;
  getSystemPrompt?: () => string;
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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
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
      if (existsSync(distPath)) {
        const ext = url.split(".").pop() || "";
        const mime: Record<string, string> = { js: "application/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2" };
        res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
        res.end(readFileSync(distPath));
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
        model: deps.modelRouter.getCurrentModel(),
        tokenUsage: {
          total: deps.modelRouter.getTokenUsage(),
          prompt: deps.modelRouter.getPromptTokens(),
          completion: deps.modelRouter.getCompletionTokens(),
        },
        workingDir: deps.workingDir,
        projectDir: deps.projectDir,
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

    if (url === apiUrl("/sessions") && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessions = deps.sessionStore.listSessions(50);
      sendJSON(res, 200, { sessions });
      return;
    }

    if (url.startsWith(apiUrl("/sessions/")) && req.method === "GET") {
      if (!deps.sessionStore) { sendJSON(res, 500, { error: "Session store not available" }); return; }
      const sessionId = url.slice(apiUrl("/sessions/").length);
      const messages = deps.sessionStore.getMessages(sessionId);
      sendJSON(res, 200, { sessionId, messages });
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

    if (url === apiUrl("/skills") && req.method === "GET") {
      const skills = deps.getSkills?.() ?? deps.skillNames.map((n) => ({ name: n, description: "", expert: "" }));
      sendJSON(res, 200, { skills });
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

        const result = await deps.coordinator.execute(
          planResult.plan,
          deps.workingDir,
          deps.projectDir,
          callbacks,
          abort.signal,
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

        const result = await deps.coordinator.debate(
          debateReq.topic,
          agentA,
          agentB,
          deps.workingDir,
          deps.projectDir,
          callbacks,
          abort.signal,
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

        const callbacks: StreamCallbacks = {
          onTextDelta: (text) => write({ type: "text", content: text }),
          onToolCall: (name, args, id) => write({ type: "tool_call", name, args, id }),
          onToolResult: (name, success, summary) =>
            write({ type: "tool_result", name, success, summary: summary.slice(0, 500) }),
          onThinkingDelta: (text) => write({ type: "thinking", content: text }),
          onThinkingStart: () => write({ type: "thinking_start" }),
          onIterationStart: () => {},
        };

        const task: Task = {
          instruction: chatReq.message,
          sessionId: sessionId ?? `http-${Date.now().toString(36)}`,
          mode: chatReq.mode as PermissionMode | undefined,
        };

        await agent.runStream(task, deps.workingDir, deps.projectDir, callbacks, abort.signal);

        if (deps.sessionStore && sessionId) {
          deps.sessionStore.appendMessage(sessionId, { role: "assistant", content: "" });
        }

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
