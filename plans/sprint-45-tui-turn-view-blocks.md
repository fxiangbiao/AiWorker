# Sprint 45：TUI 块式会话视图（思考/工具/回答可折叠）— 计划 v2（审查修订版）

目标版本：1.3.0（分支 dev）
修订记录：v2 吸收计划复审结论——A1 running turn 唯一活条目＋ask 块化；A2 回合边界与异常定稿；
A3 键位矩阵（取消空闲裸字母与 Space/Enter）；A4 视口预算惰性 wrap；其余细节补齐。

## 背景与动机

现状（Sprint 44 后核实）：
1. `--show-thinking` 默认关闭（`src/index.ts:375`），思考只在回答开始时补打一行首 120 字摘要（`index.ts:952-955`）；
   开启后思考文本被 `appendInline` 无结构拼进消息区最后一行（`renderer.ts:75-83`），与回答混行。
2. TUI 输出是"扁平行流"（`MessageList` string[] 逻辑行 + `StreamOutputRenderer` 行状态机），
   工具"进行中→完成"无法原位更新（`output.ts:174-181` 只能另起一行），无任何可折叠区域。

用户诉求：对齐 Web UI——思考阶段流式可见、思考区/工具调用区动态生成且可折叠展开。

## 已确认设计偏好（用户选择）

- 方案 B：块式会话视图（对齐 Web `timeline` 模型）
- 思考块默认折叠：标题行滚动显示「🧠 思考 · 前 80 字… · 已 N 字 ▸」，实时刷新不刷屏
- 历史回合保留结构：向上滚动可回看并折叠旧回合的思考/工具

## 一、回合与块模型（新增 `src/terminal/turn-view.ts`）

```
TurnView
  blocks: Block[]               // 按到达序追加（=视觉序）
  rawLines: string[]            // 运行期不可归类的外部输出（库 stdout 重定向），恒渲染于全部事件块之后、meta 之前
  running: boolean              // 回合进行中；false=已定稿（保留结构供回看）
  interrupted?: boolean         // Ctrl+C/异常定稿标记
  meta?: string                 // 尾注 [迭代/工具/token/中断]

Block =
  | { kind:"thinking"; summary; full:string; charCount; open:boolean; done:boolean }
      // full 实时累计；charCount=字符数（单位明确，勿与 token 混淆）
      // open=false 默认折叠：仅渲染标题行「🧠 思考 · 前 80 字… · 已 N 字 ▸」
      // open=true：标题行 + dim 灰正文（多行）
  | { kind:"tool"; id; name; argsPreview; status:"running"|"done"|"error";
      durMs; resultPreview; detailOpen:boolean; argsFull; resultFull }
      // 标题行单行渲染，状态翻转（running→✓/✗+耗时）由块状态驱动，天然原位更新（无需终端回退行）
  | { kind:"ask"; question; options:string[]; multiple; state:{highlight,selected[],resolved?:{value,timeout}}
      status:"pending"|"answered"|"timeout"|"canceled" }
      // ask_user 的 TUI 交互块（v2 修订 A1：不再以消息区静态行 + setLine 方式实现）
  | { kind:"text"; lines:string[]; lastPartial:string }   // 回答正文行缓冲（fence/table 已渲染成品行）
  | { kind:"note"; text }                                 // fileDiff/step 等单行提示
```

关键规则：
- **blocks 到达序 = 视觉序**：thinking/tool/ask/note 一律追加到 blocks 尾部；text 块首次出现时按序入列，其后增量只追加到该 text 块内（agent-loop 在 answer 开始后不再发 thinking/tool，故 text 恒为最后一个事件块）；
  `rawLines`（运行期不可归类的外部输出）不进 blocks，恒渲染于全部事件块与 meta 之间（详见 §二 收口规则）。
- thinking 流式：`thinking_delta` → 追加 `full`，刷新 `summary/charCount`；**折叠态也实时刷新标题摘要**（看得见"在想"，不刷屏）。
- 思考段边界（无 thinkingEnd 事件，同 Web）：收到 `tool_call` / `text_delta` / 新一轮 `thinking_start` 时，前一 thinking 标 `done:true`（标题加 ✓、停止计数）。
- tool：`onToolResult` 按 id 反查块置终态（done/error + durMs + resultPreview）；`detailOpen` 控制完整 args/result 子块。
- ask 块：创建即 `status:"pending"`；用户结算后转 answered/timeout/canceled（渲染压缩为一行结果，保留历史）；块内维护高亮/勾选，渲染整帧驱动，**不再逐行 setLine**（v2 修订 A1，见 §二）。
- 回合结束（flush）：thinking 全部 done、压 `meta`、`running=false` 定稿但保留 blocks；中断/异常路径（Ctrl+C、runStream 抛错）同样调 `finishTurn(interrupted)`，**防止 running=true 残留把下回合输出并入旧回合**（v2 修订 A2）。

## 二、MessageList 条目化（改造 `src/terminal/components.ts`）

```
items: Array<{ kind:"line"; text:string } | { kind:"turn"; view: TurnView }>
```

### 关键规则
1. **running turn 是消息区唯一活条目（v2 修订 A1）**：
   - **Tui 写消息区的所有入口统一收口为私有 `appendToViewport(line)`**（`appendMessage`/`appendInline`/`setPartial`/`bufferStdout` 全部改经它）；
     收口处检测到 running turn → 内容进 `turn.rawLines`（多行按行拆分），保证任何时刻屏幕底部顺序 = 事件到达序。
   - 已知类型输出由 index/output 直接写对应块（thinking/tool/text/ask/note），不走静态行。
   - 回合外（无 running turn）行为与现状完全一致（静态行、ask 旧路径兜底）。
   - 例外：用户提问行由 enter 提交路径先入静态历史（此时尚未 startTurn），回合从 assistant 侧开始，无需 user 块。
2. **渲染与滚动**：
   - `renderViewport(width,height)`：遍历 items，按当前块 open 态/ask 态展开为逻辑行序列，再经 wrap 成视觉行；`scrollOffset` 仍在视觉行空间，现有尾部跟随、↑↓/PageUp 语义不破坏。
   - **预算化展开 + 受限 wrap（v2 修订 A4 的实现取舍）**：turn 渲染行生成时即做预算——展开块正文超过 `MAX_CONTENT_ROWS` 只保留尾部 N 行并首行标注「…(前 X 行省略)」，text/raw 超限头部裁剪标注；逻辑行总数受预算约束后逐行 wrap，帧成本与现状 5000 行上限同量级（不再因展开巨文突破现状上限）。折叠内容（full 字符串）不受裁剪，展开时才按预算渲染。
   - 上限：条目数上限（保留现有 5000 行同级保护）+ 单条目展开行预算（见上）；折叠内容（full 字符串）不受裁剪，展开时才按预算渲染。
3. **兼容层**：
   - `append/setPartial/appendInline` 保留（静态输出 + 重定向用），`setLine/getTotalLines` 保留但**仅作为"无 running turn 的 ask 旧路径"兜底**；主路径 ask 块化后不再依赖（v2 修订 A1，setLine 唯一运行期调用方消除）。
   - 空行语义（`endAgentSession` 的 `append("")`、多行输入等）不变。

## 三、输出接线

### `src/terminal/output.ts`
- 引入"当前回合句柄"（index 在回合开始注入）：文本 `emitLine/emitPartial/flush` 的落点改为 `turn.text` 行缓冲（fence/table 渲染状态机原样保留，仅落点变更）；`emitPartial` 语义 = **更新 text 块的 `lastPartial`（覆盖半行，不追加行）**，`flush` 把 `lastPartial` 提为正式行；**回合开始/定稿时显式 reset 状态机**（v2 修订：异常路径不残留 fence/table 状态）。
- `toolStart/toolResult` → `turn.tool` 块；`fileDiff/stepStart/stepEnd` → `turn.note`（按到达序）；均不再直接 append 静态行。
- 未注入句柄（命令输出、非会话场景）→ 回退现有 `tui.appendMessage`（向后兼容）。
- 非 TUI（stdout 直写）分支完全不变。
- ask_user：转交 TUI `turn.ask` 通道（见下），不再经 output。

### `src/index.ts`（TUI 消息循环）
- 主对话回合开始 `tui.startTurn(userMessage)`（含 /plan /debate 之外的普通 runStream）；
- `onThinkingStart/Delta` → `turn.addThinking(...)`；`onToolCall/onToolResult` → `turn.addTool(...)`；
- `onTextDelta` → `outputRenderer.writeChunk`（已注入 turn）；`onFileDiff` → output（已注入 turn.note）；
- 正常结束 `outputRenderer.flush()` → `tui.finishTurn(metaText)`；
- **catch/abort 分支也调 `tui.finishTurn(meta, { interrupted:true })`**（v2 修订 A2），随后 `endAgentSession()` 空行照旧；
- `showThinking` 语义（保持 bool API 兼容）：`--show-thinking`/`/config thinking` = true → thinking 默认 open 展开全文；false（默认）→ 折叠摘要实时滚动。**摘要始终可见**，开关只影响默认展开态与运行时展开记忆。
- 回合边界（v2 修订 A2）：v1 仅普通对话 runStream 享受块视图；`/plan`、`/debate`（`commands/collab.ts` 命令路径）保持静态行输出（无 running turn，行为与现状一致），v1 文档注明不享受块折叠，v2 再考虑命令回合化。

### `src/terminal/tui.ts`
- `startTurn()`：items 尾追加 turn 条目，记录 `currentTurn` 句柄（用户提问行已由 enter 路径入静态历史，回合不含 user 块）。
- `finishTurn(meta?, opts?)`：关 thinking/tool、压 meta、置 running=false（结构保留）。
- **ask 块化（v2 修订 A1）**：`ask(question, options, timeout, multiple)` 在 running turn 时创建 ask 块并复用现有键盘交互状态机（`handleAskKey` 的 ↑↓/Tab/Enter/超时/Ctrl+C 逻辑），结算转终态后按 `turn.finishAsk(value|null)` **压缩为一行结果**（`❓ 问题 → 回答/已超时/已取消`，不可折叠但保留下历史）；无 running turn（防御）走旧静态行路径。askPending 期间**所有折叠快捷键不生效**（现有 `askPending` 分支优先，`tui.ts:452-455`）。
- **输出重定向（A1）**：`appendMessage/appendInline/setPartial/bufferStdout` 统一经私有 `appendToViewport`，检测 `currentTurn?.running` → 内容进 `turn.rawLines`；否则原静态行为。
- **键位（v2 修订 A3 + 实施补充：浏览模式替代"空闲裸字母"）**：

| 时段 | 键 | 动作 |
|---|---|---|
| agent 运行期（字符键已被忽略 `tui.ts:466-481`，无输入冲突） | `t` | 折叠/展开当前回合最近 thinking 块 |
| | `o` | 折叠/展开当前回合最近 tool 块详情 |
| | `[` / `]` | 当前回合可折叠块间移动焦点（标题高亮） |
| | `c` / `e` | 收起 / 展开当前回合全部可折叠块 |
| | `Space`/`Enter` | 不使用（Enter 提交、Space 输入） |
| 空闲期·浏览模式（回看历史） | `[`（或直接 ↑ 滚动后按 `[`） | **进入浏览模式**（状态栏/首行提示） |
| 浏览模式中 | ↑↓/PgUp/PgDn | 滚动历史 |
| | `[` / `]` | 焦点在**全部回合**可折叠块环上移动（逆时间序：最近回合优先） |
| | `t` / `o` | 折叠/展开焦点 thinking / tool 块 |
| | `Space`/`Enter` | 折叠/展开焦点块 |
| | `c` / `e` | 收起 / 展开焦点所在回合全部块 |
| | `Esc`/任意字母数字 | 退出浏览模式；字母数字键继续进入输入 |
| | 其余字符 | 退出浏览并输入 |
| 空闲期·普通输入态 | 无折叠键 | `[` 视为进入浏览（输入行非空时 `[` 照常输入，不进浏览） |

实现要点：浏览模式为 tui 布尔状态 + 全局折叠焦点（跨回合逆序），焦点高亮由 TurnView.renderRows 的 focusId 驱动；
不引入"视口行→条目"映射（滚动与折叠解耦，v1 焦点按回合时间序而非可视位置）。
- **首次提示（hint 独立于输入补全槽）**：running turn 出现首个 thinking/tool 块时，在 turn 内插一条 dim note（`t 展开思考 · o 工具详情 · [ ] 切换`），首个折叠键按下或回合定稿时移除。不复用 `completionHints`（该槽与 Tab 补全耦合，`tui.ts:174-180`）。
- `endAgentSession`：保持现状（定稿后追加空行 = turn 后静态空行，呼吸感不变）。

## 四、渲染外观
- thinking 标题：`dim 🧠 思考 · {summary 截 80 字}… · 已 {charCount} 字 {▸|▾}`（done 后加 ✓，去掉计数或改静态）
- thinking 正文（展开）：dim 灰、整体缩进 2 格，超视口按 §二 惰性截断
- tool 标题：`blue 🔧 name argsPreview dim ⌁dur ✓|✗`（running 显示进行态）；详情子块（展开）dim 灰
- ask 块：沿用现有选项行样式（cyan 高亮 / 绿勾选），结算后压缩为一行结果（见 §三 tui）
- 折叠记号 ▸/▾ 放标题行尾；焦点块标题反白/下划线；meta 尾注 dim、不参与折叠

## 五、非 TUI / 降级
- 非 TUI stdout 直写路径完全不变（output.ts 双分支已有先例）；fallbackMode 不变。
- commands（空闲期）输出静态行、状态栏、Ctrl+C 中断、confirm 通道不受影响。
- Web 不受影响。

## 六、文件改动清单
| 文件 | 改动 |
|---|---|
| `src/terminal/turn-view.ts`（新） | TurnView + Block 模型、addThinking/addTool/addNote/finishAsk、定稿与中断、折叠/焦点查询、按需逻辑行迭代（供惰性 wrap） |
| `src/terminal/components.ts` | MessageList 条目化（line/turn）、目标窗口驱动的惰性 wrap + 单帧预算、兼容层与兜底路径、条目上限 |
| `src/terminal/output.ts` | turn 句柄注入：文本/工具/note 落块 + fence/table 状态机回合级 reset；未注入回退；stdout 分支不变 |
| `src/terminal/tui.ts` | startTurn/finishTurn（含 interrupted）、ask 块化、append 重定向、键位矩阵、首次提示 |
| `src/index.ts` | 回合生命周期接线（含 catch/abort finishTurn）、showThinking 语义、meta 尾注 |
| 测试（新增/更新） | turn-view 逻辑（事件→块序、折叠行数、焦点环、中断定稿、ask 终态）；components 条目化渲染回归（含滚动边界、惰性截断）；output 注入/回退；ask 块化交互（tui 在 raw-mode 不可用环境以**数据层断言**为主，不依赖真实终端） |
| `README.md`/`CHANGELOG.md` | 1.3.0 条目 |

## 七、验证
- 自动：`npm run build && npm run lint && npm test && npm run web:build`
- TUI 手动冒烟矩阵：
  1. 单轮无工具：思考摘要滚动 → `t` 展开全文（流式）→ 回答 → 定稿
  2. 多迭代工具链：thinking↔tool 交替 → 工具 running→✓ 原位 → `o` 详情展开/收起 → `c`/`e`
  3. ask_user 触发：ask 块出现位置正确（工具之后、answer 之前）、选项交互/结算成一行
  4. Ctrl+C 中断：turn 定稿标记"已中断"、下一条消息不再并入旧回合
  5. fence/表格 markdown：渲染与现状一致、回合结束状态机干净
  6. 历史回看：↑ 滚动至旧回合 → `[`/`]` 折叠展开旧 thinking/tool → 输入行不受影响
  7. 长文本展开性能：巨型 thinking 展开不卡帧（惰性截断生效）
  8. `/plan /debate`：输出与现状一致（静态行回归）
  9. 非 TUI（管道/无 TTY）模式无回归
- 提交：分支 dev，中文全角标点，双远端 push（origin/gitee）

## 八、风险与对策
1. MessageList 是滚动/ask 共用组件 → 条目化先迁移既有行为再扩展；`setLine/getTotalLines` 兼容层保留为兜底路径，防未知调用方回归。
2. 滚动偏移在折叠/展开下跳变 → renderViewport 每帧由 items 重建 + `Math.min(offset,maxOffset)` 钳制；"最近可见块"查找在滚动时按展开后视觉行定位，边界做 clamp 与空态（无块可折叠时按键无操作）。
3. 惰性 wrap 的正确性 → 窗口 + 边界余量的行映射单测；超长展开截断显式标注，不静默丢内容（full 仍在，仅渲染截断）。
4. output 句柄生命周期 → index 单点注入/释放；回合级 reset fence/table；catch/abort 必走 finishTurn。
5. 空闲期 `[`/`]` 与输入极小冲突（输入方括号）→ 仅在输入行为空时消费；文档说明；v2 可引入浏览模式。
6. 思考"折叠但仍在流式"的观感 → 标题摘要 + 字数计数持续刷新已覆盖；如仍嫌隐蔽，可加"▍ 动画"指示运行中。
7. ask 块化改动面大（tui.ask 路径）→ 分两步：先 turn 模型 + 文本/工具块（不动 ask），再 ask 块化；每步全量验证后再进下一步。
