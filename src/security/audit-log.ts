/**
 * 审计日志
 * 设计依据：调研报告 6.2 节——全操作日志 + 文件变更快照 + 会话回放
 */

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { resolve } from "node:path";

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

export class AuditLog {
  private db: DBType;

  constructor(dbPath: string) {
    this.db = new Database(resolve(dbPath));
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
    return stmt.all(sessionId) as AuditEntry[];
  }

  close(): void {
    this.db.close();
  }
}
