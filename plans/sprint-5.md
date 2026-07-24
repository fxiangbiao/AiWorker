# Sprint 5 — 终端交互体验升级

## 目标

将当前"黑盒等到底"的交互提升到业界 CLI AI Agent 标配水平：
1. Streaming 逐 token 输出 + "思考中" loading 提示
2. 底部状态栏：模型 + 模式 + 上下文占用 + 快捷命令（输入行在上，状态栏在绝对底部）
3. 用户输入排队：Agent 运行期间捕获输入，任务完成后确认发送

## 目标布局

```
┌─────────────────────────────────────────┐
│                                         │  ← 内容区（正常滚动）
│  AiWorker[编码工程师] >                  │
│  ```python                               │
│  def sort(arr): ...                      │
│  ```                                     │
│  [迭代: 2, 工具调用: 1]                 │
│                                         │
├─────────────────────────────────────────┤
│ 你> _                                    │  ← 输入行（N-2）
├─────────────────────────────────────────┤
│ craft · deepseek-v4 · 1.2k/8K  /help    │  ← 状态栏（N-1，反色）
└─────────────────────────────────────────┘
```

---

## 模块拆解

### 模块一：终端渲染器 `src/terminal/`

新增 3 文件，无新依赖。

| 文件 | 职责 | 行数 |
|------|------|:--:|
| `ansi.ts` | ANSI 转义码工具：光标控制、颜色、反色 | ~50 |
| `renderer.ts` | TerminalRenderer：布局管理，内容区+状态栏+输入行 | ~150 |
| `input.ts` | InputCollector：替代 inquirer，支持异步捕获+排队 | ~100 |

### 模块二：Streaming 响应

| 文件 | 改动 |
|------|------|
| `types.ts` | 新增 `StreamChunk`、`StreamCallbacks` 类型 |
| `model-router.ts` | 新增 `completeStream()` — AsyncGenerator，逐 chunk 产出 |
| `agent-loop.ts` | 新增 `runAgentLoopStream()` — 流式循环 + AbortSignal + 回调 |

### 模块三：CLI 集成

| 文件 | 改动 |
|------|------|
| `index.ts` | 重写：renderer 替代 console.log + console.error，input collector 替代 inquirer，排队 UI |

---

## 实现步骤

### P0：核心渲染 + Streaming

| # | 内容 | 风险 |
|:--:|------|:--:|
| 1 | 新建 `src/terminal/ansi.ts` | 无 |
| 2 | 新建 `src/terminal/renderer.ts` | 中 |
| 3 | 新建 `src/terminal/input.ts` | 低 |
| 4 | `types.ts` — 新增类型 | 无 |
| 5 | `model-router.ts` — `completeStream()` | 低 |
| 6 | `agent-loop.ts` — `runAgentLoopStream()` | 中 |
| 7 | `index.ts` — 重写 CLI | 高 |
| 8 | `smoke-test.ts` — 扩展测试 | 低 |

### P1：打磨（后续迭代）

| # | 内容 |
|:--:|------|
| 9 | Token 计数精确化 |
| 10 | `/status` 命令展开详情 |
| 11 | 语法高亮（Markdown/code block） |
| 12 | 工具输出截断优化 |

---

## 关键技术决策

- **不用 inquirer**：仅有 `type: "input"` 用途，用原生 `readline` 替代更可控
- **不用 alternate screen buffer**：保留 scrollback history，不进入全屏模式
- **不用 blessed/ink**：零 UI 库依赖，纯 ANSI 转义码
- **软排队而非强打断**：Agent 运行中的输入缓存到队列，任务完成后预填到输入行让用户确认
- **保留原有 `completeWithProfile()`**：新增 `completeStream()` 并行存在，避免破坏现有调用
