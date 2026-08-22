# Changelog

## 0.6.3 (2026-08-22)

### TUI 会话导出 + Web 系统配置
- **TUI `/export [序号]`**：导出会话为 Markdown 文件（默认当前会话，`/export <序号>` 按 `/sessions` 序号；写入工作目录 `<标题>.md`）；渲染逻辑与 Web 共用（`memory/session-export.ts` 抽取）
- **Web 系统配置**（SystemPanel 新增「配置」Tab，等价 TUI `/config`）：模型下拉 / 温度 / max-tokens / **每专家迭代上限** / 思考展示开关 / 技能自动沉淀开关 / 恢复默认（reset）；设置持久化 `data/runtime-config.json`
- HTTP：`GET/POST /api/v1/config`（`setConfigField` 由 index.ts 注入，复用 modelRouter/agents/hookManager/persistRuntimeConfig）
- `persistRuntimeConfig` 提升为 server 与 CLI 共用闭包
- 测试 +5（/export 2 例 + config 端点 3 例）

## 0.6.2 (2026-08-22)

### 帮助系统精简
- `/help` 表格精简为两列（命令+别名 / 一句话功能），长 usage/detail 不再撑宽表格
- **命令级帮助**：`/<命令> --help`（或 `-h`/`help`）显示该命令的 用法/功能/说明/别名；`/help <命令>` 等价；**必选参数命令无参数时自动显示帮助**
- `/help <命令>` 查看指定命令详细用法

## 0.6.1 (2026-08-22)

### 裸格式导入导出（除 .aw 外）
- **导入**（`/install <路径>` 自动识别 + Web 导入按钮接受 `.md`/`.json`）：
  - `SKILL.md` → 解析 frontmatter 装到 `skills/<name>/`（附 manifest.json）
  - MCP 配置 `.json` → 文件名作服务器名合并 `config/mcp.json`
  - 插件目录 → 入口探测后拷贝到 `config/plugins/<name>/`
- **导出**（`/pkg export <类型> <名称> --raw` + Web「导出 .md/.json」按钮）：技能 → 裸 `SKILL.md`；MCP → 裸 server 配置 JSON；插件 → 复制目录（CLI）
- HTTP：`/packages/peek` 与 `/packages/import` 支持裸格式（`filename` 分发）；`/packages/export?raw=1`
- 测试 +7（installer 裸格式 7 例 + cli/server 裸格式用例）

## 0.6.0 (2026-08-22)

### .aw 资产包导入导出（技能 / MCP / 插件）
- **统一分发格式 `.aw`**（zip + manifest.json）：`scripts/pack-aw.mjs` 打包脚本 + `src/core/zip.ts`（零依赖 zip 读写，deflate/store）+ `src/core/package-installer.ts`
- **支持三类型**：`plugin` → `config/plugins/<name>/`（入口校验 + 回滚）、`skill` → `skills/<name>/SKILL.md`（frontmatter meta 读取）、**`mcp` → 合并条目到 `config/mcp.json`（冲突需确认）**
- manifest 校验：formatVersion / type / 包名白名单 / semver / minAppVersion；**路径穿越防护**（相对路径校验 + 解压后入口探测，失败回滚）
- **CLI**：`/install <path> [-f]`（安装）、`/pkg export <skill|mcp|plugin> <名称> [路径]`（打包导出）、`/pkg list`（可导出 + 已安装）
- **HTTP**：`GET /api/v1/packages/export`（下载 .aw）、`POST /api/v1/packages/peek`（导入前预览 manifest 供安全确认）、`POST /api/v1/packages/import`（base64 上传）、`GET /api/v1/packages/list`
- **Web**：系统面板技能/MCP/插件三 Tab 均支持导入（.aw 文件选择 → peek 确认 → 安装）与导出（下载 .aw）；插件/MCP 导入前弹安全警告
- 测试：installer 22 例（zip round-trip / mcp 安装冲突导出 / 路径穿越 / 回滚）+ cli/server 端点覆盖

## 0.5.1 (2026-08-22)

### 定时调度自然语言添加
- **自然语言解析**（`src/core/nl-schedule.ts`，规则优先）：每 N 分钟/小时、每天/每晚、每周X（含"每周一到周五"区间）、每月X号、每工作日/每周末；时间词（凌晨~午夜，下午/晚上 +12 小时）+ 整点/半点/X点X分/X:XX
- `/schedule add "每天早上8点生成早报"` 直接可用；规则解析失败时 **LLM 兜底**（few-shot 转 JSON，cron 合法性校验）
- `POST /api/v1/schedule` 支持无 cron 自然语言；Web 调度 Tab 增加自然语言输入框（cron 填写降为可选项）
- 无时间无频率的文本（如"帮我写个程序"）正确拒绝，不再误解析为每天任务

### 会话轮数修正
- `listSessions` 新增 `turnCount`（用户消息条数）；Web 侧边栏与 TUI `/sessions` 均显示真实轮数（修复"0 轮"）

### Web UI 优化
- 「系统」面板改左右布局（左侧菜单 + 右侧内容）
- 「文件变更」：目录树单目录独立折叠（$derived 自动追踪 + 按会话隔离）、列表拖拽滚动、diff 行号/符号不可选 + 点击行复制

## 0.5.0 (2026-08-22)

### 后台任务 + 定时调度
- **JobRunner**：`/bg <任务>` 后台执行不阻塞交互；状态机 queued→running→done/failed；并发上限 2（超出排队）；结果写独立会话 + 审计 + **WS `job/done` 实时推送**；后台任务不注册确认通道（fail-closed 自动拒高危）
- **Scheduler**：`config/schedule.json` 定义 cron 任务（cron-parser，5 字段标准 cron），到点自动提交 JobRunner；无效 cron 跳过记审计；支持 `/schedule` 命令与 HTTP 端点
- CLI：`/bg` / `/jobs`（含 cancel）/ `/schedule`（list/add/remove）
- HTTP：`GET/POST /api/v1/jobs`、`DELETE /api/v1/jobs/:id`、`GET/POST /api/v1/schedule`、`DELETE /api/v1/schedule/:id`
- Web SystemPanel 新增**调度 Tab**：定时任务增删 + 后台任务状态（WS 驱动实时刷新）

### 首次运行引导
- **`.env` 加载**（`env-loader`，零依赖）：KEY=VALUE 注入 process.env（不覆盖已有变量、BOM 容错）
- **三步引导**：TUI 模式 + 无 DEEPSEEK_API_KEY + 未完成过时触发——输入 API Key（写 `.env` 立即生效）→ 选权限模式（写 `permissions.json`）→ 确认目录；`/setup` 随时重进；`--server` 模式跳过

## 0.4.0 (2026-08-22)

### 迭代预算管理
- **默认上限扩容**：default 30→60 / coding 50→100 / product-ops 40→80 / financial 60→120 / data-analysis 60→120 / game-dev 70→140 / research 80→160（`config/agents/*.yaml` + default TS）
- **运行时可调**：`/config iterations <10-1000>` 设置当前专家上限，持久化 `data/runtime-config.json`（`iterations` 字段，启动自动恢复；向后兼容旧文件）
- **预算感知收尾**：剩余迭代 ≤5 轮注入一次收敛提示；撞顶不再裸返回"达到迭代上限"，改为返回最后进展 + 建议（继续追问或 /plan 拆分）
- **空转强制终止**：连续相同 (tool, args) ≥6 次强制终止（提醒阈值 3 之上），报告进展
- **工具全失败终止**：连续 4 轮全部工具调用失败提前终止

## 0.3.0 (2026-08-15)

### 执行沙箱（对比报告 #3）
- **策略化命令沙箱**：`config/sandbox.json` + `src/security/sandbox.ts`
  - cwd 越界约束（fail-closed）：`terminal_exec` 工作目录必须位于 workingDir/allowDirs 内
  - `denyCommands` 配置化命令黑名单（叠加 danger-detector 正则层）
  - `stripSecretEnv`：执行时剥离含 KEY/TOKEN/SECRET/PASSWORD 的环境变量
- 接入 `terminal_exec` 与 `terminal_session`（spawn env 清理 + exec 前策略检查）
- 说明：不做 OS 级进程沙箱（bwrap/restricted-token）——Node 无原生 API、信任模型为本人执行

### WebSocket 实时总线（对比报告 #8）
- `EventBus` 事件总线 + `GET /api/v1/ws`（ws 包，心跳 30s 清理死连接）
- chat/plan/debate 事件 SSE 与 WS 双写广播；会话创建/重命名/删除/新消息广播 `session/update`
- Web UI WS 连接 + 指数退避重连：会话列表/消息多标签页实时同步（SSE 仍为单次任务主通道，双通道不重复渲染）
- vite dev proxy 支持 WS 转发

### CI / 测试
- **GitHub Actions**：`.github/workflows/ci.yml`（windows + ubuntu 双平台：lint + build + vitest + web:build）
- npm scripts 跨平台化（cross-env 替代 Windows `set` 语法）
- 测试与真实配置解耦：`test/fixtures/models.json`（ModelRouter 注入 fixture，改配置不再碎测试）
- terminal-session 测试平台守卫（非 Windows 跳过）
- 新增沙箱 9 例 + WebSocket 4 例，共 **345 测试**

### 其他
- `config/models.json`：default profile 移除冗余 temperature/maxTokens；lite 本地模型更新（Qwen3.8-27B-UD-IQ2_XXS, 4096）

## 0.2.0 (2026-08-15)

### 插件系统与工具作用域（Sprint 27）
- **轻量插件契约**：`config/plugins/<name>/` 每目录一插件（`plugin.ts|js` 默认导出 `setup(ctx)`，可选 `config.json`），零框架依赖
- `PluginContext`：`registerTool(..., {scope?})` / `registerHook` / `config` / `dataDir`
- **scoped 工具注册**：`ToolRegistry.getScope()` 作用域视图（同名遮蔽全局），agent 按专家隔离工具可见性
- 插件工具豁免可见性白名单（即插即用，与 `mcp_` 同待遇）；`mcp_` 前缀工具始终全局可见
- `/plugins` 命令 + `GET /api/v1/plugins`；同名冲突 ⚠ 警告
- **Hook fail-soft**：插件 hook 抛错不中断任务（记审计视为放行，权限用显式 `{proceed:false}`）

### 对比报告落地（Sprint 23-26）
- **LLM Provider Seam**：`LlmAdapter` 契约 + 稳定错误码 + adapter 注册表（未知 id 降级 openai-compatible）
- **事件溯源会话**：`session_events` 仅追加日志唯一真源，消息/轮次/工具/记忆均为投影，replay-safe
- **轨迹/遥测**：`/trace` 事件级时间线 + 会话统计；TelemetrySink seam + JSONL 导出
- **审批服务**：`ApprovalService` 权限决策单点（ask/plan/auto 三模式矩阵，fail-closed），权限 hook 薄委托
- **超长工具结果落盘**（spill）：>8000 字符写入 `data/spills/` 返回定位符
- **工具调用统一超时**：默认 60s 护栏
- **ask_user 提问工具**：TUI 输入行 / Web 提问卡片 / 单选多选 / 30s 超时
- **持久终端会话**：`terminal_session` 跨调用保留 cd/env，超时销毁防缓冲区错位
- **防循环提醒**：连续 ≥3 次相同 (tool, args) 注入 system 提醒
- **会话自动标题**：首条用户消息生成（≤24 字符，不覆盖手动重命名）
- **工具结果剪枝**：上下文组装前截断 >20K 字符 tool 消息（事件日志完整，replay-safe）

### TUI / Web
- TUI 输入行多行支持（Shift/Alt/Ctrl+Enter 换行）、流式 Markdown 表格对齐、硬件光标定位
- ask_user 交互：状态栏「等待你的回答」、↑/↓ 选项导航、Tab/空格 勾选（多选）
- TUI 会话切 Web 后工具时间线完整重建（`replayEvents`）
- Web：AskCard 选项逐行/复选、SystemPanel 插件 Tab

### 其他
- **版本机制**：`package.json` 单一版本来源（`getAppVersion()`），`--version` / Banner（动态居中）/ `/status` / `/api/v1/status` 统一
- 启动横幅精简：统一状态区（✓ 模型/专家/工具/插件/技能/项目），告警置状态区后
- 项目类型「未识别」展示友好化（unknown → 未识别，无逗号空洞）
- `/status` 命令显示版本 + 7 专家列表

## 0.1.0

- 初始版本：7 专家路由 + 工具/MCP + Skills + Hooks + 三层记忆，TUI 终端与 Web UI 双界面
