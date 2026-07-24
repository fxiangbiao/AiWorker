/**
 * 会话存储 — SQLite + WAL + FTS5
 * 设计依据：HermesAgent 实证——零额外依赖，FTS5 跨会话检索
 */

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, SessionRecord, EpisodicEntry } from "../types.js";

export class SessionStore {
  private db: DBType;

  constructor(dbPath: string) {
    this.db = new Database(resolve(dbPath));
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      -- 会话表
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary TEXT
      );

      -- 消息表 (工作记忆持久化)
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

      -- FTS5 全文索引 (跨会话情景记忆检索)
      CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memory USING fts5(
        session_id,
        content,
        summary,
        timestamp,
        weight,
        tokenize = 'unicode61'
      );
    `);
  }

  /** 创建新会话 */
  createSession(agentId: string): SessionRecord {
    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run(id, agentId, now, now);
    return { id, agentId, createdAt: now, updatedAt: now };
  }

  /** 追加消息 */
  appendMessage(sessionId: string, message: Message): void {
    const seqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM messages WHERE session_id = ?`
    );
    const { next_seq } = seqStmt.get(sessionId) as { next_seq: number };

    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      sessionId,
      message.role,
      message.content,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id ?? null,
      next_seq,
      Date.now()
    );

    // 更新会话时间戳
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
  }

  /** 获取会话消息历史 */
  getMessages(sessionId: string): Message[] {
    const stmt = this.db.prepare(
      `SELECT role, content, tool_calls, tool_call_id FROM messages
       WHERE session_id = ? ORDER BY seq ASC`
    );
    const rows = stmt.all(sessionId) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
    }>;

    return rows.map((row) => {
      const msg: Message = {
        role: row.role as Message["role"],
        content: row.content,
      };
      if (row.tool_calls) {
        msg.tool_calls = JSON.parse(row.tool_calls);
      }
      if (row.tool_call_id) {
        msg.tool_call_id = row.tool_call_id;
      }
      return msg;
    });
  }

  /** 保存会话摘要 */
  setSummary(sessionId: string, summary: string): void {
    this.db.prepare(`UPDATE sessions SET summary = ? WHERE id = ?`).run(summary, sessionId);
  }

  /** FTS5 跨会话检索（含 LIKE 兜底） */
  searchEpisodic(query: string, limit = 5): EpisodicEntry[] {
    // 先尝试 FTS5 MATCH
    let rows: Array<{
      session_id: string;
      content: string;
      summary: string;
      timestamp: string;
      weight: string;
    }> = [];

    try {
      const ftsStmt = this.db.prepare(
        `SELECT session_id, content, summary, timestamp, weight
         FROM episodic_memory
         WHERE episodic_memory MATCH ?
         ORDER BY rank, weight DESC
         LIMIT ?`
      );
      rows = ftsStmt.all(query, limit) as typeof rows;
    } catch {
      // FTS5 查询语法错误时降级
    }

    // FTS5 无结果时用 LIKE 兜底（中文 tokenizer 兼容）
    if (rows.length === 0) {
      const likeStmt = this.db.prepare(
        `SELECT session_id, content, summary, timestamp, weight
         FROM episodic_memory
         WHERE content LIKE ? OR summary LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      );
      rows = likeStmt.all(`%${query}%`, `%${query}%`, limit) as typeof rows;
    }

    return rows.map((row) => ({
      id: "",
      sessionId: row.session_id,
      timestamp: parseInt(row.timestamp),
      content: row.content,
      summary: row.summary,
      weight: parseFloat(row.weight),
    }));
  }

  /** 写入情景记忆 */
  saveEpisodic(sessionId: string, content: string, summary: string, weight = 1.0): void {
    const stmt = this.db.prepare(
      `INSERT INTO episodic_memory (session_id, content, summary, timestamp, weight)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(sessionId, content, summary, Date.now().toString(), weight.toString());
  }

  close(): void {
    this.db.close();
  }
}
