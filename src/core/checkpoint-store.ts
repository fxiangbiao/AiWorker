/**
 * 检查点存储（Sprint 48）— 每回合落盘"变更前内容"，支持按回合回滚代码
 * 布局：<data>/checkpoints/<sessionId>/turn-<n>/{manifest.json,files/<hash>-<name>}
 * 诚实边界：仅 fs_write / fs_edit 可精确回滚；terminal_exec 等只记录条目（restorable=false）
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  CheckpointFileEntry,
  CheckpointManifest,
  CheckpointRestoreResult,
} from "../types.js";

export const DEFAULT_KEEP_TURNS = 20;
export const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface CheckpointStoreOptions {
  /** 每会话保留的最近回合数（超出按最旧优先清理） */
  keepTurns?: number;
  /** 单文件入 blob 上限（超出记 too-large，不落盘） */
  maxBlobBytes?: number;
}

export interface CaptureInfo {
  existedBefore: boolean;
  tool: string;
}

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf-8").digest("hex");
}

/** 内容哈希（回滚冲突检测用：与 manifest 的 hashBefore/hashAfter 同一算法） */
export function hashContent(text: string): string {
  return sha1(text);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class CheckpointStore {
  private baseDir: string;
  private keepTurns: number;
  private maxBlobBytes: number;

  constructor(dataDir: string, options: CheckpointStoreOptions = {}) {
    this.baseDir = resolve(dataDir, "checkpoints");
    const envKeep = Number(process.env.AIWORKER_CHECKPOINT_KEEP);
    this.keepTurns =
      options.keepTurns ?? (Number.isInteger(envKeep) && envKeep > 0 ? envKeep : DEFAULT_KEEP_TURNS);
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  turnDir(sessionId: string, turn: number): string {
    return resolve(this.baseDir, safeSegment(sessionId), `turn-${turn}`);
  }

  manifestPath(sessionId: string, turn: number): string {
    return resolve(this.turnDir(sessionId, turn), "manifest.json");
  }

  /** 回合开始：建立/更新 manifest（记录对话回滚阈值与用户输入；同号回合复用取首次值） */
  beginTurn(
    sessionId: string,
    turn: number,
    meta: { userInput?: string; messageSeqBefore?: number; eventSeqBefore?: number } = {},
  ): CheckpointManifest {
    const manifest = this.readManifest(sessionId, turn) ?? {
      sessionId,
      turn,
      createdAt: Date.now(),
      files: [],
    };
    if (manifest.userInput === undefined && meta.userInput !== undefined) manifest.userInput = meta.userInput.slice(0, 500);
    if (manifest.messageSeqBefore === undefined && meta.messageSeqBefore !== undefined) {
      manifest.messageSeqBefore = meta.messageSeqBefore;
    }
    if (manifest.eventSeqBefore === undefined && meta.eventSeqBefore !== undefined) {
      manifest.eventSeqBefore = meta.eventSeqBefore;
    }
    this.writeManifest(manifest);
    this.prune(sessionId);
    return manifest;
  }

  /** 写入变更前内容（同一回合同一路径只记首次，保证"回到回合前"的基准是回合起点）
   *  manifest 必须已由 beginTurn 建立；不存在则拒绝登记（禁隐式建盘）：
   *  prune 后 callback 落到旧 turn 时，隐式建盘会复活已删除的回合（缺 messageSeqBefore → /rewind blocker），
   *  且 `beginTurn` 的 prune 会把一个合法回合多删一个。返回 null 表示拒绝。 */
  capture(sessionId: string, turn: number, absPath: string, oldContent: string | null, info: CaptureInfo): CheckpointFileEntry | null {
    const manifest = this.readManifest(sessionId, turn);
    if (!manifest) return null;
    const existing = manifest.files.find((f) => f.path === absPath);
    if (existing) return existing;

    const entry: CheckpointFileEntry = {
      path: absPath,
      existedBefore: info.existedBefore,
      restorable: true,
      tool: info.tool,
    };

    if (!info.existedBefore) {
      entry.hashBefore = undefined;
    } else if (oldContent === null) {
      entry.restorable = false;
      entry.reason = "unreadable";
    } else if (oldContent.includes("\u0000")) {
      entry.restorable = false;
      entry.reason = "binary";
      entry.hashBefore = sha1(oldContent);
    } else if (Buffer.byteLength(oldContent, "utf-8") > this.maxBlobBytes) {
      entry.restorable = false;
      entry.reason = "too-large";
      entry.hashBefore = sha1(oldContent);
    } else {
      entry.hashBefore = sha1(oldContent);
      entry.blob = this.writeBlob(sessionId, turn, absPath, oldContent);
    }

    manifest.files.push(entry);
    this.writeManifest(manifest);
    return entry;
  }

  /** 写入后补充：变更后哈希（冲突检测）与行数统计 */
  recordAfter(
    sessionId: string,
    turn: number,
    absPath: string,
    newContent: string,
    stats: { added?: number; removed?: number } = {},
  ): void {
    const manifest = this.readManifest(sessionId, turn);
    if (!manifest) return;
    const entry = manifest.files.find((f) => f.path === absPath);
    if (!entry) return;
    entry.hashAfter = sha1(newContent);
    if (stats.added !== undefined) entry.added = stats.added;
    if (stats.removed !== undefined) entry.removed = stats.removed;
    this.writeManifest(manifest);
  }

  /** terminal_exec 等无法取得变更前内容的写入：仅记录，不可回滚
   *  与 capture 同规则：manifest 不存在则拒绝（禁隐式建盘） */
  markUnrestorable(sessionId: string, turn: number, absPath: string, reason: "terminal_exec", tool: string): void {
    const manifest = this.readManifest(sessionId, turn);
    if (!manifest) return;
    if (manifest.files.some((f) => f.path === absPath)) return;
    manifest.files.push({ path: absPath, existedBefore: true, restorable: false, reason, tool });
    this.writeManifest(manifest);
  }

  listTurns(sessionId: string): CheckpointManifest[] {
    const dir = resolve(this.baseDir, safeSegment(sessionId));
    if (!existsSync(dir)) return [];
    const turns: CheckpointManifest[] = [];
    for (const name of readdirSync(dir)) {
      const m = /^turn-(\d+)$/.exec(name);
      if (!m) continue;
      const manifest = this.readManifest(sessionId, Number(m[1]));
      if (manifest) turns.push(manifest);
    }
    return turns.sort((a, b) => a.turn - b.turn);
  }

  getManifest(sessionId: string, turn: number): CheckpointManifest | null {
    return this.readManifest(sessionId, turn);
  }

  /** 最近一个检查点的回合号（无则 null） */
  latestTurn(sessionId: string): number | null {
    const turns = this.listTurns(sessionId);
    return turns.length > 0 ? turns[turns.length - 1]!.turn : null;
  }

  /**
   * 恢复某一回合的代码改动（写回变更前内容；回合前不存在则删除）
   * 冲突：当前内容哈希与记录的 hashAfter 不一致（外部改动/受 terminal_exec 影响）→ 默认跳过，force 时覆盖
   */
  restore(sessionId: string, turn: number, options: { force?: boolean } = {}): CheckpointRestoreResult {
    const manifest = this.readManifest(sessionId, turn);
    const result: CheckpointRestoreResult = { turn, restored: [], deleted: [], skipped: [], conflicts: [] };
    if (!manifest) {
      result.skipped.push({ path: `turn-${turn}`, reason: "检查点不存在" });
      return result;
    }

    for (const entry of manifest.files) {
      if (!entry.restorable) {
        result.skipped.push({ path: entry.path, reason: entry.reason ?? "不可恢复" });
        continue;
      }
      if (entry.existedBefore && !entry.blob) {
        result.skipped.push({ path: entry.path, reason: "无变更前内容" });
        continue;
      }

      const current = this.readIfExists(entry.path);
      if (entry.hashAfter !== undefined && current !== null && sha1(current) !== entry.hashAfter && !options.force) {
        result.conflicts.push(entry.path);
        continue;
      }

      try {
        if (entry.existedBefore) {
          const content = this.readBlob(sessionId, turn, entry.blob!);
          if (content === null) {
            result.skipped.push({ path: entry.path, reason: "blob 缺失" });
            continue;
          }
          mkdirSync(dirname(entry.path), { recursive: true });
          writeFileSync(entry.path, content, "utf-8");
          result.restored.push(entry.path);
        } else {
          if (existsSync(entry.path)) rmSync(entry.path, { force: true });
          result.deleted.push(entry.path);
        }
      } catch (err) {
        result.skipped.push({ path: entry.path, reason: (err as Error).message });
      }
    }
    return result;
  }

  /** 保留策略：每会话仅留最近 keepTurns 个回合目录 */
  prune(sessionId: string): string[] {
    const dir = resolve(this.baseDir, safeSegment(sessionId));
    if (!existsSync(dir)) return [];
    const removed: string[] = [];
    const turns = readdirSync(dir)
      .map((name) => /^turn-(\d+)$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    while (turns.length > this.keepTurns) {
      const oldest = turns.shift()!;
      const target = this.turnDir(sessionId, oldest);
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
    return removed;
  }

  deleteSession(sessionId: string): void {
    const dir = resolve(this.baseDir, safeSegment(sessionId));
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  private readIfExists(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      if (statSync(path).isDirectory()) return null;
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  private readManifest(sessionId: string, turn: number): CheckpointManifest | null {
    const path = this.manifestPath(sessionId, turn);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CheckpointManifest;
      if (!Array.isArray(parsed.files)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeManifest(manifest: CheckpointManifest): void {
    const dir = this.turnDir(manifest.sessionId, manifest.turn);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  private writeBlob(sessionId: string, turn: number, absPath: string, content: string): string {
    const fileName = `${sha1(absPath).slice(0, 12)}-${safeSegment(basename(absPath))}`;
    const rel = `files/${fileName}`;
    const full = resolve(this.turnDir(sessionId, turn), rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
    return rel;
  }

  private readBlob(sessionId: string, turn: number, rel: string): string | null {
    try {
      return readFileSync(resolve(this.turnDir(sessionId, turn), rel), "utf-8");
    } catch {
      return null;
    }
  }
}
