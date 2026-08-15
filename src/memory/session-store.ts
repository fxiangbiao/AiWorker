/**
 * 会话存储 — SQLite + WAL + FTS5
 * 设计依据：HermesAgent 实证——零额外依赖，FTS5 跨会话检索
 */

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message, SessionRecord, EpisodicEntry, TurnLog, ToolCallLog, SessionEventType, SessionEvent } from "../types.js";

const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : null;

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

function mapTurnLogRow(r: Record<string, unknown>): TurnLog {
  return {
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
  };
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

      -- 事件溯源: 仅追加事件日志（唯一真源，Sprint 24）
      -- 不设 session_id 外键：事件日志是审计性真源，可先于会话元数据存在（saveEpisodic 等写入点）
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(type);
    `);
  }

  /** 创建新会话 */
  createSession(agentId: string): SessionRecord {
    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`INSERT INTO sessions (id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)`);
    stmt.run(id, agentId, now, now);
    this.appendEvent(id, "session/created", { agentId });
    return { id, agentId, createdAt: now, updatedAt: now };
  }

  /** 确保会话存在（指定 ID），不存在则创建 */
  ensureSession(id: string, agentId: string): void {
    const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
    if (!exists) {
      const now = Date.now();
      this.db.prepare("INSERT INTO sessions (id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        id,
        agentId,
        now,
        now,
      );
      this.appendEvent(id, "session/created", { agentId });
    }
  }

  /**
   * 追加一条会话事件（仅追加，seq 每会话连续递增；data 需 JSON 可序列化）
   * @returns 分配的事件 seq
   */
  appendEvent(sessionId: string, type: SessionEventType, data: Record<string, unknown>, source?: string): number {
    const seqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM session_events WHERE session_id = ?`,
    );
    const { next_seq } = seqStmt.get(sessionId) as { next_seq: number };
    this.db
      .prepare(
        `INSERT INTO session_events (session_id, seq, type, data, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, next_seq, type, JSON.stringify(data), source ?? null, Date.now());
    return next_seq;
  }

  /** 追加消息（单点入口：同时写事件日志 + messages 投影，同事务；assistant 可携带 usage 供轨迹/遥测） */
  appendMessage(
    sessionId: string,
    message: Message,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  ): void {
    const tx = this.db.transaction(() => {
      const seqStmt = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM messages WHERE session_id = ?`);
      const { next_seq } = seqStmt.get(sessionId) as { next_seq: number };

      const stmt = this.db.prepare(
        `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      stmt.run(
        sessionId,
        message.role,
        message.content,
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        message.tool_call_id ?? null,
        next_seq,
        Date.now(),
      );

      // 事件日志（user/assistant 消息；assistant 携带 usage 由轨迹/遥测消费）
      if (message.role === "user") {
        this.appendEvent(sessionId, "user/message", message as unknown as Record<string, unknown>, "session-store");
      } else if (message.role === "assistant") {
        this.appendEvent(
          sessionId,
          "assistant/message",
          { message, ...(usage ? { usage } : {}) } as unknown as Record<string, unknown>,
          "session-store",
        );
      }

      // 更新会话时间戳
      this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    });
    tx();
  }

  /** 获取会话消息历史 */
  getMessages(sessionId: string): Message[] {    const stmt = this.db.prepare(
      `SELECT role, content, tool_calls, tool_call_id FROM messages
       WHERE session_id = ? ORDER BY seq ASC`,
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

  /** 获取会话事件流（仅追加日志，seq 升序；支持分页） */
  getEvents(sessionId: string, fromSeq?: number, limit?: number): SessionEvent[] {
    let sql = `SELECT seq, session_id, type, data, source, created_at FROM session_events WHERE session_id = ?`;
    const params: Array<string | number> = [sessionId];
    if (fromSeq !== undefined) {
      sql += ` AND seq >= ?`;
      params.push(fromSeq);
    }
    sql += ` ORDER BY seq ASC`;
    if (limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      sessionId: r.session_id as string,
      type: r.type as SessionEventType,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
      createdAt: r.created_at as number,
      source: r.source as string | undefined,
    }));
  }

  /** 事件回放 → 消息序列（保持消息语义顺序：助手消息的 tool_calls 后紧跟对应 tool 结果） */
  replayEvents(sessionId: string): Message[] {
    const events = this.getEvents(sessionId);
    const toolResults = new Map<string, Message>();
    for (const ev of events) {
      if (ev.type === "tool/result") {
        const d = ev.data as { callId: string; success: boolean; content: string; error?: string };
        toolResults.set(d.callId, {
          role: "tool",
          content: d.success ? d.content : `Error: ${d.error ?? d.content}`,
          tool_call_id: d.callId,
        });
      }
    }
    const messages: Message[] = [];
    for (const ev of events) {
      if (ev.type === "user/message") {
        messages.push(ev.data as unknown as Message);
      } else if (ev.type === "assistant/message") {
        const { message } = ev.data as { message: Message };
        messages.push(message);
        if (message.tool_calls) {
          for (const tc of message.tool_calls) {
            const toolMsg = toolResults.get(tc.id);
            if (toolMsg) messages.push(toolMsg);
          }
        }
      }
    }
    return messages;
  }

  /** 一致性校验：事件回放派生消息 vs messages 投影（投影表不含 tool 消息，故仅比较 user/assistant 骨架） */
  verifyProjection(sessionId: string): { ok: boolean; eventCount: number; messageCount: number; mismatches: string[] } {
    const events = this.getEvents(sessionId);
    const replayed = this.replayEvents(sessionId).filter((m) => m.role !== "tool");
    const stored = this.getMessages(sessionId).filter((m) => m.role !== "tool");
    const mismatches: string[] = [];
    if (replayed.length !== stored.length) {
      mismatches.push(`长度不一致: 回放 ${replayed.length} vs 投影 ${stored.length}`);
    } else {
      for (let i = 0; i < stored.length; i++) {
        const a = replayed[i]!;
        const b = stored[i]!;
        if (a.role !== b.role || a.content !== b.content || a.tool_call_id !== b.tool_call_id) {
          mismatches.push(`第 ${i} 条不一致: ${a.role}(${b.role})`);
          if (mismatches.length >= 5) break;
        }
      }
    }
    return { ok: mismatches.length === 0, eventCount: events.length, messageCount: stored.length, mismatches };
  }

  /** 列出最近会话（含消息数 + 首条用户消息摘要） */
  listSessions(limit = 20): Array<{
    id: string;
    agentId: string;
    createdAt: number;
    updatedAt: number;
    summary: string | null;
    messageCount: number;
    firstUserMsg: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.agent_id, s.created_at, s.updated_at, s.summary,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
                (SELECT content FROM messages m2 WHERE m2.session_id = s.id AND m2.role = 'user' ORDER BY m2.seq ASC LIMIT 1) AS first_user
         FROM sessions s
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      agent_id: string;
      created_at: number;
      updated_at: number;
      summary: string | null;
      msg_count: number;
      first_user: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      summary: r.summary,
      messageCount: r.msg_count,
      firstUserMsg: r.first_user ? r.first_user.replace(/\s+/g, " ").slice(0, 60) : null,
    }));
  }

  /** 保存会话摘要 */
  setSummary(sessionId: string, summary: string): void {
    this.db.prepare(`UPDATE sessions SET summary = ? WHERE id = ?`).run(summary, sessionId);
    this.appendEvent(sessionId, "title/set", { title: summary }, "session-store");
  }

  /** 重命名会话（更新 summary 作为标题） */
  renameSession(id: string, title: string): boolean {
    const result = this.db.prepare(`UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id);
    if (result.changes > 0) {
      this.appendEvent(id, "title/set", { title }, "session-store");
    }
    return result.changes > 0;
  }

  /** 删除会话（级联删除消息、事件日志与 turn/tool logs） */
  deleteSession(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
      // 先删 tool_call_logs（外键引用 turn_logs.id），再删 turn_logs
      this.db.prepare(
        `DELETE FROM tool_call_logs WHERE turn_id IN (SELECT id FROM turn_logs WHERE session_id = ?)`,
      ).run(id);
      this.db.prepare("DELETE FROM turn_logs WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM episodic_memory WHERE session_id = ?").run(id);
      return this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
    });
    return tx();
  }

  /** 获取会话完整消息（含 seq，供导出用） */
  getSessionMessages(id: string): Array<Message & { seq: number; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, tool_calls, tool_call_id, seq, created_at
         FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(id) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      seq: number;
      created_at: number;
    }>;

    return rows.map((row) => {
      const msg: Message & { seq: number; createdAt: number } = {
        role: row.role as Message["role"],
        content: row.content,
        seq: row.seq,
        createdAt: row.created_at,
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
         LIMIT ?`,
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
      .filter((e) => e.weight * (e.decayFactor ?? 0) >= 0.05)
      .sort((a, b) => b.weight * (b.decayFactor ?? 0) - a.weight * (a.decayFactor ?? 0))
      .slice(0, limit);
  }

  /** 写入情景记忆（追加中文分词 token 增强 FTS5 索引） */
  saveEpisodic(sessionId: string, content: string, summary: string, weight = 1.0): void {
    const segmented = segmentChinese(content);
    const enriched = segmented ? `${content} ${segmented}` : content;

    const stmt = this.db.prepare(
      `INSERT INTO episodic_memory (session_id, content, summary, timestamp, weight)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(sessionId, enriched, summary, Date.now().toString(), weight.toString());
    this.appendEvent(sessionId, "memory/update", { kind: "episodic", summary }, "session-store");
  }

  private tryFts5Match(
    query: string,
    limit: number,
  ): Array<{
    session_id: string;
    content: string;
    summary: string;
    timestamp: string;
    weight: string;
  }> {
    // Sanitize FTS5 special characters to prevent syntax errors
    const safe = query
      .replace(/[*"(){}[\]]/g, " ")
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
      .trim();
    if (!safe) return [];
    try {
      const stmt = this.db.prepare(
        `SELECT session_id, content, summary, timestamp, weight
         FROM episodic_memory
         WHERE episodic_memory MATCH ?
         ORDER BY rank
         LIMIT ?`,
      );
      return stmt.all(safe, limit) as ReturnType<typeof this.tryFts5Match>;
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
    stmt.run(
      log.id,
      log.sessionId,
      log.agentId,
      log.seq,
      log.userInput,
      log.startedAt,
      log.finishedAt ?? Date.now(),
      log.iterations,
      log.toolCallsTotal,
      log.toolCallsSuccess,
      log.toolCallsFailed,
      log.tokensPrompt,
      log.tokensCompletion,
      log.finishReason,
      log.error ?? null,
    );
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
    stmt.run(
      log.id,
      log.turnId,
      log.toolName,
      log.iteration,
      log.args,
      log.startedAt,
      log.durationMs,
      log.success ? 1 : 0,
      log.resultPreview,
      log.error ?? null,
    );
  }

  getTurnLogs(sessionId: string): TurnLog[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, agent_id, seq, user_input, started_at, finished_at,
       iterations, tool_calls_total, tool_calls_success, tool_calls_failed,
       tokens_prompt, tokens_completion, finish_reason, error
       FROM turn_logs WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapTurnLogRow);
  }

  /** 获取最近有日志的会话的全部轮次日志（currentSessionId 为空时回退用） */
  getRecentTurnLogs(limit = 20): TurnLog[] {
    const latestSession = this.db
      .prepare(`SELECT session_id FROM turn_logs ORDER BY started_at DESC LIMIT 1`)
      .get() as { session_id: string } | undefined;
    if (!latestSession) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, agent_id, seq, user_input, started_at, finished_at,
       iterations, tool_calls_total, tool_calls_success, tool_calls_failed,
       tokens_prompt, tokens_completion, finish_reason, error
       FROM turn_logs WHERE session_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(latestSession.session_id, limit) as Record<string, unknown>[];
    return rows.map(mapTurnLogRow);
  }

  getToolCallLogs(turnId: string): ToolCallLog[] {
    const rows = this.db
      .prepare(
        `SELECT id, turn_id, tool_name, iteration, args, started_at, duration_ms, success, result_preview, error
       FROM tool_call_logs WHERE turn_id = ? ORDER BY started_at`,
      )
      .all(turnId) as Record<string, unknown>[];
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
