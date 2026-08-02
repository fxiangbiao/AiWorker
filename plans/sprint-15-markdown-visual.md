# Sprint 15: Markdown 视觉优化

> 代码块语法高亮 + 表格轻量美化 — 提升终端可读性，纯增量低风险

---

## 一、核心目标

| 维度 | 目标 |
|------|------|
| 代码块 | 语法高亮（关键字/字符串/数字/注释/函数名着色） |
| 表格 | 轻量美化（分隔符着色 + 表头加粗 + 分隔线美化，不跨行对齐） |
| 流式 | 逐行 tokenize，不引入重依赖，不牺牲实时性 |

**范围排除**: 全屏交替缓冲 TUI（Sprint 15 前身，已放弃——成本高收益低，见 sprint-14 计划 D5/G5）。

---

## 二、现状分析

### 代码块
`src/terminal/output.ts:72` — 代码内容行 `▍ ${chalk.white(line)}` **纯白无高亮**。
`src/terminal/markdown.ts:157` — `renderMarkdown` 同样 `chalk.white(line)`。

### 表格
`src/terminal/markdown.ts:132` — 表格行走 `renderInline(line)` 原样输出，分隔符 `│`/`|` 未着色，表头未加粗。

### 接入点
- 代码内容行渲染集中在两处：`output.ts` 的 `emitLine`（流式）+ `markdown.ts` 的 `renderMarkdown`（整块）
- fence 已携带 `lang`（`result.lang`），可据此选择语言规则

---

## 三、方案设计

### H1: 代码块语法高亮（自研 tokenizer）  ⭐⭐

**方案选型决策**: 自研轻量 tokenizer（方案 C），不用 highlight.js/shiki（输出 HTML 需转换层 + 重依赖）。

**新增文件**: `src/terminal/highlight.ts` — 纯函数，逐行 tokenize，输出 ANSI 字符串

**高亮规则**（按 token 类型着色）:

| Token | 颜色 | 正则要点 |
|-------|------|---------|
| 注释 (`//`, `#`, `--`) | `chalk.gray.italic` | 行尾或整行，优先匹配 |
| 字符串 (`"`, `'`, 反引号) | `chalk.green` | 单行内完整匹配 |
| 数字 | `chalk.blue` | 整数/浮点/科学计数 |
| 关键字 | `chalk.magenta` | const/let/var/function/if/else/return/class/import/export/def/for/while/try/catch... |
| 布尔/null | `chalk.yellow` | true/false/null/undefined/None/True/False |
| 函数名 | `chalk.cyan` | `identifier(` 形式 |
| 类型/内置 | `chalk.blue` | 常见类型关键字 |

**优先级策略**（防正则冲突）:
1. 字符串/注释**整体保护**：先扫描占位，再着色其余 token（避免字符串内的关键字被误判）
2. 降级安全：无匹配走原样白色

**语言分发**（按 fence lang）:
- `typescript`/`javascript` → JS/TS 规则
- `python`/`py` → Python 规则（`#` 注释、`def` 关键字）
- `json` → 字符串/数字/布尔
- `sql` → SQL 关键字 + 字符串
- `html`/`css`/`bash`/`shell` → 基础规则
- 默认 → 通用规则（通用关键字 + 数字 + 字符串）

**流式安全**: 逐行 tokenize，注释/字符串单行内完成；多行注释/模板字符串降级为普通色（不维护跨行状态）。

**性能**: 每行 O(n) 正则扫描，一次 tokenize 多次 replace。

### H2: 表格轻量美化  ⭐

**决策**: 不跨行对齐（成本高效果差，已确认），仅轻量美化：
- 表头行（`| a | b |` 首行）→ 加粗 + 分隔符着色
- 数据行 → 分隔符着色（`│` 灰色）
- 分隔线行（`|---|`）→ 灰色
- 用正则同时兼容 `|` 和 `│` 分隔符

**实现**: `markdown.ts` 新增 `renderTableRow(line)`（轻量版）：
- 检测 `|`/`│` 开头的表格行 → split 单元格 → 着色分隔符 → 重组
- 表头 vs 数据行区分：需要知道是否首行——用 `StreamOutputRenderer` 的表格状态（`seenTableHeader` 标志），`renderMarkdown` 内用计数器

### H3: 标题层级强化（附带）  🟡
- `#` → 加粗 + 下划线（`chalk.bold.underline.cyan`）
- `##` → 加粗青色
- `###` → 青色
- 行内代码 ` `x` ` → 统一 `bgBlack.dim`

---

## 四、任务分解

- **H1**: `highlight.ts` 创建（tokenizer + 语言分发）+ `output.ts`/`markdown.ts` 接入
- **H2**: 表格轻量美化（renderTableRow 轻量版 + 表头状态）
- **H3**: 标题层级强化
- **回归**: 92 测试全绿 + tsc + eslint

---

## 五、验收标准

| 任务 | 验证 |
|------|------|
| H1 | ```` ```ts ```` 代码块中 `const x = 1` 显示：`const`(紫) `x`(白) `=`(白) `1`(蓝)；注释灰色斜体；字符串绿色 |
| H2 | 表格表头加粗、分隔符灰色、分隔线美观；`│` 和 `|` 分隔符都兼容 |
| H3 | `#` 标题加粗下划线，`##`/`###` 层级分明 |

---

## 六、风险

| 风险 | 应对 |
|------|------|
| 字符串内关键字误判 | 字符串/注释先保护占位，再着色其余 |
| 多行注释/模板字符串 | 单行处理，跨行降级普通色 |
| 正则性能 | 每行 O(n)，一次 tokenize |
| 表格表头识别错误 | 仅依赖首行 + `seenTableHeader` 标志，识别失败降级原样 |
| CJK 高亮干扰 | 关键字/数字正则限定 ASCII，中文不动 |
