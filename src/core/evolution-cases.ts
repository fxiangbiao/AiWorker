/**
 * 进化黄金用例（Sprint 41 第三期）— 评测用成功任务轨迹
 * 提取: 窗口内 turn/end reason=stop 的 turn → input=该 turn 末条用户消息, expected=末条助手消息（截断）
 * 存储: data/evolution/cases/<caseId>.json; CasesStore 仿 ProposalStore（engine 默认实现 + 测试注入 mock）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Message, SessionEvent } from "../types.js";
import { messageText } from "../types.js";
import { EVOLUTION_WINDOW_MS, normalizeTaskText } from "./evolution-observer.js";

export interface EvolutionCase {
  id: string;
  input: string;
  expected?: string;
  source: "manual" | "session";
  sessionId?: string;
  createdAt: number;
}

/** 会话事件源（与观察器同形，index.ts 注入 sessionStore 适配） */
export interface CasesSessionDeps {
  listSessions: (limit?: number) => Array<{
    id: string;
    updatedAt: number;
    turnCount: number;
    firstUserMsg: string | null;
  }>;
  getEvents: (sessionId: string) => SessionEvent[];
}

export interface CasesStore {
  list(limit?: number): EvolutionCase[];
  get(id: string): EvolutionCase | undefined;
  add(c: { input: string; expected?: string; source: "manual" | "session"; sessionId?: string }): EvolutionCase;
  delete(id: string): boolean;
}

/** 文件版用例库（engine 缺省实现；目录注入便于测试隔离） */
export class EvolutionCases implements CasesStore {
  constructor(private dir: string) {}

  private casesDir(): string {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  list(limit = 100): EvolutionCase[] {
    const dir = this.casesDir();
    const out: EvolutionCase[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as EvolutionCase);
      } catch {
        /* 损坏文件跳过 */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  get(id: string): EvolutionCase | undefined {
    return this.list(1000).find((c) => c.id === id);
  }

  add(c: { input: string; expected?: string; source: "manual" | "session"; sessionId?: string }): EvolutionCase {
    const now = Date.now();
    const id = `case-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const full: EvolutionCase = {
      id,
      input: c.input,
      expected: c.expected,
      source: c.source,
      sessionId: c.sessionId,
      createdAt: now,
    };
    writeFileSync(resolve(this.casesDir(), `${id}.json`), JSON.stringify(full, null, 2), "utf-8");
    return full;
  }

  delete(id: string): boolean {
    const path = resolve(this.casesDir(), `${id}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}

/** 按 turn 切分会话事件（仅返回已闭环 turn/end 的 turn；未结束的末 turn 丢弃） */
export function splitTurns(events: SessionEvent[]): { turn: number; reason: string; events: SessionEvent[] }[] {
  const turns: { turn: number; reason: string; events: SessionEvent[] }[] = [];
  let cur: { turn: number; reason: string; events: SessionEvent[] } | null = null;
  let closed = false;
  for (const ev of events) {
    if (ev.type === "turn/start") {
      if (cur && closed) turns.push(cur);
      cur = { turn: (ev.data as { turn: number }).turn, reason: "stop", events: [] };
      closed = false;
    } else if (ev.type === "turn/end") {
      const d = ev.data as { turn: number; reason: string };
      if (cur && cur.turn === d.turn) {
        cur.reason = d.reason;
        closed = true;
      }
    } else if (cur) {
      cur.events.push(ev);
    }
  }
  if (cur && closed) turns.push(cur);
  return turns;
}

/** 从会话轨迹提取成功 turn 为黄金用例（input 去重；expected 截断 200 字符） */
export function extractCasesFromSessions(
  deps: CasesSessionDeps,
  store: CasesStore,
  now = Date.now(),
): { added: number; skipped: number } {
  const windowStart = now - EVOLUTION_WINDOW_MS;
  const existing = new Set(store.list(1000).map((c) => normalizeTaskText(c.input)));
  let added = 0;
  let skipped = 0;
  for (const s of deps.listSessions(500)) {
    const events = deps.getEvents(s.id).filter((ev) => ev.createdAt >= windowStart);
    for (const turn of splitTurns(events)) {
      if (turn.reason !== "stop") continue;
      const userMsgs = turn.events.filter((ev) => ev.type === "user/message");
      const assistantMsgs = turn.events.filter((ev) => ev.type === "assistant/message");
      if (userMsgs.length === 0 || assistantMsgs.length === 0) continue;
      const lastUser = userMsgs[userMsgs.length - 1]!;
      // user/message 事件 data 即 Message 本体（assistant/message 才是 {message} 包装，见 SessionEventMap）；
      // 防御旧数据/畸形 data：形状不符按空文本跳过，不抛错
      const rawUser = lastUser.data as unknown;
      const userMsg = rawUser && typeof rawUser === "object" && "content" in rawUser ? (rawUser as Message) : undefined;
      const input = userMsg ? messageText(userMsg).trim() : "";
      if (!input) {
        skipped++;
        continue;
      }
      const norm = normalizeTaskText(input);
      if (norm.length < 4 || existing.has(norm)) {
        skipped++;
        continue;
      }
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1]!;
      const aData = lastAssistant.data as { message?: Message };
      const expected = aData?.message ? messageText(aData.message).trim().slice(0, 200) : undefined;
      store.add({
        input: input.slice(0, 500),
        expected: expected || undefined,
        source: "session",
        sessionId: s.id,
      });
      existing.add(norm);
      added++;
    }
  }
  return { added, skipped };
}
