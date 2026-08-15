# Changelog

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
