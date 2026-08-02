# Sprint 14: TUI 终端升级

> AiWorker 终端交互与视觉打磨 — 对标业界 CLI（Claude Code / Aider / gh）

---

## 一、核心目标

| 维度 | 目标 |
|------|------|
| 视觉 | Markdown 终端渲染（流式直接渲染：fence 状态机 + 代码块边框） |
| 布局 | 工具调用紧凑行 + 常驻底部状态栏（降级策略明确） |
| 交互 | 运行中断（Esc/Ctrl+C）、历史持久化、Tab 补全 |
| 会话 | `/sessions` 浏览 + `/switch` 恢复上下文 |
| 展示 | 文件 diff 计数（已实现）+ 正文（扩展 onFileDiff 签名） |

**范围排除**: 全屏交替缓冲 + 回看（V5）移出本 Sprint → 独立 Sprint 15 规划。

---

## 二、现状调研 + 业界对标差距

### TUI 架构
- `src/index.ts` (846 行) — 主循环 + 命令处理 + spinner + 流式回调全部内联
- `src/terminal/renderer.ts` (195 行) — 一次性状态栏 + readline prompt
- `src/terminal/input.ts` (97 行) — raw mode 输入收集器（仅排队，无中断）
- `src/terminal/ansi.ts` — VT 序列启用

### 与业界 CLI 的差距矩阵

| 能力 | Claude Code / Aider / gh | AiWorker 现状 | 差距等级 |
|------|--------------------------|---------------|---------|
| Markdown 渲染 | 标题/列表/粗体/代码块带边框 | 纯 `stdout.write` 无渲染 | 🔴 大 |
| 代码块 | 边框 + 语言标签 + 语法高亮 | 无 | 🔴 大 |
| 工具调用 | 紧凑行：名称/参数/耗时/状态 | 单行 `🔧 name` + `✓ summary` | 🟠 中 |
| 文件 diff | 彩色 +/- 行展示 | 无（Web UI 有，TUI 无） | 🟠 中 |
| 状态栏 | 常驻底部栏实时刷新 | 一次性 `printStatus` 后消失 | 🟠 中 |
| 全屏滚动 | 交替屏幕缓冲可回看 | 无 → **移出本 Sprint** | — |
| 迭代进度 | 多工具迭代计数 | 无 | 🟡 低 |
| 语法高亮 | 关键字着色 | 无 | 🟠 中 |

### 底层能力验证（已确认可行）
- ✅ `agent-loop.ts:185` — `runAgentLoopStream` 已支持 `signal?: AbortSignal`（行 209/240/273/374）
- ✅ `types.ts:109-118` — `StreamCallbacks` 含 `onToolCall/onToolResult/onFileDiff`（onFileDiff 仅在 hooks 链路触发，不走 agent-loop）
- ⚠️ `onToolResult` **缺 id**（types.ts:114）— V2 需加 id 参数（见 G5）
- ✅ `session-store.ts` — `createSession/ensureSession/getMessages/getTurnLogs`
- ✅ `context-manager.ts:236` — `assembleContext` 按 sessionId 加载历史，切换后自动生效
- ✅ `onFileDiff` 链路**已通** — index.ts:125 注入 deps + handlers.ts:330 触发 + hooks.json 已注册（仅缺 diff 正文，见 D1）
- ⚠️ `StreamCallbacks` **无迭代级回调** — V3 需新增 `onIterationStart`（见 D6）

---

## 三、已识别缺陷与修正决策

> 三轮审阅共识别 12 项。第三轮确认 server 不受 onFileDiff 影响，发现 G2-G6（Esc 冲突 / index.ts 膨胀 / fs_edit 不存在 / onToolResult 缺 id / liveStatus 重复）。

### D1 (🔴→✅ 已修正误判): V4 diff 数据流
**初版误判**: 认为 `onFileDiff` 数据链路断裂。**实测纠正**: 链路**已通**：
- `index.ts:125-129` 已向 `loadHooksFromConfig` deps 注入 `onFileDiff` → 打印 `📄 path +3 -1`
- `handlers.ts:330` `captureDiff` 在 `onToolCallPost` 已触发 `deps.onFileDiff`
- `config/hooks.json` 中 `captureDiff` 已注册（onToolCallPre + onToolCallPost）

**结论**: V4 计数行预览**已实现**，无需打通链路。剩余工作只有 diff **正文**：`handlers.ts:568` `computeSimpleDiff` 返回了 `text`，但 `onFileDiff` 签名（handlers.ts:26）只传 `filePath/added/removed`，正文拿不到。
**修正**: 扩展 `HandlerDependencies.onFileDiff` 签名传 `diffText`，TUI 侧渲染正文。低风险改动。

### D2 (🔴): V1 两阶段设计的阶段 B 在滚动终端不可行
**实测发现**: 流式 `stdout.write` 已输出的行无法擦除（滚动终端无区域重绘能力），阶段 B"静态渲染替代已输出"不可实现。
**修正**: **放弃两阶段**，改为**流式阶段直接渲染**——fence 状态机逐行处理，代码块即时画边框（业界 Claude Code 同此方案）。用缓冲行策略：累积到 `\n` 才输出一行，代码块 fence 状态机跟踪开合，边框线逐行输出。

### D3 (🟠): V2 工具卡片与并发冲突
`agent-loop.ts:304` 工具用 `Promise.all` 并发执行，`onToolCall`(行 288) 与 `onToolResult` 顺序交错，跨行卡片开/封状态错乱。
**修正**: V2 改为**单行紧凑式**：`🔧 fs_write ⌁ 3s ✓`（名称+耗时+状态同行），不做跨行卡片。避免并发状态管理。

### D4 (🟠): V3 状态栏与输出竞争终端
流式 `stdout.write` 与状态栏 `\r\x1b[2K` 抢行，Windows 兼容陷阱（AGENTS.md 已记载）。
**修正**: 明确降级策略：
- **输出进行中** → 状态栏暂停（不渲染），避免光标竞争
- **空闲 / 思考期 / 工具执行间隙** → 状态栏常驻刷新
- 降级触发 = `onTextDelta`/`onToolResult` 开始；恢复 = 输出停顿 200ms 后

### D5 (🟡): V5 全屏与 readline 架构冲突
全屏需接管方向键输入 + 重写交互层，工作量≈mini TUI 框架。
**修正**: **移出本 Sprint**，独立 Sprint 15 单独规划。

### D6 (🟠): V3 状态栏 `iter 2/10` 无数据源
`agent-loop.ts` 流式循环（208-346）**无迭代级回调**，`iterations` 是内部局部变量。TUI 无法拿到当前迭代数。
**修正**: 方案 A — 在 `agent-loop.ts:232` `onThinkingStart` 前增加 `callbacks.onIterationStart?.(iteration)`；方案 B — TUI 侧用 `onThinkingStart` 计数。**首选 A**（agent-loop 改 1 行 + StreamCallbacks 加 1 字段）。

### D7 (🟠): V2 对 `onToolCall` args 判断错误
`agent-loop.ts:288` 实际传**完整 args**（`acc.args`，Sprint 13 已修复），非"并发下无序不可靠"。
**修正**: V2 可保留 args 摘要展示（前 40 字），不必舍弃。

### G2 (🔴): T1 Esc 中断与 ANSI 方向键冲突（第三轮新发现）
`input.ts:31` InputCollector **逐字符**处理，方向键 `\x1b[A` 首字节即 `\x1b`，会被误判为 Esc 中断。
**修正**: **放弃 Esc，仅保留 Ctrl+C 连按中断**（raw mode 下 Ctrl+C = `\x03` 字节，无冲突）。Esc 若需保留，须加 10ms 短窗口判断后随非 `[` 才算，复杂度高不划算。

### G3 (🟠): index.ts 膨胀风险（第三轮新发现）
V1 缓冲行 + V2 工具行 + V3 状态栏全部落在 `onTextDelta/onToolCall/onToolResult` 回调，index.ts 已 846 行，将膨胀至 1100+。
**修正**: 抽独立 `src/terminal/output.ts` 提供 `StreamOutputRenderer` 类，封装缓冲行 + fence 状态机 + 工具行渲染；index.ts 只接线。

### G4 (🟠): V2/V4 引用不存在的 `fs_edit` 工具（第三轮新发现）
内置工具只有 fs_read/fs_write/fs_list/terminal_exec/web_search/web_fetch；`captureDiff` 只处理 `fs_write`（handlers.ts:285）。**`fs_edit` 不存在**。
**修正**: 计划中所有 `fs_edit` 引用改为 `fs_write`。

### G5 (🔴): `onToolResult` 无 id，V2 工具行无法关联（第三轮新发现）
`onToolCall` 签名含 `id`（types.ts:113），但 `onToolResult` 只有 `(name, success, summary)`（types.ts:114）。多工具并发或同名工具时，onToolCall 与 onToolResult 无法配对，耗时归属错乱。
**修正**: `StreamCallbacks.onToolResult` 增加 `id` 参数；`agent-loop.ts:311` 传 `result.tool_call_id`。TUI 用 `Map<id, startTime>` 关联 + 计算耗时。

### G6 (🟠): V3 与现有 spinner/liveStatus 机制重复（第三轮新发现）
index.ts:654-677 已有 `startLiveStatus`/`stopLiveStatus`（500ms interval + `updateLiveStatus` 刷新状态）。V3 另建 `enablePersistentStatus` 会与现有机制双头竞争。
**修正**: **复用现有 liveStatus 机制**，扩展其内容（加 iter/工具名），不新建第二套；V3 改为改造 `startLiveStatus` + `renderer.updateLiveStatus` 的调用时机（空闲期也常驻）。

---

## 四、任务分解

### 视觉里程碑 — M14-V（核心，先行）

#### V1: Markdown 终端渲染器（流式直接渲染）  ⭐⭐
**现状**: Agent 回答直接 `stdout.write(text)`，代码块/标题/列表全是裸文本。
**设计决策（D2 修正 + G3 结构）**: 放弃两阶段，流式阶段直接渲染；渲染逻辑抽到独立类：
- 新建 `src/terminal/markdown.ts` — 纯函数渲染器（**不引入重依赖**，自研）：`renderLine(line, inFence)` / `renderMarkdown(text)` 整块渲染
- 新建 `src/terminal/output.ts` — `StreamOutputRenderer` 类：缓冲行 + fence 状态机 + 工具行渲染，封装 `writeChunk(text)` / `writeToolCall(...)` / `writeToolResult(...)` 方法（G3: 避免 index.ts 膨胀）
- **缓冲行**: 累积 chunk 直到 `\n` 才渲染输出一行（代码块内逐行输出），保证流式实时性且边界完整
- **渲染规则**：
  - 代码块 ` ```lang ` → 首行 `┌─ [lang] ─┐`，内容行 `│ 缩进内容`，闭合行 `└─ ─┘`（fence 状态机跟踪开合）
  - 标题 `#/##/###` → 加粗 + 主题色 + 分隔线
  - 列表 `- / 1.` → 缩进 + 符号着色
  - 粗体 `**x**` / 行内代码 `` `x` `` → chalk 样式
  - 表格 → 复用 `padToWidth` 对齐
- **边界降级**: 未闭合代码块（截断）→ 关闭时自动补底框；fence 嵌套等异常 → 降级为纯文本行
- 完整回答的 `result.text` 走同一渲染管线（复用 renderMarkdown 输出整块）

#### V2: 工具调用紧凑行（保留 args 摘要 + id 关联）  ⭐
**现状**: `onToolCall` 单行 `🔧 name`，结果单行 `✓ summary`。
**设计决策（D3+D7+G5 修正）**: 单行紧凑式 + args 摘要 + **id 配对**：
- **前置（G5）**: `StreamCallbacks.onToolResult` 加 `id` 参数（types.ts:114），agent-loop.ts:311 传 `result.tool_call_id`
- `onToolCall(name, args, id)` → `🔧 fs_write <args前40字>`，TUI 记录 `Map<id, startTime>`
- `onToolResult(name, success, summary, id)` → 同 id 行更新 `🔧 fs_write ⌁ 3s ✓ summary`（G5: 用 id 配对，支持并发）
- 失败 → `✗` + 红色，完整错误留到后续行展示
- 文件写入工具 `fs_write` → 行尾附加 `(+3 -1)` 计数（V4 提供）

#### V3: 常驻底部状态栏（复用 liveStatus + 降级 + iter 数据源）  ⭐
**现状**: `renderer.printStatus` 只打一次；已有 `startLiveStatus`/`stopLiveStatus`（index.ts:654-677）但仅思考期激活。
**设计决策（D4+D6+G6 修正）**: 复用现有 liveStatus 机制，扩展覆盖范围：
- **不新建第二套状态栏**（G6）: 改造现有 `startLiveStatus` 使其在**空闲 + 思考 + 工具间隙**都激活；扩展 `renderer.updateLiveStatus` 支持 iter/工具名
- 内容: `[模式] 模型 token/8000 │ iter 2/10 │ 排队:1 │ 工具:fs_write`
- **迭代数据源（D6）**: `StreamCallbacks` 加 `onIterationStart?.(iteration)`，`agent-loop.ts:232` 前触发；TUI 计数显示
- **降级策略（D4）**: 输出进行中暂停渲染；空闲/思考/工具间隙常驻；200ms 静默恢复
- 输入提示符固定在状态栏上方

#### V4: 文件 diff 计数（链路已通） + 正文（扩展签名）  ⭐⭐
**现状（D1 实测）**: 计数行已实现（`index.ts:125-129` + `handlers.ts:330` + hooks.json 已注册）。
**剩余工作**:
- 扩展 `HandlerDependencies.onFileDiff` 签名 → 增加 `diffText`（`handlers.ts:26` 类型 + `:330` 传参 + index.ts 回调）
- TUI 渲染: `△ path (+3 -1)` 计数行 + 折叠可展开的 diff 正文（`+` 绿 `-` 红，复用 `computeSimpleDiff` 的 text）

### 功能里程碑 — M14-F（交互）

#### T1: Agent 运行中断 (AbortSignal 接入)
**现状**: `agent.runStream()` 未传 signal，InputCollector 只排队。
**改动**:
- 主循环持 `AbortController`，runStream 前创建，传第 5 参（base-agent.ts:125 已支持）
- `input.ts` 注入 `onInterrupt` 回调 — **Ctrl+C 连按**触发 `controller.abort()`（G2: 放弃 Esc，避免方向键冲突）
- 中断后：`⏹ 已中断` → 收集排队输入 → 回到输入态
- **Ctrl+C 状态机**: 空闲=退出 / 运行中(第一次=排队, 第二次=中断)

#### T2: readline 命令历史持久化
**现状**: 每次新建 `createInterface`，历史不保留。
**改动**: `src/terminal/history.ts` 工具（load/append/dedupe），`~/.aiworker_history` 500 条，readline `historySize` 200。

#### T3: Tab 命令 + 技能名补全
**改动**: `prompt()` 增加 `completer`，闭包注入命令表 + `skillRegistry` 技能名。

#### T4: 多会话浏览 + 切换
**改动**: `session-store.listSessions(limit=20)` + `/sessions` + `/switch <id|序号>`。已验证 `assembleContext` 按 sessionId 加载历史。

#### T5: 输出体验增强
- token 实时显示（V3 已含）、`/tee [file]` 日志落盘（可选）

#### T6: 原始 Markdown 复制（Web 按钮 + TUI /copy）
**动机**: TUI Markdown 渲染美化后，终端复制会带边框/转义码，无法拿到原始内容。
**改动**:
- Web UI: 回答卡片右上角「⧉ 复制」按钮（`data-md` 存原始内容，copyAnswer 用 clipboard API + execCommand fallback）
- TUI: `/copy` 命令 → `copyToClipboard()`（Windows clip.exe / macOS pbcopy / Linux xclip，spawn 写入）
- 记录 `lastAnswerRaw = result.text` 供 /copy 使用

---

## 五、验收标准

| 任务 | 验证方式 |
|------|---------|
| V1 | 流式阶段代码块即时画边框（首行 `┌─ lang ─┐`、内容 `│` 缩进、闭合补底框）；标题加粗着色；表格对齐；未闭合代码块自动补框 |
| V2 | 工具调用单行紧凑显示：`🔧 fs_write <args前40字> ⌁ 3s ✓ summary`；并发工具按 id 配对正确；失败红色 ✗ |
| V3 | 空闲/思考期状态栏常驻含 iter 计数；输出进行中暂停；200ms 静默恢复；输入提示符不丢失 |
| V4 | fs_write 后打印 `△ path (+3 -1)` + 可展开 diff 正文（+绿/-红） |
| T1 | 运行中 **Ctrl+C 连按**中断回输入态不崩溃；按方向键不误触发中断 |
| T2 | 重启后上下键仍翻出历史 |
| T3 | Tab 补全 `/命令` + `/sk` 补全技能名 |
| T4 | `/sessions` 列出 + `/switch` 恢复上下文（token/cost 为全局累计，明确标注） |
| T6 | Web UI「⧉ 复制」按钮 + TUI `/copy` 命令复制原始 Markdown |

回归: `npm test` (92 全绿) + `npx tsc --noEmit` + `npx eslint .`

---

## 六、里程碑

- **M14-V**: V1 (流式 Markdown 渲染) + V2 (工具紧凑行) + V3 (降级状态栏 + iter 数据源) — 视觉核心，先行
- **M14-V4**: V4 diff 正文（onFileDiff 签名扩展）
- **M14-F**: T1 中断 → T2 历史 → T3 补全 → T4 会话
- **M14-T**: 回归 + 文档

---

## 七、风险

| 风险 | 应对 |
|------|------|
| Windows raw mode + readline 冲突（中断与 inputCollector 共存） | 中断逻辑放 InputCollector，readline 阶段不监听 Esc |
| 底部状态栏与流式输出光标错位（Windows 尤其） | 降级策略（D4）: 输出中暂停，200ms 静默恢复 |
| Ctrl+C 语义与进程退出冲突 | 状态机: 空闲(退出) / 运行(第一次排队 / 第二次中断) |
| Markdown 渲染器 CJK 对齐 | 复用 `displayWidth`/`padToWidth` 现有工具 |
| 自研渲染器边界情况（嵌套代码块、极长行、截断） | fence 状态机只跟踪 ``` 行；未闭合自动补底框；异常降级纯文本 |
| 缓冲行策略影响流式实时性 | 累积到 `\n` 输出一行；长无换行行按 120 列硬切 |
| V1 渲染增加输出延迟 | 行级渲染 O(n)，仅对代码块加边框，普通文本轻量着色 |
| 历史文件在 CI 无 home 目录 | `os.homedir()` fallback 到 data-dir |
| onFileDiff 签名扩展影响 Web Server deps | `diffText` 可选参数，未传则兼容现状（Web UI 不受影响） |
| iter 数据源（D6）改动 agent-loop 引入回归 | `onIterationStart` 可选回调，不破坏现有调用方 |
| 方向键 `\x1b[A` 首字节被误判为中断（G2） | 放弃 Esc，仅 Ctrl+C 连按中断（\x03 字节无冲突） |
| index.ts 膨胀至 1100+ 行（G3） | 渲染逻辑抽 `StreamOutputRenderer` 独立类，index.ts 只接线 |
| Ctrl+C 连按的时间窗口过宽/过窄 | 首次按下后 2s 内第二次按下算中断，超时重置为"排队" |
| onToolResult 加 id 影响其他调用方（server.ts/plan） | id 可选参数（`id?: string`），未传则按 name 降级匹配，不破坏现有调用 |
| 状态栏复用 liveStatus 后思考/空闲切换闪烁 | 沿用现有 500ms interval，切换时机与 D4 降级策略一致 |

---

## 八、后续 Sprint 15（范围外预告）

- 全屏交替缓冲（`/fullscreen`）+ ↑/↓/PgUp/PgDn 回看
- 需重写交互层（方向键接管），独立规划
