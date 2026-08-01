# Sprint 11：多轮对话 + Skill 自进化 + 目录智能感知 + 监控日志

> **目标**：打通多轮对话（核心交互模式），启动 Phase 4 自进化引擎（Skill 自动沉淀），弥补工作目录感知盲区，建立全链路对话监控和上下文透明能力。
> **预计工时**：~16h（5 个模块）

---

## 一、现状诊断

| 维度 | 问题 | 影响 |
|------|------|------|
| 多轮对话 | 每次输入都创建新任务——`agent.runStream()` 返回后 `messages` 被丢弃，下一轮像第一次见面 | 每个问题都要重新描述上下文，不能追问、不能修正 |
| Skill 自进化 | `createEvaluateSkillCreation` hook 生成骨架文件但不验证、不评分、不注册 | Phase 4 核心目标 "Skill 自动沉淀成功率 > 50%" 零进展 |
| 目录感知 | Agent 对项目结构一无所知，只能逐步 `fs_read`/`fs_list` 探索 | 浪费 token 和迭代次数在探索项目布局上 |
| 对话监控 | 无任何执行日志——每轮迭代几次、每次工具调用耗时多少、哪里报错，完全不可见 | 出问题时无法定位根因，优化性能无数据依据 |
| 上下文透明 | 不清楚 prompt 里装了什么——系统提示词占了多大、技能注入了多少、会话历史有多长，MCP 工具各耗多少 | 上下文窗口管理完全盲操作，token 超了只能被动等压缩或截断 |

---

## 二、设计原则

1. **会话连续性** — 多轮对话复用同一 session，messages 不销毁，LLM 有完整上下文
2. **Skill 质量优先** — 自动生成后必须经过验证和评分，低质量自动丢弃
3. **零额外探索成本** — 目录结构在启动时一次性扫描，注入 system prompt
4. **监控零侵入** — 日志记录在现有 Hooks 系统中埋点，不侵入 Agent 循环核心逻辑
5. **上下文可解释** — 每个 token 的来源可追溯，帮助用户和开发者理解"为什么上下文满了"

---

## 三、任务拆解

### M1 — 多轮对话模式（P0）

**现状**：

- `index.ts` 交互循环每次调用 `agent.runStream(...)` → 返回 → `result.messages` 被丢弃
- `base-agent.ts` 每次 `runStream` 都创建新 session（`sessionStore.createSession(...)`）
- session 的 messages 虽然写入了 SQLite（`getMessages`），但在 system prompt 组装时只作为历史追加，下一轮用户输入到模型时模型看不到上轮的 assistant 回复和工具结果——因为 `index.ts` 不传 `task.sessionId`

**根本原因**：CLI 层不传递上一轮的 `sessionId`，Agent 每次必须创建新会话。

**方案**：

#### 1.1 会话保持 (`src/index.ts`)

```typescript
let currentSessionId: string | undefined;
```

- 第一轮输入：`sessionId` 为 `undefined` → Agent 创建新 session → 存储返回的 sessionId
- 后续轮次：传入 `task.sessionId = currentSessionId` → Agent 复用同一 session
- `/new` 命令：手动清空 `currentSessionId`，开启新会话

#### 1.2 Agent 复用 session (`src/agents/base-agent.ts`)

`runStream()` 已支持 `task.sessionId` 参数（line 122）：

```typescript
const sessionId = task.sessionId ?? this.sessionStore.createSession(this.config.id).id;
```

但返回 `messages: []`（line 176 的 bug）会丢掉上下文。改为返回**摘要**而非清空。

当前设计意图是"避免内存膨胀"（注释 line 109），但更合理的是返回少量标记信息（iterations, toolCalls），messages 仅在 session store 中持久化，下次从 SQLite 读取。

#### 1.3 上下文连续性验证

- 同一 session 内，`assembleContext()` 通过 `getMessages(sessionId)` 读取历史消息（line 122），这些消息被追加到新 user 消息之前
- 关键：**每次 `runStream` 只追加一条 user 消息**，不重建 `assembleContext` 中的 system prompt 部分

#### 1.4 命令 `/chat`/`/new`

| 命令 | 行为 |
|------|------|
| 默认输入 | 使用同一 session 继续对话 |
| `/new` | 清空 currentSessionId，下一轮创建新 session |
| `/history` | 显示当前 session 最近 5 轮对话摘要 |

**改动文件**：2 (`index.ts`, `base-agent.ts`)

---

### M2 — Skill 自动沉淀（P1，Phase 4 启动）

**现状**：

- `createEvaluateSkillCreation` hook（`src/hooks/handlers.ts`）在 `onTaskComplete` 触发
- 条件：iterations >= 3 && toolCallsExecuted >= 3
- 行为：生成 `skills/pending/auto-{expert}-{hash}.md` 文件
- 缺陷：生成即丢弃（无验证、无评分、无注册），pending 目录在 `.gitignore` 中

**方案**：

#### 2.1 完整流水线

```
任务完成 (iter>=3, toolCalls>=3)
  │
  ▼
① LLM 生成 SKILL.md → skills/pending/auto-*.md
  │
  ▼
② 验证 (Validate)
  ├─ YAML frontmatter 解析成功？
  ├─ name / triggers 非空？
  ├─ 工具依赖存在？
  └─ 任一失败 → 丢弃
  │
  ▼
③ 评分 (Score, LLM)
  ├─ 1-5 星评分
  ├─ 标准: 可复用性 / 清晰度 / 触发词准确性 / 工具依赖合理性
  └─ < 3 星 → 保留在 pending/ 供人工审核
  │
  ▼
④ 注册 (Register)
  ├─ >= 3 星 → 自动移动到 skills/{expert}/ 目录
  ├─ skillRegistry.reloadSkill(path) 热加载
  └─ 通知用户: "✓ 新技能沉淀: stock-screening (4★)"
```

#### 2.2 技术实现

**新增文件**: `src/core/skill-evolution.ts`

```typescript
class SkillEvolution {
  async validate(skillPath: string): Promise<ValidationResult>;
  async score(skillPath: string): Promise<number>;  // 1-5
  async register(skillPath: string, expertId: string): Promise<boolean>;
  async evolve(messages: Message[], expertId: string): Promise<SkillEvolutionResult>;
}
```

**修改 `skill-registry.ts`**：新增 `reloadSkill(path)` 方法——热加载单个 SKILL.md。

**修改 `hooks/handlers.ts`**：`evaluateSkillCreation` hook 调用 `SkillEvolution.evolve()` 替代现有骨架生成。

#### 2.3 触发策略优化

- 当前仅 `iter>=3 && toolCalls>=3` 触发，过于宽泛
- 新增条件：任务成功率 > 0（非截断非报错）&& 涉及了至少 2 种不同工具
- 冷却期：同一 expert 每小时最多触发 3 次沉淀尝试

**改动文件**：~4（新增 1，修改 3）

---

### M3 — 工作目录智能感知（P2）

**现状**：

- `createAutoLoadProjectMemory` hook 加载 `package.json` 等关键文件存入 episodic memory
- 但这些信息在 episodic memory 中，并非在当前任务上下文中——agent 必须搜索 episodic 才能用上
- Agent 不知道项目类型、目录结构，首次对话大量 token 浪费在 `fs_list` 探索上

**方案**：

#### 3.1 新增类型 (`src/types.ts`)

```typescript
interface ProjectProfile {
  type: string;           // "node" | "python" | "rust" | "unknown"
  pkgManager: string;     // "npm" | "yarn" | "pnpm" | "pip" | "cargo"
  testFramework: string;  // "vitest" | "jest" | "pytest" | ""
  entryFile: string;      // "src/index.ts"
  topDirs: string[];      // ["src", "config", "skills", "plans"]
  keyFiles: string[];     // ["package.json", "tsconfig.json"]
}
```

#### 3.2 启动时扫描 (`src/core/project-profiler.ts`，新建)

```
扫描工作目录:
  ├─ 检测项目类型 → 文件特征匹配
  │   package.json → Node/TypeScript
  │   pyproject.toml / requirements.txt → Python
  │   Cargo.toml → Rust
  │   go.mod → Go
  ├─ 检测包管理器, 测试框架 → 分析 devDependencies
  ├─ 提取顶层目录树 (depth=1), 关键文件列表
  └─ 生成 ProjectProfile
```

#### 3.3 注入 System Prompt　(`src/core/context-manager.ts`)

在 `assembleContext()` 中新增注入点（在项目记忆和用户画像之间）：

```typescript
// 6.x 项目结构感知
if (this.projectProfile) {
  fullSystemPrompt += `\n\n--- 工作目录 ---\n`;
  fullSystemPrompt += `- 项目类型: ${this.projectProfile.type}\n`;
  fullSystemPrompt += `- 包管理器: ${this.projectProfile.pkgManager}\n`;
  fullSystemPrompt += `- 测试: ${this.projectProfile.testFramework || "未配置"}\n`;
  fullSystemPrompt += `- 目录: ${this.projectProfile.topDirs.join(", ")}\n`;
  fullSystemPrompt += `- 关键文件: ${this.projectProfile.keyFiles.join(", ")}\n`;
}
```

#### 3.4 启动加载 (`src/index.ts`)

```typescript
const profiler = new ProjectProfiler(workingDir);
contextManager.setProjectProfile(profiler.scan());
```

**改动文件**：~3（新增 1，修改 2）

---

### M4 — 对话监控日志（P1）

**现状**：

- 无任何执行日志。每次 agent run 的迭代次数、工具调用详情、耗时、异常——全部不可见
- `auditLogger` 只记录安全事件（tool block、task_complete），不记录性能/运行细节
- `session-store.ts` 有 messages 表，但只存内容不存元数据（耗时、状态、错误）
- 出问题时只有终端输出，没法回溯

**方案**：

#### 4.1 新增数据模型 (`src/types.ts` → `MonitorLog` 相关类型)

```typescript
interface TurnLog {
  id: string;
  sessionId: string;
  agentId: string;
  seq: number;                    // 第几轮对话
  userInput: string;              // 用户输入
  startedAt: number;
  finishedAt: number;
  iterations: number;
  toolCallsTotal: number;
  toolCallsSuccess: number;
  toolCallsFailed: number;
  tokensPrompt: number;
  tokensCompletion: number;
  finishReason: string;           // "stop" | "length" | "error" | "max_iter"
  error?: string;
}

interface ToolCallLog {
  id: string;
  turnId: string;
  toolName: string;
  iteration: number;               // 第几次迭代内调用的
  args: string;                    // 工具参数 (截断到 500 字符)
  startedAt: number;
  durationMs: number;              // 工具执行耗时
  success: boolean;
  resultPreview: string;           // 结果摘要 (截断到 200 字符)
  error?: string;
}
```

#### 4.2 监控数据库 (`src/memory/session-store.ts` — 新增表)

在现有的 `aiworker.db` 中新增两张表：

```sql
-- 轮次日志表
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
CREATE INDEX IF NOT EXISTS idx_turn_logs_session ON turn_logs(session_id, seq);

-- 工具调用日志表
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
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_turn ON tool_call_logs(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_tool ON tool_call_logs(tool_name);
```

#### 4.3 日志写入—通过 Hooks 埋点（零侵入）

日志写入全部通过现有的 5 个 Hook 生命周期事件完成，**不修改 Agent 循环**：

| Hook 事件 | 写入内容 |
|-----------|---------|
| `onMessage` | 创建 TurnLog 记录（seq、userInput、startedAt） |
| `onToolCallPre` | 创建 ToolCallLog 记录（toolName、args、startedAt、iteration） |
| `onToolCallPost` | 更新 ToolCallLog（durationMs、success、resultPreview、error） |
| `onTaskComplete` | 更新 TurnLog（iterations、toolCallsTotal/Success/Failed、tokens、finishReason） |
| `onError` | 更新 TurnLog（error） |

**新增 Hook handler**: `createTurnLogger` / `createToolCallLogger`

#### 4.4 查询与展示

| 命令 | 说明 |
|------|------|
| `/log` | 显示当前 session 的轮次摘要表（seq, 耗时, 迭代次数, 工具调用, 状态） |
| `/log <seq>` | 显示第 N 轮的详细信息（工具调用列表及各自耗时） |
| `/log export [path]` | 导出 session 完整日志为 JSON 或 Markdown |

CLI 渲染示例：

```
┌─────┬──────────┬──────────┬────────────┬────────┐
│ 轮次 │ 单轮耗时   │ 迭代次数  │ 工具调用     │ 状态   │
├─────┼──────────┼──────────┼────────────┼────────┤
│ 1   │ 2.3s     │ 3        │ 1/0/0      │ ✅     │
│ 2   │ 12.1s    │ 8        │ 5/0/0      │ ✅     │
│ 3   │ 4.5s     │ 2        │ 1/1/0      │ ⚠ error│
│ 4   │ 0.8s     │ 1        │ 0/0/0      │ ✅     │
└─────┴──────────┴──────────┴────────────┴────────┘

累计: 4 轮, 19.7s, 14 次迭代, 7 次工具调用, 1 次错误
```

```
/log 2                    — 展开第 2 轮详情：
  🔧 fs_read (iter 1)   12ms ✅
  🔧 fs_list (iter 2)   8ms  ✅
  🔧 terminal_exec (3)  1.2s ✅
  🔧 fs_write (iter 4)  23ms ✅
  🔧 terminal_exec (5)  3.1s ✅
  累计工具耗时: 4.4s | LLM 等待: 7.7s
```

**改动文件**：~3（`types.ts`, `session-store.ts`, `hooks/handlers.ts`，新增 handler）

---

### M5 — 上下文使用透明化（P1）

**现状**：

- `assembleContext()` 在 `context-manager.ts` 中按顺序拼接 6 层内容，但全程无 token 估算
- `compressor.needsCompression()` 只对整个 messages 数组做一次 `estimateTokens()`，不知道各层占比
- `/status` 只显示累积 token 计数，不显示当前上下文窗口的快照
- MCP 工具数量在启动日志中一闪而过，无持久展示入口

**方案**：

#### 5.1 上下文分层 token 统计 (`src/core/context-manager.ts`)

在 `assembleContext()` 中，对每一层进行 token 估算并存储：

```typescript
interface ContextBreakdown {
  systemPromptBase: number;     // Agent 人设
  projectMemory: number;        // MEMORY.md 项目信息段
  userProfile: number;          // USER.md
  episodicMemory: number;       // FTS5 检索结果
  injectedSkills: number;       // 匹配的 SKILL.md 内容
  conversationHistory: number;  // 当前 session 历史消息
  currentTurn: number;          // 当前用户消息
  total: number;
  windowSize: number;           // 模型上下文窗口
  skillsMatched: string[];      // 当前匹配的技能名列表
  skillsTotal: number;          // 总数
}
```

估算方法：对每段文本使用 `estimateTokens()`（`compressor.ts` 已有，4 字符/token 混合估算），不需要精确 tokenize。

#### 5.2 MCP 工具占用统计 (`src/mcp/mcp-manager.ts`)

```typescript
interface McpToolUsage {
  serverName: string;
  serverStatus: "connected" | "disconnected";
  toolCount: number;
  toolNames: string[];
  callsTotal: number;          // 累计调用次数
  callsFailed: number;
}
```

#### 5.3 `/context` 命令

```
/context

── 上下文占用 ──────────────────────────────────
│ 系统提示词         ████████████░░░░  1.2k/64k ( 2%)
│ 项目记忆(项目信息段)  ██░░░░░░░░░░░░  0.2k/64k ( 0%)
│ 用户画像            ██░░░░░░░░░░░░  0.1k/64k ( 0%)
│ 情景记忆(FTS5)      ████░░░░░░░░░░  0.5k/64k ( 1%)
│ 注入技能(3)         ████████░░░░░░  1.0k/64k ( 2%)
│   ├─ code-review
│   ├─ debug
│   └─ test-generation
│ 会话历史(24msg)     ████████████░░ 12.3k/64k (19%)
│ 当前消息            ██░░░░░░░░░░░░  0.1k/64k ( 0%)
│ 合计                ██████████████ 15.4k/64k (24%)
└───────────────────────────────────────────────

── MCP 工具 ────────────────────────────────────
│ builtin (connected): 4 工具, 调用 12 次/0 失败
│   • math_eval  • uuid_gen  • json_format  • timestamp_convert
│ 总计: 1 服务器, 4 工具
└───────────────────────────────────────────────
```

- 迷你模式：`/context --short` 只显示一行摘要 `[ctx: 15.4k/64k (24%) | skills: 3 | MCP: 4]`
- 进度条颜色：<60% 绿色，60-80% 黄色，>80% 红色

#### 5.4 实时状态栏集成

在 Sprint 10 T3（实时状态栏）的基础上，右侧增加上下文占用百分比：

```
[CRAFT] 执行 │ deepseek-v4-flash │ 15.4k/64k 24% │ iter 5/50
```

**改动文件**：~3（`context-manager.ts`, `mcp-manager.ts`, `index.ts`）

---

## 四、文件清单

| 任务 | 新建 | 修改 |
|------|------|------|
| M1 多轮对话 | — | `index.ts`, `base-agent.ts` |
| M2 Skill 自动沉淀 | `src/core/skill-evolution.ts` | `hooks/handlers.ts`, `core/skill-registry.ts`, `index.ts` |
| M3 目录智能感知 | `src/core/project-profiler.ts` | `context-manager.ts`, `index.ts`, `types.ts` |
| M4 对话监控日志 | — | `types.ts`, `session-store.ts`, `hooks/handlers.ts`, `index.ts` |
| M5 上下文透明度 | — | `context-manager.ts`, `mcp-manager.ts`, `index.ts` |

**汇总**：2 新建文件，10 个文件修改（去重后约 9 个）

---

## 五、验证标准

| 任务 | 验证方式 |
|------|---------|
| M1 | 首轮输入 "列出项目文件" → 第二轮输入 "刚才列了多少个？" → Agent 能回答正确（证明上下文保留） |
| M1 | `/new` → 新对话从空白开始，不再引用上轮内容 |
| M2 | 执行复杂任务（3+ 工具调用）→ 完成时看到 "✓ 新技能沉淀: xxx (4★)" → `skills/{expert}/` 目录出现新 SKILL.md |
| M2 | 低质任务 → 无沉淀或沉淀在 `pending/` 目录 |
| M3 | 启动后在日志中看到 "项目: Node/TypeScript, npm, vitest, 8 个顶层目录" |
| M3 | 首次对话中 agent 直接引用项目结构，无需调用 `fs_list` 探索 |
| M4 | `/log` 显示当前 session 完整轮次摘要表（轮次/耗时/迭代/工具/状态） |
| M4 | `/log 2` 展开第 2 轮详情，列出每个工具调用及耗时 |
| M4 | `/log export monitor.json` → 打开文件可验证 JSON 结构完整 |
| M5 | `/context` 显示上下文分层 token 占比 + MCP 工具列表 |
| M5 | `/context --short` 输出一行摘要 `[ctx: 15.4k/64k 24%]` |
| M5 | 执行 3 轮以上对话后 `/context` 能看到会话历史和 token 增长趋势 |
| 回归 | `npm run build` 通过，`npm test` 85 项全过 |
