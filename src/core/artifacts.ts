/**
 * 产物工作台聚合（Sprint 50）— 把「工具产物事件 / 工作目录快照 / 文档索引 / 回合检查点」
 * 合并成统一的 ArtifactItem 列表（纯函数，无 IO，便于单测）
 *
 * 去重键：`project:<工作目录相对路径>`（工作目录外为 `abs:<绝对路径>`，link 用 `link:<url>`）
 *   —— 快照里存的是**绝对路径**（`# path: <abs>`），工具产物给的是 `root+rel`，
 *      因此必须先用会话工作目录归一化，否则同一个文件会出现两次
 * 字段权威源：kind/mime/size → tool；added/removed/change → snapshot；restorable/turn/tool → checkpoint
 * 快照标记 deleted 的文件仍然保留（用户需要知道"它一度存在"）
 */

import { isAbsolute, relative, resolve } from "node:path";
import type {
  ArtifactItem,
  ArtifactKind,
  ArtifactSource,
  ArtifactWorkspace,
  CheckpointManifest,
  DiffSession,
  DocEntry,
  SessionEvent,
  ToolArtifact,
} from "../types.js";

export interface ArtifactInputs {
  sessionId: string;
  scope: "session" | "all";
  /** 当前会话工作目录（归一化快照绝对路径） */
  workingDir: string;
  /** scope=all 时各会话的工作目录（缺省回退 workingDir） */
  sessionWorkingDirs?: Record<string, string>;
  events: SessionEvent[];
  diffs: DiffSession[];
  docs: DocEntry[];
  checkpoints: CheckpointManifest[];
  /** 跨会话聚合时被截断的会话数（>0 则标记降级） */
  truncatedSessions?: number;
  /** 结构性降级原因（无会话存储 / 无回滚服务 / 老会话无产物事件） */
  degraded?: string[];
}

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: "text",
  markdown: "text",
  txt: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  ts: "text",
  tsx: "text",
  js: "text",
  mjs: "text",
  py: "text",
  sh: "text",
  html: "text",
  css: "text",
  csv: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  pdf: "pdf",
  docx: "office",
  xlsx: "office",
  pptx: "office",
};

/** 由扩展名推断 kind（快照/文档源没有 mime，只能按扩展名；未知按 other） */
export function kindFromExt(pathLike: string): ArtifactKind {
  const name = pathLike.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return KIND_BY_EXT[ext] ?? "other";
}

/** 绝对/相对路径 → `{key, rel?, abs?}`（工作目录内给 rel，工作目录外保留绝对路径） */
export function normalizePath(p: string, workingDir: string): { key: string; rel?: string; abs: string } {
  const wd = resolve(workingDir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(wd, p);
  const rel = relative(wd, abs);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    const norm = rel.replace(/\\/g, "/");
    return { key: `project:${norm}`, rel: norm, abs };
  }
  return { key: `abs:${abs.replace(/\\/g, "/")}`, abs };
}

function changeOf(added: number, removed: number, deleted?: boolean, modified?: boolean): ArtifactItem["change"] {
  if (deleted) return "deleted";
  if (modified) return "modified";
  if (added > 0 && removed > 0) return "modified";
  if (added > 0) return "added";
  return undefined;
}

export function buildArtifactWorkspace(inputs: ArtifactInputs): ArtifactWorkspace {
  const states = new Map<string, ArtifactItem>();

  const seed = (id: string, init: Omit<ArtifactItem, "sources">): ArtifactItem => {
    const found = states.get(id);
    if (found) return found;
    const item: ArtifactItem = { ...init, sources: [] };
    states.set(id, item);
    return item;
  };
  const addSource = (item: ArtifactItem, source: ArtifactSource): void => {
    if (!item.sources.includes(source)) item.sources.push(source);
  };

  // ── 1. 工具产物事件（kind/mime/size 权威） ──
  let turn = 0;
  let toolName = "";
  for (const ev of inputs.events) {
    if (ev.type === "turn/start") {
      const d = ev.data as { turn?: number };
      if (typeof d.turn === "number") turn = d.turn;
      continue;
    }
    if (ev.type === "tool/call") {
      const d = ev.data as { name?: string };
      if (typeof d.name === "string") toolName = d.name;
      continue;
    }
    if (ev.type !== "tool/result") continue;
    const artifacts = (ev.data as { artifacts?: ToolArtifact[] }).artifacts;
    if (!Array.isArray(artifacts) || artifacts.length === 0) continue;

    for (const art of artifacts) {
      if (art.type === "link") {
        const item = seed(`link:${art.url}`, {
          id: `link:${art.url}`,
          type: "link",
          kind: "other",
          url: art.url,
          title: art.title,
          site: art.site,
          snippet: art.snippet,
          turn,
          tool: toolName,
          at: ev.createdAt,
        });
        addSource(item, "tool");
        continue;
      }
      if (art.type === "diff") {
        const norm = normalizePath(art.path, inputs.workingDir);
        const item = seed(norm.key, {
          id: norm.key,
          type: "file",
          kind: kindFromExt(art.path),
          root: "project",
          rel: norm.rel,
          path: norm.abs,
          hasDiff: true,
          turn,
          tool: toolName,
          at: ev.createdAt,
        });
        addSource(item, "tool");
        if (art.patch) item.hasDiff = true;
        continue;
      }
      const norm =
        art.rel !== undefined
          ? { key: `${art.root ?? "project"}:${art.rel.replace(/\\/g, "/")}`, rel: art.rel.replace(/\\/g, "/"), abs: art.path }
          : normalizePath(art.path, inputs.workingDir);
      const item = seed(norm.key, {
        id: norm.key,
        type: "file",
        kind: art.kind,
        root: art.root ?? "project",
        rel: norm.rel,
        path: art.path,
        mime: art.mime,
        size: art.size,
        turn,
        tool: toolName,
        at: ev.createdAt,
      });
      addSource(item, "tool");
      item.kind = art.kind;
      item.mime = art.mime;
      item.size = art.size;
      if (turn) item.turn = turn;
      if (toolName) item.tool = toolName;
    }
  }

  // ── 2. 快照 diff（added/removed/change 权威） ──
  for (const session of inputs.diffs) {
    if (inputs.scope === "session" && session.sessionId !== inputs.sessionId) continue;
    const wd = inputs.sessionWorkingDirs?.[session.sessionId] ?? inputs.workingDir;
    for (const file of session.files) {
      const norm = normalizePath(file.path, wd);
      const change = changeOf(file.added, file.removed, file.deleted, file.modified);
      const item = seed(norm.key, {
        id: norm.key,
        type: "file",
        kind: kindFromExt(file.path),
        root: "project",
        rel: norm.rel,
        path: norm.abs,
        at: session.updatedAt,
      });
      addSource(item, "snapshot");
      item.added = file.added;
      item.removed = file.removed;
      item.change = change;
      item.hasDiff = file.lines.length > 0;
      if (file.deleted) item.degraded = "文件已删除，无内容可预览";
      if (file.binary) item.degraded = "二进制文件，仅元信息";
    }
  }

  // ── 3. 文档索引 ──
  for (const doc of inputs.docs) {
    const rel = doc.path.replace(/\\/g, "/");
    const id = `${doc.root}:${rel}`;
    const item = seed(id, {
      id,
      type: "file",
      kind: "text",
      root: doc.root,
      rel,
      title: doc.title,
      size: doc.size,
      at: doc.mtime,
    });
    addSource(item, "docs");
  }

  // ── 4. 回合检查点（restorable/turn/tool 权威） ──
  for (const manifest of inputs.checkpoints) {
    for (const file of manifest.files) {
      const norm = normalizePath(file.path, inputs.workingDir);
      const item = seed(norm.key, {
        id: norm.key,
        type: "file",
        kind: kindFromExt(file.path),
        root: "project",
        rel: norm.rel,
        path: norm.abs,
        at: manifest.createdAt,
      });
      addSource(item, "checkpoint");
      item.turn = manifest.turn;
      item.tool = file.tool;
      item.restorable = file.restorable;
      if (typeof file.added === "number") item.added = file.added;
      if (typeof file.removed === "number") item.removed = file.removed;
      if (item.change === undefined) item.change = changeOf(file.added ?? 0, file.removed ?? 0, false, true);
    }
  }

  const items = [...states.values()];
  items.sort((a, b) => b.at - a.at);

  const byKind: Record<string, number> = {};
  const byChange = { added: 0, modified: 0, deleted: 0 };
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    if (item.change) byChange[item.change] += 1;
  }

  const degraded = [...(inputs.degraded ?? [])];
  if (inputs.scope === "all" && (inputs.truncatedSessions ?? 0) > 0) degraded.push("tool-artifacts-truncated");

  return {
    sessionId: inputs.sessionId,
    scope: inputs.scope,
    items,
    timeline: [...inputs.checkpoints].sort((a, b) => a.turn - b.turn),
    counts: { total: items.length, byKind, byChange },
    degraded,
  };
}
