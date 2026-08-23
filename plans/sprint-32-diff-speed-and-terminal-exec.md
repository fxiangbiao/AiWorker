# Sprint 32 — 文件变更检测提速 + terminal_exec 用途明确

> 状态：**✅ 已实施（0.6.5）**
> 需求：1) 「文件变更」检测慢，找出原因并优化；2) terminal_exec 是否被模型误用于写入/修改文件（描述不清晰）
> 2026-08-23 排查结论见下

---

## 一、问题 1：文件变更检测慢 — 根因（实测）

实测数据：工作目录 `ai_default_project` 共 **17992 个文件**：

| 目录 | 文件数 | 性质 | 是否用户关心 |
|---|---|---|---|
| `echotown_prototype\.godot` | 9120 | Godot 引擎缓存（`.md5/.ctex/.import` 引擎自动生成，随导入/运行高频重写） | ❌ 纯噪音 |
| `echotown_prototype\assets` | 8454 | **用户资产**（`.png/.glb/.fbx/.obj/.dae/.scn` 等） | ✅ 资产本身关心，但内容不可预览 |
| `passman\node_modules` | 254 | 依赖 | ❌ |
| 真正源码（scripts/core/test/web） | ~300 | 文本源码 | ✅ 行级 diff 展示 |

`data/snapshots/9c9f0d62…` 会话已有 **16484 个 .diff 快照**，几乎全是 `.godot_imported_*.md5.diff`、`*.import.diff`、`*.glb.diff` —— 引擎缓存与二进制资产被当"变更"逐文件全文读取 + base64 落盘。

### 根因 A：指纹扫描每次工具调用全量递归 + 范围过大

`src/hooks/handlers.ts` `onToolCallPost`：**任何工具调用后**（含 `web_search`/`fs_read` 等只读工具）都 `scanDirFingerprint` 全量递归 + statSync，`skipDirs` 未跳过 `.godot`、构建产物目录。

实测：全量枚举 ~388ms / stat ~15ms。**单次扫描并非不可接受，问题是"每次工具调用都扫"+"变更后逐文件读全文/base64 落盘"**。

### 根因 B：变更文件全文读取 + base64 落盘

指纹监控发现变化后，`recordDirDiff` 对**每个**变化文件 `readFileSync` 全文 + base64 编码写快照（`new_b64`）——二进制资产（.glb 可达数 MB）逐次读全文编码，慢且快照爆炸。

### 根因 C：`/diffs` 每次请求全量解析所有快照

`server.ts` `scanDiffs` 每次 GET `/diffs` 都 readFileSync + parseDiffFile 全部 .diff 文件（16484 个），Web 每次 diffVersion 变化都卡。

## 二、问题 1：优化方案（v3）

### 核心设计：三级检测 + 分层快照

```
精确通道（fs_write，已有）：onToolCallPre 存旧内容 + post 行级 diff      ✅ 不动

指纹通道（兜底，terminal_exec / MCP / 插件等不可预知写入）：
  只对「可能写文件的工具」触发 + 扫描范围分层 + 会话级节流 + 快照分级
```

### 1. 指纹扫描只在"可能写文件"的工具后触发

新增**写工具白名单**：`terminal_exec`、`terminal_session`、`mcp_*`、插件工具（`plugin_*`）。`onToolCallPost` 中：

```ts
// 只读工具（web_search / fs_read / fs_list / web_fetch / math_eval 等）不触发指纹扫描
if (!MAY_WRITE_TOOL.test(toolName)) return;
```

`fs_write` 走精确快照逻辑，指纹层跳过（现有 `fsWritePaths` 机制保留）。

### 2. 扫描范围分层（不丢用户资产）

**目录跳过（仅机器生成、无业务价值的缓存/依赖/产物）**：

```ts
const SKIP_DIRS = new Set([
  ".godot",       // Godot 引擎缓存（9120 个，导入/运行自动重写，非用户资产）
  "node_modules", ".git", "dist", "web", ".svelte-kit", ".aiworker_history",
  "build", "out", "target", "coverage", ".next", ".vite",
]);
```

**用户资产文件（assets 下的 .png/.glb/.fbx/.obj 等）不再跳过** —— 变更仍被检测，但快照降级（见第 3 点）。

### 3. 快照分级：可展示文本 vs 不可展示内容

`scanDirFingerprint` 扫描时按内容可展示性给每个文件打标，`recordDirDiff` 分两档写快照：

| 级别 | 判定 | 快照内容 | 前端展示 |
|---|---|---|---|
| 文本（可展示） | 扩展名白名单 OR 文件头无 NUL 字节 | 行级 diff + `new_b64`（现状） | 行级 diff / 当前内容 |
| 二进制（不可展示） | 不在文本白名单 或 文件头 512B 含 NUL | **仅元信息**：`# path` + `---` + `binary: 1` + old/new 大小字节数，**不读全文、不 base64** | "二进制文件已变更（内容不可预览）" |

文本扩展名白名单：`.ts .js .mjs .cjs .json .md .html .css .svelte .py .txt .yml .yaml .toml .ini .cfg .env .gitignore .sh .bat .ps1` 等源码/文档类。

→ 用户资产变更**不丢**（Web 可见"xx.glb 已变更"），但**不再读全文、不 base64、快照极小**，性能与噪音同时解决。

### 4. 会话级节流

同一 session 两次 `scanDirFingerprint` 间隔 ≥ 2s（`lastScanAt` Map），一轮内多次写工具调用合并为一次扫描。

### 5. `/diffs` 快照目录签名缓存

`server.ts`：记录 `snapshotsDir` 的 `(文件总数, 目录 mtime 最大值)` 签名；签名未变直接返回内存缓存（TTL 30s 兜底）；变化才重新 `scanDiffs`。

### 6. 存量噪音快照清理

- 删除 echotown 会话中 **`.godot` 引擎缓存类**噪音快照（`.godot_imported_*.md5`、`*.ctex`、引擎生成的 `.import` 等）；
- 二进制资产快照（`*.glb.diff` 等，量大且 base64 无意义）可选降级/删除 —— 由用户确认范围。

### 前端配套（FileDiffPanel / server 类型）

- `DiffFile` 增加 `binary?: boolean` 字段；`parseDiffFile` 识别 `binary: 1` 元信息行；
- FileDiffPanel 渲染：`binary` 文件显示占位"二进制文件已变更（内容不可预览）"，不渲染行级 diff / 当前内容块。

### （不采用）fs.watch 事件驱动

Windows 上事件可靠性差（编辑器原子替换 tmp+rename、事件丢失），且需维护 watch 生命周期/多会话共享；过滤后全量扫描已毫秒级。**不采用**，保留扫描兜底语义。

## 三、问题 2：terminal_exec 误用于写文件 — 根因

工具描述过于简略：`"执行终端命令。返回 stdout 和 stderr。"`。模型不知道写文件应首选 `fs_write`（精确行级 diff + 审计）；用 shell 重定向（`echo >`、`type nul >`、`copy`、`move`、`sed -i`）写文件会绕过精确追踪，只留"内容已变化（旧内容不可恢复）"。

## 四、问题 2：优化方案

### 1. terminal_exec 描述重写（`src/tools/builtin.ts`）

```ts
description:
  "执行终端命令（编译、运行测试、包管理、Git、查看输出等）。" +
  "写入/修改文件请使用 fs_write 工具（支持精确差异记录与审计）；" +
  "不要用 shell 重定向（>、echo、type、copy、move 等）写文件，否则变更无法被精确追踪。"
```

### 2. 各 agent system prompt 统一

- `coding-agent.ts`、`default-agent.ts`、`data-analysis-agent.ts`、`game-dev-agent.ts`：terminal_exec 行补"写文件用 fs_write"。

### 3. fs_write 描述补一句

`"写入文件内容。自动创建父目录。写文件请首选本工具（变更可精确追踪）。"`

## 五、验证

1. `npm test` 全绿（445）；新增 /diffs 缓存测试（可选）。
2. 实机验证：
   - 工具调用后无卡顿（指纹扫描仅写工具触发 + 目录分层后大幅收敛）；
   - 用户资产（.glb/.png）变更**仍出现在** Web 文件变更面板（显示"不可预览"），`.godot` 缓存不再产生快照；
   - Web /diffs 响应明显下降。
3. 双 remote push（GitHub 443 + Gitee）。

## 六、涉及文件

| 文件 | 改动 |
|---|---|
| `src/hooks/handlers.ts` | 写工具白名单触发 + SKIP_DIRS 分层 + 二进制降级快照 + 2s 节流 |
| `src/server.ts` | `DiffFile.binary` 字段 + `binary: 1` 解析 + /diffs 签名缓存 |
| `web/src/components/FileDiffPanel.svelte` | binary 文件占位展示 |
| `src/tools/builtin.ts` | terminal_exec 描述重写 + fs_write 描述补充 |
| `src/agents/coding-agent.ts` 等 4 个 | system prompt 补写 |
| `test/server.test.ts` | binary 解析 + /diffs 缓存测试（可选） |
