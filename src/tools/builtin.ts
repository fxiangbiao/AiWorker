/**
 * 内置工具实现
 * 文件系统读写 + 终端执行 + Web 搜索 + Web 抓取
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { exec, spawnSync, type ExecOptions } from "node:child_process";
import type { ToolDefinition, ToolHandler, ToolArtifact, ToolContext, ToolResult } from "../types.js";
import { toolRegistry } from "../core/tool-registry.js";
import { buildFileArtifact, isTextPath, sniffIsBinary, simpleDiffLines, formatSize } from "../core/preview.js";
import { DangerDetector } from "../security/danger-detector.js";
import { loadSandboxPolicy, checkCommand, sanitizeEnv, resolveSandboxConfigPath } from "../security/sandbox.js";
import { evaluatePath, resolvePathPolicy, type PathAccessKind, type PathPolicy } from "../security/path-policy.js";
import { spillOrTruncate, SPILL_THRESHOLD } from "./spill.js";
import { requestAsk } from "./ask-channel.js";
import { terminalSessionPool } from "./terminal-session.js";

const detector = new DangerDetector();

/**
 * fs 四件套的读写边界（Sprint 49）：读根 / 写根取自 config/sandbox.json 的
 * allowReadDirs / allowWriteDirs（留空回退工作目录），且**不受 sandbox.enabled 影响**——
 * 命令层的开关不能静默关掉文件读写边界；需要更大范围请显式配置读根/写根。
 */
function fsPathPolicy(workingDir: string): PathPolicy {
  const config = loadSandboxPolicy(resolveSandboxConfigPath(workingDir));
  return resolvePathPolicy(workingDir, {
    enabled: true,
    allowReadDirs: config.allowReadDirs,
    allowWriteDirs: config.allowWriteDirs,
  });
}

/** 越界即拒绝（返回错误结果；null = 放行）。判定含符号链接真实路径解析 */
function denyOutOfScope(kind: PathAccessKind, rawPath: string, ctx: ToolContext): ToolResult | null {
  const decision = evaluatePath(kind, rawPath, fsPathPolicy(ctx.workingDir), ctx.workingDir);
  if (decision.allowed) return null;
  return { tool_call_id: "", success: false, content: "", error: decision.reason };
}

/**
 * 构造 exec 环境：确保 node 可执行目录在 PATH 中。
 * server 若从受限环境启动（PATH 缺 node 目录），node/npm 命令会报 'node' is not recognized；
 * 此处显式补入 node 目录（幂等），保证 terminal_exec 能调用 node/npm。
 */
function buildExecEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const pathKey = isWin ? "Path" : "PATH";
  const cur = String(base[pathKey] ?? base.PATH ?? "");
  const parts = cur.split(sep).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === nodeDir.toLowerCase())) return base;
  return { ...base, [pathKey]: `${nodeDir}${sep}${cur}` };
}

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
        lineNumbers: {
          type: "boolean",
          description: "true 时每行前置行号（1-based，右对齐），便于 fs_edit 按行号编辑（startLine/endLine）",
        },
      },
      required: ["path"],
    },
  },
};

const readFileHandler: ToolHandler = async (args, ctx) => {
  const denied = denyOutOfScope("read", args.path as string, ctx);
  if (denied) return denied;
  const filePath = resolve(ctx.workingDir, args.path as string);
  if (!existsSync(filePath)) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `文件不存在: ${filePath}`,
    };
  }
  const st = statSync(filePath);
  // 文本类：整读 utf-8（保持 LLM 可读）；二进制类：不整读 utf-8，只返回元信息 + artifact 供预览
  if (isTextPath(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const out =
      args.lineNumbers === true
        ? (() => {
            // 与 fs_edit 行号语义一致：尾部换行不产生额外空行行号
            const lines = content.split("\n");
            if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
            return lines.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n");
          })()
        : content;
    return {
      tool_call_id: "",
      success: true,
      content: spillOrTruncate(ctx.dataDir, ctx.sessionId, out, "txt"),
      artifacts: [
        buildFileArtifact(filePath, st.size, ctx.workingDir, ctx.dataDir, {
          truncated: content.length > SPILL_THRESHOLD,
        }),
      ],
    };
  }
  // 二进制/未知扩展名：只读头 512 字节嗅探；仍像文本则按文本读（供 LLM 用），否则返回元信息
  try {
    const sn = readHead(filePath, 512);
    if (!sniffIsBinary(sn)) {
      const content = readFileSync(filePath, "utf-8");
      return {
        tool_call_id: "",
        success: true,
        content: spillOrTruncate(ctx.dataDir, ctx.sessionId, content, "txt"),
        artifacts: [
          buildFileArtifact(filePath, st.size, ctx.workingDir, ctx.dataDir, {
            truncated: content.length > SPILL_THRESHOLD,
          }),
        ],
      };
    }
  } catch {
    /* 读取失败按元信息处理 */
  }
  return {
    tool_call_id: "",
    success: true,
    content: `[二进制文件: ${filePath} · ${formatSize(st.size)} · 点击预览/下载]`,
    artifacts: [buildFileArtifact(filePath, st.size, ctx.workingDir, ctx.dataDir)],
  };
};

/** 只读文件头 N 字节（用于二进制嗅探，避免整读大文件） */
function readHead(filePath: string, n: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// ===== 文件写入 =====

const writeFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fs_write",
    description: "写入文件内容。自动创建父目录。写文件请首选本工具（变更可精确追踪与审计）。",
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
  const denied = denyOutOfScope("write", args.path as string, ctx);
  if (denied) return denied;
  const filePath = resolve(ctx.workingDir, args.path as string);

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
  const wst = statSync(filePath);
  return {
    tool_call_id: "",
    success: true,
    content: `已写入文件: ${filePath} (${(args.content as string).length} 字符)`,
    artifacts: [buildFileArtifact(filePath, wst.size, ctx.workingDir, ctx.dataDir)],
  };
};

// ===== 文件编辑（局部修改：替换/删除指定片段） =====

const editFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "fs_edit",
    description:
      "修改文件中的局部片段（两种模式，二选一）：" +
      "①行号模式：startLine/endLine 指定 1-based 行区间（含两端），newText 替换该区间（空 = 删除），行号可用 fs_read 加 lineNumbers:true 查看；" +
      "②文本匹配模式：oldText 必须唯一匹配的原文片段替换为 newText（空 = 删除），支持跨行。适合局部微调（改几行/删几行），避免整文件重写；新文件请用 fs_write。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        oldText: { type: "string", description: "文本匹配模式：要替换的原文片段（必须唯一匹配，可跨行）" },
        newText: { type: "string", description: "替换后的内容（空字符串 = 删除；两种模式通用）" },
        startLine: { type: "number", description: "行号模式：起始行（1-based，含）。提供 startLine 或 endLine 即启用行号模式" },
        endLine: { type: "number", description: "行号模式：结束行（1-based，含；缺省 = startLine 只改一行）" },
      },
      required: ["path"],
    },
  },
};

const editFileHandler: ToolHandler = async (args, ctx) => {
  const denied = denyOutOfScope("write", args.path as string, ctx);
  if (denied) return denied;
  const filePath = resolve(ctx.workingDir, args.path as string);

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

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { tool_call_id: "", success: false, content: "", error: `文件不存在: ${filePath}` };
  }

  const newText = String(args.newText ?? "");
  const hasLineMode = args.startLine !== undefined || args.endLine !== undefined;

  // ── 行号模式：替换/删除第 startLine..endLine 行（1-based，含两端） ──
  if (hasLineMode) {
    const lines = content.split("\n");
    // 尾部换行不产生额外空行（行号与 fs_read lineNumbers 一致）
    const hadTrailing = lines.length > 1 && lines[lines.length - 1] === "";
    if (hadTrailing) lines.pop();
    const total = lines.length;
    const sNum = args.startLine !== undefined ? Math.floor(Number(args.startLine)) : 1;
    const eNum = args.endLine !== undefined ? Math.floor(Number(args.endLine)) : sNum;
    if (!Number.isFinite(sNum) || !Number.isFinite(eNum) || sNum < 1 || eNum < 1) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `startLine/endLine 必须为 ≥1 的整数（实际 startLine=${args.startLine ?? "未提供"}, endLine=${args.endLine ?? "未提供"}）`,
      };
    }
    if (eNum < sNum) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `endLine(${eNum}) 不能小于 startLine(${sNum})`,
      };
    }
    const s = sNum;
    const e = eNum;
    if (e > total) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `行号超出文件范围: ${s > total ? "startLine" : "endLine"} ${e} > 总行数 ${total}（可用 fs_read 加 lineNumbers:true 查看行号）`,
      };
    }
    // newText 为空 = 删除区间行；否则替换为新行（按 \n 拆分）
    const replacementLines = newText === "" ? [] : newText.split("\n");
    const updatedLines = [...lines.slice(0, s - 1), ...replacementLines, ...lines.slice(e)];
    let updated = updatedLines.join("\n");
    if (hadTrailing && updatedLines.length > 0) updated += "\n";
    writeFileSync(filePath, updated, "utf-8");
    return {
      tool_call_id: "",
      success: true,
      content: `已修改文件: ${filePath}（第 ${s}-${e} 行 → ${replacementLines.length} 行）`,
      artifacts: editArtifacts(filePath, ctx, content, updated),
    };
  }

  // ── 文本匹配模式：oldText 唯一匹配替换 ──
  const oldText = String(args.oldText ?? "");
  if (!oldText) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: "缺少编辑目标：请提供 oldText（文本匹配）或 startLine/endLine（行号模式）",
    };
  }

  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `未找到匹配文本（oldText 与文件内容不一致）: ${oldText.slice(0, 80)}`,
    };
  }
  if (occurrences > 1) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `oldText 匹配不唯一（出现 ${occurrences} 次），请提供更大上下文或改用行号模式`,
    };
  }

  // 用 split/join 替换：replace 会把 newText 中的 $&/$`/$'/$$ 按替换模式展开，静默篡改内容
  const updated = content.split(oldText).join(newText);
  writeFileSync(filePath, updated, "utf-8");
  return {
    tool_call_id: "",
    success: true,
    content: `已修改文件: ${filePath}（替换 1 处：${oldText.split("\n").length} 行 → ${newText.split("\n").length} 行）`,
    artifacts: editArtifacts(filePath, ctx, content, updated),
  };
};

/** fs_edit 产物：文件 + 局部行 diff */
function editArtifacts(filePath: string, ctx: ToolContext, oldText: string, newText: string): ToolArtifact[] {
  const st = statSync(filePath);
  const file = buildFileArtifact(filePath, st.size, ctx.workingDir, ctx.dataDir);
  const patch = simpleDiffLines(oldText, newText).slice(0, 60).join("\n");
  return [file, { type: "diff", path: filePath, patch }];
}

/** 取 URL 主机名（非法返回空串） */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 从 HTML 提取 <title>（不区分大小写；去标签；失败返回空串） */
function extractPageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

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
  const rawPath = (args.path as string) ?? ".";
  const denied = denyOutOfScope("read", rawPath, ctx);
  if (denied) return denied;
  const dirPath = resolve(ctx.workingDir, rawPath);
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
    description:
      "执行终端命令（编译、运行测试、包管理、Git、查看输出等）。" +
      "Windows 下命令在 cmd 中执行：PowerShell 语法需用 powershell -Command 包裹（如 Select-Object 不能直接在 cmd 用）。" +
      "写入/修改文件请使用 fs_write 工具（支持精确差异记录与审计）；" +
      "不要用 shell 重定向（>、echo、type、copy、move 等）写文件，否则变更无法被精确追踪。",
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

  // 沙箱强制层（先于权限层，任何模式都拦截）：cwd 越界 fail-closed + 配置化黑名单
  const sandbox = loadSandboxPolicy(resolveSandboxConfigPath(ctx.workingDir));
  const sandboxCheck = checkCommand(command, cwd, ctx.workingDir, sandbox);
  if (!sandboxCheck.allowed) {
    return {
      tool_call_id: "",
      success: false,
      content: "",
      error: `⛔ ${sandboxCheck.reason}\n命令: ${command}`,
    };
  }

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
    env: buildExecEnv(sandbox.stripSecretEnv ? sanitizeEnv(process.env) : process.env),
  };

  // Windows cmd 输出默认 GBK，前缀 chcp 65001 强制 UTF-8 避免中文乱码
  const finalCommand = process.platform === "win32" ? `chcp 65001 >nul & ${command}` : command;

  return new Promise((resolve) => {
    /** 中断时按进程树杀（Windows 上 exec 的 pid 是 cmd.exe，真实命令是孙进程：
     *  exec 的 signal 选项只能杀直接子进程，实测不可靠 → 用 taskkill /T /F 杀树） */
    const killTree = (pid: number): void => {
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        } catch {
          /* 杀树失败不阻塞返回 */
        }
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 进程可能已退出 */
        }
      }
    };

    let settled = false;
    let onAbort: (() => void) | null = null;
    const finish = (body: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      resolve(body);
    };

    const child = exec(finalCommand, options, (error, stdout, stderr) => {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      if (interrupted) {
        finish({
          tool_call_id: "",
          success: false,
          content: out,
          error: `命令已被中断（进程树已终止）: ${command}`,
        });
        return;
      }
      if (error) {
        // 命令 2>&1 时 stderr 已合并进 stdout：真实失败原因在 out 里，
        // 若只回 error.message（笼统的 "Command failed: ..."）会丢失根因。
        // 失败时回传 stdout 尾部作为错误详情，供模型/用户定位（如 'node' is not recognized）。
        const detail = (err || out || error.message).trim().slice(-1500);
        finish({
          tool_call_id: "",
          success: false,
          content: out,
          error: detail || error.message,
        });
      } else {
        finish({
          tool_call_id: "",
          success: true,
          // 超长输出落盘，避免撑爆上下文
          content: spillOrTruncate(ctx.dataDir, ctx.sessionId, out, "log"),
        });
      }
    });

    let interrupted = false;
    if (ctx.signal) {
      onAbort = () => {
        interrupted = true;
        if (child.pid) killTree(child.pid);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
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

    return {
      tool_call_id: "",
      success: true,
      content: output,
      artifacts: results.map((r) => ({
        type: "link",
        url: r.url,
        title: r.title,
        site: hostnameOf(r.url),
        snippet: r.snippet,
      })),
    };
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
    if (!response.ok) {
      return {
        tool_call_id: "",
        success: false,
        content: "",
        error: `抓取失败: HTTP ${response.status} ${response.statusText}`,
      };
    }
    const text = await response.text();
    const title = extractPageTitle(text);
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
      artifacts: [{ type: "link", url, title: title || undefined, site: hostnameOf(url), snippet: cleaned.slice(0, 120) }],
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
      "向用户提出澄清问题。当任务信息不足、存在多种合理解释或需要用户决策时使用。options 提供候选选项（可选），用户可选项或输入自由文本；multiple=true 时用户可多选（建议选项 ≤6 个）。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问的问题" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "候选选项（可选），用户可直接选择或输入自由文本",
        },
        multiple: {
          type: "boolean",
          description: "是否允许多选（默认 false）",
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
  const multiple = args.multiple === true;
  if (!question.trim()) {
    return { tool_call_id: "", success: false, content: "", error: "问题不能为空" };
  }
  const answer = await requestAsk(question, options, multiple);
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
      // 与 terminal_exec 同一套沙箱：黑名单 + 写入目标可写根约束（相对路径按会话工作目录解析）
      const sandboxPolicy = loadSandboxPolicy(resolveSandboxConfigPath(ctx.workingDir));
      const denyCheck = checkCommand(command, ctx.workingDir, ctx.workingDir, sandboxPolicy);
      if (!denyCheck.allowed) {
        return {
          tool_call_id: "",
          success: false,
          content: "",
          error: `⛔ ${denyCheck.reason}\n命令: ${command}`,
        };
      }
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
  toolRegistry.register("fs_edit", editFileDef, editFileHandler);
  toolRegistry.register("fs_list", listDirDef, listDirHandler);
  toolRegistry.register("terminal_exec", execCmdDef, execCmdHandler);
  toolRegistry.register("web_search", webSearchDef, webSearchHandler);
  toolRegistry.register("web_fetch", webFetchDef, webFetchHandler);
  toolRegistry.register("ask_user", askUserDef, askUserHandler);
  toolRegistry.register("terminal_session", terminalSessionDef, terminalSessionHandler);
}
