/**
 * 会话存储 — SQLite + WAL + FTS5
 * 设计依据：HermesAgent 实证——零额外依赖，FTS5 跨会话检索
 */

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, SessionRecord, EpisodicEntry, TurnLog, ToolCallLog } from "../types.js";

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter("zh-CN", { granularity: "word" })
  : null;

function segmentChinese(text: string): string {
  if (!segmenter) return "";
  const tokens: string[] = [];
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) tokens.push(s.segment);
  }
  return tokens.join(" ");
}

function getDecayFactor(timestamp: number): number {
  const daysAgo = (Date.now() - timestamp) / 86400000;
  return Math.max(0.1, 1 - daysAgo * 0.15);
}

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

      -- 监控: 轮次日志
      CREATE TABLE IF NOT EXISTS turn_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        user_input TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        iterations INTEGER,
        tool_calls_total INTEGER,
        tool_calls_success INTEGER,
        tool_calls_failed INTEGER,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        finish_reason TEXT,
        error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_logs_sess ON turn_logs(session_id, seq);

      -- 监控: 工具调用日志
      CREATE TABLE IF NOT EXISTS tool_call_logs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        iteration INTEGER,
        args TEXT,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        success INTEGER,
        result_preview TEXT,
        error TEXT,
        FOREIGN KEY (turn_id) REFERENCES turn_logs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_logs_turn ON tool_call_logs(turn_id);
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

  /** FTS5 跨会话检索（三阶段：原始 → 分词 → LIKE + 时间衰减） */
  searchEpisodic(query: string, limit = 5): EpisodicEntry[] {
    let rows = this.tryFts5Match(query, limit);

    if (rows.length === 0) {
      const segmented = segmentChinese(query);
      if (segmented) {
        rows = this.tryFts5Match(segmented, limit);
      }
    }

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

    const entries = rows.map((row) => {
      const ts = parseInt(row.timestamp);
      const decay = getDecayFactor(ts);
      return {
        id: "",
        sessionId: row.session_id,
        timestamp: ts,
        content: row.content,
        summary: row.summary,
        weight: parseFloat(row.weight),
        decayFactor: decay,
      } satisfies EpisodicEntry;
    });

    // 按 effectiveWeight 降序，低于 0.05 过滤
    return entries
      .filter((e) => (e.weight * (e.decayFactor ?? 0)) >= 0.05)
      .sort((a, b) => (b.weight * (b.decayFactor ?? 0)) - (a.weight * (a.decayFactor ?? 0)))
      .slice(0, limit);
  }

  /** 写入情景记忆（追加中文分词 token 增强 FTS5 索引） */
  saveEpisodic(sessionId: string, content: string, summary: string, weight = 1.0): void {
    const segmented = segmentChinese(content);
    const enriched = segmented ? `${content} ${segmented}` : content;

    const stmt = this.db.prepare(
      `INSERT INTO episodic_memory (session_id, content, summary, timestamp, weight)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(sessionId, enriched, summary, Date.now().toString(), weight.toString());
  }

  private tryFts5Match(query: string, limit: number): Array<{
    session_id: string;
    content: string;
    summary: string;
    timestamp: string;
    weight: string;
  }> {
    try {
      const stmt = this.db.prepare(
        `SELECT session_id, content, summary, timestamp, weight
         FROM episodic_memory
         WHERE episodic_memory MATCH ?
         ORDER BY rank
         LIMIT ?`
      );
      return stmt.all(query, limit) as ReturnType<typeof this.tryFts5Match>;
    } catch {
      return [];
    }
  }

  // ── 监控日志 CRUD ──

  createTurnLog(log: TurnLog): void {
    const stmt = this.db.prepare(`INSERT INTO turn_logs
      (id, session_id, agent_id, seq, user_input, started_at, finished_at,
       iterations, tool_calls_total, tool_calls_success, tool_calls_failed,
       tokens_prompt, tokens_completion, finish_reason, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(log.id, log.sessionId, log.agentId, log.seq, log.userInput,
      log.startedAt, log.finishedAt ?? Date.now(), log.iterations,
      log.toolCallsTotal, log.toolCallsSuccess, log.toolCallsFailed,
      log.tokensPrompt, log.tokensCompletion, log.finishReason, log.error ?? null);
  }

  updateTurnLog(turnId: string, updates: Partial<TurnLog>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(updates)) {
      const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      fields.push(`${col} = ?`);
      values.push(v ?? null);
    }
    if (fields.length === 0) return;
    values.push(turnId);
    this.db.prepare(`UPDATE turn_logs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  createToolCallLog(log: ToolCallLog): void {
    const stmt = this.db.prepare(`INSERT INTO tool_call_logs
      (id, turn_id, tool_name, iteration, args, started_at, duration_ms, success, result_preview, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(log.id, log.turnId, log.toolName, log.iteration, log.args,
      log.startedAt, log.durationMs, log.success ? 1 : 0,
      log.resultPreview, log.error ?? null);
  }

  getTurnLogs(sessionId: string): TurnLog[] {
    const rows = this.db.prepare(
      `SELECT id, session_id, agent_id, seq, user_input, started_at, finished_at,
       iterations, tool_calls_total, tool_calls_success, tool_calls_failed,
       tokens_prompt, tokens_completion, finish_reason, error
       FROM turn_logs WHERE session_id = ? ORDER BY seq`).all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      agentId: r.agent_id as string,
      seq: r.seq as number,
      userInput: (r.user_input as string) ?? "",
      startedAt: r.started_at as number,
      finishedAt: r.finished_at as number,
      iterations: r.iterations as number,
      toolCallsTotal: r.tool_calls_total as number,
      toolCallsSuccess: r.tool_calls_success as number,
      toolCallsFailed: r.tool_calls_failed as number,
      tokensPrompt: r.tokens_prompt as number,
      tokensCompletion: r.tokens_completion as number,
      finishReason: r.finish_reason as string,
      error: r.error as string | undefined,
    }));
  }

  getToolCallLogs(turnId: string): ToolCallLog[] {
    const rows = this.db.prepare(
      `SELECT id, turn_id, tool_name, iteration, args, started_at, duration_ms, success, result_preview, error
       FROM tool_call_logs WHERE turn_id = ? ORDER BY started_at`).all(turnId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      turnId: r.turn_id as string,
      toolName: r.tool_name as string,
      iteration: r.iteration as number,
      args: (r.args as string) ?? "",
      startedAt: r.started_at as number,
      durationMs: r.duration_ms as number,
      success: !!r.success,
      resultPreview: (r.result_preview as string) ?? "",
      error: r.error as string | undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
