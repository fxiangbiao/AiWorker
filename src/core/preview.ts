/**
 * preview.ts — 工具产物预览辅助（纯函数，无副作用）
 *
 * 供文件/网络工具 handler 构建 `ToolArtifact` 元数据，以及文件端口按 mime/kind 分派渲染。
 * 编码策略：扩展名白名单 + 头字节嗅探，不引入重量级 MIME 依赖。
 */

import { resolve, relative, isAbsolute, basename } from "node:path";
import type { ArtifactKind, ToolArtifact } from "../types.js";

/** 常见扩展名 → MIME（未知回退 octet-stream） */
const MIME_BY_EXT: Record<string, string> = {
  // 文本 / 代码
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  csv: "text/csv",
  ts: "text/typescript",
  tsx: "text/tsx",
  js: "text/javascript",
  jsx: "text/jsx",
  mjs: "text/javascript",
  cjs: "text/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  css: "text/css",
  scss: "text/x-scss",
  html: "text/html",
  htm: "text/html",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  bat: "text/x-bat",
  ps1: "text/x-powershell",
  sql: "text/x-sql",
  vue: "text/x-vue",
  svelte: "text/x-svelte",
  log: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  // 图片
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // 视频 / 音频
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  // 文档 / Office
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  // 压缩 / 其它
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
};

/** 取扩展名（小写，无点） */
function extOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 按扩展名判 MIME（未知回退 octet-stream） */
export function mimeFromPath(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}

/** 按 MIME/扩展名归类产物类型（供渲染器分派） */
export function kindFromMime(mime: string): ArtifactKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/x-7z-compressed"
  ) {
    return "binary";
  }
  if (
    mime.includes("wordprocessingml") ||
    mime.includes("spreadsheetml") ||
    mime.includes("presentationml") ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint" ||
    mime.includes("oasis.opendocument")
  ) {
    return "office";
  }
  if (mime.startsWith("text/") || /json|yaml|javascript|typescript|xml|shell|x-python|x-php|x-sh|x-vue|x-svelte|x-c/.test(mime)) {
    return "text";
  }
  return "binary";
}

/** 判断该路径是否为可读文本（供 fs_read 选择读法） */
export function isTextPath(path: string): boolean {
  return kindFromMime(mimeFromPath(path)) === "text";
}

/** 计算文件产物在 [会话资产|项目文档] 下的 root/rel（供 /docs/content 直接使用） */
export function fileRootRel(filePath: string, workingDir: string, dataDir?: string): { root: "session" | "project"; rel: string } {
  if (dataDir) {
    const docsDir = resolve(dataDir, "docs");
    const relDoc = relative(docsDir, filePath);
    if (!relDoc.startsWith("..") && !isAbsolute(relDoc)) return { root: "session", rel: relDoc.replace(/\\/g, "/") };
  }
  const relProject = relative(resolve(workingDir), filePath);
  if (!relProject.startsWith("..") && !isAbsolute(relProject)) return { root: "project", rel: relProject.replace(/\\/g, "/") };
  return { root: "project", rel: filePath.replace(/\\/g, "/") };
}

/** 构建文件 artifact（mime/kind/root/rel/size） */
export function buildFileArtifact(
  filePath: string,
  size: number,
  workingDir: string,
  dataDir?: string,
  opts?: { truncated?: boolean },
): ToolArtifact {
  const mime = mimeFromPath(filePath);
  const { root, rel } = fileRootRel(filePath, workingDir, dataDir);
  return {
    type: "file",
    path: filePath,
    mime,
    size,
    kind: kindFromMime(mime),
    root,
    rel,
    ...(opts?.truncated ? { truncated: true } : {}),
  };
}

/**
 * 二进制嗅探：读取头字节，出现 NUL 或高比例非文本控制字符即判为二进。
 * 供 fs_read 对未知扩展名文件在整读 utf-8 前预判（避免把二进制毁成乱码）。
 */
export function sniffIsBinary(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  let nuls = 0;
  let ctrl = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) nuls++;
    // 可打印 ASCII 或常见 UTF-8 多字节首字节之外的"异常"控制符
    if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
  }
  return nuls > 0 || ctrl > buf.length * 0.05;
}

/**
 * 极简行级 diff（针对 fs_edit 局部编辑）：公共前后缀裁剪后，输出改动中段
 * 以 `-旧` / `+新` 行的形式返回。局部修改场景足够，不引入 diff 依赖。
 */
export function simpleDiffLines(oldText: string, newText: string): string[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);
  const out: string[] = [];
  for (const l of aMid) out.push(`-${l}`);
  for (const l of bMid) out.push(`+${l}`);
  if (out.length === 0) out.push(`~无内容变化`);
  return out;
}

/** 文件大小可读缩写（B/KB/MB） */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
