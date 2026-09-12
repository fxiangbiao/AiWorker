# Web 产物工作台（Artifacts Workspace）设计 —— 合并「文件变更 / 文档预览 / 回滚」

> 状态：**已实施**（P0.1 + P1.1 + P1.2 + P1.3；P0.2 按用户裁定跳过）
> 关系：复用 `plans/preview-artifacts-design.md` 已落地的 `ToolArtifact` / `FilePreview` / `DocRenderer`；那份解决的是"对话流里点开某一个产物"，本方案解决"**事后集中查阅 + 沿时间轴回退**"，两者互补不重叠
> 前置：当前工作树 **38 modified + 9 untracked 未提交**（Sprint 49 两轮 + 测试基建 + 设备探测）。本方案会大改 `App.svelte` / `SystemPanel.svelte` / 右栏三个面板，**建议先提交再动**，否则回看与回滚都会很痛苦

---

## 〇、目标与判据

**一句话**：让"这次会话到底产出了什么"有一个固定地方可查（代码 diff、Markdown、图片、音视频、PDF、Office、链接），并且能沿着时间轴回到任意回合。

判据（每条都可当场验证）：

1. 右栏 tab 由 **5 → 2**（产物 / 应用预览）；
2. 会话里出现过的**每一个** `file` / `link` / `diff` 产物都能在产物面板里找到——尤其是**图片与音视频**，现在它们只在对话流卡片里出现一次，滚过去就再也找不回来；
3. 回滚从"独立面板"变成"**时间线上的操作**"，`dryRun` 预览与二次确认**不弱于现状**；
4. 安全不降级：涉及路径的读取一律沿用 `/files`、`/docs/content` 既有的根白名单 + `realpath`，**不新增遍历面**。

---

## 一、现状诊断（均为实读代码，非推测）

### 1.1 已经有了（这让本次改造很便宜）

| 能力 | 位置 | 说明 |
|---|---|---|
| 统一产物模型 | `src/types.ts:51-64` | `ToolArtifact` 三形态：`file`（`kind` = text/image/video/audio/pdf/office/binary/other）、`link`、`diff` |
| 产物产出 | `src/tools/builtin.ts` + `src/core/preview.ts` | fs 四件套 / terminal / web 已填充；`kindFromMime` 判型 |
| 产物持久化 | `src/core/agent-loop.ts:704` + `src/types.ts:488` | `tool/result` 事件**已带 `artifacts`**，落在 `session_events` |
| 事件查询 API | `src/memory/session-store.ts:363` | `getEvents(sessionId, fromSeq?, limit?)` |
| 二值/大文件服务 | `GET /api/v1/files?root=session\|project&path=&session=` | 根白名单 + realpath + 64MB 上限 + `download=1` + 审计（`src/server.ts:2106-`） |
| 查看器（**已齐全**） | `web/src/components/FilePreview.svelte` | 图片 / 视频 `<video>` / 音频 `<audio>` / PDF `<iframe>` / Office→HTML（mammoth、SheetJS）/ 文本 / 二进制降级 |
| Markdown 查看器 | `DocRenderer.svelte` + `GET /docs/content` | 一套渲染，不重造 |
| diff 视图 | `FileDiffPanel.svelte` + `GET /diffs` | 行级彩色 diff + 树形列表 |
| 时间线数据 | `GET /sessions/:id/checkpoints` + `POST /rewind` | `CheckpointManifest`（`src/types.ts:811-821`）含每文件 `tool/added/removed/restorable` |
| 快照 diff 结构 | `DiffFile`（`src/server.ts:336-349`） | `added/removed/lines/currentContent/binary/modified/deleted` |

### 1.2 缺口（三个，决定了改造范围）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **产物数据存了但读不出来** | `projectTrace` 投影 `tool/result` 时只取 `callId/success/content/durationMs`，**丢弃 `artifacts`**（`src/core/trace.ts:96-105`） | 图片/音视频/链接产物在事后**无任何端点可取** |
| G2 | 三个面板各拉各的数据源 | 右栏 `App.svelte:138-166`；`FileDiffPanel`→`/diffs`、`DocPreviewPanel`→`/docs`、`RewindPanel`→`/checkpoints` | 同一批产物在三个 tab 里三种组织方式，用户要在三个地方找同一个文件 |
| G3 | 文档源只收 `.md` | `src/server.ts:2020`（session 根）、`2056`（project 根，深度 ≤4、排除系统目录、≤200 个、单个 ≤1MB） | 非 md 的产出（csv/图片/音视频）不会出现在"文档预览"里——**这正是本次要合并的理由** |

### 1.3 结论

**UI 合并几乎不需要新造轮子**：查看器齐全、数据齐全，唯一缺的是"聚合"（G1 的一处投影修正 + G2 的一个聚合端点）。

---

## 二、设计

### 2.1 概念模型：一个数据集 + 两条轴

```
        空间轴（产物是什么）                 时间轴（什么时候产生、能不能退回去）
   ┌──────────────────────────────┐    ┌────────────────────────────────────┐
   │ 类型 / 目录 / 回合 分组        │    │ 检查点（回合）时间线 + 回到这里      │
   │ 列表 + 查看器（按 kind 分派）  │    │ 复用 /checkpoints 与 /rewind 语义   │
   └──────────────────────────────┘    └────────────────────────────────────┘
```

**关键判断**：回滚是**时间轴上的操作**，不是第四种产物类型；其中"仅对话回滚"连产物都不是（纯聊天语义），应回到对话流。

### 2.2 统一产物项 `ArtifactItem`

新增 `src/core/artifacts.ts`（纯函数，便于单测）：

```ts
export interface ArtifactItem {
  id: string;                                  // 去重键：root + ":" + rel（link 用 url）
  sources: Array<"tool" | "snapshot" | "docs" | "checkpoint">;
  type: "file" | "link" | "diff";
  kind: ArtifactKind;                          // 复用现有枚举
  root?: "session" | "project";
  rel?: string;
  path?: string;                               // 绝对路径（来自 tool artifact）
  url?: string; title?: string; site?: string; snippet?: string;   // link
  mime?: string; size?: number;
  turn?: number; tool?: string;                // 谁在哪个回合产生
  change?: "added" | "modified" | "deleted";
  added?: number; removed?: number;            // 行级统计（快照/检查点权威）
  restorable?: boolean;                        // 检查点权威：能否恢复
  hasDiff?: boolean;
  at: number;                                  // 首次出现时间（排序/展示）
  degraded?: string;                           // 该条目的已知限制（如"老会话无产物记录"）
}
```

**合并规则**（写进单测）：

1. 去重键 = `root + ":" + rel`；`link` 用 `url`；无 `root/rel` 的 tool 产物退化为绝对路径 `path`；
2. 同一键多来源 → 合并 `sources`，字段取**权威源**：`kind/mime/size` 取 `tool`；`added/removed/change` 取 `snapshot`；`restorable/tool/turn` 优先取 `checkpoint`；
3. `turn/tool` 缺失时，用该路径在事件流中**最早**一次 `tool/result` 补齐；
4. 快照标记 `deleted` 的文件**仍然列出**（用户要知道"它一度存在"），查看器给"已删除，无内容可预览"，并标注 `change=deleted`；
5. 排序：默认 `type` 分组内按 `at` 倒序；提供"按回合"排序。

### 2.3 聚合端点

```
GET /api/v1/artifacts?sessionId=<id>&scope=session|all
→ { items: ArtifactItem[], timeline: CheckpointManifest[], counts: {...}, degraded?: "early-session" | "no-rewind" | "no-store" }
```

- 路由薄（`src/server.ts`），合并逻辑在 `src/core/artifacts.ts`：`mergeArtifacts({ events, diffs, docs, checkpoints })`；
- 数据取用：`deps.sessionStore.getEvents(sessionId)`（G1 修正后事件里就有 artifacts）、`getDiffsCached(...)`、现有 docs walker（抽成可复用函数）、`deps.rewindService.list(sessionId)`；
- 降级必须显式：无 `rewindService` → `timeline: []` + `degraded: "no-rewind"`；老会话事件无 `artifacts` → `degraded: "early-session"`，面板写明"仅显示文件改动与文档"；
- **安全**：本端点只做聚合，**不读文件字节**；字节仍由 `/files` 与 `/docs/content` 提供，两者既有防护不动。

### 2.4 右栏布局

```
┌ 产物 ─────────────────────────────────────────────────────────────────────┐
│ [全部] [文档] [代码] [图片] [媒体] [链接]    分组:类型▾  范围:本会话▾  🔍   │
├────────────────────────────┬──────────────────────────────────────────────┤
│ ▾ 图片 (3)                 │  chart.png                  1.2 MB · 回合 7  │
│   🖼 chart.png      回合7   │ ┌──────────────────────────────────────────┐ │
│   🖼 shot-2.jpg     回合7   │ │        （按 kind 分派查看器，复用        │ │
│ ▾ 文档 (2)                 │ │   FilePreview：图片/视频/音频/PDF/Office/  │ │
│   📄 report.md  +12  回合5 │ │   文本；.md 复用 DocRenderer；            │ │
│   📄 spec.md    新增 回合6 │ │   diff 复用抽出的 DiffView）              │ │
│ ▾ 代码 (4)        +120 −8  │ └──────────────────────────────────────────┘ │
│   📝 src/a.ts    改 回合6  │  原始 │ 差异 │ 下载 │ 复制路径 │ 在对话中查看 │
│   📝 src/b.ts    新增 回合6│  来源：工具产物 · 快照 · 文档 · 检查点       │
│ ▾ 链接 (5)                 │  chart.png · 回合 7 · fs_write · 可恢复 ✓    │
├────────────────────────────┴──────────────────────────────────────────────┤
│ 时间线  ●──●──◆──●──○            当前：回合 7                              │
│         3  5  7  9  11   [回到回合 5 ▾  代码+对话 / 仅代码 / 仅对话]        │
└───────────────────────────────────────────────────────────────────────────┘
```

组件拆分：

| 组件 | 动作 | 说明 |
|---|---|---|
| `ArtifactsPanel.svelte` | **新增** | 容器：分组 / 过滤 / 搜索 / 列表 / 详情挂载 / 时间线 |
| `ArtifactList.svelte` | **新增** | 分组树 + 徽标（`新增/修改/删除`、`+n −n`、回合、大小） |
| `ArtifactDetail.svelte` | **新增** | 元信息条 + 动作条 + 按 `kind` 分派查看器 |
| `DiffView.svelte` | **抽出** | 从 `FileDiffPanel` 提出行级 diff 渲染（列表部分不再需要） |
| `TimelineStrip.svelte` | **新增** | 回合点选 + `回到这里` 下拉 + `dryRun` 预览 + 复用 `ConfirmModal` |
| `FilePreview.svelte` / `DocRenderer.svelte` | **复用不动** | 查看器 |
| `FileDiffPanel.svelte` / `DocPreviewPanel.svelte` / `RewindPanel.svelte` | **删除** | 内容分别并入 `DiffView` / `ArtifactDetail` / `TimelineStrip` |

### 2.5 交互细节

1. **分组**：默认「按类型」（贴合"产物"心智），可切「按目录」「按回合」；
2. **范围**：默认「本会话」，可切「所有会话」（复用 `/diffs` 的 `sessions` 分组能力，聚合端点 `scope=all`）；
3. **过滤 chips**：全部 / 文档 / 代码 / 图片 / 媒体 / 链接；搜索框按路径与标题过滤；
4. **选中项**：右侧查看器 + 元信息条（来源徽标、回合、产生工具、大小、是否可恢复）；
5. **动作**：`原始`（文本/md）、`差异`（`hasDiff` 才有）、`下载`（`/files?download=1`）、`复制路径`、`在对话中查看`；
6. **时间线**：点选回合 → 该回合产物高亮并置顶（不隐藏其他，避免"东西不见了"的困惑）；`回到这里` → 三档范围 → **必走 `dryRun` 预览**（展示将被恢复/删除的文件与将删除的消息数）→ 二次确认 → 执行后清本地缓存并重拉消息投影（沿用现状行为）；
7. **`仅对话回滚` 移出产物面板**：落到对话流里用户消息 hover 的「从这里重新开始」，因为它是聊天语义；
8. **空态/降级文案**：老会话、无 rewind 服务、无产物时分别给出明确说明，不留白屏。

### 2.6 与对话流的联动（含一处诚实降级）

- `在对话中查看`：滚动到对应工具卡片并高亮。
- **限制**：WS `tool_result` 消息**不带 `callId`**，Web 侧现按"首个未决工具"位置匹配（`preview-artifacts-design` §十 已记录该局限）。因此 P1 阶段该动作为**按路径匹配最近一次出现的工具卡片**（够用但不精确），**精确化放到 P2**（WS 消息补 `callId`）。

---

## 三、任务拆分（每步独立可验证）

| 步骤 | 内容 | 涉及文件 | 验收（当场可验） | 风险 |
|---|---|---|---|---|
| **P0.1** | `projectTrace` 的 `tool/result` 分支带上 `artifacts`（G1） | `src/core/trace.ts` + `test/trace.test.ts` | `GET /api/v1/trace/:id` 返回的工具项里能看到 `artifacts`；单测断言 | 极低（纯增强，`TraceItem` 加可选字段） |
| **P0.2** | 右栏新增「产物」tab，**前端合并三源**（`/diffs` + `/docs` + `/trace/:id`），左侧分组列表 + 右侧复用 `FilePreview`/`DocRenderer`；旧三 tab **暂时保留**（双轨） | `web/src/components/ArtifactsPanel.svelte`（新）、`ArtifactList.svelte`（新）、`App.svelte`、`apps.svelte.ts`（`rightTab` 联合类型） | 一轮对话产生图片 + 文档 + 代码改动后，**在产物 tab 里三样都能看到并能打开**；svelte-check 0 错误 | 中（前端合并逻辑，先不进后端） |
| **P1.1** | `src/core/artifacts.ts` 纯函数合并 + `GET /api/v1/artifacts` 端点 + 单测（去重/权威源/deleted 保留/降级） | `src/core/artifacts.ts`（新）、`src/server.ts`、`test/artifacts.test.ts`（新） | 端点返回合并后 `items`（同一文件只出现一次且 `sources` 含多个来源）；老会话返回 `degraded: "early-session"` | 中（合并规则多，靠单测钉住） |
| **P1.2** | 右栏收敛为 **2 tab**（产物 / 应用预览），删除三个旧面板，时间线并入（`dryRun` + 二次确认不变） | `App.svelte`、删 `RewindPanel/DocPreviewPanel/FileDiffPanel`、新增 `DiffView/TimelineStrip` | 右栏只剩 2 个 tab；回滚流程与现状**逐条对齐**（预览文件动作、冲突勾选、确认、回滚后刷新） | **中高**（回滚是危险操作，必须逐条回归） |
| **P1.3** | `仅对话回滚` 移到对话流消息操作 | `ChatPanel.svelte`、`UserMessage.svelte` | 在某条用户消息上点「从这里重新开始」→ 走同一 dryRun + 确认 → 对话被截断 | 中（改动对话流交互） |
| **P2.1** | 媒体查看器打磨：视频 `Range` 续传、Office 失败兜底、大文本截断提示 | `FilePreview.svelte` | 50MB 视频可拖动进度；失败有下载兜底 | 低 |
| **P2.2** | `在对话中查看` 精确化（WS `tool_result` 补 `callId`） | `src/types.ts`、`src/server.ts`（三处写出点）、`chat.svelte.ts` | 点产物 → 精确高亮对应的那张工具卡片 | 中（三处写出点要改全，同 `preview-artifacts-design` 的经验） |
| **P2.3** | 产物导出：单个产物下载 / 批量 `.aw` 打包 | 复用 `/files?download=1`、`/packages/export` | 产物详情页可下载；批量导出可用 | 低 |

---

## 四、验收矩阵

**功能**

1. 一轮里 `fs_write` 写代码 + 生成 `.md` + `fs_read` 一张图片 → 产物面板「代码/文档/图片」三组齐全，各自能打开；
2. `web_search` → 「链接」组有 url/title/site，点击新标签打开（scheme 仅 http/https）；
3. `fs_edit` → 该条目 `+n −n` 徽标正确，`差异` 按钮打开行级 diff；
4. 切「按回合 / 按目录 / 按类型」三种分组，排序与分组正确；
5. 点时间线回合 5 → 该回合产物高亮；`回到这里（仅代码）` → 预览列出将恢复/删除的文件 → 确认后文件回到该回合状态，对话保留；
6. `回到这里（仅对话）` 改在对话流消息上触发，行为与旧面板一致。

**安全与反例**

7. 产物详情里的所有内容请求都走 `/files` 或 `/docs/content`；手工把 `path` 改成 `../../` 或绝对路径 → 403/404（**回归既有用例**）；
8. `GET /api/v1/artifacts` 对不存在的 `sessionId` → 空结果而**非** 500；`scope` 非法值 → 400 或按默认处理（需定，见 §七）；
9. 快照里 `deleted` 的文件仍列出且标注"已删除"，不尝试读取内容；
10. 老会话（事件无 artifacts）→ 面板显示"仅显示文件改动与文档"，不白屏、不报错。

**门禁**：`npm run verify` 全绿（build / lint / test / web:build / svelte-check）；新增单测覆盖合并规则与降级分支。

---

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| 合并规则出错导致**产物重复或丢失** | 去重键与权威源写成纯函数 + 表驱动单测（每来源组合一例） |
| 回滚交互回归（**危险操作**） | P1.2 逐条对齐现状：`dryRun` 预览、冲突勾选、`blockers` 展示、二次确认、执行后刷新；改完用同一会话手工回归三个范围 |
| `/diffs` 是**工作目录快照**，可能含非本会话产生的外部改动 | UI 用来源徽标区分「工具产物 / 文件系统快照」，并在范围切换处说明；**不假装都是 Agent 写的** |
| 聚合端点成为新的路径遍历面 | 端点只聚合元数据不读字节；所有内容请求仍走既有 `/files`、`/docs/content`（根白名单 + realpath 不动） |
| 老会话数据缺 `artifacts` | 显式 `degraded` 标记 + 面板文案；不伪造数据 |
| 右栏 tab 减少后，**常用路径变长**（如"就想看文档"） | 保留过滤 chips（文档）+ 记忆上次选择（`localStorage`）；`在对话中查看` 与 chip 点击仍直达 |
| 大文件/大目录导致面板卡顿 | 列表虚拟化不做（本轮），改用：端点分页（`limit` 默认 500）+ 前端分组折叠默认收起非当前组 |

---

## 六、明确不做

1. **不动 `/files`、`/docs/content`、`/diffs` 既有接口语义**（只新增聚合端点）；
2. **不做产物原地编辑**（只读 + 下载，与既有裁定一致）；
3. **不把「应用预览」并进来**：它是运行中的应用窗口（panel/float/widget 三形态），不是文件产物；
4. **不动 TUI**：TUI 侧的产物 chips 已实现（`preview-artifacts-design` Phase A/C），本轮只做 Web；
5. **不做「设置 / 控制台」拆分与「权限」迁移**：那是另一个 IA 议题，见 §七-5，避免一个改动里混两件事；
6. **不做产物版本的多次历史**（同一文件在回合 3/5/7 各改一次只展示"最近一次 + 可从时间线回退"，不做逐版本 diff 浏览）。

---

## 七、决策记录（2026-09-12 用户已确认）

| # | 问题 | 裁定 | 影响 |
|---|---|---|---|
| 1 | 「仅对话回滚」放哪 | **移到对话流消息操作**（聊天语义；时间线的"仅对话"档去掉） | 时间线只留「仅代码」「代码+对话」；对话流用户消息新增「从这里重新开始」 |
| 2 | 非本会话产生的文件变更 | **显示，但打「文件系统快照」来源标** | `sources` 徽标必须可见；范围切换处加说明 |
| 3 | `data/docs` 只收 `.md` | **先不放宽** | 非 md 产出走产物聚合（tool artifacts），不改文档源 |
| 4 | 是否保留 P0.2 双轨期 | **不保留：直接做 P1.1 + P1.2 一次到位** | 右栏一次性收敛为 2 tab；`P0.2` 作废（其价值被 P1.2 覆盖） |
| 5 | 「权限」迁到设置 | **分开做**（不在本方案） | 本方案不动设置结构；右栏「权限」tab 暂时保留到下一次 IA 改造 |
| 6 | 时间线默认范围 | **仅代码**（危险面最小） | `TimelineStrip` 默认选中「仅代码」 |

**追加裁定**：右栏第二个 tab 由「应用预览」**改名为「应用」**（与左栏导航、控制台用词统一）。

**执行顺序调整**：`P0.1`（trace 投影带 artifacts）仍在本次范围内——它是诚实性修复（轨迹面板同样受影响），但不作为 P1.1 的前置。

---

## 八、实施结果（2026-09-12 完成，未提交）

| 步骤 | 状态 | 产物 |
|---|---|---|
| P0.1 | ✅ | `src/core/trace.ts` 的 `tool/result` 投影带上 `artifacts`（轨迹面板此前同样取不到） |
| P0.2 | ⏭️ 按裁定跳过 | 直接做 P1.1 + P1.2 |
| P1.1 | ✅ | `src/core/artifacts.ts`（纯函数合并）、`src/core/docs-index.ts`（`/docs` 与新端点共用一份扫描实现）、`GET /api/v1/artifacts`、`test/artifacts.test.ts`（15 例） |
| P1.2 | ✅ | 右栏 3 Tab（产物 / 权限 / 应用）；新增 `ArtifactsPanel` / `ArtifactList` / `ArtifactDetail` / `DiffView` / `TimelineStrip`；删除 `FileDiffPanel` / `DocPreviewPanel` / `RewindPanel` |
| P1.3 | ✅ | 对话流用户消息「从这里重新开始」（`replayEvents` 带 `seq`，按 `messageSeqBefore` 映射回合，先 `dry-run` 再确认） |

**实测证据**

1. `npm run verify` exit 0：**1025 例 / 67 文件**，`svelte-check` 0 错误 58 warnings（删除旧右栏面板后 warning 由 65 降至 58）；
2. **真实历史数据冒烟**（`GET /api/v1/artifacts` 打真实 `data/`）：某会话 34 项，其中 3 个文件成功合成 **`sources=tool+snapshot+checkpoint` 一条**——证明"快照绝对路径 ↔ 工具产物 `root+rel`"归一化有效；`byChange={modified:2, deleted:1}`；`timeline=1`；老会话正确标 `degraded=early-session`；`scope=all` 400 项；缺 `sessionId` → 400、非法 `scope` → 400、未知会话 → 200 空结果；
3. 构建产物核对：新面板文案（产物 / 时间线 / 从这里重新开始 / 在对话中查看）均在 bundle 内；旧文案「文件变更」「文档预览」与三个已删组件**全部消失**。

**与方案的实现偏差（1 处，已纠正）**：时间线点选回合最初实现成**过滤**其他产物，与本节"高亮并置顶、不隐藏"不符 → 改为 `highlightTurn` 高亮（左侧竖条），不过滤。
**媒体查看器**：图片内联、`.md` 复用 `DocRenderer`、`.html/.htm` 复用 `HtmlPreview`（sandbox iframe）、diff 复用抽出组件；视频/音频/PDF/Office 仍走既有 `FilePreview` 窗口（含 mammoth/SheetJS 转换），未另写内联播放器——避免第二套渲染实现。查看器按 kind 分档（标签为「全文 / 预览 / 图片 / 说明」+「改动」），默认档：文本/代码 → 改动优先，HTML 与图片/媒体 → 内容优先（见 §八 用户反馈（八）（九））。

**未由我验证的部分**：浏览器内的实际点击交互（面板布局、hover 显示「从这里重新开始」、时间线回滚确认流程）需人工确认；仓库测试不覆盖这些面板的挂载，回归保护依赖 `svelte-check` + 人工核对。

**用户截图实测发现的缺陷（已修，正是"未由我验证"的那一类）**：产物面板点开**项目文档**时永远停在"加载文档…"。

- 原因一（我的错）：给 `DocRenderer` 传的是 `rel`，**漏了 `project:` 前缀**；`DocRenderer` 把无前缀路径当会话文档 → 请求 `root=session`。实测：`root=session` → **404**，`root=project` → **200（88 行正文）**。
- 原因二（既有缺陷）：`DocRenderer` 对非 2xx 直接 `return`，把失败伪装成"加载中"，所以表现为**永久**加载而不是报错。
- 修法：`toDocKey(root, rel)` 收进 `$lib/artifacts.ts` 作唯一实现（`FilePreview` 原先自己拼、写法正确，一并改为调用它，消除"同一逻辑两份实现"）；`DocRenderer` 增加 `error`/`loaded` 状态与失败/空文档文案。
- 教训：这类"漏前缀即静默失败"的 bug，`svelte-check` 与单测都拦不住（无 Web 组件测试基建），只能靠**真实点击**或让失败显式化——所以原因二的修复本身也是防复发措施。

**用户实测发现的缺陷（二）：「在对话中查看」点击无反应（已修）**。同样是两层**静默**失效叠加：

| 层 | 问题 | 证据 | 修法 |
|---|---|---|---|
| 前端锚点 | `id="msg-N"` 只加在**用户**消息上，工具卡片在**助手**消息上 → `getElementById` 返回 `null`，`el?.scrollIntoView()` 静默无效 | 代码自查（`ChatPanel` 的 `{#if msg.role === "user"}` 分支） | 锚点覆盖**所有**消息，重命名按钮仍只在用户消息 |
| 数据链路 | **刷新后时间线没有 artifacts**：`replayEvents` 构造 tool 消息时不带 `artifacts`，`loadRemoteMessages` 也不往时间线项上拷（只有实时流路径会写） | 真实数据：修复前 `/sessions/:id` 的 tool 消息无 `artifacts`；修复后会话 `cmtvk4fo` = 7 条 tool 消息 / 4 条带产物，样例正是被点的那篇 `reports/AI大模型发展见解与程序员职业建议.md` | `replayEvents` tool 消息带 `artifacts` + `loadRemoteMessages` 写入时间线项 |
| 反馈 | 匹配失败只把提示写在**面板顶部**，用户在详情区看不到 → "像没反应" | 用户反馈 | 结果提示**就地**显示在详情区，并区分原因（本轮之前写入 / 已回滚 / 来自其他会话 / 未渲染） |

**顺带修掉既有 flaky（P0-7）**：`test/memory.test.ts` 的 turn_logs 用例用两次独立 `Date.now()` 断言差值恰为 1000，跨毫秒即 1001 → 全量并行偶发红、单跑必绿。改为同一时间基准后，`memory.test.ts` 连跑 5 次 + 全量 `npm run verify` 连跑 2 次全绿（1025/1025，exit 0）。

**结论**：两轮用户实测缺陷都属于同一类——**我未在浏览器里点击验证**，而这类"静默失败"（漏前缀、锚点缺失、提示写在看不见的地方）恰好是 `svelte-check` + 单测的盲区。后续新增交互时，**失败路径必须显式化**应作为硬约束。

**用户反馈（三）：预览下方大片留白（已修）**。根因是我用**按视口裁剪**而不是**铺满**：`.aw-list max-height:46vh`、`.aw-detail max-height:52vh`、详情内 `.ad-pre/.ad-doc/.dv-lines` 也是 `52vh` → 内容到 52vh 截止、下面是死区，长文档还会在中间被裁断（截图里文档确实断在一张卡片中间）。改为 flex 铺满链条（右栏 flex 列 → `.aw`/`.aw-body` `flex:1 1 auto; min-height:0` → 列表与查看器各自滚动；`.ad-doc { height:100% }` 给 `DocRenderer` 确定高度——它自身就是 `height:100%` + 内部滚动，缺的只是确定高度；时间线 `flex:0 0 auto` 不被压缩）。构建后 CSS 实测核对：四条规则就位、产物面板内 `max-height:52vh` 归零。

**调试经验（值得记住）**：组件自己写 `height:100%` + 内部滚动时，**父容器必须给出确定高度**；给 `max-height` 只会得到"能滚但只占一小块"的观感。这与前两条缺陷同源——**靠 vh 猜布局**而不是让 flex 决定。后续此类区域一律用 `flex + min-height:0`，禁止用 `vh` 裁剪主内容区。

**用户反馈（四）：Markdown 大纲定位失效（已修）**。根因仍是我改动布局引入的**隐藏耦合**：`DocRenderer.jumpTo` 手算 `renderEl.scrollTop + (e.top - r.top)`，**默认 `.dr-render` 就是滚动容器**；而我把外层改成 `.ad-viewer { overflow:auto }` 后，滚动可能发生在其祖先层，算术落空且无任何反馈。修法三条：① 沿祖先链找第一个真正可滚动的容器（`overflow-y ∈ auto|scroll|overlay` 且 `scrollHeight > clientHeight`），找不到才 `scrollIntoView`；② 锚点查找先在本实例 DOM 内做（`renderEl.querySelector`），避免同页多实例时 `getElementById` 取错；③ 找不到锚点在大纲列**就地提示**。另外把大纲列 `width:150px; flex-shrink:0` 改为 `flex: 0 1 150px; min-width: 92px`（窄面板不再被挤出可视区）。

**这一轮四条用户反馈的共同规律**（值得写进以后的检查清单）：**我改动布局/尺寸时，破坏了组件里"假设某层负责滚动/某前缀存在/某 id 全局唯一"的隐式契约**——`vh` 裁剪、双层滚动、doc key 前缀、`id="msg-N"` 锚点、`renderEl` 是滚动容器，全都是这类。结论：**凡是"组件内部假设外部布局"的写法都要改成自证式**（自己找滚动祖先、自己限定查询范围、失败必须可见），而不是依赖调用方的布局约定。

**用户反馈（五）：「在对话中查看」定位正确但高亮太短、易丢焦点（已优化）**。原实现是 1.6s 一次性动画——**假设用户一直盯着看**，错过就没了。改为三段式：

| 层 | 作用 | 行为 |
|---|---|---|
| 脉冲 `.artifact-pulse` | 吸引注意 | 2.4s 一次性 box-shadow 扩散；连续定位同一元素时"移除→强制回流→再加"重启动画；`prefers-reduced-motion` 下自动禁用 |
| **持久环 `.artifact-focus`** | **不丢焦点** | 主题色描边 + 淡底，**一直保留**到切换产物 / `Esc` / 点「清除高亮」 |
| 多命中走查 | 一个产物常命中多处 | 详情区显示「已定位：第 n/总数 处（1 = 最近一次）」+ ↑更早 / ↓更近；命中列表仍按**最近优先**收集 |

样式放全局 `app.css`（`ChatPanel` 里原 `.msg-flash` 一次性动画删除，避免两套机制并存）。**设计原则**：短暂动画只能做"提示"，**状态**必须由持久样式承载——这与前四条"失败必须可见"是同一条思路的两面（一个是失败不能静默，一个是成功不能一闪而过）。

**用户反馈（六）：高亮框住了整个中间对话区（已修）**。上一版把"取不到卡片就高亮整条消息"当作兜底，结果在最需要它的长会话里最难看——因为目标卡片**根本不在 DOM**：`ToolsGroup` 把连续多个工具调用折叠成「工具调用 (N)」，折叠时 `{#if open}` 让**子卡片完全不渲染**，`data-call-id` 自然查不到，于是回退到那条**极高的**助手消息容器。

修法（结构问题用结构解决，不调样式）：① 新增 `focusToolCallId` store；定位前先置入目标 callId，`ToolsGroup` 的 `$effect` 检测到本组含该 id 就**自动展开**，`await tick()` 后再取卡片；② **取不到卡片时只滚动、不加环**，并就地写明原因——**禁止用大范围描边冒充定位**。这条也修正了我上一版的判断错误：当时以为"回退到消息级"是"有总比没有好"，实际是**看起来像定位成功、其实指错了地方**，比明确失败更糟。

**用户反馈（七）：最下面那张命中卡片没有高亮（已修）**。卡片级定位成功、但**视觉上完全看不出来**，原因是两个"只在折叠分组内暴露"的坑：① `ToolsGroup { overflow: hidden }` 会裁掉画在外侧的 `outline`；② 组件样式 `.tool-card { background: var(--surface) }` 与全局 `.artifact-focus { background: … }` 同权重且更靠后，把底色盖掉。修法：`outline-offset: -2px`（画在内侧，不受祖先裁剪）+ 底色用 `box-shadow: inset 0 0 0 9999px`（不参与 `background` 级联竞争），脉冲同样改为 inset 扩散。

**结论（追加到检查清单）**：给"别人渲染的元素"加高亮时，**不能假设它外侧空间可用、也不能假设同名 class 的 background 能生效**——要么画在内侧（负 offset / inset），要么走组件自己的 API。三条用户反馈（分组未展开 / 外侧 outline 被裁 / background 被组件样式覆盖）本质是同一件事：**我的定位逻辑跨越了组件边界，却只按"我自己写的样式"来推理**。

**用户反馈（八）：SVG 是图片资源，产物面板却不预览（已修）**。核实后先纠正前提：SVG **本来就是图片产物**——工具侧 `svg → image/svg+xml → kind=image`（`src/core/preview.ts:59,103`），快照/文档侧 `KIND_BY_EXT.svg = "image"`（`src/core/artifacts.ts:64`），`/files` 以 `image/svg+xml` 直出且已有断言（`test/server.test.ts:248-272`）；实读会话 `cmtvk4fob` 的 `session_events`，三个 svg 的产物事件就是 `mime:"image/svg+xml",kind:"image"`。真正错的是**查看器优先级**：`ArtifactDetail` 原先是 `diff > 内容` 一刀切，而 `diffMap` 取自 `/diffs` **全量、按路径**建索引（跨会话也命中），所以"刚生成/改过的图"点开看到的是**满屏 `+ <svg …>` 源码行**（`data/snapshots/cmtvk4fob/…reports_assets_ai-trend-diagram.svg.diff` 实测 100+ 行全 `+`），视觉上就是"不支持预览"；同一份产物在对话流里反而正常（`ToolCard → FilePreview → <img>`），**同一个功能两套表现**。

修法：拆成**正交两档 + 段控切换**（「图片/内容」↔「改动」+`+n −m`），默认档按 kind 定——**文本/代码（含 md）保持改动优先**（不推翻既有裁定：改动要能一眼看到），**图片/媒体内容优先**（图的价值是它长什么样，源码级 diff 只能是可切换的次要视图）。顺带补两处**同一个功能两套标准**的不一致：图片档给了 `onerror` 兜底（此前碎图无任何解释，而 `FilePreview` 早有"加载失败，请下载"）、`change === "deleted"` 时不再发一次注定 404 的请求而是显式说明；切产物时档位复位（否则上一项的选档会串到下一项）。

**结论（追加到检查清单）**：**"优先级/默认视图"也是产品决策，不能只按数据可得性来排**——"有 diff 就先显示 diff"是数据视角，用户视角是"我点的是什么东西"。凡一个产物同时有"内容"和"改动"两种看法，就要**按 kind 分档 + 可切换**，并且**同一语义在对话流与工作台必须给同一套默认**（这次两边不一致本身就是线索）。

**同一轮追加修复（用户截图）：切换按钮下边缘被切**。两根因叠加：① `.ad` 是 flex 列，除查看器外各行默认 `flex-shrink: 1`，而查看器的 `flex-basis: auto` 等于其**内容高度**（几百~几千 px），收缩量按「基准 × 因子」分摊 → **小行也被分到十几 px 的收缩**；行内文本溢出还看得见（所以只有这一个按钮露馅），但 `.ad-toggle` 当时为段控圆角用了 `overflow: hidden`，于是**只有它把收缩渲染成"底部被切"**；② 按钮高度依赖行盒撑开 + 容器裁圆角，本身就有取整/裁切风险。修法：`.ad > *:not(.ad-viewer) { flex: 0 0 auto }`（`.aw > *:not(.aw-body)` 同理，工具条/时间线一并免疫）、**容器彻底去掉 `overflow: hidden`**（改为首/末按钮各自圆角）、按钮改 `inline-flex + align-items: center + line-height: 16px` 让高度由字高确定。

**结论（追加到检查清单）**：**"一个滚动容器 + 若干固定行"的 flex 列，必须显式声明谁能伸缩**——只给滚动行 `flex: 1 1 auto; min-height: 0` 是不够的，**其余行要 `flex: 0 0 auto`**，否则它们会按 flex-basis 比例被"分摊"掉高度。这与前几条（`vh` 裁剪、双层滚动、外侧 outline 被裁）同族：**根因都是我把"默认值/隐式契约"当成了"我要的效果"**。而且**凡是用了 `overflow: hidden` 的地方，就等于承诺"这里的尺寸一定够"**——尺寸一旦被别处压低，它会把问题从"只是难看"升级成"直接看不见"。

**用户反馈（九）：HTML/JS 切「内容」有没有必要？HTML 不支持预览吗（已修）**。两问分开答，结论不同：

- **「全文」不冗余**：改动档**只含变更行、无上下文**（`src/hooks/handlers.ts` 的 LCS 只推 `+/-`），所以对**改过的文件**，"完整文件"与"改了什么"是两个真实需求。但用户看到的 `sea-song.html` 是**新增**（`+674 −0`），改动档本身就是全文 → 两档看起来重复，**旧标签「内容」既不准确又容易被读成"渲染结果"**。现按 kind 改名：`text → 全文`、`markdown/html → 预览`、`image → 图片`、媒体/PDF/Office → `说明`。
- **HTML 确实一直不渲染**：`html → kind=text` 是既有分类（`src/core/preview.ts` MIME 表 + `kindFromMime`；`src/core/artifacts.ts` 的 `KIND_BY_EXT`），所以「内容」档只能给 `/files` 原文。现补 `HtmlPreview.svelte`（**唯一的 sandbox 实现**，产物面板与文件预览窗共用）：`<iframe sandbox="allow-scripts">`，默认档=预览，源码/改动可切换。
- **为什么只能 sandbox，以及为什么这属于安全面**：`/api/v1/files` 与 Web **同源**，而 `index.html` 内联 `window.__AIWORKER_TOKEN__`（该响应故意不带 ACAO）。Agent 写的 HTML 一旦以同源文档执行，`fetch("/")` 即可读出 token 再调权限写接口——**产物变提权入口**。故 `sandbox`（不给 `allow-same-origin`）是硬要求，且**绝不给 HTML 产物加"新标签打开"**；服务端另加 `fileSecurityHeaders()`：仅在**导航请求**上给 `text/html` 加 `CSP: sandbox allow-scripts`、给 `image/svg+xml` 加 `sandbox`，并恒发 `nosniff`——这样"手动把 `/files` 的 URL 贴进地址栏"同样降级，而 `<img>`/媒体子资源请求不受影响。
- **如实标注的边界**：opaque origin 下 `type="module"` 脚本与相对 `import` 会被拦；引用同目录兄弟资源的相对路径也**不会**解析（iframe 的 URL 是 `/files?path=…`，基址不是文件目录）→ 自包含单文件 HTML（本例 23.9 KB，全文无 `src=`/`href=`/`fetch(`）不受影响；多文件站点需另加**路径式预览路由**（`/api/v1/preview/<root>/<rel>`，让相对资源按目录解析），列入待办。

**结论（追加到检查清单）**：**"能不能渲染"从来不只是能力问题，先问"渲染后它在哪个源里执行"**——凡是把外部/模型产物交给浏览器执行的功能，第一句话必须是"它拿到什么 origin、能读到什么"。同时**同一语义在对话流与工作台必须一次改齐**（上一轮 SVG 就是只改了工作台才暴露不一致），所以本次 `HtmlPreview` 做成共用组件、两个界面同时接入。

**同轮一并说明的媒体与链接处理（非缺陷，属现状）**：媒体（video/audio/pdf/office/binary）**不内联**，详情给「打开预览」→ 复用 `FilePreview` 覆盖窗（`<video>`/`<audio>`/PDF `<iframe>`/Office 转换/下载兜底；`/files` 支持单区间 `Range` 供视频 seek），避免第二套渲染实现；链接只做**卡片 + 新标签打开**（`rel=noopener`，仅 http/https），**刻意不内嵌远端页面**——同源 iframe 等于把任意外站放进应用源，服务端抓取又要背 SSRF 与正文抽取的复杂度，两者代价都不值。已知待打磨：音频/PDF 其实可内联、`.svgz` 不在扩展名表、链接详情卡未显示 `site`。

---

## 九、后续预告（非本方案范围）

- **设置 / 控制台拆分**：`⚙` 现在 13 个 tab 混装"设置 + 观测 + 资源 + 系统"，建议拆成「设置」（模型 / 安全 / 工作区 / 交互 / 关于）与「控制台」（观测 / 资源 / 系统）；
- **「权限」迁到设置 → 安全**，并补齐目前 Web 完全缺失的入口：沙箱读写边界、受保护路径清单、永不自动批准清单（现在只能手改 `config/sandbox.json`）；
- **模型配置收口**：`配置`（选模型）与 `设备`（能力/参数/端点）目前分居两处，应合成一处（含上一轮的「检测图片能力」）。
