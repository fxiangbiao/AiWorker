/**
 * 内置工具实现
 * 文件系统读写 + 终端执行 + Web 搜索 + Web 抓取
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { exec, type ExecOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ToolDefinition,
  ToolHandler,
  ToolResult,
  RegisteredTool,
  ToolContext,
} from "../types.js";
import { toolRegistry } from "../core/tool-registry.js";
import { DangerDetector } from "../security/danger-detector.js";

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
    content,
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
  const filePath = resolve(ctx.projectDir, args.path as string);

  // 路径遍历防护: 确保解析后路径仍在 projectDir 内
  const resolvedPath = resolve(filePath);
  const resolvedBase = resolve(ctx.projectDir);
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `路径超出项目目录: ${args.path as string}`,
    };
  }

  // 权限检查：Craft 模式下高危需确认
  const dangerCheck = detector.check(`write ${filePath}`);
  if (dangerCheck.isDangerous && ctx.permissions === "craft") {
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

  // 危险操作检测
  const dangerCheck = detector.check(command);
  if (dangerCheck.isDangerous) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `⚠️ 高危操作被拦截: ${dangerCheck.message}\n命令: ${command}`,
    };
  }

  const options: ExecOptions = {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024 * 10, // 10MB
  };

  return new Promise((resolve) => {
    exec(command, options, (error, stdout, stderr) => {
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
          content: out || "(无输出)",
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

    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
      .join("\n\n");

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
    const snippet = snippetMatch
      ? snippetMatch[1].replace(tagRegex, "").replace(/\s+/g, " ").trim().slice(0, 400)
      : "";

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

// ===== 注册所有内置工具 =====

export function registerBuiltinTools(): void {
  toolRegistry.register("fs_read", readFileDef, readFileHandler);
  toolRegistry.register("fs_write", writeFileDef, writeFileHandler);
  toolRegistry.register("fs_list", listDirDef, listDirHandler);
  toolRegistry.register("terminal_exec", execCmdDef, execCmdHandler);
  toolRegistry.register("web_search", webSearchDef, webSearchHandler);
  toolRegistry.register("web_fetch", webFetchDef, webFetchHandler);
}
