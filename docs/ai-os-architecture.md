# AiWorker AI OS 架构（正式版）

> 版本 1.0.0 · 由 [AIOS-架构升级方案.md](AIOS-架构升级方案.md) 提炼定稿
> 一句话：**AI 是大脑、Harness 是手脚、应用是进程、一切皆可即时生成、用完即毁**

## 1. 设计愿景

AiWorker 从"多智能体个人助手"升级为**个人 AI 操作系统**——五个支柱：

| 支柱 | 落地 |
|---|---|
| AI 是大脑 | 认知内核（agent-loop / 7 专家路由 / 团队协作 / 上下文管理）只做决策，不直接碰文件/进程 |
| Harness 是手脚 | 一切执行走工具层（fs 四件套 / terminal / web / MCP / 应用进程），可审计、可拦截、可回滚 |
| 应用是进程 | 应用模型（tool/skill/agent/service/app）+ 生命周期状态机 + 子进程隔离 |
| 即时生成 | AppFactory：描述 → 生成 agent → 校验（语法/manifest/权限白名单）→ 安装 → 运行 → keep/destroy |
| 自进化 | 进化引擎闭环：观察 → 提议 → 两段式确认 → 写入生效 → 快照回滚 → 变更对比 → 黄金用例评测 → A/B 验证 → 阈值自动回滚 |

## 2. 分层架构

```
┌─────────────────────────────────────────────┐
│ 交互层：TUI（自研帧缓冲） · Web UI · CLI      │
├─────────────────────────────────────────────┤
│ 认知内核（大脑）：agent-loop · model-router · │
│   7 专家路由 · team-coordinator · 上下文管理  │
├─────────────────────────────────────────────┤
│ 执行层（手脚）：工具（fs/terminal/web/ask）·  │
│   MCP · Skills · Hooks · 能力桥（应用子进程） │
├─────────────────────────────────────────────┤
│ 进程层：Agent 进程 · App 进程 · Job/定时任务  │
├─────────────────────────────────────────────┤
│ 系统服务：event-bus(IPC) · audit 审计 ·       │
│   权限/沙箱 · 版本 · 设备（语音/视觉）        │
└─────────────────────────────────────────────┘
```

关键决策：认知内核不直接感知"应用"，只通过工具/事件与进程层交互——应用是"会自己干活、有生命周期、可被销毁的工具集合"。

## 3. 进程模型（一切皆进程）

- Agent 会话 / 应用 / 后台任务 / 定时任务统一由 `processManager` 登记（`process/start|update|end` 广播），Web「进程」视图实时可见，附带 token 资源仪表
- 应用生命周期：`installed → starting → running → stopping → stopped`；`destroyed` 终态（代码+进程+权限+审计全清）
- 崩溃恢复：service/app 子进程意外退出 → 心跳检测 → 指数退避重启（1s/2s/4s，≤3 次）→ 仍失败置 failed 告警

## 4. 应用模型与安全

- manifest：`data/apps/<id>/app.json`（tool/skill/agent/service/app；`entry` + 权限声明 + 工具声明）
- **隔离**：tool/service 子进程 + stdin/stdout 行分隔 JSON-RPC + 白名单能力桥（storage/notify/llm/fs/http，**无 terminal**）；webapp 沙箱 iframe（origin="null"，宿主回发 targetOrigin 必须 `"*"`）
- **权限**：静态声明（manifest 预授权）+ 运行时申请（ask 通道），均记审计；能力强制层（storage 自动允许，其余须声明命中）
- **生成期安全**：权限上限模板硬编码 + 独立最小化系统提示（防上下文注入）+ 权限声明审查 + 校验器（JS 语法 / manifest / 白名单）
- 运行时限制：工具调用 60s 超时、`resourceLimits` 内存上限、stdout 截断

## 5. 进化闭环（自进化）

```
Observe 观察（7 天窗口派生指标，零新增存储）
   ↓ 工具成功率/耗时/失败原因 · 任务完成率 · 重复任务聚类 · 用户干预 · 生成统计
Propose 提议（meta-agent → 结构化提案，schema 校验，每日 ≤3 条限频）
   ↓ new-skill / new-tool / new-app / config-change / tool-fix / prompt-fix
Adopt 确认（两段式：adopt 仅预览不写入 → apply 才真正执行）
   ↓ 写入前自动快照 data/evolution/snapshots/<id>.json
Apply 生效（技能落盘 / 工具描述热覆盖 / 提示词 YAML+热重载 / 生成任务 / 配置字段）
   ↓
Rollback 回滚（applied → rolled_back 终态，快照一键还原，审计+广播）
   ↓
Diff 变更对比（before=快照 / after=提案，行级 LCS）
   ↓
Eval 黄金用例评测（成功会话按 turn 沉淀 + 手工补录；裁判注入；before 双轨）
   ↓
Verify 推广后验证（完整 A/B → 回归超阈值 → 自动回滚，全程审计广播）
```

**护栏**：提案仅建议、用户确认；高影响变更两段式；限频 + 快照保留；全部动作审计 + `evolution/*` 广播；路径穿越三层防护；config-change 白名单（temperature/maxTokens）。

## 6. 会话与项目目录

- 会话事件溯源（`session_events` 仅追加，唯一真源）：消息/轮次/工具/记忆均为投影
- **每会话项目目录**：`/dir <绝对路径>` 或 Web 会话控制条 📁 编辑器设置；fs 工具/沙箱根/审批基线/文档面板项目根跟随该会话，未设置回退全局 `--dir`
- 三层记忆：工作（会话内）/ 情景（SQLite FTS5）/ 语义（MEMORY.md）

## 7. 交互与界面

- **TUI**：自研帧缓冲渲染（差分 + CJK 宽）+ markdown OSC8 超链接
- **Web**：Svelte 5 + SSE（chat 流）+ WS 实时总线（eventBus 双写）；左侧导航（对话/应用/进程/任务）+ 右侧面板（文件变更/文档预览/应用预览）+ SystemPanel 13 Tab（上下文/智能体/技能/MCP/插件/应用/进程/设备/进化/调度/配置/轨迹/审计）
- **设备**：TTS（edge-tts 在线 / sherpa 本地降级）、媒体服务器 WS 音频通道、模型多模态能力展示
- **CLI**：`/mode /plan /debate /app /bg /jobs /schedule /install /pkg /skill(s) /setup /new /sessions /trace /dir /config /evo /export /help /exit`

## 8. 快速开始

```bash
npm install
# 配置 DEEPSEEK_API_KEY（.env）
npm run dev            # CLI（tsx，无需编译）
npm run dev -- --server --port 3000   # 附带 Web UI（或 npm run web:dev 单独起 :5173）
npm run web:build      # 构建 Web → web/dist
npm test               # 全量单测（vitest）
```

- `--dir` 默认 `./ai_default_project`；`--data-dir` 数据目录（会话/记忆/审计/应用/进化）
- 示例应用包：`examples/`（番茄钟 webapp / 批量替换 tool / 待办 service）——目录安装用 `/app install examples/<name>`；打包分发 `/pkg export app <id>` 后 `/install <file>.aw`

## 9. 目录结构

```
src/          核心（core 内核 / tools 工具 / mcp / agents 智能体 / memory 记忆 /
              security 安全 / terminal TUI / media 媒体 / commands CLI / server HTTP）
web/          Svelte 5 前端（components / lib/stores）
config/       agents YAML / models / sandbox / plugins / mcp
data/         运行时数据（sessions.db / audit.db / apps / docs / evolution / media）
skills/       技能库（SKILL.md）
examples/     .aw 可分发示例应用包
plans/        Sprint 计划 · docs/ 设计文档
```

## 10. 版本与演进

- 0.7.0 应用模型+进程模型 → 0.9.x 语音/视频/应用工坊/智能体管理 → 0.10.0-0.12.0 进化引擎三期（观察提议/补丁回滚/评测验证）→ **1.0.0 AI OS 整合**（审计/设备/资源仪表/示例包/正式文档）
- 设计边界：黄金用例自动沉淀、独立进化 token 预算、能力自生长闭环、示例自动评测留后续版本
