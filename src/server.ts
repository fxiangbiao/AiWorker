/**
 * AiWorker HTTP Server — API 模式
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stdout } from "node:process";
import chalk from "chalk";
import type { ModelRouter } from "./core/model-router.js";
import { toolRegistry } from "./core/tool-registry.js";
import type { StreamCallbacks, Task, AgentRunResult } from "./types.js";

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
  createAgent: (agentId: string) => DelegateAgent | undefined;
}

interface ChatRequest {
  message: string;
  agentId?: string;
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

    if (url === "/status" && req.method === "GET") {
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
      });
      return;
    }

    if (url === "/tools" && req.method === "GET") {
      const all = toolRegistry.getAll();
      const tools = all.map((t) => ({ name: t.definition.function.name, description: t.definition.function.description }));
      sendJSON(res, 200, { tools });
      return;
    }

    if (url === "/chat" && req.method === "POST") {
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
        const callbacks: StreamCallbacks = {
          onTextDelta: (text) => write({ type: "text", content: text }),
          onToolCall: (name, args, id) => write({ type: "tool_call", name, args, id }),
          onToolResult: (name, success, summary) =>
            write({ type: "tool_result", name, success, summary: summary.slice(0, 500) }),
          onThinkingDelta: (text) => write({ type: "thinking", content: text }),
          onThinkingStart: () => write({ type: "thinking_start" }),
        };

        const task: Task = {
          instruction: chatReq.message,
          sessionId: `http-${Date.now().toString(36)}`,
        };

        await agent.runStream(task, deps.workingDir, deps.projectDir, callbacks, abort.signal);

        write({
          type: "done",
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
    stdout.write(chalk.gray(`  端点: POST /chat | GET /status | GET /tools\n`));
  });

  return server;
}
