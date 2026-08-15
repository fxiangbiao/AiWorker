/**
 * 内置工具实现
 * 文件系统读写 + 终端执行 + Web 搜索 + Web 抓取
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { exec, type ExecOptions } from "node:child_process";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { toolRegistry } from "../core/tool-registry.js";
import { DangerDetector } from "../security/danger-detector.js";
import { spillOrTruncate } from "./spill.js";
import { requestAsk } from "./ask-channel.js";
import { terminalSessionPool } from "./terminal-session.js";

const detector = new DangerDetector();

// ===== 文件读取 =====

const readFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fs_read",
    description: "读取文件内容。支持文本文件。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于工作目录或绝对路径）",
        },
        encoding: {
          type: "string",
          description: "文件编码，默认 utf-8",
          enum: ["utf-8", "base64"],
        },
      },
      required: ["path"],
    },
  },
};

const readFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = resolve(ctx.workingDir, args.path as string);
  if (!existsSync(filePath)) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `文件不存在: ${filePath}`,
    };
  }
  const content = readFileSync(filePath, "utf-8");
  return {
    tool_call_id: "",
    success: true,
    content: spillOrTruncate(ctx.dataDir, ctx.sessionId, content, "txt"),
  };
};

// ===== 文件写入 =====

const writeFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fs_write",
    description: "写入文件内容。自动创建父目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "写入内容" },
      },
      required: ["path", "content"],
    },
  },
};

const writeFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = resolve(ctx.workingDir, args.path as string);

  // 路径遍历防护: 确保解析后路径仍在工作目录内
  const resolvedPath = resolve(filePath);
  const resolvedBase = resolve(ctx.workingDir);
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `路径超出项目目录: ${args.path as string}`,
    };
  }

  // 权限检查：Auto 模式下高危需确认
  const dangerCheck = detector.check(`write ${filePath}`);
  if (dangerCheck.isDangerous && ctx.permissions === "auto") {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `高危操作被拦截: ${dangerCheck.message}`,
    };
  }

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, args.content as string, "utf-8");
  return {
    tool_call_id: "",
    success: true,
    content: `已写入文件: ${filePath} (${(args.content as string).length} 字符)`,
  };
};

// ===== 目录列表 =====

const listDirDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fs_list",
    description: "列出目录内容。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，默认当前工作目录" },
      },
      required: [],
    },
  },
};

const listDirHandler: ToolHandler = async (args, ctx) => {
  const dirPath = resolve(ctx.workingDir, (args.path as string) ?? ".");
  if (!existsSync(dirPath)) {
    return { tool_call_id: "", success: false, content: "", error: `目录不存在: ${dirPath}` };
  }
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const result = entries
    .map((e) => {
      const full = resolve(dirPath, e.name);
      const stat = statSync(full);
      const type = e.isDirectory() ? "[DIR] " : "      ";
      return `${type} ${e.name} (${stat.size} bytes)`;
    })
    .join("\n");
  return { tool_call_id: "", success: true, content: result };
};

// ===== 终端执行 =====

const execCmdDef: ToolDefinition = {
  type: "function",
  function: {
    name: "terminal_exec",
    description: "执行终端命令。返回 stdout 和 stderr。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        cwd: { type: "string", description: "工作目录，默认当前目录" },
        timeout: { type: "number", description: "超时毫秒数，默认 30000" },
      },
      required: ["command"],
    },
  },
};

const execCmdHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  const cwd = (args.cwd as string) ?? ctx.workingDir;
  const timeout = (args.timeout as number) ?? 30000;

  // 危险操作检测：ask 模式直接拦截；plan/auto 由 hook（confirmHighRisk）确认放行
  if (ctx.permissions === "ask") {
    const dangerCheck = detector.check(command);
    if (dangerCheck.isDangerous) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `⚠️ 高危操作被拦截（ask 模式不允许）: ${dangerCheck.message}\n命令: ${command}`,
      };
    }
  }

  const options: ExecOptions = {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024 * 10, // 10MB
    encoding: "buffer",
  };

  // Windows cmd 输出默认 GBK，前缀 chcp 65001 强制 UTF-8 避免中文乱码
  const finalCommand = process.platform === "win32" ? `chcp 65001 >nul & ${command}` : command;

  return new Promise((resolve) => {
    exec(finalCommand, options, (error, stdout, stderr) => {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      if (error) {
        resolve({
          tool_call_id: "",
          success: false,
          content: out,
          error: err || error.message,
        });
      } else {
        resolve({
          tool_call_id: "",
          success: true,
          // 超长输出落盘，避免撑爆上下文
          content: spillOrTruncate(ctx.dataDir, ctx.sessionId, out, "log"),
        });
      }
    });
  });
};

// ===== Web 搜索 =====

const webSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "搜索互联网获取信息。使用 Bing 搜索引擎。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "number", description: "最大结果数，默认 5，最大 10" },
      },
      required: ["query"],
    },
  },
};

const webSearchHandler: ToolHandler = async (args) => {
  const query = args.query as string;
  const maxResults = Math.min((args.max_results as number) ?? 5, 10);

  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });

    if (!response.ok) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `搜索请求失败: HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const results = parseBingResults(html, maxResults);

    if (results.length === 0) {
      return {
        tool_call_id: "",
        success: true,
        content: `搜索 "${query}" 未找到结果。`,
      };
    }

    const output = results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`).join("\n\n");

    return { tool_call_id: "", success: true, content: output };
  } catch (err) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `搜索失败: ${(err as Error).message}`,
    };
  }
};

function parseBingResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  const algoRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  const titleRegex = /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex = /<p[^>]*>([\s\S]*?)<\/p>/i;
  const tagRegex = /<[^>]+>/g;

  let algoMatch: RegExpExecArray | null;
  while ((algoMatch = algoRegex.exec(html)) !== null && results.length < limit) {
    const block = algoMatch[1];

    const titleMatch = titleRegex.exec(block);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = titleMatch[2].replace(tagRegex, "").trim();

    const snippetMatch = snippetRegex.exec(block);
    const snippet = snippetMatch ? snippetMatch[1].replace(tagRegex, "").replace(/\s+/g, " ").trim().slice(0, 400) : "";

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ===== Web 抓取 =====

const webFetchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "获取网页内容并转为文本。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的 URL" },
      },
      required: ["url"],
    },
  },
};

const webFetchHandler: ToolHandler = async (args) => {
  const url = args.url as string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    // 简单 HTML 清理
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      tool_call_id: "",
      success: true,
      content: cleaned.slice(0, 10000), // 限制长度
    };
  } catch (err) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `抓取失败: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ===== 向用户提问 =====

const askUserDef: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "向用户提出澄清问题。当任务信息不足、存在多种合理解释或需要用户决策时使用。options 提供候选选项（可选），用户可选项或输入自由文本。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问的问题" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "候选选项（可选），用户可直接选择或输入自由文本",
        },
      },
      required: ["question"],
    },
  },
};

const askUserHandler: ToolHandler = async (args) => {
  const question = String(args.question ?? "");
  const options = Array.isArray(args.options)
    ? (args.options as unknown[]).map(String).filter(Boolean)
    : [];
  if (!question.trim()) {
    return { tool_call_id: "", success: false, content: "", error: "问题不能为空" };
  }
  const answer = await requestAsk(question, options);
  if (answer === null) {
    return { tool_call_id: "", success: false, content: "", error: "用户未在限时内回答，请基于已有信息继续" };
  }
  return {
    tool_call_id: "",
    success: true,
    content: `用户回答: ${answer}`,
  };
};

// ===== 持久终端会话 =====

const terminalSessionDef: ToolDefinition = {
  type: "function",
  function: {
    name: "terminal_session",
    description:
      "持久终端会话：跨调用保留工作目录与环境变量（cd/export 生效）。action=start 启动，exec 执行命令，end 关闭。适用于多步开发任务（安装依赖→构建→运行）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "exec", "end"],
          description: "start 启动会话；exec 执行命令；end 关闭会话",
        },
        command: { type: "string", description: "action=exec 时要执行的命令" },
        timeout: { type: "number", description: "单条命令超时毫秒数，默认 30000" },
      },
      required: ["action"],
    },
  },
};

const terminalSessionHandler: ToolHandler = async (args, ctx) => {
  const action = String(args.action ?? "");
  const command = String(args.command ?? "");
  const timeout = (args.timeout as number) ?? 30000;

  try {
    if (action === "start") {
      const started = terminalSessionPool.start(ctx.sessionId);
      return {
        tool_call_id: "",
        success: true,
        content: started ? "持久终端会话已启动（工作目录与环境变量跨调用保留）" : "持久终端会话已存在",
      };
    }
    if (action === "end") {
      terminalSessionPool.end(ctx.sessionId);
      return { tool_call_id: "", success: true, content: "持久终端会话已关闭" };
    }
    if (action === "exec") {
      const session = terminalSessionPool.get(ctx.sessionId);
      if (!session) {
        terminalSessionPool.start(ctx.sessionId);
      }
      const result = await terminalSessionPool.exec(ctx.sessionId, command, timeout);
      if (!result.ok) {
        return {
          tool_call_id: "",
          success: false,
          content: spillOrTruncate(ctx.dataDir, ctx.sessionId, result.stdout, "log"),
          error: result.stderr || "命令执行失败",
        };
      }
      return {
        tool_call_id: "",
        success: true,
        content: spillOrTruncate(ctx.dataDir, ctx.sessionId, result.stdout || "(无输出)", "log"),
      };
    }
    return { tool_call_id: "", success: false, content: "", error: `未知 action: ${action}` };
  } catch (err) {
    return { tool_call_id: "", success: false, content: "", error: `终端会话失败: ${(err as Error).message}` };
  }
};

// ===== 注册所有内置工具 =====

export function registerBuiltinTools(): void {
  toolRegistry.register("fs_read", readFileDef, readFileHandler);
  toolRegistry.register("fs_write", writeFileDef, writeFileHandler);
  toolRegistry.register("fs_list", listDirDef, listDirHandler);
  toolRegistry.register("terminal_exec", execCmdDef, execCmdHandler);
  toolRegistry.register("web_search", webSearchDef, webSearchHandler);
  toolRegistry.register("web_fetch", webFetchDef, webFetchHandler);
  toolRegistry.register("ask_user", askUserDef, askUserHandler);
  toolRegistry.register("terminal_session", terminalSessionDef, terminalSessionHandler);
}
