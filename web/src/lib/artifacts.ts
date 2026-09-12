/**
 * 工具产物类型（Web 侧同构副本）— 与后端 `src/types.ts` 的 ToolArtifact/ArtifactKind 结构一致。
 * 经 WS `tool_result` JSON 传递，两端无需共享模块。
 */
export type ArtifactKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "office"
  | "binary"
  | "other";

export type ToolArtifact =
  | { type: "file"; path: string; mime: string; size: number; kind: ArtifactKind; root?: "session" | "project"; rel?: string; truncated?: boolean }
  | { type: "link"; url: string; title?: string; site?: string; snippet?: string }
  | { type: "diff"; path: string; patch?: string };

/** 文件类型图标（按产物 kind） */
export function artifactIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "text":
      return "📄";
    case "image":
      return "🖼️";
    case "video":
      return "🎬";
    case "audio":
      return "🎧";
    case "pdf":
      return "📕";
    case "office":
      return "📊";
    case "binary":
      return "📦";
    default:
      return "📄";
  }
}

/** 文件大小可读缩写 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** basename（兼容 Win/Unix 分隔符） */
export function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

// ===== 产物工作台（Sprint 50：与后端 /api/v1/artifacts 的载荷同构） =====

export type ArtifactSource = "tool" | "snapshot" | "docs" | "checkpoint";

export interface ArtifactItem {
  id: string;
  sources: ArtifactSource[];
  type: "file" | "link" | "diff";
  kind: ArtifactKind;
  root?: "session" | "project";
  rel?: string;
  path?: string;
  url?: string;
  title?: string;
  site?: string;
  snippet?: string;
  mime?: string;
  size?: number;
  turn?: number;
  tool?: string;
  change?: "added" | "modified" | "deleted";
  added?: number;
  removed?: number;
  restorable?: boolean;
  hasDiff?: boolean;
  at: number;
  degraded?: string;
}

export interface TimelineTurn {
  sessionId: string;
  turn: number;
  createdAt: number;
  userInput?: string;
  files: Array<{ path: string; restorable: boolean; tool: string; added?: number; removed?: number; reason?: string }>;
}

export interface ArtifactWorkspace {
  sessionId: string;
  scope: "session" | "all";
  items: ArtifactItem[];
  timeline: TimelineTurn[];
  counts: { total: number; byKind: Record<string, number>; byChange: { added: number; modified: number; deleted: number } };
  degraded: string[];
}

export interface DiffLineView {
  type: "add" | "del" | "ctx";
  text: string;
}

export interface DiffFileView {
  path: string;
  added: number;
  removed: number;
  lines: DiffLineView[];
  currentContent?: string;
  binary?: boolean;
  modified?: boolean;
  deleted?: boolean;
}

/** 产物类别标签（过滤 chips 用） */
export type ArtifactCategory = "doc" | "code" | "image" | "media" | "link" | "other";

export const CATEGORY_LABEL: Record<ArtifactCategory, string> = {
  doc: "文档",
  code: "代码",
  image: "图片",
  media: "媒体",
  link: "链接",
  other: "其他",
};

export function isMarkdown(item: ArtifactItem): boolean {
  const rel = item.rel ?? item.path ?? "";
  return (item.mime ?? "").includes("markdown") || rel.toLowerCase().endsWith(".md");
}

export function categoryOf(item: ArtifactItem): ArtifactCategory {
  if (item.type === "link") return "link";
  if (item.kind === "image") return "image";
  if (item.kind === "video" || item.kind === "audio" || item.kind === "pdf" || item.kind === "office") return "media";
  if (item.kind === "text") return isMarkdown(item) ? "doc" : "code";
  return "other";
}

export function sourceLabel(source: ArtifactSource): string {
  switch (source) {
    case "tool":
      return "工具产物";
    case "snapshot":
      return "文件系统快照";
    case "docs":
      return "文档索引";
    default:
      return "回合检查点";
  }
}

export type GroupMode = "kind" | "dir" | "turn";

export function groupOf(item: ArtifactItem, mode: GroupMode): string {
  if (mode === "kind") return CATEGORY_LABEL[categoryOf(item)];
  if (mode === "turn") return item.turn ? `回合 ${item.turn}` : "未记录回合";
  const rel = item.rel ?? item.path ?? item.url ?? "";
  const norm = rel.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx > 0 ? norm.slice(0, idx) : "（根目录）";
}

/** 分组（保持传入顺序；组内顺序即 items 顺序） */
export function groupArtifacts(items: ArtifactItem[], mode: GroupMode): Array<{ key: string; items: ArtifactItem[] }> {
  const map = new Map<string, ArtifactItem[]>();
  for (const item of items) {
    const key = groupOf(item, mode);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].map(([key, list]) => ({ key, items: list }));
}

/** 路径匹配键（跨平台大小写/分隔符归一，用于把产物映射到 /diffs 的行级 diff） */
export function pathKey(p: string | undefined): string {
  return (p ?? "").replace(/\\/g, "/").toLowerCase();
}

/** 产物 → 打开预览所需的最小 artifact 形状（复用 FilePreview） */
export function toPreviewArtifact(item: ArtifactItem): ToolArtifact | null {
  if (item.type === "link") return { type: "link", url: item.url ?? "", title: item.title, site: item.site, snippet: item.snippet };
  if (!item.path) return null;
  return {
    type: "file",
    path: item.path,
    mime: item.mime ?? "",
    size: item.size ?? 0,
    kind: item.kind,
    root: item.root,
    rel: item.rel,
  };
}

/**
 * 文档键 `<root>:<rel>`（DocRenderer 的入参格式）。
 * 唯一实现：漏掉 `project:` 前缀会被 DocRenderer 当成会话文档去 data/docs 里找 → 404 且界面停在"加载文档…"。
 */
export function toDocKey(root: string | undefined, rel: string | undefined | null): string {
  if (!rel) return "";
  return `${root ?? "session"}:${rel}`;
}

