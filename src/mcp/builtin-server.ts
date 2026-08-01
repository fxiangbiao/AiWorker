/**
 * MCP 内置工具服务器 — JSON-RPC 2.0 over stdin/stdout
 * 提供 math_eval / uuid_gen / json_format / timestamp_convert 四个工具
 * 由 McpManager 以 stdio transport 方式 spawn 启动
 */

const TOOLS = [
  {
    name: "math_eval",
    description: "计算数学表达式。支持 + - * / ** % () 和 Math 函数。",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "数学表达式，如 2+3*4 或 Math.sqrt(16)" },
      },
      required: ["expression"],
    },
  },
  {
    name: "uuid_gen",
    description: "生成 UUID v4",
    inputSchema: { type: "object", properties: { count: { type: "number", description: "生成数量，默认 1" } } },
  },
  {
    name: "json_format",
    description: "格式化 JSON 字符串并验证语法",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON 字符串" },
        indent: { type: "number", description: "缩进空格数，默认 2" },
      },
      required: ["json"],
    },
  },
  {
    name: "timestamp_convert",
    description: "时间戳与日期字符串互相转换",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "时间戳(毫秒) 或 ISO 日期字符串" },
      },
      required: ["value"],
    },
  },
];

function uuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function safeEval(expr: string): string {
  // Strip whitespace and check allowed characters
  const sanitized = expr.replace(/\s+/g, "");
  if (!/^[\d+\-*/().%,\w]+$/.test(sanitized)) {
    throw new Error("表达式包含不允许的字符");
  }

  // Only allow Math.xxx where xxx is one of the whitelisted methods
  if (sanitized.includes("Math.")) {
    const mathCall = sanitized.match(/Math\.(\w+)/g);
    if (mathCall) {
      for (const call of mathCall) {
        const method = call.slice(5);
        if (!ALLOWED_MATH_METHODS.has(method)) {
          throw new Error(`不允许的 Math 方法: Math.${method}`);
        }
      }
    }
  }

  // Build a sandbox with whitelisted Math functions only
  const sandbox: Record<string, unknown> = {};
  for (const key of ALLOWED_MATH_METHODS) {
    sandbox[key] = (Math as unknown as Record<string, unknown>)[key];
  }

  const sandboxKeys = Object.keys(sandbox);
  const sandboxValues = sandboxKeys.map((k) => sandbox[k]);

  try {
    const fn = new Function(...sandboxKeys, `"use strict"; return (${sanitized})`);
    const result = fn(...sandboxValues);
    return String(result);
  } catch {
    throw new Error("表达式计算失败");
  }
}

const ALLOWED_MATH_METHODS = new Set([
  "abs",
  "ceil",
  "floor",
  "round",
  "max",
  "min",
  "sqrt",
  "pow",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "PI",
  "E",
  "LN2",
  "LN10",
]);

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "math_eval": {
      const expr = String(args.expression ?? "");
      if (!expr) throw new Error("缺少 expression 参数");
      return { content: [{ type: "text", text: safeEval(expr) }] };
    }
    case "uuid_gen": {
      const count = Number(args.count ?? 1);
      if (!Number.isFinite(count) || count < 1) {
        throw new Error("count 参数必须是一个正数");
      }
      const n = Math.min(Math.floor(count), 10);
      const ids = Array.from({ length: n }, () => uuidV4());
      return { content: [{ type: "text", text: ids.join("\n") }] };
    }
    case "json_format": {
      const raw = String(args.json ?? "");
      const indent = Number(args.indent ?? 2);
      const obj = JSON.parse(raw);
      const formatted = JSON.stringify(obj, null, indent);
      return { content: [{ type: "text", text: formatted }] };
    }
    case "timestamp_convert": {
      const val = String(args.value ?? "");
      const num = Number(val);
      if (!isNaN(num) && num > 1e10) {
        // 毫秒时间戳 → ISO
        return { content: [{ type: "text", text: new Date(num).toISOString() }] };
      } else if (!isNaN(num)) {
        // 秒时间戳 → ISO
        return { content: [{ type: "text", text: new Date(num * 1000).toISOString() }] };
      } else {
        // 日期字符串 → 毫秒时间戳
        const ts = new Date(val).getTime();
        if (isNaN(ts)) throw new Error("无法解析日期");
        return { content: [{ type: "text", text: String(ts) }] };
      }
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ── JSON-RPC Loop ──

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respondError(id: number | string | null | undefined, code: number, message: string): void {
  respond({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

let buf = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);

      // Notification (no id) — e.g. "notifications/initialized"
      if (msg.id === undefined || msg.id === null) {
        // ignore — no response needed
        continue;
      }

      const id = msg.id as number | string;

      switch (msg.method) {
        case "initialize":
          respond({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "aiworker-builtin", version: "0.1.0" },
            },
          });
          break;

        case "tools/list":
          respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          break;

        case "tools/call": {
          try {
            const result = callTool(msg.params?.name ?? "", msg.params?.arguments ?? {});
            respond({ jsonrpc: "2.0", id, result });
          } catch (err) {
            respond({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `错误: ${(err as Error).message}` }], isError: true },
            });
          }
          break;
        }

        default:
          respondError(id, -32601, `未知方法: ${msg.method}`);
      }
    } catch {
      // 非 JSON 行，忽略
    }
  }
});

process.stdin.resume();
