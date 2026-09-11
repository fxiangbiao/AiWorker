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
