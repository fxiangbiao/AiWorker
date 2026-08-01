# Sprint 10：TUI 交互全面升级

> **目标**：交互体验对标主流 AI Code/Agent 工具（Claude Code、Cursor、Codex、OpenCode），补齐思考展示、进度可视化、实时状态栏三大缺口。
> **预计工时**：~10h（6 个模块）

---

## 一、现状诊断

| 维度 | 问题 | 对标差距 |
|------|------|---------|
| 思考展示 | 只有 spinner "思考中..." | Claude Code / Cursor 展示 `reasoning` 内容 |
| reasoning_content | `completeStream()` 只监听 `delta.content`，DeepSeek R1 等模型的 `reasoning_content` 直接丢弃 | 新模型推理能力完全浪费 |
| Plan 执行 | 规划阶段 spinner，执行阶段完全黑盒 | 包含 4-5 步的 plan 可能等 2-5 分钟，用户不知道在执行哪一步 |
| 状态栏 | 仅在 Agent 回答完成后才打印一次 | 主流工具在底部常驻实时更新的状态栏 |
| 帮助 | 一行灰字列出命令名，无描述 | 现代 CLI 都有结构化命令表 |
| Token 成本 | `totalTokensUsed` 计数器存在但不区分 prompt/completion，无价格计算 | 所有付费 API 工具都显示成本 |
| 文件 diff | `captureDiff` hook 已记录到审计日志，但 CLI 不展示 | Agent 写文件后用户不知道改了什么 |

---

## 二、设计原则

1. **ANSI 序列，零 UI 依赖** — 所有渲染基于 `src/terminal/ansi.ts` 已实现的 ANSI 控制序列（`moveTo`、`savePosition`、`clearLine`、`reverseVideo` 等），不引入 ncurses/blessed 等重量库
2. **流式优先** — 思考内容、执行进度、状态栏均为流式更新，不等完整结果
3. **折叠可见** — 思考内容默认折叠（灰色一行摘要），展开用快捷键；不干扰正文阅读
4. **渐进增强** — T1→T3 覆盖最大痛点，T4→T6 锦上添花

---

## 三、任务拆解

### T1 — 思考内容可视化（reasoning_content）

**优先级**：P0 — 核心功能缺失

**现状**：
- `StreamChunk` 类型只有 `text | tool_call_start | tool_call_delta | tool_call_done | done | error`，无 thinking 类型
- `StreamCallbacks` 只有 `onThinkingStart` 无 `onThinkingDelta`
- `completeStream()` 仅处理 `delta.content` 和 `delta.tool_calls`
- 流式循环（`agent-loop.ts`）的 switch 没有 thinking case

**方案**：

#### 1.1 类型扩展 (`src/types.ts`)

```diff
 StreamChunk:
+  type: "thinking"      // 新增
 StreamCallbacks:
+  onThinkingDelta?: (text: string) => void;
```

#### 1.2 ModelRouter 解析 reasoning_content (`src/core/model-router.ts`)

```typescript
// 在 for await (const chunk of stream) 循环内：
const delta = chunk.choices?.[0]?.delta;

// 新增: 解析 reasoning_content (DeepSeek R1 等新模型)
const reasoning = (delta as Record<string, unknown>)?.reasoning_content as string | undefined
  ?? (delta as Record<string, unknown>)?.thinking as string | undefined;
if (reasoning) {
  yield { type: "thinking" as const, content: reasoning };
}
```

#### 1.3 AgentLoop 转发 (`src/core/agent-loop.ts`)

在 `runAgentLoopStream` 的 `switch(chunk.type)` 中新增：

```typescript
case "thinking":
  callbacks.onThinkingDelta?.(chunk.content!);
  break;
```

#### 1.4 CLI 折叠渲染 (`src/index.ts`)

- 默认显示灰色一行摘要：`🧠 思考: ${firstLine}...`
- `--show-thinking` 参数或 `/thinking` 命令切换完整展示
- 完整展示时用 `chalk.dim` / `chalk.gray` 区分思考与正式回复
- 存储最近的完整思考文本到 `let lastThinking = ""`，支持展开

**改动文件**：4 (`types.ts`, `model-router.ts`, `agent-loop.ts`, `index.ts`)

---

### T2 — Plan 执行进度可视化

**优先级**：P0 — 用户体验影响大

**现状**：
- `/plan` 执行完全黑盒——用户不知道哪个步骤在跑、当前进度
- `TeamCoordinator.execute()` 中的 `callbacks.onToolCall` 只在步骤完成时触发
- 无步骤状态机

**方案**：

#### 2.1 步骤状态机 (`src/core/team-coordinator.ts`)

ExecutionStep 执行周期：
```
pending → running → done | failed | skipped
```

新增 `stepResults` Map 存储结构化结果（含状态）：
```typescript
interface StepProgress {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  content: string;
  elapsed: number;  // ms
}
```

#### 2.2 回调扩展 (`src/types.ts` → `StreamCallbacks`)

```diff
 StreamCallbacks:
+  onStepStart?: (stepId: string, expertId: string, desc: string) => void;
+  onStepEnd?: (stepId: string, success: boolean) => void;
```

#### 2.3 CLI 进度渲染 (`src/index.ts`)

步骤列表实时更新策略：

```
执行前:  ⚪ s3: game-dev — 设计核心玩法循环
执行中:  🔵 s3: game-dev — 设计核心玩法循环 (进行中...)
完成:    ✅ s3: game-dev — 设计核心玩法循环
失败:    ❌ s3: game-dev — 设计核心玩法循环 (已跳过)
```

利用 ANSI `moveUp(N)` + `clearLine()` 在步骤列表区域局部刷新，不干扰流式正文输出。

**改动文件**：3 (`types.ts`, `team-coordinator.ts`, `index.ts`)

---

### T3 — 实时常驻状态栏

**优先级**：P1 — ANSI 基础设施已就绪

**现状**：
- 状态栏仅在 Agent 响应完成后打印一次（`index.ts:444-452`）
- `src/terminal/ansi.ts` 已有 `savePosition()`、`moveTo()`、`clearLine()` 但未用于常驻状态栏
- `renderer.printStatus()` 用普通 `stdout.write` + `\n`

**方案**：

#### 3.1 底部固定行布局 (`src/terminal/renderer.ts`)

新增 `startPersistentStatus()` / `updateStatus()` / `stopPersistentStatus()` 方法：

```
启动时:
  1. stdout.write("")  —  预留底部一行
  2. savePosition()    —  记住状态栏位置

流式输出期间:
  3. 文本输出在状态栏上方滚动
  4. updateStatus(data) → savePosition() → 输出新状态 → restorePosition()

结束时:
  5. stopPersistentStatus() → 最终状态 + 释放固定行
```

#### 3.2 更新频率控制

- debounce 200ms：避免高频 token 更新导致闪烁
- 每次 `onTextDelta` 触发时累计 token 数，debounce 后一次性写入状态栏

#### 3.3 状态栏内容

```
[CRAFT] 执行 │ deepseek-v4-flash │ 12.3k/64k tokens │ iter 5/50 │ 🛠 reading fs_read
```

- 左侧：模式 + 模型 + token 用量 + 迭代
- 右侧：当前工具名（有工具调用时），否则快捷命令提示
- 颜色：token > 80% 黄色，95% 红色

**改动文件**：2 (`terminal/renderer.ts`, `index.ts`)

---

### T4 — 帮助系统优化

**优先级**：P1

**现状**：
- `/help` 单行灰字列出命令名，无描述
- 无上下文提示

**方案**：

#### 4.1 结构化命令表

```
┌───────────────┬─────────────────────┬──────────────────────────────┐
│ 命令           │ 示例                │ 说明                          │
├───────────────┼─────────────────────┼──────────────────────────────┤
│ /plan <描述>   │ /plan 开发一个游戏    │ 多专家 DAG 协作               │
│ /debate <话题> │ /debate React vs Vue │ 双专家辩论                    │
│ /mode <模式>   │ /mode ask           │ 切换权限: ask/plan/craft      │
│ /skill <名称>  │ /skill code-review  │ 手动激活技能                  │
│ /status        │ —                   │ Token 用量、模型、排队状态     │
│ /thinking      │ —                   │ 切换思考内容显示               │
│ /help          │ —                   │ 显示此帮助                    │
│ /exit          │ —                   │ 退出                          │
└───────────────┴─────────────────────┴──────────────────────────────┘
```

#### 4.2 上下文提示

- 空输入按 Enter：不再直接跳过，显示 `输入 /help 查看帮助，或直接输入任务`
- 输入 `?`：显示上下文相关的提示（例如上一步是文件操作，提示可用工具）

**改动文件**：1 (`index.ts`)

---

### T5 — Token 用量与成本统计

**优先级**：P2

**现状**：
- `ModelRouter.totalTokensUsed` 不区分 prompt/completion
- 无定价信息

**方案**：

#### 5.1 定价配置 (`config/models.json`)

```json
{
  "pricing": {
    "deepseek": { "prompt": 0.14, "completion": 0.28 },
    "qwen":     { "prompt": 0,    "completion": 0 }
  }
}
// 单位: $/1M tokens
```

#### 5.2 分项计数 (`model-router.ts`)

```typescript
totalPromptTokens: number;
totalCompletionTokens: number;
getCost(): number;  // prompt × p.price + completion × c.price
```

#### 5.3 展示

- `/status`: 显示 prompt/completion tokens + 累计成本
- 响应 footer: `[in:2.3k, out:567, $0.0003 │ iter:3, tools:5]`

**改动文件**：2 (`config/models.json`, `model-router.ts`)

---

### T6 — 文件变更摘要展示

**优先级**：P2

**现状**：
- `createCaptureDiff` hook 已在 `onToolCallPost` 中计算 diff 并写入审计日志
- CLI 完全不展示

**方案**：

#### 6.1 回调新增 (`types.ts`)

```diff
 StreamCallbacks:
+  onFileDiff?: (filePath: string, added: number, removed: number) => void;
```

#### 6.2 触发路径

- `fs_write` 执行成功后，在 `agent-loop.ts` 中的工具结果处理阶段调用钩子通知 CLI
- 也可由 `captureDiff` hook 直接通过新的事件通道发送

#### 6.3 CLI 渲染

```
  📄 src/index.ts (+12 -3)
```

**改动文件**：2 (`types.ts`, `index.ts`)

---

## 四、文件清单

| 任务 | 新建 | 修改 |
|------|------|------|
| T1 思考可视化 | — | `types.ts`, `model-router.ts`, `agent-loop.ts`, `index.ts` |
| T2 Plan 进度 | — | `types.ts`, `team-coordinator.ts`, `index.ts` |
| T3 实时状态栏 | — | `terminal/renderer.ts`, `index.ts` |
| T4 帮助优化 | — | `index.ts` |
| T5 Token 成本 | — | `config/models.json`, `model-router.ts` |
| T6 文件 diff | — | `types.ts`, `index.ts` |

**汇总**：0 新建文件，最多 8 个文件修改（去重后）

---

## 五、验证标准

| 任务 | 验证方式 |
|------|---------|
| T1 | `--show-thinking` 启动 → 输入问题 → 看到灰色思考内容 → `/thinking` 切换折叠/展开 |
| T2 | `/plan <任务>` → 执行过程中看到每个步骤状态实时更新 |
| T3 | 启动后底部常驻状态栏 → 流式输出期间 token 数实时更新 → 工具调用时显示工具名 |
| T4 | `/help` 看到表格 → `?` 看到上下文提示 |
| T5 | `/status` 显示分项 token 和成本 → 响应 footer 含成本 |
| T6 | Agent 写文件后 CLI 显示 `📄 path (+N -M)` |
| 回归 | `npm run build` 通过，`npm test` 85 项全过 |
