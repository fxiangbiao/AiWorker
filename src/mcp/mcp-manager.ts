/**
 * MCP Manager — Model Context Protocol 客户端
 * 支持 stdio / HTTP 两种传输协议，运行时工具发现与注册
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolResult, McpServerConfig, McpToolDef, McpServerStatus, ToolDefinition, ToolHandler } from "../types.js";
import { toolRegistry } from "../core/tool-registry.js";

interface McpConnection {
  config: McpServerConfig;
  process?: ChildProcess;
  pendingRequests: Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  buffer: string;
  initialized: boolean;
  capabilities: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpManager {
  private connections: Map<string, McpConnection> = new Map();
  private static instance: McpManager;

  static getInstance(): McpManager {
    if (!McpManager.instance) {
      McpManager.instance = new McpManager();
    }
    return McpManager.instance;
  }

  async loadConfig(configPath: string): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch {
      return;
    }

    const config = JSON.parse(raw) as { servers?: Record<string, McpServerConfig> };
    const servers = config.servers ?? {};

    for (const [name, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled !== false) {
        try {
          await this.connectServer({ ...serverConfig, name });
        } catch {
          // 自动降级: 连接失败不阻塞启动
        }
      }
    }
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      return;
    }

    const conn: McpConnection = {
      config,
      pendingRequests: new Map(),
      nextId: 1,
      buffer: "",
      initialized: false,
      capabilities: {},
    };

    if (config.transport === "stdio") {
      await this.connectStdio(conn);
    } else if (config.transport === "http") {
      conn.initialized = true;
    } else {
      throw new Error(`不支持的传输协议: ${config.transport}`);
    }

    this.connections.set(config.name, conn);

    // 发现并注册工具
    await this.discoverAndRegisterTools(config.name);
  }

  private async connectStdio(conn: McpConnection): Promise<void> {
    if (!conn.config.command) {
      throw new Error(`Stdio 传输需要指定 command，server: ${conn.config.name}`);
    }

    const child = spawn(conn.config.command, conn.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...conn.config.env },
    });

    conn.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      conn.buffer += chunk.toString();
      this.processStdioBuffer(conn);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // MCP 服务器的 stderr 通常用于日志，静默处理
    });

    child.on("error", (err) => {
      conn.initialized = false;
    });

    child.on("exit", () => {
      conn.initialized = false;
    });

    // 发送 initialize 请求
    const initResult = await this.sendRequest(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aiworker", version: "0.1.0" },
    });
    conn.capabilities = (initResult as Record<string, unknown>)?.capabilities as Record<string, unknown> ?? {};
    conn.initialized = true;

    // 发送 initialized 通知
    this.sendNotification(conn, "notifications/initialized", {});
  }

  private async discoverAndRegisterTools(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn || !conn.initialized) return;

    try {
      const result = await this.sendRequest(conn, "tools/list", {});
      const tools = ((result as Record<string, unknown>)?.tools as McpToolDef[]) ?? [];

      for (const mcpTool of tools) {
        const toolName = `mcp:${serverName}:${mcpTool.name}`;
        if (toolRegistry.isAvailable(toolName)) {
          toolRegistry.unregister(toolName);
        }

        const definition: ToolDefinition = {
          type: "function",
          function: {
            name: toolName,
            description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (${serverName})`,
            parameters: mcpTool.inputSchema as unknown as ToolDefinition["function"]["parameters"],
          },
        };

        const handler: ToolHandler = async (args) => {
          try {
            const result = await this.sendRequest(conn, "tools/call", {
              name: mcpTool.name,
              arguments: args,
            });
            const content = (result as Record<string, unknown>)?.content;
            const text = Array.isArray(content)
              ? content.map((c: { text?: string }) => c.text ?? "").join("\n")
              : JSON.stringify(result);
            return { tool_call_id: "", success: true, content: text };
          } catch (err) {
            return {
              tool_call_id: "",
              success: false,
              content: "",
              error: `MCP 工具调用失败: ${(err as Error).message}`,
            };
          }
        };

        toolRegistry.register(toolName, definition, handler, {
          availabilityCheck: async () => {
            return conn.initialized;
          },
        });
      }
    } catch (err) {
      // 工具发现失败，静默降级
    }
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const conn = this.connections.get(serverName);
    if (!conn || !conn.initialized) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `MCP 服务器 ${serverName} 未连接`,
      };
    }

    try {
      const result = await this.sendRequest(conn, "tools/call", { name: toolName, arguments: args });
      return { tool_call_id: "", success: true, content: JSON.stringify(result) };
    } catch (err) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: (err as Error).message,
      };
    }
  }

  getStatuses(): Record<string, McpServerStatus> {
    const statuses: Record<string, McpServerStatus> = {};
    for (const [name, conn] of this.connections) {
      statuses[name] = {
        name,
        transport: conn.config.transport,
        connected: conn.initialized,
        toolCount: toolRegistry.getAll().filter((t) => t.definition.function.name.startsWith(`mcp:${name}:`)).length,
      };
    }
    return statuses;
  }

  disconnectServer(name: string): void {
    const conn = this.connections.get(name);
    if (!conn) return;

    // 注销该服务器注册的所有工具
    for (const tool of toolRegistry.getAll()) {
      if (tool.definition.function.name.startsWith(`mcp:${name}:`)) {
        toolRegistry.unregister(tool.definition.function.name);
      }
    }

    conn.process?.kill();
    this.connections.delete(name);
  }

  dispose(): void {
    for (const name of this.connections.keys()) {
      this.disconnectServer(name);
    }
  }

  // ===== JSON-RPC 通信 =====

  private sendRequest(conn: McpConnection, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = conn.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    if (conn.config.transport === "stdio") {
      return this.stdioRequest(conn, request);
    } else {
      return this.httpRequest(conn, request);
    }
  }

  private sendNotification(conn: McpConnection, method: string, params?: Record<string, unknown>): void {
    const notification = { jsonrpc: "2.0" as const, method, params };
    if (conn.config.transport === "stdio" && conn.process?.stdin) {
      conn.process.stdin.write(JSON.stringify(notification) + "\n");
    }
  }

  private stdioRequest(conn: McpConnection, request: JsonRpcRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      conn.pendingRequests.set(request.id, { resolve, reject });
      if (conn.process?.stdin) {
        conn.process.stdin.write(JSON.stringify(request) + "\n");
      } else {
        reject(new Error("Stdio 连接未就绪"));
      }
    });
  }

  private processStdioBuffer(conn: McpConnection): void {
    const lines = conn.buffer.split("\n");
    conn.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && conn.pendingRequests.has(msg.id)) {
          const pending = conn.pendingRequests.get(msg.id)!;
          conn.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // 非 JSON 行，忽略
      }
    }
  }

  private async httpRequest(conn: McpConnection, request: JsonRpcRequest): Promise<unknown> {
    if (!conn.config.url) {
      throw new Error(`HTTP 传输需要指定 url，server: ${conn.config.name}`);
    }

    const response = await fetch(conn.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...conn.config.headers,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as JsonRpcResponse;
    if (data.error) {
      throw new Error(data.error.message);
    }
    return data.result;
  }
}

export const mcpManager = McpManager.getInstance();
