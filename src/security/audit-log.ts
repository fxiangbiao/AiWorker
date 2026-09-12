/**
 * 审计日志
 * 设计依据：调研报告 6.2 节——全操作日志 + 文件变更快照 + 会话回放
 */

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface AuditEntry {
  id?: number;
  timestamp: number;
  agentId: string;
  sessionId: string;
  action: string;
  target?: string;
  result: "success" | "blocked" | "error";
  detail?: string;
}

/** SQLite 行 → AuditEntry：列名是 snake_case，直接用会把 agentId/sessionId 读成 undefined（审计面板会话列恒空） */
function toEntry(row: unknown): AuditEntry {
  const r = row as Record<string, unknown>;
  return {
    id: typeof r.id === "number" ? r.id : undefined,
    timestamp: Number(r.timestamp ?? 0),
    agentId: String(r.agent_id ?? ""),
    sessionId: String(r.session_id ?? ""),
    action: String(r.action ?? ""),
    target: r.target === null || r.target === undefined ? undefined : String(r.target),
    result: (r.result as AuditEntry["result"]) ?? "success",
    detail: r.detail === null || r.detail === undefined ? undefined : String(r.detail),
  };
}

export class AuditLog {
  private db: DBType;

  constructor(dbPath: string) {
    // better-sqlite3 不创建父目录：数据目录缺失时（首次运行 / 全新检出）会直接抛错
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new Database(abs);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);
  }

  log(entry: Omit<AuditEntry, "id">): void {
    const stmt = this.db.prepare(
      `INSERT INTO audit_log (timestamp, agent_id, session_id, action, target, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      entry.timestamp,
      entry.agentId,
      entry.sessionId,
      entry.action,
      entry.target ?? null,
      entry.result,
      entry.detail ?? null,
    );
  }

  queryBySession(sessionId: string): AuditEntry[] {
    const stmt = this.db.prepare(`SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp ASC`);
    return stmt.all(sessionId).map(toEntry);
  }

  /** 最近 N 条（可选 action 前缀过滤，如 "evolution:"；timestamp 降序 + id 断链，严格最新在前） */
  queryRecent(limit = 100, actionPrefix?: string): AuditEntry[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 100, 1000));
    if (actionPrefix) {
      const stmt = this.db.prepare(
        `SELECT * FROM audit_log WHERE action LIKE ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
      );
      return stmt.all(`${actionPrefix}%`, safeLimit).map(toEntry);
    }
    const stmt = this.db.prepare(`SELECT * FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT ?`);
    return stmt.all(safeLimit).map(toEntry);
  }

  /** 按 action 精确匹配计数（进化观察的生成统计用） */
  countByAction(action: string): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = ?`);
    return (stmt.get(action) as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
