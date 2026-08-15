# Sprint 25 — 轨迹观测（Trajectory & Telemetry）设计

> 来源：`docs/comparison-report.md` 可借鉴点 #7「无 OTel/轨迹观测」
> 依赖：Sprint 24 的 `session_events` 事件日志（唯一真源）
> 借鉴对象：DeepSeek Harness `dsh-session-stats`（whole-log 会话统计投影）与 `dsh-session-telemetry`（`SessionTelemetryRecord`：channel/severity/attributes/body；非阻塞 `emit`；`session-telemetry/record` 脱敏 waterfall；接收端按 `(session.id, event.seq)` 去重）

## 1. 目标摘要

在事件日志之上构建**轨迹观测层**，让每次会话可复盘：

1. **轨迹投影（Trajectory）**：从 `session_events` 派生结构化时间线——轮次/迭代步边界、工具调用（参数摘要/耗时/成败）、token 消耗、结束原因——CLI `/trace` 时间轴 + Web 轨迹面板。
2. **统计投影（Stats）**：会话级统计（轮次数、工具成功率、总 token、耗时、错误数），`/sessions` 列表与 Web 面板展示。
3. **遥测导出（Telemetry）**：`SessionTelemetryRecord` 事件流 → 脱敏链 → 后端（默认本地 JSONL，零依赖；预留 OTel seam），便于跨会话聚合复盘与失败告警。

原则：**观测只读事件日志，永不改写**（权威日志不可变）；导出副本脱敏，权威日志不脱敏。

## 2. 设计依据（DSH 对照）

| DSH 组件 | 借鉴点 | AiWorker 落点 |
|---|---|---|
| `session-stats` | 从日志派生 whole-log 统计投影 | `src/core/trajectory.ts` 的 `computeSessionStats` |
| `session-telemetry` record | `{channel: ledger\|ops, time, severity, attributes, body}`；`emit` 非阻塞入队、错误隔离 | `src/memory/telemetry.ts` 的 `SessionTelemetryRecord` + `TelemetrySink` |
| 捕获策略 | 每 `(turn,step)` 只发首条 `assistant/chunk`（"流已开始"信号），其余丢弃（seq 缺口正常） | 事件级：`assistant/message` 只发组装后消息（含 usage），不发流块 |
| 脱敏 waterfall | `session-telemetry/record` 事件堆叠规则，仅作用导出副本 | 复用现有 HookManager 增加 `onTelemetryRecord` 事件（hooks.json 可配规则） |
| 后端约定 | `emit` / `flush?` / `shutdown`；接收端去重 | JSONL 后端 + 可替换 seam |
| 严重度预映射 | `error`：工具 isError / turn/end 错误原因；其余 `info` | 同 |

## 3. 轨迹投影设计

### 3.1 投影结构（`src/core/trajectory.ts`）

```ts
export interface TrajectoryItem {
  seq: number;
  type: "turn" | "step" | "user" | "assistant" | "tool" | "memory" | "title";
  label: string;            // 人类可读（如 "turn #1" / "fs_write"）
  detail?: string;          // 摘要（用户消息截断 / 工具参数摘要 / 错误）
  at: number;               // 事件时间
  durationMs?: number;      // step / tool 耗时
  status?: "ok" | "fail" | "running";
  tokens?: { prompt: number; completion: number; total: number };
}

export interface SessionStats {
  sessionId: string;
  turnCount: number;
  stepCount: number;
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsSuccessRate: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  wallMs: number;           // 首个事件 → 末个事件
  finishReason: string;
  errorCount: number;
}

export function projectTrajectory(events: SessionEvent[]): TrajectoryItem[];
export function computeSessionStats(events: SessionEvent[]): SessionStats;
```

### 3.2 事件 → 轨迹映射

| 事件 | 轨迹项 |
|---|---|
| `turn/start` · `turn/end` | `turn` 项（end 时填 durationMs + reason） |
| `step/start` · `step/end` | `step` 项（end 填 durationMs + status） |
| `user/message` | `user` 项（detail = content 摘要 ≤120 字符） |
| `assistant/message` | `assistant` 项（detail = text 摘要；tokens 来自事件 usage） |
| `tool/call` | `tool` 项（label = name，detail = arguments 摘要，status=running） |
| `tool/result` | 匹配同 `callId` 的 tool 项：填 durationMs（result.at − call.at）+ status=ok/fail + error |
| `memory/update` · `title/set` | `memory` / `title` 项 |

> 耗时与 token 由投影聚合（`tool/result.at - tool/call.at`），事件本身不带耗时字段——**观测数据从事件派生，不重复存储**（对齐 DSH「没有独立的 usage 记录」）。

## 4. 遥测导出设计

### 4.1 Record 结构（`src/memory/telemetry.ts`）

```ts
export type TelemetrySeverity = "info" | "warn" | "error";

export interface SessionTelemetryRecord {
  channel: "ledger" | "ops";
  time: number;
  severity: TelemetrySeverity;
  attributes: Record<string, string | number>;  // session.id / event.type / event.seq / agent.id
  body: unknown;                                 // 事件 data 深拷贝（导出副本）
}

/** 后端契约：非阻塞入队，错误由协调器隔离（对齐 DSH SessionTelemetrySink） */
export interface TelemetrySink {
  emit(record: SessionTelemetryRecord): void;
  flush?(): void;
  shutdown(): Promise<void>;
}

export class TelemetryCoordinator {
  constructor(private sink: TelemetrySink) {}
  /** 从事件流捕获记录（供轨迹/会话结束/工具回调调用）；emit 内错误吞掉并记审计 */
  capture(events: SessionEvent[]): void;
}
```

### 4.2 脱敏链（复用 HookManager）

- HookManager 增加事件 `onTelemetryRecord`（`HookEvent` 联合类型扩展，`config/hooks.json` 注册 `redactTelemetry` 等 handler）
- 每个 handler 可返回 `{ proceed: false, modifiedData }` 或改写 `data.record`——与现有 `onToolCallPre` 拦截语义一致
- **只作用于导出副本**；`session_events` 权威日志永不改写
- 内置 `redactSensitive` handler：复用 `handlers.ts` 的敏感模式（sk-xxx / 私钥 / 密码）对 `body` 与 `attributes` 脱敏

### 4.3 后端

- **默认 JSONL 本地后端**（`TelemetryJsonlSink`）：追加写 `data/telemetry/<sessionId>.jsonl`（或单一 `data/telemetry.jsonl` + sessionId 属性），`emit` 同步写（WAL 下可接受），`shutdown` flush
- **预留 OTel seam**：`TelemetrySink` 接口即 seam；后续 `TelemetryOtlpSink` 引入 `@opentelemetry/*` 依赖即可替换，**本 Sprint 不引入任何新依赖**
- 接收端去重约定：`(session.id, event.seq)` 幂等（文档化，供聚合脚本使用）

## 5. UI 与 API

### 5.1 CLI

```
/trace [会话序号]           # 当前/指定会话的轨迹时间轴（复用 TUI 表格渲染）
  ● turn #1 (ok, 2.3s, 412 tok)
    ├─ step #0  ok  1.1s  fs_write ×1
    │   └─ 🔧 fs_write → "src/foo.ts" ✓ 320ms
    ├─ step #1  ok  0.8s  (无工具)
    └─ 📋 结果摘要: ...
/trace --json               # 输出 JSON（供脚本消费）
```

- `src/terminal/` 新增 `trajectory-view.ts`（树形时间轴渲染，复用 `screen.ts`/`markdown.ts` 能力）

### 5.2 Web

- 会话详情新增「轨迹」Tab（`web/src/components/TrajectoryPanel.svelte`）：时间线 + 失败高亮（红）+ 工具卡（复用 ToolCard 展示）
- 侧边栏会话列表显示 `session-stats` 徽标（轮次/工具失败数/token）

### 5.3 HTTP API（`server.ts`，统一 `/api/v1`）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/trace/:sessionId` | GET | 轨迹投影（TrajectoryItem[] + SessionStats） |
| `/api/v1/stats` | GET | 跨会话统计聚合（最近 N 会话） |
| `/api/v1/telemetry/:sessionId` | GET | 遥测记录（JSONL 后端读取，分页） |

## 6. 文件变更清单

**新建**：
- `src/core/trace.ts` — `TraceItem` / `SessionStats` / `projectTrace` / `computeSessionStats`（实现时命名统一为 trace，同 CLI/API）
- `src/memory/telemetry.ts` — `SessionTelemetryRecord` / `TelemetrySink` / `TelemetryCoordinator` / `TelemetryJsonlSink`
- `src/terminal/trace-view.ts` — CLI 时间轴渲染
- `web/src/components/TracePanel.svelte` — Web 轨迹 Tab
- `test/trace.test.ts` — 投影/统计/遥测单测（见 §7）

**修改**：
- `src/types.ts` — `HookEvent` 增加 `"onTelemetryRecord"`；导出 `TraceItem`/`SessionStats` 类型（`import type`）
- `src/hooks/hook-manager.ts` / `hook-config-loader.ts` / `handlers.ts` — 注册 `onTelemetryRecord` 事件与 `redactSensitive` handler
- `src/server.ts` — 3 个新端点
- `src/index.ts` — 挂载 `TelemetryCoordinator`（server/CLI 分支之前）；`/trace` 命令（Tab 补全列表同步加入）
- `src/agents/base-agent.ts` / `src/hooks/handlers.ts` — turn/step 边界与工具回调调用 `coordinator.capture`（消费 Sprint 24 事件）
- `web/src/components/Sidebar.svelte` — 会话统计徽标
- `web/src/lib/stores/chat.svelte.ts` — 轨迹/统计数据拉取

## 7. 验证标准

**单元测试（`test/trajectory.test.ts`，构造事件序列，不触真实 LLM）**：
- `projectTrajectory`：给定完整事件序列 → 轨迹项顺序/类型/耗时（tool/result.at − tool/call.at）/status 正确；失败工具（result.success=false）标 fail
- `computeSessionStats`：轮次/工具/失败率/token/耗时/错误数聚合正确；空事件 → 全零
- telemetry：`capture` 生成记录（channel=ledger、attributes 含 session.id/event.type/event.seq）；`emit` 抛错被隔离不冒泡
- 脱敏：`redactSensitive` 对含 `sk-xxxx` 的 body 改写，权威事件不动
- JSONL 后端：写入 → 重读一致；`shutdown` flush 后文件完整

**整体回归**：
- 现有 198 + Sprint 24 测试全绿；`npx tsc --noEmit` + `npx eslint src/` + `npm run build` 通过
- 真机冒烟：`/trace` 展示一次真实对话轨迹；Web 轨迹 Tab 正常渲染

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 遥测写入拖慢热路径 | `emit` 非阻塞同步写（JSONL 追加，WAL 下 ~微秒级）；`capture` 批量（turn/end 时一次捕获该轮事件）；后端错误吞掉 + 审计 |
| 脱敏遗漏（导出泄露敏感信息） | 默认启用 `redactSensitive`（复用既有模式）；`onTelemetryRecord` 瀑布可叠加更多规则；文档标注"遥测可能含未脱敏数据，部署前检查" |
| 轨迹投影性能（长会话事件多） | `projectTrajectory` 单次线性扫描；分页（`getEvents(fromSeq, limit)`）；Web 端懒加载 |
| 与压缩交互（事件保留原始、投影压缩） | 轨迹基于事件日志（原始），不受压缩影响；文档注明轨迹显示原始流而非压缩态 |
| 文件膨胀（telemetry.jsonl 长期累积） | 按 `data/telemetry/` 按会话分文件 + `created_at` 归档策略；`/telemetry` 分页 |

## 9. 执行记录

| 日期 | 任务 | 说明 |
|------|------|------|
| 2026-08 | 轨迹投影 | 新建 `src/core/trace.ts`：`projectTrace`（事件 → 时间线，tool 耗时=result.at−call.at、失败标 fail、非 stop 轮次标 fail、assistant 携带 tokens）+ `computeSessionStats`（轮次/步/工具成功率/token/wallMs/错误数）；`TraceItem.tokens` 字段与事件 usage 命名统一 |
| 2026-08 | 遥测 | 新建 `src/memory/telemetry.ts`：`TelemetrySink` seam + `TelemetryJsonlSink`（data/telemetry/<id>.jsonl）+ `TelemetryCoordinator`（capture 走 `onTelemetryRecord` 脱敏瀑布、proceed=false 丢弃、按 (session.id, event.seq) 幂等去重、错误隔离 fail-closed）+ `readTelemetryFile`；turnLogger 轮次结算后批量 capture |
| 2026-08 | 脱敏 | `handlers.ts` 新增 `createTelemetryRedact`（递归脱敏 body/attributes：sk-xxx/私钥/密钥对）；`hook-config-loader.ts` 注册 `redactTelemetry`；`config/hooks.json` 增 `onTelemetryRecord` 段（默认启用） |
| 2026-08 | API/CLI | `server.ts` 新增 `GET /api/v1/trace/:id`（items+stats）、`/stats`（最近 20 会话统计）、`/telemetry/:id`；`index.ts` 挂载 TelemetryCoordinator（hooks deps 注入）+ `/trace [序号\|--json]` 命令 + 退出 shutdown；新建 `src/terminal/trace-view.ts` 树形时间轴渲染 |
| 2026-08 | Web | 新建 `web/src/components/TracePanel.svelte`（SystemPanel「轨迹」Tab：统计徽标 + 时间线，失败红色高亮，按 activeChatId 自动刷新）；`Sidebar.svelte` 会话项显示 token/失败徽标（/stats）；命令名与 API 路径统一为 `trace` |
| 2026-08 | 测试 | 新增 `test/trace.test.ts` 8 例：投影顺序/耗时/失败标记、统计聚合/空事件、遥测捕获+严重度+JSONL 落盘、幂等去重、emit 错误隔离、脱敏改写导出副本 |
| 2026-08 | 验证 | tsc + eslint 全绿；全量测试 212 passed；`npm run web:build` 成功 |
