# 工具产物预览（Artifact / Preview）设计 —— Web 优先

> 目标：让 TUI 与 Web 都能**高亮**工具操作的文件与网络链接，并支持**点击预览**（文本/图片/视频/PDF/Office）。
> 本设计按用户裁定：**先 Web、Office 用轻量纯前端、本轮只出方案不改代码**。
>
> **状态（Phase A/B/C 已实现，未提交）**：后端 `ToolArtifact`/`ToolResult.artifacts`/`onToolResult` 透传、`src/core/preview.ts` 构建、fs/web handler 填充、`GET /api/v1/files` 安全端口（含审计）；Web `TimelineItem.artifacts`+`ToolCard` chips+`FilePreview`（文本/代码/图片/PDF/链接/下载/Office docx/xlsx 前端转换/彩色 diff，`.md` 复用 `DocRenderer`）；TUI `ToolBlock.artifacts` 存储 + `renderTool` OSC 8 超链接 chips（`file://` 打开默认应用、`https://` 开浏览器、类型徽标）。全量 build/lint/test/web:build 绿（821）。

## 〇、背景与问题

当前工具返回是纯字符串，UI 无法结构化识别"这是文件/这有链接"：

- `ToolResult = { tool_call_id, content, success, error? }`（`src/types.ts`），`content` 为纯文本。
- `fs_read` 只回文本内容；`fs_write/fs_edit` 只回结果摘要；`web_search` 把 URL 以 `URL: xxx` 纯文本嵌进 content（`src/tools/builtin.ts`）。
- `tool/result` 事件 `{ callId, success, content, error?, durationMs }`（`src/types.ts:425`）也带不动结构化元数据。
- 工具卡在 Web 端由 `ChatPanel.svelte` 把 `tool_call`/`tool_result` 组装成 `TimelineItem`，`ToolCard.svelte` 只渲染 `args`/`resultPreview`/`error`。
- **尚无文件预览端口**（`server.ts` 只有 `/api/v1` 前缀与 WS 总线）。

结果：文件没法点击查看，链接只是可复制文字；图片/视频/Office 更无预览入口。

## 一、总体原则

1. **权威来源是工具执行层**：只有 `fs_read` 知道它读了 `path=P`、`mime=…`、`size=…`；只有 `web_search` 知道结果里的 `url/title/site/snippet`。因此**产物元数据由工具 handler 自己填充**，不靠 UI 猜、不靠 LLM 编。
2. **content 保持不变**（LLM 需要文本文件内容去推理），`artifacts` 是**增量、给人看**的。
3. **二进制不进 content**：图片/视频/Office 不把原始字节塞进工具结果文本（体积爆炸/base64污染），只给 `file` artifact，UI **点击时才拉字节**。
4. **只读预览先行**：本轮预览是只读查看 + 下载；不做在预览里原地编辑。
5. **信任模型最小化**：文件端口 session 绑定 + 根目录白名单 + 反路径遍历 + 体积上限 + 审计。

## 二、数据模型（`src/types.ts`）

新增可选字段 `artifacts`，向后兼容（不填 = 现状行为）：

```ts
export type ArtifactKind =
  | "text" | "image" | "video" | "audio" | "pdf" | "office" | "binary" | "other";

export type ToolArtifact =
  | { type: "file"; path: string; mime: string; size: number; kind: ArtifactKind; root?: "session" | "project"; rel?: string; truncated?: boolean }
  | { type: "link"; url: string; title?: string; site?: string; snippet?: string }
  | { type: "diff";  path: string; patch?: string };

export interface ToolResult {
  tool_call_id: string;
  content: string;
  success: boolean;
  error?: string;
  artifacts?: ToolArtifact[];   // 新增：结构化产物（UI 高亮/预览用）
}
```

- `path` 为**解析后的绝对路径**（fs 工具已在 handler 内 `resolve(ctx.workingDir, …)`）；**`root`/`rel` 也由 handler 计算好**（文件在会话 `workingDir` 下 → `root="project"`、`rel=relative(workingDir,path)`；在 `dataDir/docs` 下 → `root="session"`）。Web **无需再反推**路径→root 映射，消除客户端耦合与歧义。
- `kind` 由 `mime`/扩展名判定，用于 UI 分派渲染器。
- **Web 侧需独立类型**：web 用 `$lib` alias（`vite.config.ts`），无法 import `src/types.ts`；`TimelineItem` 是 web 本地接口（`web/src/lib/stores/chat.svelte.ts:68`）。应在 `web/src/lib/`（如 `artifacts.ts`）定义**同构** `ToolArtifact`/`ArtifactKind`，`TimelineItem.artifacts?: ToolArtifact[]` 引用之。两端靠 WS JSON 结构一致，不共享模块。
- **事件通道要修正**：Web 消费的是 WS 流消息 `tool_result`（下划线，`onToolResult` 产出），**不是**事件总线 `tool/result`（斜杠，types.ts:425，Web 不消费）。见 3.3。
- 工具类：`src/core/preview.ts`（新）放 `mimeFromPath(path)`、`kindFromMime(mime)`、`isTextKind(kind)` 等纯函数，供各 handler 复用与单测。

## 三、后端管道（handler 填充 → 事件透传）

### 3.1 各 handler 填充 artifacts

| 工具 | 产出 artifact |
|---|---|
| `fs_read` | `file`（path、mime、size、kind、root、rel；文本类型含 `truncated`） |
| `fs_write` | `file`（path、mime、size、kind、root、rel） |
| `fs_edit` | `file` + `diff`（path、patch；diff 在 **handler 内现算**新旧内容对比，**不复用 hook 层 fileDiff 事件**——那是 `onFileDiff` 回调 + dataDir 快照，非工具结果字段） |
| `web_search` | `link` 数组（每个结果 title/url/site/snippet）——数据已 parse，直接映射 |
| `web_fetch` | `link`（目标 url + 页面 `<title>`；现状只返回清后文本，需**补 `<title>` 解析**） |

### 3.2 二进制读取决策（fs_read 关键改动）

- 读文件前先嗅探：文本类（`utf-8` 可解码/扩展名文本/knowmime 文本）→ 现有行为不变（content = 文本）。
- 二进制类（图/视频/Office/其它）→ **content 改成短元信息**（如 `[binary 文件: xx.png · 123KB · 点击右下角预览/下载]`），真正内容交给 artifact + `/files` 端口；LLM 通常也用不上原始字节。
- 用 `file-type`（或**扩展名+前 N 字节 magic byte 嗅探**，优先不加新依赖）判断；**先嗅探再决定读法**——二进制只读前 N 字节判型并返回元信息，**不整读 utf-8**（现有实现先 `readFileSync(utf-8)` 会把二进制毁成乱码，本轮一并修正为安全读）。
- **`content` 可能已被 spill**：`fs_read` 现返回 `spillOrTruncate`，大文件 content 是"已落盘"引用而非全文。预览应**重读全文**（经 `/docs/content` 或 `/files`，不受 spill 影响）；"content=LLM 文本"前提仅对小文件成立。
- 该改动要配单测：确保**文本文件 LLM 可读**（content 不变/语义等价），**二进制文件不崩、不塞字节**。

### 3.3 事件透传（关键：走 WS `tool_result`，不是 `tool/result`）

Web 消费的是 WS 流消息 **`tool_result`（下划线）**——由 `onToolResult(name, success, summary, id)` 产出，而 agent-loop（`src/core/agent-loop.ts:466`）目前传 `result.content.slice(0,100)`（**只有摘要**，不含 content/artifacts/callId）。`tool/result`（斜杠，`src/types.ts:425`）是**事件总线**另一通道，Web 不消费。

要带 `artifacts` 到 Web，需三处同步扩展：
1. **`onToolResult` 回调签名**（`src/types.ts:138`）：增 `artifacts?: ToolArtifact[]` 参数；agent-loop 调用处透传 `result.artifacts`。
2. **WS `tool_result` 写出点**：server.ts **三处** `write({ type: "tool_result", name, success, summary, ... })`（约 1549 / 1627 / 2023，分别对应单智能体/collab/chat 三条流）都补 `artifacts`。
3. **ChatPanel 消费**：`tool_result` 分支读 `data.artifacts` 写入 `TimelineItem.artifacts`。

TUI：`turn-view.ToolBlock` 增加 `artifacts`；`toolResult(callId, ok, preview, full, durMs, artifacts?)` 存储。

## 四、文件加载路径（复用现有 `/docs/content` ＋ 新增二值 `/files`）

**不重造文本取件**：文本类（含 `.md`、代码文本）**复用现有** `GET /api/v1/docs/content?root=&path=&sessionId=`（root∈session|project，`relative()` 反遍历 + 根白名单，只取 UTF-8 文本，返回 `{content}`）。文本 artifact 以 `root=project`、`rel=相对 workingDir 路径` 调用，即可直接喂给现有 `DocRenderer`。

**新增二值端口**（现有 `/docs/content` 只能取 UTF-8 文本，二值取不了）：

```
GET /api/v1/files?session=<id>&path=<abs|rel>
```

实现原则（复用现有沙箱/审计模式，参考 `fs_write` 的反遍历与 `/docs/content` 的安全检查）：

1. **session 绑定**：此处"绑定"= 校验 `sessionId` 有效 + 解析后路径落在该会话允许的根目录内。**项目无登录体系/token**（server.ts 无 per-request 鉴权），`<img>/<video>/<iframe>` 子资源为**同源纯 GET**，只靠同源 + query 传参，**`/files` 不得要求自定义 header**。
2. **根目录白名单**：候选根 = 会话 `workingDir`、`dataDir`（与 fs 工具一致）。解析后必须落在某一根内。
3. **反遍历**：`resolve` + 存在后 `realpath`，拒绝 `..`/绝对逃逸；不在根内 → 403（与 `/docs/content` 的 `relative(base,abs).startsWith("..")` 同构）。
4. **体积上限**：超限文本截断；媒体用 `createReadStream` + `Range` 流式，不整读进内存。
5. **Content-Type**：由 `mimeFromPath` 决定；图片/媒体 `inline`，Office/未知强调 `Content-Disposition`（可 `?download=1` 附件）。
6. **审计**：文件读取走现有审计/日志，与其它敏感操作一致。
7. **`/files` 只服务二值 + 大文本**：小文本/`.md` 可走 `/docs/content`；**大文本若走 `/docs/content` 无上限**（`readFileSync` 整读，`DocRenderer` 亦 uncapped），超出阈值的文本应改走 `/files` 的 `Range`/截断或前端按行截断——避免内存/传输爆炸。

> 文本内容尽量**不经过** `/files`（保持 `/docs/content` + `DocRenderer` 现状不被破坏）；`/files` 承担二值字节 + Range 流式 + 大文本兜底。
> **root/rel 已在 handler 算好**（见数据模型），Web 直接用 `artifact.root/rel` 拼 `/docs/content` URL，不再做路径→root 映射。
> **`/docs/content` 为 `resolve` 未 `realpath`**（潜在符号链接逃逸，但与现有文档库行为一致、非新增风险）；如需严格防符号链接逃逸，文本可改走带 `realpath` 的 `/files`。
> **URL 传参需 `encodeURIComponent(path/rel/sessionId)`**（绝对路径含空格/非 ASCII）。
> 本端口服务于 **聊天主 UI**（同源）。**生成的 app 沙箱 iframe 不在本设计范围**（app 无 terminal 能力、且不应有任意读文件权限）；app 的文件预览属另一议题。
> 沙箱 iframe 的 `null` origin 对 cookie 的影响在"生成的 app"场景才相关，聊天主 UI 不受影响（见风险表"生成的 app iframe"行）。

## 五、Web 渲染层

### 5.1 时间线数据

- `web/src/lib/stores/chat.svelte` 的 `TimelineItem` 增加 `artifacts?: ToolArtifact[]`。
- `ChatPanel.svelte` 在 `tool_result` 分支写入 `t.artifacts = data.artifacts`。

### 5.2 ToolCard 高亮 chip（`web/src/components/ToolCard.svelte`）

结果预览后渲染 chip 行（有 `artifacts` 才显示）：

- `file` → 彩色 chip：按 `kind` 给图标（📄 文本/🖼️ 图片/🎬 视频/🎧 音频/📊 Office）+ **basename** + `size` 缩写；点击 → ① `.md`/文本文档则**复用 `DocRenderer`**（可用"在文档预览面板打开"落到右栏），② 二值/代码则打开 `FilePreview`。
- `link` → 青色可点 chip：`<a href target="_blank" rel="noopener noreferrer">`，显示 `site`/`title` + 域名；点击新标签打开。**URL scheme 仅 http/https**（复用 `sanitizeUrl`，防 `javascript:` 注入）；结果**限幅显示**（前 N 条 + "更多"，`web_search` 最多 10 条）防刷屏。
- `diff` → chip 打开 diff 查看器（路径 + patch 高亮；`fs_edit` handler 现算的 diff 存入 patch 字段）。

### 5.3 预览入口分层（复用 DocRenderer，不做第二套 Markdown 渲染）

文本类与二值类**分开处理**，最大程度复用现有文档预览、不破坏它：

- **`.md` / 文本文档 artifact** → 直接**复用 `DocRenderer`**（label doc：`docs/content?root=project&path=<relWorkingDir>`；会话资产则 `root=session`）。可选在 chip 上给"在文档预览面板打开"，落到现有右栏 `DocRenderer`——用户只看到一套文档阅读体验；也可内联复用 `DocRenderer` 渲染。
- **二值类 + 非 Markdown 文本**（`.py/.ts` 等代码、图片、视频、PDF、Office）→ 轻量 `FilePreview.svelte`（新 modal/抽屉），入参 `{ sessionId, path, mime, kind }`，构造 `fileUrl = /api/v1/files?session=&path=`，按 `kind` 分派：

| kind | 渲染 |
|---|---|
| text(非 md 代码) | fetch 文本 → 代码高亮 / 原样 `<pre>`（不做 markdown 解析） |
| image | `<img src=fileUrl>` |
| video/audio | `<video>/<audio controls src=fileUrl>` |
| pdf | `<iframe src=fileUrl>` |
| office | dynamic import（见 5.4） |
| binary/other | 元信息卡 + 下载按钮 |

面板统一：顶部文件名/类型/大小、加载与错误态、`下载` 与 `关闭`；对超限文本给截断提示。

### 5.4 Office 轻量纯前端转换

依赖用 **dynamic import**（不进首屏包）：`mammoth`（docx）、`xlsx`/SheetJS（xlsx/csv）。

- `docx` → `fetch(fileUrl).arrayBuffer()` → `mammoth.convertToHtml({arrayBuffer})` → 渲染 HTML。
- `xlsx/csv` → SheetJS `read` → 渲染为表格。
- `pptx` → **本轮以"下载 / 用默认应用打开"兜底**（无可靠轻量客户端渲染；高保真需服务端 LibreOffice，按用户裁定本轮不上）。
- 失败统一走下载/错误态。

## 六、TUI 层（本次次要，方案备档）

- `turn-view.ToolBlock` 存 `artifacts`；`renderTool` 把文件路径渲染成 **OSC 8 超链接**（`file://<abs>`，点击用系统默认应用打开），URL 渲染成 `https://…` 超链接（点击开浏览器）——`markdown.ts` 已支持 OSC 8，零新依赖。
- 文件类型徽标（📄/🖼️/…）+ color（文件蓝、链接青）。
- 文本文件内容本就显示在 tool 块（即"预览"）；图片/视频/Office 点击即开。
- 内联图片（kitty/sixel）本轮**不做**（依赖终端支持，属 stretch goal）。
- **细节**：Windows 路径需 `file:///C:/…` 形式；不支持 OSC 8 的终端回落为普通着色文字；OSC 8 是单字符序列，需确认经 `wrapSingle`（含 gutter 重放）切分**不在序列内部**断开（`escapeEnd` 已识别 OSC，须回归验证）。

## 七、范围边界（明确不做）

1. 服务端 LibreOffice/ffmpeg 等重转换（Office 用轻量前端，pptx 下载兜底）。
2. TUI 内联图片协议（sixel/kitty）。
3. 生成的 app 沙箱内的文件预览。
4. 在预览面板里原地编辑（本轮只读 + 下载）。
5. Web 内嵌 mini 浏览器渲染网页（链接先新标签打开）。
6. **不改动现有文档预览链路**：`DocRenderer.svelte` / `DocPreviewPanel.svelte` / `/docs` / `/docs/content` 现有实现**一律不动**，仅复用；Markdown 预览行为保持原样，不得回归。
7. 不为 artifact 预览**新增独立 Markdown 渲染器**（复用 `DocRenderer`；`FilePreview` 只承担二值与代码文本）。

## 八、分阶段实施计划

**Phase A — 核心闭环（Web）**
1. `src/types.ts`：`ToolArtifact`/`ArtifactKind` + `ToolResult.artifacts?` + `onToolResult` 回调加 `artifacts` 参数；`tool/result` 事件总线（如另有消费方）同样加 `artifacts`；server.ts 三处 `tool_result` 写出点补 `artifacts`（见 3.3）。
2. `src/core/preview.ts`：`mimeFromPath` / `kindFromMime` / 文本判定；`src/tools/builtin.ts` 各 handler 填充（fs_read 二进制安全化、web_search 映射 link、web_fetch link）。
3. `server.ts`：`GET /api/v1/files` 二值端口（session 绑定/root 白名单/反遍历/上限/Range/审计）；文本走现有 `/docs/content`（不变）。
4. Web：`TimelineItem.artifacts` + `ToolCard.svelte` chips（`.md`/文本→复用 `DocRenderer`，二值→`FilePreview`）+ `FilePreview.svelte`（图片/PDF/链接 + 代码文本）。
5. TUI：`ToolBlock.artifacts` 存储（渲染留到 Phase C）。

**Phase B — 增强（Web）**
6. `FilePreview` 视频/音频流式；`docx`(mammoth)/`xlsx`(SheetJS) 前端转换；`diff` 查看器；大小限制/出错态打磨。

**Phase C — TUI + 打磨**
7. TUI OSC 8 超链接 chips + 类型徽标；审计/日志补全；回归冒烟。

## 九、验证

- 后端单测：artifact 构建（fs_read 文本/二进制、web_search 多 link、fs_write/fs_edit）、`mimeFromPath/kindFromMime`、**`onToolResult` 透传 `result.artifacts`**（agent-loop 单测）、**WS `tool_result` 写出生效**（server 单测捕获三处 `write` 负载含 `artifacts`）。
- 文件端口单测：反遍历（`..`/绝对逃逸/根外）、session 绑定、非会话根 403、体积上限、`Content-Type`、`Range` 媒体流、404。
- fs_read 回归：文本 content 语义不变（LLM 可读）、二进制不崩且不塞字节、大文件 spill 预览仍取全文。
- 全量：`npm run build && npm run lint && npm test && npm run web:build`。

## 十、风险与对策

| 风险 | 对策 |
|---|---|
| fs_read 二进制行为变更影响 LLM | 文本判定保守（只对明确二进制走元信息）；content 对文本语义等价；单测护住 |
| **`onToolResult`/WS 管道改不全**（artifacts 丢到 Web） | ①扩展回调签名 ②server 三处 `tool_result` 写出点全补 ③ChatPanel 读 `data.artifacts`；单测捕获三处负载 |
| **Web 类型与 src 不共享** | web 侧独立同构 `ToolArtifact`/`ArtifactKind`；两端靠 WS JSON 结构一致 |
| 文件端口被当任意文件读取器 | session 绑定 + root 白名单 + realpath + 反遍历 + 体积上限 + 审计；仅暴露 `workingDir/dataDir`；不得要求自定义 header（子资源纯 GET） |
| 大文本走 `/docs/content` 无上限 | 阈值内走 `/docs/content`，超阈值文本改走 `/files` Range/截断，或前端按行截断 |
| **`fs_read` 判型后读法** | 先 sniff 再读；二进制不整读 utf-8（防乱码）；文本语义等价 |
| `file-type` 依赖取舍 | 优先扩展名+magic-byte 小判型表（不加依赖）；确需精确 MIME 再引 `file-type` |
| **`tool_result` 关联为位置匹配**（非 callId） | WS `tool_result` 现无 callId，Web 按"首个未决 tool"匹配（既有局限）；并行/乱序工具可能错关联，本轮不扩展（如需精确关联，后续在 WS 消息加 callId） |
| 生成的 app iframe 需读文件但无权限 | 本轮明确**不做** app 场景；聊天主 UI 同源鉴权不受影响 |
| mammoth/SheetJS 增大首屏包 | 一律 dynamic import；失败回退下载 |
| `pptx` 无法轻量预览 | 已裁定为"下载 + 默认应用打开"兜底；后续可选 LibreOffice |
| link chip 注入/刷屏 | URL scheme 仅 http/https（复用 `sanitizeUrl`）；结果限幅显示（前 N + 更多） |
| Web 需服务器相对地址（`API = "/api/v1"`，dev 经 Vite 代理 :5173→:3000，prod 同源） | 预览 URL 复用现有 `API` 常量（`${API}/files`、`${API}/docs/content`），与代理/同源配置一致 |
| TUI OSC 8 被 wrap 切断 / Windows `file://` 格式 | `escapeEnd` 已识别 OSC（须回归验证）；Windows 用 `file:///C:/…`；不支持 OSC 8 的终端回落着色文字 |

## 十一、验收冒烟矩阵（Web 优先）

1. 一轮里 agent 调用 `fs_read`（文本）→ ToolCard 显示 📄 文件 chip，点击打开高亮预览。
2. agent 调用 `fs_read`（图片/视频/Office）→ chip 出现；图片 `<img>` / 视频可播 / Office 按 5.4 处理，均可下载。
3. `web_search` → 结果每条 link chip，点击新标签打开正确 URL。
4. 文件端口安全：手改 `path=../..` 或绝对路径 → 403；非会话根 → 403。
5. `fs_edit` → diff chip 打开 diff 查看器。
6. TUI：文件/链接 OSC 8 可点；类型徽标显示。
