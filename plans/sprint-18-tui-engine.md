# Sprint 18: TUI 引擎重写

> 彻底重写终端交互层 — 对标 Pi TUI（屏幕缓冲 + 差分渲染 + 组件化），解决状态栏消失根因。

---

## 一、目标摘要

以**屏幕缓冲 + 差分渲染**为核心重建 TUI 引擎：状态栏作为每帧固定组成（物理上不消失），raw-mode 键处理替换 readline（消除光标竞争与 50ms hack），组件化消息区/输入区/状态栏。零新依赖，保留现有模块兼容导出。

## 二、现状问题与根因

| 问题 | 根因 |
|------|------|
| 状态栏不显示/消失 | 内容直接 `stdout.write` 流式输出，与状态栏写入竞争终端光标；无"屏幕缓冲 + 差分重绘"，被覆盖后无法恢复 |
| readline 与全屏冲突 | `renderer.prompt()` readline（终端模式）与 `InputCollector`（raw mode）切换产生 50ms hack、光标错位 |
| 无差分渲染 | 每次输出全量重绘 → 闪烁、性能差、无法精确控制单行更新 |
| 无 resize 处理 | SIGWINCH 后布局错乱 |
| 组件逻辑散落 | 消息/输入/状态栏逻辑内联在 index.ts（965 行） |

## 三、任务拆分

### T1: Screen 帧缓冲 + 差分渲染引擎 ⭐⭐ (P0)
**新建 `src/terminal/screen.ts`**
- `Screen` 类：持有 rows×cols 帧缓冲，`render(lines[])` 对比上一帧只写变化行
- ANSI 安全：行尾补 SGR 重置，样式不跨行泄漏
- CJK 宽度：`displayWidth` 精确换行/截断
- 全帧清屏 / 部分更新两策略

### T2: Terminal raw-mode + 键解析 ⭐⭐ (P0)
**新建 `src/terminal/term.ts`**
- `Terminal` 类：raw mode 输入 + 键事件解析
- 键解析：方向键（CSI-u 与经典 CSI 双协议）、Home/End、退格、Delete、Enter、Tab、Ctrl+C、粘贴（bracketed paste）
- resize 监听：SIGWINCH → 回调
- 键序列 10ms 超时判定（防 `\x1b[A` 与 `Esc` 歧义）

### T3: 组件抽象 + 三组件 ⭐ (P1)
**新建 `src/terminal/components.ts`**
- `Component` 接口：`render(width): string[]` + `invalidate()`
- `MessageList`：追加行/块，滚动回看（↑↓/PgUp/PgDn/跟随底部）
- `InputLine`：单行编辑（左右移动/Home/End/退格/Delete/历史/补全）
- `StatusBar`：模式/模型/token/窗口占用/思考状态/工具名

### T4: Tui 主控制器 ⭐⭐ (P0)
**新建 `src/terminal/tui.ts`**
- 组合 MessageList + InputLine + StatusBar，固定底部状态栏
- `requestRender()` 16ms 节流
- 全帧合成：消息区（rows-2）+ 输入行 + 状态栏
- `prompt(): Promise<string>` — raw-mode 阻塞输入
- `startAgentSession()` / `endAgentSession()` — 流式期间输入行转为"运行中"指示

### T5: renderer 薄封装 + 删除旧模块 ⭐ (P1)
- `src/terminal/renderer.ts` 改为 Tui 薄封装：保留 `printStatus/updateLiveStatus/write/writeLine/writeError/writeSuccess/writeInfo/prompt/formatStatus/recordHistory/destroy` 导出（smoke-test 依赖）
- **删除** `src/terminal/tui-screen.ts`、`src/terminal/input.ts`（input.ts 改为转发 term.ts 的兼容导出）

### T6: Markdown 块级渲染增强 (P2)
**修改 `src/terminal/markdown.ts`**
- 表格列宽跨行对齐、代码块边框、标题着色（现有能力复核 + 补齐块级上下文）

### T7: index.ts 集成 ⭐⭐ (P0)
- 替换 `renderer.prompt()` / `inputCollector` / `stdout.write` 直写 → Tui 组件 API
- 流式回调（onTextDelta/onToolCall/onToolResult/onFileDiff）写入 MessageList
- 命令输出（/help、/sessions、/context 等）写消息区
- 交互循环精简

### T8: 回归验证 (P0)
- smoke-test 兼容导出保留（renderer/input/ansi）
- `npm test` 92 全绿 + `npx tsc --noEmit` + `npx eslint src/` 零错误

## 四、文件变更清单

**新建（4）**：
- `src/terminal/screen.ts`
- `src/terminal/term.ts`
- `src/terminal/tui.ts`
- `src/terminal/components.ts`

**修改（3）**：
- `src/terminal/renderer.ts`（薄封装）
- `src/terminal/markdown.ts`（P2 增强）
- `src/index.ts`（集成）

**删除（2）**：
- `src/terminal/tui-screen.ts`
- `src/terminal/input.ts`（input.ts 改为转发，保留导出；tui-screen 删除）

## 五、依赖关系图

```
index.ts ──→ renderer.ts ──→ tui.ts ──→ screen.ts (帧缓冲+diff)
   │              │              │──→ components.ts (MessageList/StatusBar/InputLine)
   │              │              └──→ term.ts (raw模式+键解析+resize)
   │              └──→ markdown.ts / highlight.ts (渲染)
   └──→ output.ts (流式渲染, 写 MessageList)
```

## 六、验证标准

| 任务 | 验收条件 |
|------|---------|
| T1 | Screen diff 只写变化行；CJK 宽度正确；行尾 SGR 重置无样式泄漏 |
| T2 | raw-mode 捕获方向键/Home/End/退格/Delete/Enter/Tab/Ctrl+C；resize 触发重绘；CSI-u 与经典 CSI 双协议 |
| T3 | 消息区滚动回看；输入行光标移动；状态栏常驻底部 |
| T4 | 全帧绘制状态栏在底部；requestRender 16ms 节流；prompt 返回输入文本 |
| T5 | renderer 兼容导出完整（smoke-test 417-447 通过） |
| T6 | 表格对齐、代码块边框、标题着色正确 |
| T7 | /exit /help /sessions /context /plan /debate 等命令可用；流式显示正常 |
| T8 | `npm test` 92 全绿 + tsc + eslint 零错误 |

## 七、风险与对策

| 风险 | 对策 |
|------|------|
| Windows raw-mode 键序列差异 | 键解析器 CSI-u + 经典 CSI 双协议 + 10ms 序列超时 |
| readline 移除后 IME/粘贴兼容 | bracketed paste 支持；IME 光标 CURSOR_MARKER 方案 |
| 状态栏仍被流式覆盖 | 全帧渲染：状态栏每次 requestRender 重画，无法单独覆盖 |
| index.ts 965 行改造面大 | 分步：T1-T4 引擎独立可测，再 T7 集成 |
| output.ts toolResult 用 `\r\x1b[1A` 回退行 | TUI 模式下改为消息列表追加行（保留非 TUI 回退行逻辑） |
| 现有 smoke-test 依赖旧导出 | T5 保留兼容导出；input.ts 转发而非直接删 |

## 八、里程碑

- **M18-A**: T1 Screen + T2 Terminal（引擎核心，先行）
- **M18-B**: T3 组件 + T4 Tui 控制器（可组合渲染）
- **M18-C**: T5 renderer 封装 + T7 index 集成（端到端可用）
- **M18-D**: T6 markdown + T8 回归（打磨 + 验证）

## 九、执行记录

| 日期 | 任务 | 说明 |
|------|------|------|
| 2026-08-04 | T1-T4 | 引擎核心（Screen/Terminal/组件/Tui 控制器）+ 19 项 TUI 测试 |
| 2026-08-04 | T5/T7 | renderer 薄封装 + index 集成（raw-mode prompt 替换 readline，server 模式跳过 TUI） |
| 2026-08-04 | T6/T8 | Markdown 表格跨行对齐 + 回归（111 测试全绿 + tsc/eslint/build 零错误） |
| 2026-08-04 | 交付 | 未提交（待用户审核后手动 commit/push） |
