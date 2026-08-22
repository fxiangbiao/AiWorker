# Changelog

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
