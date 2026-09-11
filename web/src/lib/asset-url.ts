/**
 * 文档内资源 URL 解析（纯函数，无 DOM 依赖）——把 Markdown 中的本地图片路径映射到 `/api/v1/files`，
 * 同时**完整保留**外部链接与站点根相对引用。
 *
 * 背景：`marked` 渲染出的 `<img src="assets/x.svg">` 会被浏览器按 Web 页面 URL 解析（而非按文档所在目录），
 * 导致本地文档中的相对图片 404。这里把"明确的本地引用"改写为 `/files`（realpath + 根白名单 + Range），
 * 其余一律原样保留。
 *
 * 判定优先级（顺序即语义）：
 * 1. 空值                                    → 原样
 * 2. 已是 `/api/v1/files` 的引用              → 原样（避免二次改写）
 * 3. Windows 盘符绝对路径 `C:\` `C:/`         → 本地引用（先于 scheme 判断，否则 "C:" 会被当成协议）
 * 4. `file://` URI                           → 本地引用（解码后去盘符前斜杠）
 * 5. UNC 路径 `\\server\share\x.png`          → 本地引用
 * 6. 远程/内联/锚点（`http(s):`、`data:`、`blob:`、`//cdn`、`#`、`mailto:` 等）→ 原样
 * 7. 站点根相对 `/logo.png`                   → 原样（无法与 POSIX 绝对路径区分，优先不破坏既有站点资源）
 * 8. 其余相对路径（`assets/x.svg`、`./a.png`、`../b.png`）→ 相对文档所在目录解析
 *
 * 已知边界：仅处理 `<img src="…">`（双引号、标签内首个 src）；`srcset`、`<source>`、
 * 单引号属性（marked 当前不产出）不改写——保持原样，不会因此损坏已有外链。
 */

export interface DocAssetContext {
  /** 文档所属根：session（data/docs）| project（会话工作目录） */
  root: string;
  /** 文档在根内的相对路径（posix 或反斜杠均可） */
  docRel: string;
  /** 会话 id：/files 据此解析会话工作目录 */
  sessionId?: string | null;
  /** API 前缀，默认 /api/v1 */
  apiBase?: string;
}

/** Windows 盘符绝对路径（需先于 scheme 判断） */
const WIN_ABS = /^[a-zA-Z]:[\\/]/;

/** UNC 路径 `\\server\share\...` */
const UNC_ABS = /^\\\\/;

/** 远程 / 内联 / 锚点等无需改写的引用 */
const REMOTE_OR_INLINE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** 去掉路径上的 query（本地文件引用不应带它），但保留 `#fragment`（SVG 片段标识等） */
function stripQuery(p: string): string {
  const i = p.search(/[?#]/);
  return i === -1 ? p : p.slice(0, i);
}

/** 拆出 `#fragment`（本地 SVG 片段选择器等需保留） */
function splitHash(p: string): { path: string; hash: string } {
  const i = p.indexOf("#");
  return i === -1 ? { path: p, hash: "" } : { path: p.slice(0, i), hash: p.slice(i) };
}

/** 目录部分（posix 语义） */
function dirOf(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i === -1 ? "" : norm.slice(0, i);
}

/** 归一化 `base/rel`，消除 `.`、`..` 与重复分隔符；越界 `..` 保留（交服务端根校验拒绝，避免静默指向根内其它文件） */
export function normalizeRelPath(base: string, rel: string): string {
  const parts = `${base}/${rel}`.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length > 0) out.pop();
      else out.push("..");
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

/** `file://` URI → 本地路径（Windows 下去掉盘符前的斜杠） */
export function fileUriToPath(uri: string): string {
  const raw = uri.slice("file://".length);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* 非法百分号编码：按原样处理 */
  }
  if (/^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1);
  return decoded;
}

/** 是否"明确的本地引用"（需要改写为 /files） */
export function isLocalAssetRef(src: string): boolean {
  const raw = (src ?? "").trim();
  if (!raw) return false;
  if (WIN_ABS.test(raw) || UNC_ABS.test(raw)) return true;
  if (raw.toLowerCase().startsWith("file://")) return true;
  if (REMOTE_OR_INLINE.test(raw)) return false;
  return !raw.startsWith("/"); // 相对路径；站点根相对（/x）保持原样
}

/**
 * 解析单个文档内资源引用：本地引用 → `/api/v1/files?root=…&path=…[&session=…]`；其余原样返回。
 */
export function resolveDocAssetSrc(src: string, ctx: DocAssetContext): string {
  const raw = (src ?? "").trim();
  if (!raw) return src;
  const api = ctx.apiBase ?? "/api/v1";
  const filesPath = `${api}/files`;
  if (raw === filesPath || raw.startsWith(`${filesPath}?`)) return src;
  if (!isLocalAssetRef(raw)) return src;

  const { path: noHash, hash } = splitHash(raw);
  let pathParam: string;
  if (noHash.toLowerCase().startsWith("file://")) {
    pathParam = fileUriToPath(stripQuery(noHash));
  } else if (WIN_ABS.test(noHash) || UNC_ABS.test(noHash)) {
    pathParam = stripQuery(noHash).replace(/\\/g, "/");
  } else {
    pathParam = normalizeRelPath(dirOf(ctx.docRel), stripQuery(noHash));
  }
  if (!pathParam) return src;

  const root = ctx.root === "project" ? "project" : "session";
  const sid = ctx.sessionId ? `&session=${encodeURIComponent(ctx.sessionId)}` : "";
  return `${api}/files?root=${root}&path=${encodeURIComponent(pathParam)}${sid}${hash}`;
}

/** HTML 属性值解码（marked + DOMPurify 输出的转义） */
function decodeAttr(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** HTML 属性值编码（用于重新写入 src / data-orig-src） */
function encodeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 重写一段（已净化）HTML 中 `<img>` 的本地 `src`，并记录 `data-orig-src` 供加载失败时回退。
 * 纯字符串处理：不依赖 DOM，便于单测；非 img 标签与无需改写的引用保持字节不变。
 */
export function rewriteDocAssetUrls(cleanHtml: string, ctx: DocAssetContext): string {
  if (!cleanHtml.includes("<img")) return cleanHtml;
  return cleanHtml.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/(\s)src="([^"]*)"/i, (m, lead: string, raw: string) => {
      const original = decodeAttr(raw);
      const fixed = resolveDocAssetSrc(original, ctx);
      if (fixed === original) return m;
      return `${lead}src="${encodeAttr(fixed)}" data-orig-src="${encodeAttr(original)}"`;
    }),
  );
}
