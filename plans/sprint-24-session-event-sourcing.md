# Sprint 24 — 会话事件溯源（Event Sourcing）改造设计

> 来源：`docs/comparison-report.md` 可借鉴点 #4「会话是消息数组 + SQLite 表，非事件溯源」
> 借鉴对象：DeepSeek Harness `dsh-session`（类型化 `SessionEventMap` 仅追加日志 = 唯一真源，消息历史由日志*派生*，回放即重新派生）与 `dsh-session-checkpoint-policy`（语义化持久化检查点）

## 1. 目标摘要

为会话引入**只追加事件日志（append-only event log）作为单一事实源**：消息、轮次、工具调用、记忆更新都变成事件流的一部分；现有 `messages` / `turn_logs` / `tool_call_logs` 表降级为**投影（projection）**，可随时由事件重放派生。收益：diff 快照、回放、统计、轨迹观测（Sprint 25）获得统一数据底座，审计可溯源。

采用**渐进迁移**：第一阶段事件与投影双写（同事务，零破坏）；第二阶段读取改为事件回放派生；第三阶段（可选）移除冗余投影表。

## 2. 现状分析

`src/memory/session-store.ts`（501 行，SQLite WAL）当前是"最终状态"存储：

| 表 | 内容 | 问题 |
|---|---|---|
| `sessions` | 会话元信息（agent/summary/时间戳） | 无创建事件 |
| `messages` | 消息行（role/content/tool_calls/seq） | 只存结果，丢失时序过程（流、工具调用与消息的先后、token 轨迹） |
| `turn_logs` / `tool_call_logs` | 轮次/工具监控日志 | 由 hooks 结算写入，与消息表无统一序号，无法回放 |
| `episodic_memory`（FTS5） | 情景记忆 | 与事件流无关 |

**写入点分布**（改造后都收敛到事件追加）：
- `appendMessage`（单点入口）：`base-agent.ts` run/runStream 各 2 处 + `server.ts` chat 端点 2 处
- `createTurnLog` / `createToolCallLog`：`hooks/handlers.ts` 的 turnLogger（onMessage 记基线 / onTaskComplete 结算）/ toolCallLogger（onToolCallPost）
- `saveEpisodic`：`context-manager.ts` + `handlers.ts`（autoLoadProjectMemory）
- `setSummary`：记忆总结处

## 3. 目标架构

```
                    ┌────────────────────────────────────────────────┐
                    │  session_events（唯一真源，仅追加，seq 连续）   │
                    │  session/created · user/message · assistant/… │
                    │  tool/call · tool/result · turn/start · end · │
                    │  step/start · end · memory/update · title/set │
                    └──────────────┬─────────────────────────────────┘
          append（同事务）          │ replay（派生）
                    ┌──────────────▼─────────────────────────────────┐
                    │  projections（投影，可按需重建）                │
                    │  messages 表（工作记忆）                        │
                    │  turn_logs / tool_call_logs（监控）            │
                    │  episodic_memory（情景 FTS5）                  │
                    └───────────────────────────────────────────────┘
```

设计原则（对齐 DSH `SessionEventMap`）：

1. **事件是唯一事实**：`session_events` 记录每次真实发生（用户消息、助手消息含 tool_calls、工具调用与结果、轮次开合、迭代步开合、记忆写入、标题变更）。
2. **事件不可变、无损 JSON**：`data` 为 `JSON` 列，`Session.append` 时校验 JSON 可序列化；`seq` 每会话内连续递增（与消息 seq 语义一致）。
3. **消息历史派生**：`replayEvents(sessionId)` 只读事件流即可重建 `Message[]`（user/message、assistant/message 投影为消息；tool/call + tool/result 投影为 tool 消息与 tool_calls 配对）。
4. **可扩展词汇**：类型定义采用映射接口 + 声明合并（TypeScript `declare module` 风格预留），插件/后续 Sprint 可加 `compaction/*`、`goal/*` 等事件而不改核心。
5. **检查点语义**（借鉴 `dsh-session-checkpoint-policy`）：事件在"模型请求前 / 工具副作用后"的边界落盘（WAL 同步），崩溃后回放可还原到最后一致状态。

## 4. 接口设计

### 4.1 事件类型（`src/types.ts` 新增）

```ts
export interface SessionEventMap {
  "session/created": { agentId: string };
  "turn/start": { turn: number };
  "turn/end": { turn: number; reason: "stop" | "error" | "aborted" | "length" };
  "step/start": { turn: number; step: number };
  "step/end": { turn: number; step: number };
  "user/message": Message;
  "assistant/message": { message: Message; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string; success: boolean; error?: string; preview?: string };
  "memory/update": { kind: "episodic" | "semantic"; summary?: string };
  "title/set": { title: string };
}

export type SessionEventType = keyof SessionEventMap;

export interface SessionEvent {
  seq: number;
  sessionId: string;
  type: SessionEventType;
  data: Record<string, unknown>;
  createdAt: number;
  /** 可选来源标记（hook / agent / server），便于溯源 */
  source?: string;
}
```

> `assistant/message` 携带 usage：模型输出与 token 记账同行（对齐 DSH「没有独立的 usage 记录」），Sprint 25 轨迹投影直接消费。

### 4.2 表结构（`session-store.ts` init 追加）

```sql
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,          -- JSON
  source TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(type);
```

### 4.3 SessionStore 新方法

```ts
/** 追加事件（同事务写入：事件 + 对应投影；appendMessage 内部自动调用） */
appendEvent(sessionId: string, type: SessionEventType, data: Record<string, unknown>, source?: string): number;
/** 追加事件 + 投影消息（单点：现有 appendMessage 调用方零改动即获得事件） */
appendMessage(sessionId: string, message: Message): void;   // 内部：appendEvent + messages 双写
/** 全量回放：事件流 → 消息序列（第一阶段用于校验，第二阶段替代 getMessages） */
replayEvents(sessionId: string): Message[];
/** 原始事件流（轨迹/统计/遥测消费） */
getEvents(sessionId: string, fromSeq?: number, limit?: number): SessionEvent[];
/** 一致性校验：事件派生消息 vs messages 表（/context 或启动时） */
verifyProjection(sessionId: string): { ok: boolean; eventCount: number; messageCount: number };
```

### 4.4 事件写入点映射（收敛表）

| 事件 | 写入点 | 方式 |
|---|---|---|
| `session/created` | `createSession` / `ensureSession` | 方法内直接 append |
| `user/message` · `assistant/message` | `appendMessage` | **单点**：base-agent / server 全部自动获得 |
| `tool/call` · `tool/result` | `createToolCallLog` / hooks toolCallLogger | 在 `createToolCallLog` 内同步 append（单点） |
| `turn/start` | hooks turnLogger（onMessage） | 追加 `{turn: seq}` |
| `turn/end` | hooks turnLogger（onTaskComplete 结算） | 追加 reason（finishReason → stop/length；error → error） |
| `step/start` · `step/end` | `base-agent.ts` runStream 迭代边界 | 迭代开始/结束各一次（turn=seq, step=iterations） |
| `memory/update` | `saveEpisodic` | 方法内同步 append |
| `title/set` | `setSummary` / `renameSession` | 方法内同步 append |

> 原则：**投影写入的既有方法内同步 append 对应事件**——所有调用方零改动、事件与投影同事务（better-sqlite3 `transaction`）。

## 5. 迁移路径（三阶段）

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| **P0 双写**（本 Sprint） | 新增 `session_events` 表 + 全量事件写入点 + `replayEvents`/`getEvents`/`verifyProjection`；读取仍走 messages 表 | 新会话事件完整；`verifyProjection` 对存量+新会话 ok |
| **P1 回放派生**（后续） | `getMessages` 内部改为 `replayEvents` 派生（投影表保留作 cache，`maybeCompress` 后重建） | 回放结果与双写校验一致；性能达标 |
| **P2 投影瘦身**（可选） | 删除 `messages` / `turn_logs` / `tool_call_logs` 冗余列，全部事件派生；仅保留 `episodic_memory` FTS5 索引 | 全量测试绿 + 回放 benchmark |

## 6. 文件变更清单

**修改**：
- `src/types.ts` — 新增 `SessionEventMap` / `SessionEventType` / `SessionEvent`
- `src/memory/session-store.ts` — 新增 `session_events` 表；`appendEvent` / `replayEvents` / `getEvents` / `verifyProjection`；`appendMessage` / `createToolCallLog` / `saveEpisodic` / `setSummary` / `createSession` / `renameSession` 内同步 append
- `src/hooks/handlers.ts` — turnLogger 增 `turn/start`、`turn/end` 事件；toolCallLogger 依赖 `createToolCallLog` 单点（无需改）
- `src/agents/base-agent.ts` — runStream 迭代边界 append `step/start` / `step/end`
- `src/core/context-manager.ts` — `saveEpisodic` 已单点（无需改）

**新建**：
- `test/session-events.test.ts` — 事件溯源单测（见 §8）

## 7. 依赖关系图

```
session-store（appendEvent 单点）
  ├─ appendMessage ──→ user/message · assistant/message
  ├─ createToolCallLog ──→ tool/call · tool/result
  ├─ saveEpisodic ──→ memory/update
  ├─ setSummary/rename ──→ title/set
  ├─ createSession ──→ session/created
  ├─ turnLogger(hooks) ──→ turn/start · turn/end
  └─ base-agent ──→ step/start · step/end
           │
           ▼
session_events（唯一真源）
  ├─→ replayEvents → Message[]（P1 起替代 getMessages）
  ├─→ getEvents → 轨迹投影 / 统计 / 遥测（Sprint 25 消费）
  └─→ verifyProjection → 一致性校验
```

## 8. 验证标准

**单元测试（`test/session-events.test.ts`，`makeTestDir` 隔离）**：
- 事件完整：一次完整对话（user → 工具调用 → assistant）后，事件序列 = session/created → user/message → turn/start → step/start → tool/call → tool/result → step/end → assistant/message → turn/end（顺序与 seq 连续）
- 单点覆盖：`appendMessage` 的 4 个既有调用方（base-agent ×2、server ×2）无需改动即产生事件（mock 调用验证）
- 回放等价：`replayEvents` 派生 Message[] 与 `getMessages` 结果一致（含 tool_calls / tool 消息配对）
- 一致性校验：伪造事件（少一条）→ `verifyProjection` 返回 `ok: false`
- 事件不可变：append 后 data 序列化往返一致；seq 每会话连续无空洞

**整体回归**：
- 现有 198 测试全绿（server.test.ts / hooks.test.ts 已覆盖既有路径，事件为追加式无破坏）
- `npx tsc --noEmit` + `npx eslint src/` + `npm run build` 通过

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 双写一致性（事件与投影不同步） | 同 `better-sqlite3` transaction 内完成事件 + 投影写入；`verifyProjection` 提供校验与告警 |
| 事件表增长（长期运行膨胀） | 事件含 `created_at`，可周期归档（`DELETE ... WHERE created_at < N 天 AND seq < 最新 checkpoint`）；P1 起消息由事件派生，messages 表即可删 |
| 性能（热路径 append 开销） | 事件写入为单条 INSERT（与投影同事务，额外成本 ~1 次插入）；`step/start` 等高频事件只在迭代边界，量级可控 |
| 既有会话无事件 | 存量会话 `verifyProjection` 仅告警不阻断；后续可提供 `backfillEvents(sessionId)` 一次性回填 |
| 与压缩（maybeCompress）交互 | 压缩只改 messages 投影，事件日志保持原始（DSH 中 compaction 事件为 log-only 快照，同理）；压缩后 verifyProjection 关闭（投影为压缩态，非事件直接派生） |

## 10. 执行记录

| 日期 | 任务 | 说明 |
|------|------|------|
| 2026-08 | 事件模型 | `src/types.ts` 新增 `SessionEventMap`（9 类事件）/`SessionEventType`/`SessionEvent`；`HookEvent` 扩展 `onTelemetryRecord` |
| 2026-08 | 存储层 | `session-store.ts` 新增 `session_events` 表（不设 session_id 外键，事件日志为审计真源可先于会话存在）+ `appendEvent`/`getEvents`/`replayEvents`/`verifyProjection`；`appendMessage` 单点同事务双写（user/message · assistant/message）；`createSession`/`ensureSession`/`saveEpisodic`/`setSummary`/`renameSession` 内同步 append 对应事件 |
| 2026-08 | 写入点 | `agent-loop.ts`：deps 增 sessionStore，循环边界 append `step/start`/`step/end`（endStep helper，全部 return/continue 路径覆盖）；`executeTool` 拆包装层发 `tool/call`/`tool/result`（hooks 拿不到完整 content，改在 loop 层发）；`handlers.ts` turnLogger 增 `turn/start`/`turn/end`；`base-agent.ts` 两处调用传 sessionStore |
| 2026-08 | 测试 | 新增 `test/session-events.test.ts` 6 例：事件序列+seq 连续、回放派生与投影一致（投影表不含 tool 消息，仅比较 user/assistant 骨架）、verifyProjection 检测缺失、记忆/标题事件、分页 |
| 2026-08 | 修复 | 移除 session_events 外键（saveEpisodic 等写入点可能先于会话存在）；`deleteSession` 级联清理 session_events |
| 2026-08 | 验证 | tsc + eslint 全绿；全量测试 212 passed（198 原有 + 14 新增） |
