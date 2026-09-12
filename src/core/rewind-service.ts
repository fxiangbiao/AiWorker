/**
 * 回滚服务（Sprint 48）— 代码 + 对话按回合回滚，预览（dry-run）与执行共用同一套判定
 * 语义：/rewind <n> = 回到第 n 轮开始之前（撤销第 n 轮及之后的改动）
 * 对话回滚走事件日志追加标记（rewind/applied），不改写历史事件
 */

import { existsSync, readFileSync } from "node:fs";
import type { CheckpointManifest, RewindFileAction, RewindPlan, RewindResult, RewindScope } from "../types.js";
import { hashContent } from "./checkpoint-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { SessionStore } from "../memory/session-store.js";

export interface RewindServiceDeps {
  sessionStore: SessionStore;
  checkpointStore: CheckpointStore;
}

export class RewindService {
  private sessionStore: SessionStore;
  private checkpointStore: CheckpointStore;

  constructor(deps: RewindServiceDeps) {
    this.sessionStore = deps.sessionStore;
    this.checkpointStore = deps.checkpointStore;
  }

  /** 列出会话检查点（升序） */
  list(sessionId: string): CheckpointManifest[] {
    return this.checkpointStore.listTurns(sessionId);
  }

  /** 预览：将改动的文件、将删除的消息数、阻塞原因（不触碰任何文件/数据） */
  preview(sessionId: string, toTurn: number, scope: RewindScope): RewindPlan {
    const turns = this.checkpointStore
      .listTurns(sessionId)
      .filter((m) => m.turn >= toTurn)
      .map((m) => m.turn)
      .sort((a, b) => b - a);

    const blockers: string[] = [];
    if (turns.length === 0) {
      blockers.push(`没有第 ${toTurn} 轮及之后的检查点（/rewind 查看可用回合；检查点保留最近 20 轮）`);
    }

    const files = new Map<string, RewindFileAction>();
    if (scope !== "chat") {
      for (const turn of turns) {
        const manifest = this.checkpointStore.getManifest(sessionId, turn);
        if (!manifest) continue;
        for (const entry of manifest.files) {
          // 降序遍历：同路径以最早回合的"回合前"状态为准（最终生效结果）
          if (!entry.restorable) {
            files.set(entry.path, { path: entry.path, action: "skip", reason: entry.reason ?? "不可恢复" });
            continue;
          }
          const conflicted = this.isConflicted(entry);
          files.set(entry.path, {
            path: entry.path,
            action: conflicted ? "conflict" : entry.existedBefore ? "restore" : "delete",
            reason: conflicted ? "内容已被外部改动，需 --force" : undefined,
          });
        }
      }
    }

    let messageCount = 0;
    if (scope !== "code") {
      const base = this.checkpointStore.getManifest(sessionId, toTurn);
      if (base?.messageSeqBefore === undefined) {
        blockers.push(`第 ${toTurn} 轮缺少对话回滚阈值（该轮无检查点元数据），无法回滚对话`);
      } else {
        messageCount = this.sessionStore.countMessagesSince(sessionId, base.messageSeqBefore);
      }
    }

    return { sessionId, toTurn, scope, turns, files: [...files.values()], messageCount, blockers };
  }

  /** 执行回滚（force=true 覆盖外部改动） */
  apply(sessionId: string, toTurn: number, scope: RewindScope, options: { force?: boolean } = {}): RewindResult {
    const plan = this.preview(sessionId, toTurn, scope);
    if (plan.blockers.length > 0) {
      return {
        ok: false,
        sessionId,
        toTurn,
        scope,
        turns: plan.turns,
        restored: [],
        deleted: [],
        skipped: [],
        conflicts: [],
        messagesDeleted: 0,
        error: plan.blockers[0],
      };
    }

    const restored = new Set<string>();
    const deleted = new Set<string>();
    const skipped = new Map<string, { path: string; reason: string }>();
    const conflicts = new Set<string>();

    if (scope !== "chat") {
      for (const turn of plan.turns) {
        const result = this.checkpointStore.restore(sessionId, turn, { force: options.force });
        for (const p of result.restored) restored.add(p);
        for (const p of result.deleted) deleted.add(p);
        for (const s of result.skipped) skipped.set(s.path, s);
        for (const p of result.conflicts) conflicts.add(p);
      }
    }

    let messagesDeleted = 0;
    const base = this.checkpointStore.getManifest(sessionId, toTurn);
    if (scope === "code") {
      // 仅代码：仍追加回滚事件（审计），但不删除消息
      this.sessionStore.rewindMessages(sessionId, Number.MAX_SAFE_INTEGER, {
        toTurn,
        scope,
        files: [...restored, ...deleted],
        skipped: [...skipped.keys()],
        conflicts: [...conflicts],
      });
    } else {
      messagesDeleted = this.sessionStore.rewindMessages(sessionId, base?.messageSeqBefore ?? Number.MAX_SAFE_INTEGER, {
        toTurn,
        scope,
        toEventSeq: base?.eventSeqBefore,
        files: [...restored, ...deleted],
        skipped: [...skipped.keys()],
        conflicts: [...conflicts],
      });
    }

    return {
      ok: true,
      sessionId,
      toTurn,
      scope,
      turns: plan.turns,
      restored: [...restored],
      deleted: [...deleted],
      skipped: [...skipped.values()],
      conflicts: [...conflicts],
      messagesDeleted,
    };
  }

  private isConflicted(entry: { path: string; hashAfter?: string }): boolean {
    if (entry.hashAfter === undefined) return false;
    try {
      if (!existsSync(entry.path)) return false;
      return hashContent(readFileSync(entry.path, "utf-8")) !== entry.hashAfter;
    } catch {
      return false;
    }
  }
}
