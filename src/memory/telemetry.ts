/**
 * 遥测导出 — 从会话事件捕获记录 → 脱敏瀑布 → 后端（默认 JSONL，零依赖）
 * 设计依据：对比报告借鉴点 #7（对齐 DSH dsh-session-telemetry：
 * SessionTelemetryRecord 结构、非阻塞 emit、错误隔离、接收端按 (session.id, event.seq) 去重）
 */

import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hookManager } from "../hooks/hook-manager.js";
import type { SessionEvent, SessionTelemetryRecord } from "../types.js";

/** 后端契约：非阻塞入队，错误由协调器隔离 */
export interface TelemetrySink {
  emit(record: SessionTelemetryRecord): void;
  flush?(): void;
  shutdown(): Promise<void>;
}

/** 本地 JSONL 后端（追加写 data/telemetry/<sessionId>.jsonl） */
export class TelemetryJsonlSink implements TelemetrySink {
  private filePath: string;

  constructor(dataDir: string, sessionId: string) {
    this.filePath = resolve(dataDir, "telemetry", `${sessionId}.jsonl`);
  }

  emit(record: SessionTelemetryRecord): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  flush(): void {
    /* appendFileSync 同步落盘，无需额外 flush */
  }

  async shutdown(): Promise<void> {
    /* 无缓冲，无需 drain */
  }
}

function severityOf(ev: SessionEvent): SessionTelemetryRecord["severity"] {
  if (ev.type === "tool/result" && (ev.data as { success: boolean }).success === false) return "error";
  if (ev.type === "turn/end" && (ev.data as { reason: string }).reason !== "stop") return "error";
  return "info";
}

export class TelemetryCoordinator {
  private sinks = new Map<string, TelemetrySink>();
  /** 已交接的事件 seq（(session.id, event.seq) 去重约定） */
  private lastSeen = new Map<string, number>();

  constructor(private dataDir: string) {}

  private sinkFor(sessionId: string): TelemetrySink {
    let sink = this.sinks.get(sessionId);
    if (!sink) {
      mkdirSync(resolve(this.dataDir, "telemetry"), { recursive: true });
      sink = new TelemetryJsonlSink(this.dataDir, sessionId);
      this.sinks.set(sessionId, sink);
    }
    return sink;
  }

  /** 捕获一批会话事件（非阻塞；脱敏瀑布只作用导出副本，权威事件日志永不改写） */
  async capture(sessionId: string, events: SessionEvent[]): Promise<void> {
    const sink = this.sinkFor(sessionId);
    for (const ev of events) {
      // 幂等：跳过已交接的 seq（lastSeen 只在 emit 成功后推进，emit 失败可下次重试）
      const last = this.lastSeen.get(sessionId) ?? 0;
      if (ev.seq <= last) continue;

      const record: SessionTelemetryRecord = {
        channel: "ledger",
        time: ev.createdAt,
        severity: severityOf(ev),
        attributes: { "session.id": sessionId, "event.type": ev.type, "event.seq": ev.seq },
        body: ev.data,
      };

      // 脱敏 waterfall：handler 返回 proceed=false 丢弃；modifiedData.record 改写导出副本
      let finalRecord: SessionTelemetryRecord;
      try {
        const result = await hookManager.trigger("onTelemetryRecord", {
          agentId: "",
          sessionId,
          data: { record },
        });
        if (!result.proceed) continue;
        finalRecord = (result.modifiedData?.record as SessionTelemetryRecord | undefined) ?? record;
      } catch {
        // 脱敏失败按 fail-closed 丢弃本条，不影响后续
        continue;
      }

      try {
        sink.emit(finalRecord);
        // emit 成功后才推进游标（失败保留，下次 capture 重试该条）
        this.lastSeen.set(sessionId, ev.seq);
      } catch {
        // 后端错误隔离，绝不上抛到主流程
      }
    }
  }

  /** 关闭全部后端（应用退出前调用） */
  async shutdown(): Promise<void> {
    for (const sink of this.sinks.values()) {
      try {
        await sink.shutdown();
      } catch {
        /* ignore */
      }
    }
    this.sinks.clear();
  }
}

export function readTelemetryFile(dataDir: string, sessionId: string): SessionTelemetryRecord[] {
  const filePath = resolve(dataDir, "telemetry", `${sessionId}.jsonl`);
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionTelemetryRecord);
  } catch {
    return [];
  }
}
